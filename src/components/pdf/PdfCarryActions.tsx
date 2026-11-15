"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { carryVersionNotes, previewVersionCarry, setCarryMovesHidden } from "@/app/actions/files";
import type { CarryPreview, CarryResult } from "@/lib/file-anchor-move";
import { carryPreviewWords, carryResultWords } from "@/lib/file-carry-words";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "Moving a note forward" — the bulk carry a manager starts
// on one earlier version, on its file's manage page and on a version's map
// page.
//
// **It shows what it would do before it stores a map or moves a note**: the
// first click asks only for that, and nothing in the app undoes either. The
// second runs it, and says what it did: how many notes moved, how many
// stayed on each version, and how many were skipped.
//
// **A success ends in a refresh**, which the manager asks for once they have
// read the answer: the refresh can take this away, with the notes it counted.
// Both pages are server-rendered behind no `ssr: false` boundary, so the
// refresh delivers what is where now. A promotion's carry is said by the
// manage page's versions section, which outlives the refresh that takes the
// candidate's card away.
//
// Each act is a manager's (`canUserManageFile`, asked by the action), and a
// refusal comes back as an answer and is shown.

type Props = {
  /** The earlier version the carry starts on. */
  versionId: string;
  number: number;
  latestNumber: number;
};

const FAILED = "That didn't work. Reload the page and try again.";

export default function PdfCarryActions({ versionId, number, latestNumber }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<CarryPreview | null>(null);
  const [result, setResult] = useState<CarryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const look = () => {
    setError(null);
    startTransition(async () => {
      const answer = await previewVersionCarry(versionId).catch(() => ({ ok: false as const, error: FAILED }));
      if (answer.ok) setPreview(answer.value);
      else setError(answer.error);
    });
  };
  const run = () => {
    setError(null);
    startTransition(async () => {
      const answer = await carryVersionNotes(versionId).catch(() => ({ ok: false as const, error: FAILED }));
      if (answer.ok) setResult(answer.value);
      else setError(answer.error);
    });
  };

  return (
    <div className={styles.manage} data-testid="pdf-carry">
      {result ? (
        <CarryResultNote
          result={result}
          onDone={() => {
            setResult(null);
            setPreview(null);
            router.refresh();
          }}
        />
      ) : preview ? (
        <>
          <div className={styles.versionFacts} data-testid="pdf-carry-preview">
            {carryPreviewWords(preview).map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          <div className={styles.manageRow}>
            {(preview.notes + preview.parts > 0 || preview.storesMaps.length > 0) && (
              <button type="button" className={styles.manageButton} disabled={pending} data-testid="pdf-carry-run" onClick={run}>
                {pending ? "Carrying…" : preview.notes + preview.parts > 0 ? "Carry them forward" : "Match the pages"}
              </button>
            )}
            <button type="button" className={styles.manageButton} disabled={pending} onClick={() => setPreview(null)}>
              Not now
            </button>
          </div>
        </>
      ) : (
        <div className={styles.manageRow}>
          <button type="button" className={styles.manageButton} disabled={pending} data-testid="pdf-carry-look" onClick={look}>
            {pending ? "Working out what would carry…" : `Carry notes from version ${number} to version ${latestNumber}…`}
          </button>
        </div>
      )}
      {error && (
        <p className={styles.manageError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** What a carry did, with the refresh that shows it. */
function CarryResultNote({ result, onDone }: { result: CarryResult; onDone: () => void }) {
  return (
    <div className={styles.versionFacts} data-testid="pdf-carry-result">
      {carryResultWords(result).map((line) => (
        <p key={line}>{line}</p>
      ))}
      <div className={styles.manageRow}>
        <button type="button" className={styles.manageButton} data-testid="pdf-carry-reload" onClick={onDone}>
          Show the versions as they are now
        </button>
      </div>
    </div>
  );
}

/**
 * One carry, on the manage page under the version it moved notes to, with
 * its moves shown or hidden together. A
 * carry's moves are hidden when it is run: on a corrected scan a move tells
 * a reader nothing. Shown, each moved note's card says which version it was
 * moved from, and the page of the version it left lists it as moved.
 *
 * A note's author shows or hides a move of their own note, a carry's
 * included, so some of a carry's moves can be shown and the rest hidden:
 * the record then says how many, and offers both.
 */
export function PdfCarryRecord({ carryId, moves, shown, children }: { carryId: string; moves: number; shown: number; children: React.ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const set = (to: boolean) => {
    setError(null);
    startTransition(async () => {
      const answer = await setCarryMovesHidden(carryId, to).catch(() => ({ ok: false as const, error: FAILED }));
      if (answer.ok) router.refresh();
      else setError(answer.error);
    });
  };
  const hidden = shown === 0;
  return (
    <div className={styles.versionFacts} data-testid="pdf-carry-record" data-carry-hidden={hidden ? "true" : "false"}>
      {children}{" "}
      {hidden
        ? "Its moves are hidden: no card says a note was moved."
        : shown === moves
          ? "Its moves are shown on each note's card."
          : `${shown} of its moves ${shown === 1 ? "is" : "are"} shown on ${shown === 1 ? "its note's card" : "their notes' cards"}.`}{" "}
      {shown < moves && (
        <button type="button" className={styles.manageButton} disabled={pending} data-testid="pdf-carry-show" onClick={() => set(false)}>
          {hidden ? "Show its moves" : "Show them all"}
        </button>
      )}
      {shown > 0 && (
        <button type="button" className={styles.manageButton} disabled={pending} data-testid="pdf-carry-hide" onClick={() => set(true)}>
          {shown === moves ? "Hide its moves" : "Hide them all"}
        </button>
      )}
      {error && (
        <span className={styles.manageError} role="alert">
          {" "}
          {error}
        </span>
      )}
    </div>
  );
}
