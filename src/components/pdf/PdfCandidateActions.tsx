"use client";

import { useEffect, useState, useTransition } from "react";
import { abandonVersion, buildVersionMap, previewPromotionCarry, promoteVersion, type CarryAnswer, type VersionActionResult } from "@/app/actions/files";
import type { CarryPreview } from "@/lib/file-anchor-move";
import { carryPreviewWords } from "@/lib/file-carry-words";
import type { CandidateFacts } from "@/lib/file-version-candidate";
import { pdfMapPath } from "@/lib/file-version";
import type { PageMapNumbers } from "@/lib/pdf-page-map";
import { keepCarryOutcome } from "./PdfCarryActions";
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
// **The page map, where it has one, in numbers** (§13, "Matching the
// pages"): sheets paired, removed and unmapped, and the runs of sheets with a
// question open, with a link to where they are answered. Without one this
// offers to build it, and says what storing one means: that the two versions
// hold the same text, so links written against either are carried to the
// other from then on.
//
// **Where it has a map, what a promotion with the carry would move** (§13,
// "Moving a note forward"), asked for once the component mounts, since
// working it out reads both versions' sheets: how many notes and link parts
// would move to this version, and how many would stay for their authors.
// The promotion is then offered both ways. With the carry it answers what
// it did, which is kept for the page the reload brings (`keepCarryOutcome`):
// the action's own revalidation takes this component away with the
// candidate it was about.
//
// Promoting without the carry moves no note. Every note stays on the version
// it is on, listed on the latest's page under that version. A link written
// against the outgoing version is carried to this one where it has a map,
// and opens the version it names where it has none.

type Props = {
  slug: string;
  versionId: string;
  number: number;
  /** The number of the version `/pdf/<slug>` shows now. */
  latestNumber: number;
  /** The candidate's page map in numbers; null where it has none. */
  map: PageMapNumbers | null;
  facts: CandidateFacts | null;
};

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// One asking per candidate for as long as the page is open: the banner and
// the version list each mount this for the same version, and every act that
// could change the answer reloads the page.
const previews = new Map<string, Promise<CarryAnswer<CarryPreview | null>>>();

function previewFor(versionId: string): Promise<CarryAnswer<CarryPreview | null>> {
  let asked = previews.get(versionId);
  if (!asked) {
    asked = previewPromotionCarry(versionId).catch((): CarryAnswer<CarryPreview | null> => ({ ok: false, error: "What a carry would move couldn't be worked out." }));
    previews.set(versionId, asked);
  }
  return asked;
}

export default function PdfCandidateActions({ slug, versionId, number, latestNumber, map, facts }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmingAbandon, setConfirmingAbandon] = useState(false);
  const [carry, setCarry] = useState<CarryAnswer<CarryPreview | null> | null>(null);
  const mapped = map !== null;

  useEffect(() => {
    if (!mapped) return;
    let current = true;
    void previewFor(versionId).then((answer) => {
      if (current) setCarry(answer);
    });
    return () => {
      current = false;
    };
  }, [versionId, mapped]);

  const run = (act: (id: string) => Promise<VersionActionResult>) => {
    setError(null);
    startTransition(async () => {
      const result = await act(versionId).catch((): VersionActionResult => ({ ok: false, error: "That didn't work. Reload the page and try again." }));
      if (result.ok) {
        if (result.carried) keepCarryOutcome(result.carried);
        window.location.reload();
        return;
      }
      setError(result.error);
    });
  };

  const wouldCarry = carry?.ok && carry.value ? carry.value : null;
  const carries = wouldCarry !== null && wouldCarry.notes + wouldCarry.parts > 0;

  return (
    <div className={styles.manage} data-testid="pdf-candidate-actions">
      {map ? (
        <p className={styles.versionFacts} data-testid="pdf-candidate-map">
          Its pages are matched with version {latestNumber}&apos;s: {count(map.paired, "sheet", "sheets")} paired, {map.removed} removed and {map.unmapped} unmapped.{" "}
          {map.openRuns > 0 && <>{count(map.openRuns, "question about a run of sheets is", "questions about runs of sheets are")} open. </>}
          <a href={pdfMapPath(slug, number)}>{map.openRuns > 0 ? "Answer on the page map" : "See the page map"}</a>
        </p>
      ) : (
        <p className={styles.versionFacts} data-testid="pdf-candidate-no-map">
          Its pages are not matched with version {latestNumber}&apos;s. Matching them says the two versions hold the same text: a link written against either is
          then carried to the other, and notes can be carried forward.{" "}
          <button type="button" className={styles.manageButton} disabled={pending} data-testid="pdf-candidate-build-map" onClick={() => run(buildVersionMap)}>
            Match its pages
          </button>
        </p>
      )}
      <p className={styles.versionFacts}>
        Promoting makes version {number} the one this file&apos;s address shows.{" "}
        {map
          ? `With the carry, the notes that place themselves on version ${number} move to it. Every other note stays on the version it is on, where it is still drawn and listed.`
          : `Notes stay on version ${latestNumber}, where they are still drawn and listed.`}{" "}
        {map
          ? `A link written against version ${latestNumber} is carried to version ${number}.`
          : `A link written against version ${latestNumber} still opens it.`}
      </p>
      {map && (
        <div className={styles.versionFacts} data-testid="pdf-candidate-carry" data-carry-state={carry === null ? "working" : carry.ok ? "ready" : "failed"}>
          {carry === null && <p>Working out what a carry would move…</p>}
          {carry !== null && !carry.ok && <p>{carry.error}</p>}
          {wouldCarry && carryPreviewWords(wouldCarry).map((line) => <p key={line}>{line}</p>)}
        </div>
      )}
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
        {carries && (
          <button type="button" className={styles.manageButton} disabled={pending} data-testid="pdf-candidate-promote-carry" onClick={() => run((id) => promoteVersion(id, true))}>
            Promote with the carry
          </button>
        )}
        <button type="button" className={styles.manageButton} disabled={pending} onClick={() => run((id) => promoteVersion(id))}>
          {carries ? `Promote version ${number} without it` : `Promote version ${number}`}
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
