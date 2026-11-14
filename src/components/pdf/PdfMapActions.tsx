"use client";

import { useState, useTransition } from "react";
import { answerVersionMapRun, buildVersionMap, type VersionActionResult } from "@/app/actions/files";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "Matching the pages" — the acts on a version's map page:
// asking for the map, and accepting or declining one run of its sheets.
// Each is a manager's (`canUserManageFile`, asked by the action), and each
// reloads the page on success, which is a plain server page.
//
// A refusal comes back as an answer and is shown, as a version's other acts
// show theirs: a production build hides a thrown error's message.

type Props = {
  versionId: string;
  /** Offer to build the map: the version has none. */
  build?: boolean;
  /** Offer an answer to this run, which nobody has accepted. */
  run?: { index: number; declined: boolean };
};

export default function PdfMapActions({ versionId, build, run }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

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
              Accept: pair them as proposed
            </button>
            {!run.declined && (
              <button
                type="button"
                className={styles.manageButton}
                disabled={pending}
                data-testid="pdf-map-decline"
                onClick={() => act(() => answerVersionMapRun(versionId, run.index, false))}
              >
                Decline: leave them unmapped
              </button>
            )}
          </>
        )}
      </div>
      {error && (
        <p className={styles.manageError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
