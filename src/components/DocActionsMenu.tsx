"use client";

import { useRef, useState } from "react";
import { createPostFromDoc } from "@/app/actions/posts";
import { useDocScrubPosition, type ScrubPosition } from "@/components/DocScrubContext";
import { useCloseOnOutsideClick } from "@/components/use-close-on-outside-click";
import ForkDialog from "./ForkDialog";
import styles from "./DocActionsMenu.module.css";

/**
 * docs/FORKS.md "The doc view: an Actions menu and the Fork dialog" — the
 * byline's menu on the doc view. Each item is shown only to whoever may do
 * it, decided by the page (src/app/doc/[slug]/page.tsx):
 *
 * - **Publish as blog post**, for an editor of a doc with no post (PLAN.md
 *   §15d's doc-page entry point into post creation);
 * - **Fork…**, for any reader with canManageDocs, which includes readers who
 *   can't edit.
 *
 * The server still decides each one; the menu only keeps from offering what
 * would be refused. A <details>, as the header's tool menus are. The dialog
 * sits outside it, since a modal inside a closed <details> isn't rendered.
 */
export default function DocActionsMenu({ docId, publish, fork }: { docId: string; publish: boolean; fork: boolean }) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  useCloseOnOutsideClick(menuRef);
  const forkRef = useRef<HTMLDialogElement>(null);
  const getScrubPosition = useDocScrubPosition();
  // Where the scrub bar was when the dialog last opened: asked once, at the
  // click, so the dialog names one version however the slider moves behind it.
  const [position, setPosition] = useState<ScrubPosition | null>(null);

  if (!publish && !fork) return null;

  function openFork() {
    if (menuRef.current) menuRef.current.open = false;
    setPosition(getScrubPosition());
    forkRef.current?.showModal();
  }

  return (
    <span className={styles.menuWrap}>
      <details ref={menuRef} >
        <summary className={styles.summary}>
          Actions <span aria-hidden="true">▾</span>
        </summary>
        <div className={styles.panel}>
          {publish && (
            <form action={createPostFromDoc.bind(null, docId)}>
              <button type="submit" className={styles.item}>
                Publish as blog post
              </button>
            </form>
          )}
          {fork && (
            <button type="button" className={styles.item} onClick={openFork}>
              Fork…
            </button>
          )}
        </div>
      </details>
      {fork && <ForkDialog dialogRef={forkRef} parentId={docId} position={position} />}
    </span>
  );
}
