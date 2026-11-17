"use client";

import { useActionState, type RefObject } from "react";
import { forkDocAction, type ForkDocState } from "@/app/actions/docs";
import LocalTime from "@/components/LocalTime";
import type { ScrubPosition } from "@/components/DocScrubContext";
import styles from "./DocActionsMenu.module.css";

const initialState: ForkDocState = {};

/**
 * docs/FORKS.md "The doc view: an Actions menu and the Fork dialog" — says
 * what the fork will copy and asks who can read it: `PRIVATE` by default,
 * whatever the parent's. `position` is where the scrub bar's slider was when
 * the dialog opened (DocActionsMenu asks the bar), null for the doc as it is
 * now. The action lands on the fork's editor; a refusal is shown here.
 *
 * A native <dialog>, opened by its owner with `showModal()`, so Escape and
 * the backdrop are the browser's.
 */
export default function ForkDialog({
  dialogRef,
  parentId,
  position,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  parentId: string;
  position: ScrubPosition | null;
}) {
  const [state, formAction, pending] = useActionState(forkDocAction, initialState);

  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="fork-dialog-title">
      <form action={formAction} className={styles.form}>
        <h2 id="fork-dialog-title" className={styles.title}>
          Fork this doc
        </h2>
        <input type="hidden" name="parentId" value={parentId} />
        <input type="hidden" name="revision" value={position?.updateId ?? ""} />
        <p className={styles.note} data-kind="fork-copies">
          {position ? (
            <>
              A new doc of your own, starting as a copy of this one as it was at <LocalTime value={position.createdAt} />.
            </>
          ) : (
            "A new doc of your own, starting as a copy of this one as it is now."
          )}{" "}
          Its text keeps its authors&apos; colours. Notes, tags, links and posts stay with this doc.
        </p>
        <label className={styles.field}>
          Who can read it
          <select name="visibility" defaultValue="PRIVATE">
            <option value="PRIVATE">PRIVATE: you alone, until you add authors</option>
            <option value="SHARED">SHARED: everyone who can read docs here</option>
          </select>
        </label>
        {state.error && <p className={styles.error}>{state.error}</p>}
        <div className={styles.buttons}>
          <button type="button" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
          <button type="submit" disabled={pending}>
            {pending ? "Forking..." : "Fork"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
