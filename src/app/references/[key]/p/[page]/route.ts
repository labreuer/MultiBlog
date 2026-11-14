import { notFound, redirect } from "next/navigation";
import { actorFromSessionUser } from "@/lib/actor";
import { auth } from "@/lib/auth";
import { citedPageTarget } from "@/lib/reference-cited-by";

// docs/CITATIONS.md, "The link" — where a citation of a work at a page links,
// for every reader of a doc or a post alike: `/references/<key>/p/49`, with
// the passage it points at as its query when it has one. It renders nothing.
// A reader who may open the work's PDF is sent to the page cited in it, the
// passage outlined, and anyone else to the reference's own page, which is
// what a reference with no PDF gives everyone. So a chip's link is the same
// for everyone who sees it, and whether a reader may open the PDF is asked
// when they follow it, as /link/<id> asks of its targets.
//
// A route handler rather than a page, since the query is read raw, in order
// and still percent-encoded, as a fragment is read (docs/PDF_FRAGMENT_LINKS.md
// §2): a page's `searchParams` arrive decoded, and lose the order of a `p=`
// and a `sheet=` between their `text`s. It reads the session; the reference's
// page beside it reads none, and never gets the query.

export async function GET(request: Request, { params }: { params: Promise<{ key: string; page: string }> }) {
  const { key, page } = await params;
  // A param arrives percent-encoded (CLAUDE.md, Gotchas), a key's `:` as `%3A`; a malformed one is no page.
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return "";
    }
  };
  const session = await auth();
  const query = new URL(request.url).search.slice(1);
  const target = await citedPageTarget(session?.user ? actorFromSessionUser(session.user) : null, decode(key), decode(page), query);
  if (!target) notFound();
  redirect(target);
}
