import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import type { Session } from "next-auth";
import type { DocVisibility } from "@/generated/prisma/enums";
import { isDocParamShape, resolveDocParam, resolveDocSlugHistory } from "@/lib/resolve-doc-param";
import { gatedAnyViewer, titleWhenOk } from "@/lib/route-access";
import { canReadWikiDoc, canUserReadDoc } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { wikiPathOfDoc } from "@/lib/wiki-address";
import { pathWithQuery, signInPath } from "@/lib/sign-in-redirect";
import { SCRUB_PARAM, parseScrubUpdateId } from "@/lib/scrub-url";
import DocReadingView, { DOC_READ_SELECT } from "./doc-reading-view";
import styles from "./page.module.css";

// Inherently dynamic (per-user gated, and the decode-from-ydoc fallback in
// DocReadingView is a live decode) — no generateStaticParams, and none should
// be added (PLAN.md §12f: a route eligible for static generation that also
// calls a dynamic API throws DYNAMIC_SERVER_USAGE at build, §10 item 17).
// prose_json is what keeps this cheap, not a Next cache — see CACHING.md.

/**
 * docs/WIKI.md "URLs" — a wiki doc's `/doc/<slug>` is only an internal
 * handle, so it answers with a 307 to the page's address for a viewer the
 * wiki read rule lets read it (canReadWikiDoc): signed in or out, a COMMENTER
 * included, since the editor's link picker writes `/doc/` links and a PUBLIC
 * page's would otherwise send its readers to Forbidden or to sign in. Anyone
 * else signed in gets a 404, not Forbidden, which would confirm that a page
 * of that name exists, a wiki doc's slug being made from its name; signed
 * out, the sign-in redirect, as for a missing doc. A 307 rather than a 308:
 * the answer depends on who asks, and the address can change under the link.
 */
async function wikiAnswer(
  user: Session["user"] | null,
  doc: {
    id: string;
    visibility: DocVisibility;
    deletedByUserId: string | null;
    wikiName: string | null;
    wikiVariant: string;
    wikiOwner: { slug: string } | null;
  },
): Promise<{ redirect: string } | "not-found" | "signed-out"> {
  if (!(await canReadWikiDoc(user, doc))) return user ? "not-found" : "signed-out";
  return { redirect: wikiPathOfDoc({ wikiName: doc.wikiName, wikiVariant: doc.wikiVariant, ownerSlug: doc.wikiOwner?.slug ?? null })! };
}

// One select for both callers rather than a narrow one for the title: the memo
// in the envelope keys on arguments, so two different selects would be two
// misses and so two queries, which is the thing being removed.
//
// On gatedAnyViewer rather than gated(), since a signed-out request has to be
// looked up to be redirected to a PUBLIC page. The cost is a lookup of one to
// three queries per signed-out request (by id, by slug, the slug history),
// which cost none before; anything else signed out is still the sign-in
// redirect, a missing doc included, so the two still look alike.
const loadDocForRead = gatedAnyViewer(async (user, slug: string) => {
  // Before any lookup: a param can carry a NUL, which Postgres refuses.
  if (!isDocParamShape(slug)) return user ? "not-found" : "signed-out";
  const doc = await resolveDocParam(slug, DOC_READ_SELECT);
  if (!doc) {
    // A past slug redirects to the current one (docs/DOCS.md "Routes"). Gated
    // before redirecting, not after: the new slug is derived from the title,
    // so handing it to a viewer who may not read the doc would disclose what
    // the gate at that URL withholds. Such a viewer gets the answer the
    // current URL would give them.
    const moved = await resolveDocSlugHistory(slug);
    if (moved && moved.deletedByUserId === null) {
      if (moved.wikiName !== null) return wikiAnswer(user, moved);
      if (user === null) return "signed-out";
      if (!(await canUserReadDoc(user.id, user.role, moved))) {
        return "forbidden";
      }
      return { redirect: `/doc/${moved.slug}` };
    }
  }
  // resolveDocParam uses prismaIncludingDeleted (the editor needs a deleted
  // doc to still resolve, for its Settings panel's Undelete) — the reading
  // route is the caller that must not show a soft-deleted doc, so it checks
  // deletedByUserId itself rather than relying on the soft-delete extension.
  if (!doc || doc.deletedByUserId !== null) {
    return user ? "not-found" : "signed-out";
  }
  if (doc.wikiName !== null) return wikiAnswer(user, doc);
  if (user === null) return "signed-out";
  if (!(await canUserReadDoc(user.id, user.role, doc))) {
    return "forbidden";
  }
  return { doc, user };
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return titleWhenOk(await loadDocForRead(slug), (value) => docTitleOrFallback(value.doc.title));
}

export default async function PublicDocPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ sel?: string; at?: string }>;
}) {
  const { slug } = await params;
  const { sel, at } = await searchParams;
  // Which point in the doc's history the scrub bar should open at, if any
  // (src/lib/scrub-url.ts). Validated here rather than in the bar so a
  // malformed value never reaches the client at all, and so the redirect
  // below re-emits a canonical one.
  const scrubUpdateId = parseScrubUpdateId(at);
  // The query both redirects and the sign-in return path keep: ?sel= and
  // ?at=. A shared anchored link is the one URL a signed-out reader is
  // likeliest to arrive by, and a link to a revision is a link somebody was
  // sent; a redirect or a callbackUrl that kept only the pathname would land
  // on the right doc with its passages or its revision silently gone
  // (docs/ANCHORED_LINKS.md), as /pdf/[slug] avoids too.
  const preserved = new URLSearchParams();
  if (sel) preserved.set("sel", sel);
  if (scrubUpdateId) preserved.set(SCRUB_PARAM, scrubUpdateId);
  // Free — generateMetadata already ran this for the same request.
  const access = await loadDocForRead(slug);
  if (access.status === "signed-out") {
    redirect(signInPath(pathWithQuery(`/doc/${slug}`, preserved)));
  }
  if (access.status === "redirect") {
    redirect(pathWithQuery(access.to, preserved));
  }
  if (access.status === "not-found") {
    notFound();
  }
  if (access.status === "forbidden") {
    return (
      <main className={styles.forbidden}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to read this doc.</p>
      </main>
    );
  }
  return <DocReadingView doc={access.value.doc} user={access.value.user} sel={sel} scrubUpdateId={scrubUpdateId} />;
}
