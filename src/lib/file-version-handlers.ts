import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { actorFromSessionUser, type Actor } from "@/lib/actor";
import { ApiError, httpStatusOf } from "@/lib/api/errors";

// docs/PDF.md §14, "What the page holds", item 6 — the shape both of a
// version's Route Handlers answer in (`/api/files/versions/<id>/map` and
// `…/promotion-carry`). Each is a wrapper, as a server action is: the
// session's `Actor` handed to the function in src/lib/ that holds the gate.
//
// - signed out: 401, as `PUT /api/files/<id>` answers, never a redirect;
// - a refusal: its `ApiError`'s status, with its message as `{ error }`;
// - anything else: a 500 whose line says to reload, the fault logged.
//
// Server-only. The browser's half is `file-version-requests.ts`.

export async function versionHandler<T>(what: string, run: (actor: Actor) => Promise<T>, init?: ResponseInit): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "You are signed out. Sign in, then try again." }, { status: 401, headers: init?.headers });
  try {
    return NextResponse.json(await run(actorFromSessionUser(session.user)), init);
  } catch (err) {
    if (err instanceof ApiError) return NextResponse.json({ error: err.message }, { status: httpStatusOf(err), headers: init?.headers });
    console.error(`[files/versions] ${what} failed:`, err);
    return NextResponse.json({ error: "That didn't work. Reload the page and try again." }, { status: 500, headers: init?.headers });
  }
}
