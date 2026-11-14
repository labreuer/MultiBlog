"use client";

import { useState, useTransition } from "react";
import { abandonVersion, promoteVersion, type VersionActionResult } from "@/app/actions/files";
import type { CandidateFacts } from "@/lib/file-version-candidate";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "The upload" — what a candidate shows whoever may manage
// the file: what a promotion would do to the citations of the file, and the
// two acts that end its waiting.
//
// **Each act names the version**, never "the candidate": a manager's click
// can't land on a version another manager uploaded since (`promoteFileVersion`
// checks it is still the file's candidate, under the file row's lock).
//
// **A success reloads the page in full.** The viewer is behind `ssr: false`,
// where a `router.refresh()` alone is lost (CLAUDE.md), and after either act
// the address this page is on means something else: the latest's own page,
// or the page of an abandoned version.
//
// Promoting moves no note and carries no link: nothing has a page map yet, so
// every note stays on the version it is on, listed on the latest's page under
// that version, and every link opens the version it names.

type Props = {
  versionId: string;
  number: number;
  /** The number of the version `/pdf/<slug>` shows now. */
  latestNumber: number;
  facts: CandidateFacts | null;
};

export default function PdfCandidateActions({ versionId, number, latestNumber, facts }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmingAbandon, setConfirmingAbandon] = useState(false);

  const run = (act: (id: string) => Promise<VersionActionResult>) => {
    setError(null);
    startTransition(async () => {
      const result = await act(versionId).catch((): VersionActionResult => ({ ok: false, error: "That didn't work. Reload the page and try again." }));
      if (result.ok) {
        window.location.reload();
        return;
      }
      setError(result.error);
    });
  };

  return (
    <div className={styles.manage} data-testid="pdf-candidate-actions">
      <p className={styles.versionFacts}>
        Promoting makes version {number} the one this file&apos;s address shows. Notes stay on version {latestNumber}, where they are still drawn and listed, and a link
        written against version {latestNumber} still opens it.
      </p>
      {facts?.unlabelled && (
        <p className={styles.manageWarning} data-testid="pdf-candidate-unlabelled">
          Version {number} has no page labels, so every citation of this file will take its page as a sheet number of version {number}. A scan is better given
          its page labels before it is uploaded.
        </p>
      )}
      {facts && facts.pagedCitations !== null && facts.pagedCitations > 0 && (
        <p className={styles.manageWarning} data-testid="pdf-candidate-citations">
          {facts.pagedCitations === 1 ? "1 citation names" : `${facts.pagedCitations} citations name`} a page of this file, in what you can read, and{" "}
          {facts.unlabelled ? "this version has" : `version ${latestNumber} has`} no page labels to find it by. If the sheets have moved, those citations will
          open the wrong page.
        </p>
      )}
      <div className={styles.manageRow}>
        <button type="button" className={styles.manageButton} disabled={pending} onClick={() => run(promoteVersion)}>
          Promote version {number}
        </button>
        {confirmingAbandon ? (
          <>
            <button type="button" className={styles.manageButton} disabled={pending} onClick={() => run(abandonVersion)}>
              Abandon it for good
            </button>
            <button type="button" className={styles.manageButton} disabled={pending} onClick={() => setConfirmingAbandon(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className={styles.manageButton} disabled={pending} onClick={() => setConfirmingAbandon(true)}>
            Abandon version {number}
          </button>
        )}
      </div>
      {confirmingAbandon && <p className={styles.versionFacts}>Abandoning removes this version&apos;s bytes and page text. Its number is not used again.</p>}
      {error && (
        <p className={styles.manageError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
