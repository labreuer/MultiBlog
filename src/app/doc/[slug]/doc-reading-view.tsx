import type { JSONContent } from "@tiptap/react";
import * as Y from "yjs";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import type { Session } from "next-auth";
import type { Prisma } from "@/generated/prisma/client";
import { canEditAnySharedDoc, canManageDocs, canUserEditDoc, canUserSeeDocHistory } from "@/lib/doc-authz";
import { wikiAddressOfDoc, wikiPagePath } from "@/lib/wiki-address";
import WikiAddressLine from "@/components/wiki/WikiAddressLine";
import { loadDocFamily } from "@/lib/doc-family";
import { docTitleOrFallback } from "@/lib/doc-title";
import { docContentExtensions } from "@/lib/tiptap-schema";
import { readYdocContent } from "@/lib/ydoc-render";
import { chipInputsForBody } from "@/lib/entity-chips/context";
import { parseChipStyles } from "@/lib/entity-chips/settings";
import { renderWithChips } from "@/lib/entity-chips/static";
import { StaticBibliography } from "@/components/bibliography/Bibliography";
import { ChipSurfaceProvider } from "@/lib/entity-chips/chip-surface";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import DocView from "@/components/DocView";
import AuthorByline from "@/components/AuthorByline";
import DocPostsLine from "@/components/DocPostsLine";
import DocActionsMenu, { type DocActionsContext } from "@/components/DocActionsMenu";
import { wikiNamespacesFor } from "@/lib/wiki-create";
import { ownerWhoCanAct } from "@/lib/wiki-claim";
import { isFrontPageAddress } from "@/lib/front-page";
import type { WikiPageMoveTargets } from "@/components/wiki/MoveWikiPageDialog";
import DocFamily from "@/components/DocFamily";
import AnnotationSection from "@/components/annotation/AnnotationSection";
import { getDocAnnotationsAsThreads } from "@/lib/annotation-data";
import { buildAnnotationEntries } from "@/components/annotation/annotation-entries";
import { annotationAnchorInputs, anchoredLinkAnchorInputs } from "@/lib/annotation-highlight-extension";
import { entryHasVisibleContent } from "@/lib/annotation-visibility";
import { anchoredLinkForViewer } from "@/lib/anchored-link-data";
import AnchoredLinkBanner from "@/components/anchored-link/AnchoredLinkBanner";
import AnchoredLinkTray from "@/components/anchored-link/AnchoredLinkTray";
import { AnnotationMoveProvider } from "@/components/annotation/annotation-move-context";
import { DocPresenceProvider } from "@/components/annotation/doc-presence-context";
import { DocScrubProvider } from "@/components/DocScrubContext";
import { MarginNotesProvider, MarginNotesRail } from "@/components/margin-notes/margin-notes-context";
import TagChips from "@/components/tags/TagChips";
import proseStyles from "@/styles/prose.module.css";
import styles from "./page.module.css";

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

// The reading view over a doc already resolved and gated: what /doc/[slug]
// renders, and what a wiki page's address renders for a reader with
// canViewDocs (docs/WIKI.md "The doc view at an address"). Each route keeps
// its own resolver and its own gate (src/lib/route-access.ts: the envelope is
// shared, never the gate); this is only what comes after them.
//
// Inherently dynamic (per-user, and the decode-from-ydoc fallback below is a
// live decode). prose_json is what keeps this cheap, not a Next cache — see
// CACHING.md.

