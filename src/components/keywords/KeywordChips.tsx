import { keywordsForTarget } from "@/lib/keyword-data";
import type { AnchorTarget } from "@/lib/anchors";
import KeywordStrip, { type KeywordStripVariant } from "./KeywordStrip";

// PLAN.md §20d — the keyword strip on an object page: /doc/[slug], a post
// page, /pdf/[slug].
//
// **The gate is the page's, not this component's.** By the time this renders,
// its caller has already run that page's own access check — canUserReadDoc,
// canUserReadFile, publishedPostWhere — so a PRIVATE doc's chips are exactly as
// private as the doc, by construction rather than by a second gate that could
// disagree with the first. It takes a resolved `AnchorTarget` rather than a
// slug specifically so it cannot be dropped onto an ungated surface by
// accident: there is no way to call it without having already resolved the
// object.
//
// **It deliberately reads no session.** The public post page carries
// `generateStaticParams` and `revalidate = 60`, and a route eligible for static
// generation that also calls a dynamic API throws DYNAMIC_SERVER_USAGE at build
// (PLAN.md §12f, §10 item 17) — so reaching for `auth()` here to decide whether
// to show a tagger would break the build on exactly the page keywords most need
// to reach. The chips themselves need no session anyway: which terms are on an
// object is the same answer for every viewer who can see the object at all.
// Everything viewer-shaped lives in the client island below, which asks the
// server for its own state when someone actually opens it.

export default async function KeywordChips({
  target,
  variant = "section",
}: {
  target: AnchorTarget;
  variant?: KeywordStripVariant;
}) {
  const chips = await keywordsForTarget(target);
  return <KeywordStrip target={target} chips={chips} variant={variant} />;
}
