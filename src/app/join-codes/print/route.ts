import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { actorFromSessionUser } from "@/lib/actor";
import { ApiError } from "@/lib/api/errors";
import { appUrl } from "@/lib/app-url";
import { SITE_TITLE } from "@/lib/site-config";
import { liveCardsForPrinting } from "@/lib/join-codes/cards";
import { renderCardSheet } from "@/lib/join-codes/sheet";
import { pathWithQuery, signInPath } from "@/lib/sign-in-redirect";

// docs/EMAIL.md §10, "Minting and printing" — a batch's live cards as the
// printable sheet, `?batch=<id>`, with `&line=<text>` for an optional line on
// every card, under its invitation. The codes are derived again from the rows
// under the current key (liveCardsForPrinting), so the sheet can be closed
// once printed and drawn again whenever it is wanted.
//
// **A page's gate doesn't cover a Route Handler**, so this one asks for an
// ADMIN itself, through liveCardsForPrinting, which reads the account row as
// well as the session. It writes nothing. The document holds live codes, so
// it is never cached, sends no referrer, and loads nothing: its CSP allows its
// own inline style and nothing else.

/** The longest extra line a card takes; past one line, it runs the text below the QR (docs/EMAIL.md). */
const MAX_LINE_LENGTH = 120;

const SHEET_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

function refusal(message: string, status: number): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const session = await auth();
  if (!session?.user) redirect(signInPath(pathWithQuery(url.pathname, url.searchParams)));

  const batchId = url.searchParams.get("batch");
  if (!batchId) return refusal("Name a batch: /join-codes/print?batch=<id>.", 400);
  const line = (url.searchParams.get("line") ?? "").trim();
  if (line.length > MAX_LINE_LENGTH) return refusal(`The line is at most ${MAX_LINE_LENGTH} characters.`, 400);

  let cards: { serial: number; code: string }[];
  try {
    ({ cards } = await liveCardsForPrinting(actorFromSessionUser(session.user), batchId));
  } catch (err) {
    if (err instanceof ApiError) return refusal(err.message, err.code === "forbidden" ? 403 : 400);
    throw err;
  }
  if (cards.length === 0) return refusal("That batch has no live cards to print.", 400);

  const sheet = renderCardSheet({
    siteTitle: SITE_TITLE,
    host: new URL(appUrl("/")).host,
    line: line || undefined,
    cards,
  });
  return new Response(sheet, { headers: SHEET_HEADERS });
}