export const DOC_READ_SELECT = {
  id: true,
  title: true,
  visibility: true,
  proseJson: true,
  chipStyles: true,
  deletedByUserId: true,
  updatedAt: true,
  // The family lines' (docs/FORKS.md "A doc's family"): what this doc was
  // forked from, at which of the parent's updates, and when.
  createdAt: true,
  // A wiki page's address (docs/WIKI.md "The doc view at an address"): its
  // title, its own links, and the redirect /doc/<slug> makes to it.
  wikiName: true,
  wikiVariant: true,
  wikiOwnerUserId: true,
  wikiOwner: { select: { slug: true } },
  forkedFromDocId: true,
  forkedFromUpdateId: true,
  authors: {
    orderBy: { bylineOrder: "asc" },
    select: { userId: true, user: { select: { slug: true, name: true } } },
  },
  // The posts made from this doc (PLAN.md §15d), for the byline's post
  // line (§21i). deletedByUserId filtered by hand: resolveDocParam reads
  // through prismaIncludingDeleted, and the soft-delete extension never
  // reaches a nested relation anyway.
  posts: {
    where: { deletedByUserId: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, slug: true, title: true, publishedAt: true, publishEventId: true },
  },
} as const;

export type DocForReading = Prisma.DocGetPayload<{ select: typeof DOC_READ_SELECT }>;

