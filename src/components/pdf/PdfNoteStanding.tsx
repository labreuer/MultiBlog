"use client";

import { useState, useTransition } from "react";
import { markNoteStays, setNoteMoveShown } from "@/app/actions/note-moves";
import { useAnnotationReload } from "@/components/annotation/annotation-reload-context";
import type { NoteStanding } from "@/lib/file-note-move";
import { movedFromWords } from "@/lib/file-note-words";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "Moving a note forward" — what a note's card says of where
// the note stands among its file's versions, under the card.
//
// **A shown move**: which version the note was moved from, and who moved it
// where that is not its author. A hidden move leaves no sign on any card,
// its author's included: a carry's moves are hidden because on a corrected
// scan they tell a reader nothing, and a line on each of an author's own
// cards would tell them that two hundred times. So a move is hidden from
// here, and shown again from the note's entry on the page of the version it
// left (`PdfOtherVersionNotes`).
//
// **"Stays here"**, on the author's own card on an earlier version's page: a
// note posted from an earlier version's address can be marked as soon as it
// is posted, and the mark taken off. A note on the latest has nothing to
// stay behind from, and is offered no mark.
//
// Nothing is rendered for a note with neither.

type Props = {
  noteId: string;
  standing: NoteStanding;
  /** The version shown, which the note is on. */
  versionNumber: number;
  /** Whether a later version exists for the note to stay behind from: the version shown is an earlier one. */
  canStay: boolean;
  /** The latest version's number, where the note would be moved to. */
  latestNumber: number | null;
};

export default function PdfNoteStanding({ noteId, standing, versionNumber, canStay, latestNumber }: Props) {
  const reload = useAnnotationReload();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const shown = standing.moves.filter((move) => !move.hidden);
  const marks = standing.mine && canStay;
  if (shown.length === 0 && !marks) return null;

  const act = (run: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setError(null);
    startTransition(async () => {
      const answer = await run().catch(() => ({ ok: false as const, error: "That didn't work. Reload the page and try again." }));
      if (answer.ok) reload();
      else setError(answer.error);
    });
  };

  return (
    <div className={styles.standing} data-testid="pdf-note-standing">
      {shown.map((move) => (
        <p key={move.id} data-testid="pdf-note-moved">
          {movedFromWords(move, versionNumber)}{" "}
          {standing.mine && (
            <button type="button" className={styles.linkButton} disabled={pending} data-testid="pdf-note-move-hide" onClick={() => act(() => setNoteMoveShown(move.id, false))}>
              Don&apos;t say so
            </button>
          )}
        </p>
      ))}
      {marks &&
        (standing.stays ? (
          <p data-testid="pdf-note-stays">
            You marked this note as staying on version {versionNumber}.{" "}
            <button type="button" className={styles.linkButton} disabled={pending} data-testid="pdf-note-unstay" onClick={() => act(() => markNoteStays({ kind: "annotation", id: noteId }, false))}>
              Take the mark off
            </button>
          </p>
        ) : (
          <p>
            <button type="button" className={styles.linkButton} disabled={pending} data-testid="pdf-note-stay" onClick={() => act(() => markNoteStays({ kind: "annotation", id: noteId }, true))}>
              Mark as staying on version {versionNumber}
            </button>
            {latestNumber !== null && ` Without the mark it is in your list of notes to move, on version ${latestNumber}'s page.`}
          </p>
        ))}
      {error && (
        <p className={styles.manageError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
