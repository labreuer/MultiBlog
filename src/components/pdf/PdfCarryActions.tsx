"use client";

import { useEffect, useState, useTransition } from "react";
import { carryVersionNotes, previewVersionCarry, setCarryMovesHidden } from "@/app/actions/files";
import type { CarryPreview, CarryResult } from "@/lib/file-anchor-move";
import { carryPreviewWords, carryResultWords } from "@/lib/file-carry-words";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "Moving a note forward" — the bulk carry a manager starts
// on one earlier version, in the version list and on a version's map page.
//
// **It shows what it would do before it stores a map or moves a note**: the
// first click asks only for that, and nothing in the app undoes either. The
// second runs it, and says what it did: how many notes moved, how many
// stayed on each version, and how many were skipped.
//
// **A success ends in a full reload**, which the manager asks for once they
// have read the answer: the viewer is behind `ssr: false`, where a
// `router.refresh()` alone is lost (CLAUDE.md), and its notes are listed by
// version. A promotion's carry can't keep its answer on screen that way, and
// hands it to the page its reload brings (`keepCarryOutcome`,
// `PdfCarryOutcome`).
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
        <CarryResultNote result={result} />
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

/** What a carry did, with the reload that shows it. */
export function CarryResultNote({ result }: { result: CarryResult }) {
  return (
    <div className={styles.versionFacts} data-testid="pdf-carry-result">
      {carryResultWords(result).map((line) => (
        <p key={line}>{line}</p>
      ))}
      <div className={styles.manageRow}>
        <button type="button" className={styles.manageButton} data-testid="pdf-carry-reload" onClick={() => window.location.reload()}>
          Reload the page
        </button>
      </div>
    </div>
  );
}

// What a promotion's carry did, kept across the reload that follows it. The
// promotion's action revalidates the page, which takes the candidate's
// banner away before it could show an answer, so the answer is written here
// and read once by the page that comes back.
const CARRY_OUTCOME_KEY = "pdf-carry-outcome";

// Set by the page that wrote an outcome and is about to reload. The action's
// revalidation can mount `PdfCarryOutcome` on that same page in the moment
// before the reload takes it away, and a read there would use the outcome up
// where nobody sees it.
let leaving = false;

export function keepCarryOutcome(result: CarryResult) {
  leaving = true;
  try {
    window.sessionStorage.setItem(CARRY_OUTCOME_KEY, JSON.stringify(result));
  } catch {
    // Storage refused: the carry ran, and the version list says what is where.
  }
}

/**
 * What the carry of the promotion that led here did, shown once to the
 * manager who ran it: how many notes moved, how many stayed on each
 * version, and how many were skipped. Nothing where no carry led here.
 */
export function PdfCarryOutcome({ className }: { className?: string }) {
  const [result, setResult] = useState<CarryResult | null>(null);
  useEffect(() => {
    if (leaving) return;
    let kept: string | null = null;
    try {
      kept = window.sessionStorage.getItem(CARRY_OUTCOME_KEY);
      window.sessionStorage.removeItem(CARRY_OUTCOME_KEY);
    } catch {
      return;
    }
    if (!kept) return;
    try {
      // Read in an effect, after hydration: the server rendered nothing here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResult(JSON.parse(kept) as CarryResult);
    } catch {
      // Not an outcome: nothing to show.
    }
  }, []);
  if (!result) return null;
  return (
    <aside className={`${styles.banner} ${className ?? ""}`} data-testid="pdf-carry-outcome">
      <div className={styles.bannerText}>
        <p>Version {result.toNumber} is now the latest.</p>
        {carryResultWords(result).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      <button type="button" className={styles.dismiss} onClick={() => setResult(null)} aria-label="Dismiss what the carry did">
        ✕
      </button>
    </aside>
  );
}

/**
 * One carry in the version list, with its moves shown or hidden together. A
 * carry's moves are hidden when it is run: on a corrected scan a move tells
 * a reader nothing. Shown, each moved note's card says which version it was
 * moved from, and the page of the version it left lists it as moved.
 *
 * A note's author shows or hides a move of their own note, a carry's
 * included, so some of a carry's moves can be shown and the rest hidden:
 * the record then says how many, and offers both.
 */
export function PdfCarryRecord({ carryId, moves, shown, children }: { carryId: string; moves: number; shown: number; children: React.ReactNode }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const set = (to: boolean) => {
    setError(null);
    startTransition(async () => {
      const answer = await setCarryMovesHidden(carryId, to).catch(() => ({ ok: false as const, error: FAILED }));
      if (answer.ok) window.location.reload();
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
