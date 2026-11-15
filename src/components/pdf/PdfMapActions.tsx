"use client";

import { useState, useTransition } from "react";
import { answerVersionMapRun, buildVersionMap, unpairVersionMapRun, type VersionActionResult } from "@/app/actions/files";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "Matching the pages" — the acts on a version's map page:
// asking for the map, pairing one run of its sheets or leaving it unmatched
// (§14, "A version's page map, sheet by sheet": two choices, each saying what
// it does), and un-pairing a run that was paired, which asks first. Each is a
// manager's (`canUserManageFile`, asked by the action), and each reloads the
// page on success, which is a plain server page.
//
// A refusal comes back as an answer and is shown, as a version's other acts
// show theirs: a production build hides a thrown error's message.

type Props = {
  versionId: string;
  /** Offer to build the map: the version has none. */
  build?: boolean;
  /** Offer an answer to this run, which nobody has accepted. */
  run?: { index: number; kind: "labels" | "place"; declined: boolean };
  /** Offer to un-pair this run, which an answer paired: what the confirmation says it costs. */
  unpair?: { index: number; carried: number; baseNumber: number; number: number };
};

export default function PdfMapActions({ versionId, build, run, unpair }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const act = (does: () => Promise<VersionActionResult>) => {
    setError(null);
    startTransition(async () => {
      const result = await does().catch((): VersionActionResult => ({ ok: false, error: "That didn't work. Reload the page and try again." }));
      if (result.ok) {
        window.location.reload();
        return;
      }
      setError(result.error);
    });
  };

  return (
    <div className={styles.manage}>
      <div className={styles.manageRow}>
        {build && (
          <button type="button" className={styles.manageButton} disabled={pending} data-testid="pdf-map-build" onClick={() => act(() => buildVersionMap(versionId))}>
            {pending ? "Matching the pages…" : "Match the pages"}
          </button>
        )}
        {run && (
          <>
            <button
              type="button"
              className={styles.manageButton}
              disabled={pending}
              data-testid="pdf-map-accept"
              onClick={() => act(() => answerVersionMapRun(versionId, run.index, true))}
            >
              {run.kind === "labels" ? "Pair them by their words" : "Pair them by their place"}
            </button>
            {!run.declined && (
              <button
                type="button"
                className={styles.manageButton}
                disabled={pending}
                data-testid="pdf-map-decline"
                onClick={() => act(() => answerVersionMapRun(versionId, run.index, false))}
              >
                Leave them unmatched
              </button>
            )}
          </>
        )}
        {unpair && !confirming && (
          <button type="button" className={styles.manageButton} disabled={pending} data-testid="pdf-map-unpair" onClick={() => setConfirming(true)}>
            Un-pair them
          </button>
        )}
      </div>
      {unpair && confirming && (
        <div className={styles.manage} data-testid="pdf-map-unpair-confirm">
          <p className={styles.manageWarning}>
            They become a question again, and their sheets are unmapped until someone pairs them. A link written against version {unpair.baseNumber} to these
            sheets is then carried to version {unpair.number} only where its words are found.{" "}
            {unpair.carried === 0
              ? "No carry has moved a note or a link part through them."
              : `${unpair.carried === 1 ? "1 note or link part a carry moved" : `${unpair.carried} notes and link parts a carry moved`} through them ${unpair.carried === 1 ? "stays" : "stay"} where ${unpair.carried === 1 ? "it was" : "they were"} moved.`}
          </p>
          <div className={styles.manageRow}>
            <button
              type="button"
              className={styles.manageButton}
              disabled={pending}
              data-testid="pdf-map-unpair-yes"
              onClick={() => act(() => unpairVersionMapRun(versionId, unpair.index))}
            >
              {pending ? "Un-pairing…" : "Un-pair them"}
            </button>
            <button type="button" className={styles.manageButton} disabled={pending} onClick={() => setConfirming(false)}>
              Keep them paired
            </button>
          </div>
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
