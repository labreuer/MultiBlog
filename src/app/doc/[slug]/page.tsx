import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import type { JSONContent } from "@tiptap/react";
import { renderToReactElement } from "@tiptap/static-renderer";
import * as Y from "yjs";
import { prisma } from "@/lib/prisma";
import { resolveDocParam } from "@/lib/resolve-doc-param";
import { gated, titleWhenOk } from "@/lib/route-access";
import { canUserReadDoc, canUserEditDoc, readableDocsFor } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { createPostFromDoc } from "@/app/actions/posts";
import { docContentExtensions } from "@/lib/tiptap-schema";
import { renderYdocDoc } from "@/lib/ydoc-render";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import DocView from "@/components/DocView";
import AuthorByline from "@/components/AuthorByline";
import CompareWithPicker from "@/components/CompareWithPicker";
import AnnotationSection from "@/components/annotation/AnnotationSection";
import { getDocAnnotationsAsThreads } from "@/lib/annotation-data";
import { buildAnnotationEntries } from "@/components/annotation/annotation-entries";
import { annotationAnchorInputs } from "@/lib/annotation-highlight-extension";
import { signInPath } from "@/lib/sign-in-redirect";
import { AnnotationMoveProvider } from "@/components/annotation/annotation-move-context";
import { DocPresenceProvider } from "@/components/annotation/doc-presence-context";
import { DocScrubProvider } from "@/components/DocScrubContext";
import { MarginNotesProvider, MarginNotesRail } from "@/components/margin-notes/margin-notes-context";
import TagChips from "@/components/tags/TagChips";
import proseStyles from "@/styles/prose.module.css";
import styles from "./page.module.css";

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

// Inherently dynamic (per-user gated, and the decode-from-ydoc fallback
// below is a live decode) — no generateStaticParams, and none should be
// added (PLAN.md §12f: a route eligible for static generation that also
// calls a dynamic API throws DYNAMIC_SERVER_USAGE at build, §10 item 17).
// prose_json is what keeps this cheap, not a Next cache — see CACHING.md.

const DOC_SELECT = {
  id: true,
  title: true,
  visibility: true,
  proseJson: true,
  deletedByUserId: true,
  updatedAt: true,
  authors: {
    orderBy: { bylineOrder: "asc" },
    select: { userId: true, user: { select: { slug: true, name: true } } },
  },
} as const;

