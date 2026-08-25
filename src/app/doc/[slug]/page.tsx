import { notFound, redirect } from "next/navigation";
import type { JSONContent } from "@tiptap/react";
import { renderToReactElement } from "@tiptap/static-renderer";
import * as Y from "yjs";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveDocParam } from "@/lib/resolve-doc-param";
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

export default async function PublicDocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const doc = await resolveDocParam(slug, {
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
  });
  // resolveDocParam uses prismaIncludingDeleted (the editor needs a deleted
  // doc to still resolve, for its Settings panel's Undelete) — the reading
  // route is the caller that must not show a soft-deleted doc, so it checks
  // deletedByUserId itself rather than relying on the soft-delete extension.
  if (!doc || doc.deletedByUserId !== null) {
    notFound();
  }

  if (!(await canUserReadDoc(session.user.id, session.user.role, doc))) {
    return (
      <main className={styles.forbidden}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to read this doc.</p>
      </main>
    );
  }

  const canEdit = await canUserEditDoc(session.user.id, session.user.role, doc.id);
  const otherDocs = (await readableDocsFor(session.user.id, session.user.role)).filter((d) => d.id !== doc.id);

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
                    userColor={session.user.color}
                    annotationAnchors={annotationAnchors}
                    byline={
                      // A <div>, not <p> — <form> isn't valid inside <p> (HTML
                      // rejects it; React hydrates it anyway and then warns), same
                      // reason docs/page.tsx's own create-doc form isn't wrapped in
                      // one. .byline's styling (page.module.css) is purely visual,
                      // so the tag swap changes nothing about how this renders.
                      <div className={styles.byline}>
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
                      </div>
                    }
                  />
                  {/* PLAN.md §20d — gated by this page's own canUserReadDoc
                      above, which is what makes a PRIVATE doc's chips exactly
                      as private as the doc. Below the body rather than in the
                      byline: a tag says what the whole document is about,
                      so it reads as a footer to the text rather than as part
                      of its attribution. */}
                  <TagChips target={{ kind: "doc", id: doc.id }} />
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
