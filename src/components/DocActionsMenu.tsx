"use client";

import { useRef, useState } from "react";
import type { DocVisibility } from "@/generated/prisma/enums";
import { createPostFromDoc } from "@/app/actions/posts";
import { useDocScrubPosition, type ScrubPosition } from "@/components/DocScrubContext";
import { useCloseOnOutsideClick } from "@/components/use-close-on-outside-click";
import MoveIntoWikiDialog from "@/components/wiki/MoveIntoWikiDialog";
import MoveWikiPageDialog, { type WikiPageMoveTargets } from "@/components/wiki/MoveWikiPageDialog";
import type { WikiNamespaces } from "@/components/wiki/wiki-dialog-parts";
import ForkDialog from "./ForkDialog";
import styles from "./DocActionsMenu.module.css";

/** What the Fork and Move dialogs read of the doc and the viewer. */
export type DocActionsContext = {
  /** The doc's title as the view shows it, a wiki page's being its name. */
  title: string;
  visibility: DocVisibility;
  isWikiPage: boolean;
  namespaces: WikiNamespaces;
  /** Whether this is the commons' `Front Page` while it is `PUBLIC`, which "Move…" says it takes off the landing page. */
  frontPage: boolean;
};

/**
 * docs/FORKS.md "The doc view: an Actions menu and the Fork dialog", and
 * docs/WIKI.md "The Actions menu" — the byline's menu on the doc view. Each
 * item is shown only to whoever may do it, decided by the page
 * (src/app/doc/[slug]/doc-reading-view.tsx):
 *
 * - **Publish as blog post**, for an editor of a doc with no post (PLAN.md
 *   §15d's doc-page entry point into post creation), never on a wiki page.
 *   It makes a draft either way; to a viewer who may not publish (PLAN.md
 *   §38) it says **Draft a blog post**, since an editor publishes it;
 * - **Fork…**, for any reader with canManageDocs, which includes readers who
 *   can't edit. One item with a Where: a doc, your namespace, or the commons;
 * - **Move into the wiki…**, for an editor on the byline of a doc that isn't
 *   a wiki page and has no post, a deleted one included;
 * - **Move…**, on a wiki page, to another namespace or out of the wiki, for
 *   its owner, or for a commons page an ADMIN or EDITOR on its byline.
 *
 * The server still decides each one; the menu only keeps from offering what
 * would be refused. A <details>, as the header's tool menus are. The dialogs
 * sit outside it, since a modal inside a closed <details> isn't rendered.
 */
export default function DocActionsMenu({
  docId,
  postItem,
  fork,
  moveIn,
  moveOut,
  context,
}: {
  docId: string;
  /** Which label the post item takes, or null when it isn't offered. */
  postItem: "publish" | "draft" | null;
  fork: boolean;
  moveIn: boolean;
  /** Where "Move…" may take this wiki page, or null when it isn't offered. */
  moveOut: WikiPageMoveTargets | null;
  context: DocActionsContext;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  useCloseOnOutsideClick(menuRef);
  const forkRef = useRef<HTMLDialogElement>(null);
  const moveRef = useRef<HTMLDialogElement>(null);
  const moveOutRef = useRef<HTMLDialogElement>(null);
  const getScrubPosition = useDocScrubPosition();
  // Where the scrub bar was when the dialog last opened: asked once, at the
  // click, so the dialog names one version however the slider moves behind it.
  const [position, setPosition] = useState<ScrubPosition | null>(null);
  // Which dialog is showing, so only that one asks the server for its default address.
  const [showing, setShowing] = useState<"fork" | "move" | "moveOut" | null>(null);

  if (!postItem && !fork && !moveIn && !moveOut) return null;

  function closeMenu() {
    if (menuRef.current) menuRef.current.open = false;
  }

  function openFork() {
    closeMenu();
    setPosition(getScrubPosition());
    setShowing("fork");
    forkRef.current?.showModal();
  }

  function openMove() {
    closeMenu();
    setShowing("move");
    moveRef.current?.showModal();
  }

  function openMoveOut() {
    closeMenu();
    setShowing("moveOut");
    moveOutRef.current?.showModal();
  }

  return (
    <span className={styles.menuWrap}>
      <details ref={menuRef}>
        <summary className={styles.summary}>
          Actions <span aria-hidden="true">▾</span>
        </summary>
        <div className={styles.panel}>
          {postItem && (
            <form action={createPostFromDoc.bind(null, docId)}>
              <button type="submit" className={styles.item}>
                {postItem === "publish" ? "Publish as blog post" : "Draft a blog post"}
              </button>
            </form>
          )}
          {fork && (
            <button type="button" className={styles.item} onClick={openFork}>
              Fork…
            </button>
          )}
          {moveIn && (
            <button type="button" className={styles.item} onClick={openMove}>
              Move into the wiki…
            </button>
          )}
          {moveOut && (
            <button type="button" className={styles.item} onClick={openMoveOut}>
              Move…
            </button>
          )}
        </div>
      </details>
      {fork && (
        <ForkDialog
          dialogRef={forkRef}
          open={showing === "fork"}
          onClose={() => setShowing(null)}
          parentId={docId}
          position={position}
          title={context.title}
          isWikiPage={context.isWikiPage}
          namespaces={context.namespaces}
        />
      )}
      {moveIn && (
        <MoveIntoWikiDialog
          dialogRef={moveRef}
          open={showing === "move"}
          onClose={() => setShowing(null)}
          docId={docId}
          title={context.title}
          visibility={context.visibility}
          namespaces={context.namespaces}
        />
      )}
      {moveOut && (
        <MoveWikiPageDialog
          dialogRef={moveOutRef}
          open={showing === "moveOut"}
          onClose={() => setShowing(null)}
          docId={docId}
          name={context.title}
          visibility={context.visibility}
          namespaces={context.namespaces}
          targets={moveOut}
          frontPage={context.frontPage}
        />
      )}
    </span>
  );
}