// One select for both callers rather than a narrow one for the title: the memo
// in `gated` keys on arguments, so two different selects would be two misses
// and so two queries, which is the thing being removed.
const loadDocForRead = gated(async (user, slug: string) => {
  const doc = await resolveDocParam(slug, DOC_SELECT);
  // resolveDocParam uses prismaIncludingDeleted (the editor needs a deleted
  // doc to still resolve, for its Settings panel's Undelete) — the reading
  // route is the caller that must not show a soft-deleted doc, so it checks
  // deletedByUserId itself rather than relying on the soft-delete extension.
  if (!doc || doc.deletedByUserId !== null) {
    return "not-found";
  }
  if (!(await canUserReadDoc(user.id, user.role, doc))) {
    return "forbidden";
  }
  return doc;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  return titleWhenOk(await loadDocForRead(slug), (doc) => docTitleOrFallback(doc.title));
}

export default async function PublicDocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Free — generateMetadata already ran this for the same request.
  const access = await loadDocForRead(slug);
  if (access.status === "signed-out") {
    redirect(signInPath(`/doc/${slug}`));
  }
  if (access.status === "redirect") {
    redirect(access.to);
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
  const { value: doc, user } = access;

  const canEdit = await canUserEditDoc(user.id, user.role, doc.id);
  const otherDocs = (await readableDocsFor(user.id, user.role)).filter((d) => d.id !== doc.id);

  // PLAN.md §13o — fetched here rather than inside AnnotationSection because
  // the body needs them too: a column-anchored annotation's highlight is a
  // decoration this page has to supply, where a mark-anchored one's arrives
  // with the content. One fetch, so the highlight and the card can't be
  // derived from two different snapshots.
  const threads = await getDocAnnotationsAsThreads(doc.id);
  const annotationAnchors = annotationAnchorInputs(buildAnnotationEntries(threads));

  // bodyJSON seeds DocReadingBody's editor so its first paint is identical to
  // staticBody's SSR output (no hydration mismatch, no flash); staticBody is
  // what's shown until that editor reports ready.
  let bodyJSON: JSONContent = EMPTY_DOC;
  let staticBody;
  if (doc.proseJson) {
    bodyJSON = doc.proseJson as JSONContent;
    staticBody = renderToReactElement({ content: bodyJSON, extensions: docContentExtensions });
  } else {
    // decode-from-ydoc fallback (§12d) — prose_json is still null because no
    // store debounce has fired yet, e.g. a doc that was created but never
    // edited. A scratch Y.Doc decoded once for this render, then discarded;
    // DocReadingBody below opens the real live connection.
    const row = await prisma.ydoc.findUnique({ where: { id: ydocIdForDoc(doc.id) }, select: { ydoc: true } });
    const scratch = new Y.Doc();
    if (row) Y.applyUpdate(scratch, row.ydoc);
    const result = renderYdocDoc(scratch);
    if (result.ok) {
      bodyJSON = result.bodyJSON;
      staticBody = result.body;
    } else {
      staticBody = <p style={{ color: "var(--error)" }}>{result.error}</p>;
    }
    scratch.destroy();
  }

  return (
    <main className={`${styles.container} ${canEdit ? styles.containerScrubbable : ""}`}>
      {/* Wraps both trees so "Move to bottom" (PLAN.md §13g) can hand a
          draft's id from the inline popover (inside DocView) to the bottom
          composer (AnnotationSection), and so every LiveAnnotationComposer
          (§13i) can publish presence onto DocView's own read-only
          connection — siblings here, not parent/child, so a prop can't
          carry either across on its own. */}
      <DocPresenceProvider>
        <AnnotationMoveProvider>
          {/* PLAN.md §12p/§13 — same cross-tree reason as the two providers
              above: AnnotationNode's "at this revision" control (inside
              AnnotationSection) reaches DocScrubBar's slider (inside
              DocView) through this, since neither is the other's ancestor. */}
          <DocScrubProvider>
            {/* PLAN.md §18. AnnotationSection stays exactly where it was —
                below the doc, heading and composer and sort control included,
                along with every annotation whose mark is gone — and only the
                presently-anchored cards are portaled out into the rail beside
                the text. Inside AnnotationMoveProvider rather than outside
                because "move to bottom" spans the same two subtrees and there
                is no reason for two different nesting orders. */}
            <MarginNotesProvider>
              <div className={styles.layout}>
                <div className={styles.mainColumn}>
                  <DocView
                    docId={doc.id}
                    initialTitle={docTitleOrFallback(doc.title)}
                    initialBodyJSON={bodyJSON}
                    staticBody={<div className={proseStyles.prose}>{staticBody}</div>}
                    canEdit={canEdit}
                    userColor={user.color}
                    annotationAnchors={annotationAnchors}
                    byline={
                      // A <div>, not <p> — <form> isn't valid inside <p> (HTML
                      // rejects it; React hydrates it anyway and then warns), same
                      // reason docs/page.tsx's own create-doc form isn't wrapped in
                      // one. .byline's styling (page.module.css) is purely visual,
                      // so the tag swap changes nothing about how this renders.
                      //
                      // The `key` is load-bearing, like TagChips' below, for a
                      // second reason: this element is a *prop* that DocView
                      // renders among siblings. While TagChips is still awaiting
                      // (a doc that has tags), the RSC stream hands the whole div
                      // to the client as a lazy chunk, and the reconciler checks
                      // the resolved element for a key at DocView's level —
                      // "Check the top-level render call using <DocView>" — which
                      // the static-JSX validation that normally exempts it never
                      // ran on. CLAUDE.md's Gotchas has the fuller story.
                      <div key="byline" className={styles.byline}>
                        <AuthorByline
                          authors={doc.authors.map((a) => ({ userId: a.userId, slug: a.user.slug, name: a.user.name }))}
                          showPrefix={false}
                        />
                        {/* updatedAt, not createdAt: a doc has no publish step (PLAN.md
                            §12k), so "last edited" is the only date that means anything.
                            Short date visible, full timestamp on hover. */}
                        <span title={doc.updatedAt.toLocaleString()}>{doc.updatedAt.toLocaleDateString()}</span>
                        <CompareWithPicker docId={doc.id} otherDocs={otherDocs} />
                        {/* PLAN.md §15d — the doc-page entry point into post
                            creation, alongside the /posts/new picker. Bound with the
                            extra leading arg the way any parameterized form action
                            is; createPostFromDoc redirects to the new post's editor
                            on success. */}
                        {canEdit && (
                          <form action={createPostFromDoc.bind(null, doc.id)} style={{ display: "inline" }}>
                            <button type="submit">Publish as blog post</button>
                          </form>
                        )}
                        {/* PLAN.md §20k — a second line of the byline rather
                            than a block below the text, and "bare" is what
                            drops the "Tags" label. Gated by this page's own
                            canUserReadDoc above (docs/PERMISSIONS.md, "Chips
                            are as private as the thing they are on").

                            The `key` is load-bearing and this is not a list:
                            it is a Server Component with element siblings
                            inside a prop that crosses into DocView, a client
                            component. Drop it and the page logs "Each child in
                            a list should have a unique key prop" against this
                            div — CLAUDE.md's Gotchas has why. */}
                        <TagChips key="tags" target={{ kind: "doc", id: doc.id }} variant="bare" />
                      </div>
                    }
                  />
                  <AnnotationSection docId={doc.id} threads={threads} />
                </div>
                <MarginNotesRail className={styles.rail} />
              </div>
            </MarginNotesProvider>
          </DocScrubProvider>
        </AnnotationMoveProvider>
      </DocPresenceProvider>
    </main>
  );
}
