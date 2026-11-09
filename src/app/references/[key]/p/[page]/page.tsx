import { notFound, redirect } from "next/navigation";
import { actorFromSessionUser } from "@/lib/actor";
import { auth } from "@/lib/auth";
import { citedPageTarget } from "@/lib/reference-cited-by";

// docs/CITATIONS.md, "The link" — where a citation of a work at a page links,
// for every reader of a doc or a post alike: `/references/<key>/p/49`. It
// renders nothing. A reader who may open the work's PDF is sent to the page
// cited in it, and anyone else to the reference's own page, which is what a
// reference with no PDF gives everyone. So a chip's link is the same for
// everyone who sees it, and whether a reader may open the PDF is asked when
// they follow it, as /link/<id> asks of its targets.
//
// It reads the session, so it is dynamic; the reference's page beside it
// reads none and stays cached.

export default async function CitedPage({ params }: { params: Promise<{ key: string; page: string }> }) {
  const { key, page } = await params;
  // A param arrives percent-encoded (CLAUDE.md, Gotchas); a malformed one is no page.
  let decoded: string;
  try {
    decoded = decodeURIComponent(page);
  } catch {
    decoded = "";
  }
  const session = await auth();
  const target = await citedPageTarget(session?.user ? actorFromSessionUser(session.user) : null, key, decoded);
  if (!target) notFound();
  redirect(target);
}
