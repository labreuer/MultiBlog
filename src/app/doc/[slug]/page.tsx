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
import { AnnotationMoveProvider } from "@/components/annotation/annotation-move-context";
import { DocPresenceProvider } from "@/components/annotation/doc-presence-context";
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
      staticBody = <p style={{ color: "crimson" }}>{result.error}</p>;
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
          <DocView
            docId={doc.id}
            initialTitle={docTitleOrFallback(doc.title)}
            initialBodyJSON={bodyJSON}
            staticBody={<div className={proseStyles.prose}>{staticBody}</div>}
            canEdit={canEdit}
            userColor={session.user.color}
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
          <AnnotationSection docId={doc.id} />
        </AnnotationMoveProvider>
      </DocPresenceProvider>
    </main>
  );
}