export default async function DocReadingView({
  doc,
  user,
  sel,
  scrubUpdateId,
}: {
  doc: DocForReading;
  user: Session["user"];
  sel: string | undefined;
  scrubUpdateId: string | null;
}) {
  const wikiAddress = wikiAddressOfDoc({ wikiName: doc.wikiName, wikiVariant: doc.wikiVariant, ownerSlug: doc.wikiOwner?.slug ?? null });
  const wikiPath = wikiAddress && wikiPagePath(wikiAddress);


  // Two questions, which have one answer only while a doc's history is its
  // editors' (docs/FORKS.md, "Who may see a doc's history"): the title's link
  // to the editor and the posts line ask the first, the scrub bar and the
  // room left for it the second.
  const [canEdit, canSeeHistory] = await Promise.all([
    canUserEditDoc(user.id, user.role, doc.id),
    canUserSeeDocHistory(user.id, user.role, doc.id),
  ]);

  // docs/FORKS.md "The doc view: an Actions menu and the Fork dialog" — who
  // is offered what. Publishing is an editor's, of a doc with no post yet;
  // forking is any reader's who may create docs, readers who can't edit this
  // one included. The server decides each again when it is asked.
  // A wiki page publishes nothing (docs/WIKI.md "Doc rules a wiki page
  // doesn't inherit"): the menu leaves the item out, and the publish actions
  // refuse one whatever the menu offers.
  const canPublish = canEdit && doc.wikiName === null && doc.posts.length === 0;
  const canFork = canManageDocs(user.role);
  // docs/WIKI.md "The Actions menu" — moving a doc into the wiki is an
  // editor's on its byline, of a doc that isn't a wiki page and has no post.
  // The page's own list of posts leaves deleted ones out, and a deleted one
  // refuses a move too, so the count is its own.
  const movable =
    canFork &&
    canEdit &&
    doc.wikiName === null &&
    doc.posts.length === 0 &&
    doc.authors.some((a) => a.userId === user.id) &&
    (await prismaIncludingDeleted.post.count({ where: { docId: doc.id } })) === 0;
  // Where the dialogs may put a page, by a fresh read of the viewer's
  // account; the server reads it again when a dialog is sent.
  const namespaces = canFork ? await wikiNamespacesFor(user) : null;
  // docs/WIKI.md "Renaming", "Moving out of the wiki" — "Move…", on a wiki
  // page: a person's page by its owner, read afresh, to the commons when
  // they are an ADMIN or EDITOR, or out; a commons page by an ADMIN or EDITOR
  // on its byline, to their own namespace when they have one, or out.
  let moveOut: WikiPageMoveTargets | null = null;
  if (doc.wikiName !== null) {
    if (doc.wikiOwnerUserId !== null) {
      if (doc.wikiOwnerUserId === user.id && (await ownerWhoCanAct(user.id)) !== null) {
        moveOut = { namespace: canEditAnySharedDoc(user.role) ? "commons" : null, namespaceRefusal: null };
      }
    } else if (canEditAnySharedDoc(user.role) && doc.authors.some((a) => a.userId === user.id)) {
      moveOut = { namespace: namespaces?.person ? "person" : null, namespaceRefusal: namespaces?.personRefusal ?? null };
    }
  }
  const frontPage =
    moveOut !== null && doc.wikiOwnerUserId === null && doc.wikiVariant === "" && doc.visibility === "PUBLIC"
      ? await isFrontPageAddress(doc.id)
      : false;
  const actionsContext: DocActionsContext = {
    title: doc.title,
    visibility: doc.visibility,
    isWikiPage: doc.wikiName !== null,
    frontPage,
    namespaces: {
      viewerId: user.id,
      person: namespaces?.person ? { slug: namespaces.person.slug } : null,
      personRefusal: namespaces?.personRefusal ?? null,
      commons: namespaces?.commons ?? false,
    },
  };
  const family = await loadDocFamily(user, doc);

  // PLAN.md §13o — fetched here rather than inside AnnotationSection because
  // the body needs them too: a column-anchored annotation's highlight is a
  // decoration this page has to supply, where a mark-anchored one's arrives
  // with the content. One fetch, so the highlight and the card can't be
  // derived from two different snapshots.
  const threads = await getDocAnnotationsAsThreads(doc.id);

  // docs/ANCHORED_LINKS.md — a ?sel= page resolves the link it names, per
  // viewer. Outside the `gated` memo on purpose: the memo keys on its
  // arguments and generateMetadata already ran it without the searchParam,
  // so folding `sel` in would just split the doc load into two queries. Null
  // (no such link, or nothing this viewer may see) renders as if ?sel= were
  // absent.
  const link = sel ? await anchoredLinkForViewer(sel, user) : null;
  const linkGroupHere = link?.groups.find((g) => g.target.kind === "doc" && g.target.id === doc.id) ?? null;

  // This doc's DOC_RANGE parts merge into the same anchor list the
  // annotations ride: one list, one plugin state, one per-transaction
  // resolve pass — the `kind` field on each input keeps the two apart
  // downstream (annotation-highlight-extension.ts).
  // A deleted annotation stays in `threads` (a soft delete; its replies may
  // still be a conversation), so the highlight is filtered here by the rule
  // its card is: a stored-offset anchor has no mark for the delete to remove.
  const annotationAnchors = [
    ...annotationAnchorInputs((await buildAnnotationEntries(threads)).filter(entryHasVisibleContent)),
    ...(linkGroupHere ? anchoredLinkAnchorInputs(linkGroupHere.parts) : []),
  ];

  // bodyJSON seeds DocReadingBody's editor so its first paint is identical to
  // staticBody's SSR output (no hydration mismatch, no flash); staticBody is
  // what's shown until that editor reports ready.
  let bodyJSON: JSONContent = EMPTY_DOC;
  let bodyError: string | null = null;
  if (doc.proseJson) {
    bodyJSON = doc.proseJson as JSONContent;
  } else {
    // decode-from-ydoc fallback (§12d) — prose_json is still null because no
    // store debounce has fired yet, e.g. a doc that was created but never
    // edited. A scratch Y.Doc decoded once for this render, then discarded;
    // DocReadingBody below opens the real live connection.
    const row = await prisma.ydoc.findUnique({ where: { id: ydocIdForDoc(doc.id) }, select: { ydoc: true } });
    const scratch = new Y.Doc();
    if (row) Y.applyUpdate(scratch, row.ydoc);
    const result = readYdocContent(scratch);
    if (result.ok) {
      bodyJSON = result.bodyJSON;
    } else {
      bodyError = result.error;
    }
    scratch.destroy();
  }

  // Entity chips (docs/ENTITY_CHIPS.md): the context the static body's labels
  // are computed from, loaded once and handed to the live editor too, so the
  // swap from one to the other changes no label.
  const chipInputs = await chipInputsForBody(bodyJSON, parseChipStyles(doc.chipStyles));
  const staticBody = bodyError ? (
    <p style={{ color: "var(--error)" }}>{bodyError}</p>
  ) : (
    <>
      {renderWithChips(bodyJSON, docContentExtensions, chipInputs)}
      <StaticBibliography body={bodyJSON} inputs={chipInputs} download={`doc=${doc.id}`} />
    </>
  );

  return (
    <main className={`${styles.container} ${canSeeHistory ? styles.containerScrubbable : ""}`}>
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
              DocView) through this, since neither is the other's ancestor.
              `hasScrubBar` is the same answer the bar itself is gated on:
              that control is a link now (docs/DOCS.md, "?at="), so it renders
              before the bar has loaded — but never on a page where no bar
              will ever exist, which is what a read-only viewer has. */}
          <DocScrubProvider hasScrubBar={canSeeHistory}>
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
                  {link && (
                    <AnchoredLinkBanner link={link} currentTarget={{ kind: "doc", id: doc.id }} />
                  )}
                  {/* The key makes doc identity a mount boundary. A client-side
                      nav between two docs (the anchored-link banner's group
                      links are the first surface that does this) otherwise
                      *reuses* DocReadingBody: its editor still holds the old
                      doc until the new provider syncs, so the anchors effect
                      pushes the new doc's quotes against the old doc's text and
                      detaches every one — and detachment is only re-evaluated
                      on the next anchor push (annotation-highlight-extension.ts),
                      which never comes. Remounting also retires the same-class
                      staleness in ready/synced and in DocView's scrub state. */}
                  <ChipSurfaceProvider doc={doc.id} initial={chipInputs}>
                    <DocView
                      key={doc.id}
                      docId={doc.id}
                      initialTitle={docTitleOrFallback(doc.title)}
                      // A wiki page's title is its name, whatever its title
                      // fragment says, live or at a version ("The name is the
                      // title"), and its own links go to its address.
                      fixedTitle={wikiAddress?.name}
                      editHref={wikiPath ? `${wikiPath}/edit` : `/doc/${doc.id}/edit`}
                      addressLine={
                        wikiAddress && <WikiAddressLine key="address" address={wikiAddress} visibility={doc.visibility} />
                      }
                      initialBodyJSON={bodyJSON}
                      staticBody={<div className={proseStyles.prose}>{staticBody}</div>}
                      canEdit={canEdit}
                      canSeeHistory={canSeeHistory}
                      userColor={user.color}
                      annotationAnchors={annotationAnchors}
                      initialScrubUpdateId={scrubUpdateId}
                      // docs/FORKS.md "A doc's family" — under the byline.
                      // Keyed for the byline's own reason: a prop DocView
                      // renders among siblings.
                      family={family && <DocFamily key="family" family={family} surface={wikiAddress ? "wiki" : "doc"} />}
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
                          {/* PLAN.md §21i — the doc's posts, once it has any.
                              Gated on canEdit: a scheduled post is not public
                              information. The key is load-bearing for the same
                              reason TagChips' below is. */}
                          {canEdit && doc.posts.length > 0 && (
                            <DocPostsLine key="posts" docTitle={doc.title} posts={doc.posts} />
                          )}
                          {/* docs/FORKS.md — "Publish as blog post" (§15d's
                              entry point into post creation), "Fork…" and
                              docs/WIKI.md's "Move into the wiki…" and "Move…", each for
                              whoever may. A client island, which renders
                              nothing with none; keyed for the same reason. */}
                          <DocActionsMenu
                            key="actions"
                            docId={doc.id}
                            publish={canPublish}
                            fork={canFork}
                            moveIn={movable}
                            moveOut={moveOut}
                            context={actionsContext}
                          />
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
                  </ChipSurfaceProvider>
                  <AnnotationSection docId={doc.id} threads={threads} />
                </div>
                <MarginNotesRail className={styles.rail} />
              </div>
            </MarginNotesProvider>
          </DocScrubProvider>
        </AnnotationMoveProvider>
      </DocPresenceProvider>
      {/* docs/ANCHORED_LINKS.md — self-fetching, fixed-position, renders
          nothing without a draft; the server row is its state, so it needs
          nothing from this page but a mount point outside the layout grid. */}
      <AnchoredLinkTray />
    </main>
  );
}
