"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { abandonVersion, promoteVersion, type VersionActionResult } from "@/app/actions/files";
import type { CarryPreview, CarryResult } from "@/lib/file-anchor-move";
import { carryPreviewWords } from "@/lib/file-carry-words";
import type { CandidateFacts } from "@/lib/file-version-candidate";
import { requestPromotionCarry, type VersionRequestAnswer } from "@/lib/file-version-requests";
import { pdfMapPath } from "@/lib/file-version";
import type { PageMapNumbers } from "@/lib/pdf-page-map";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "The upload", and §14, "What the page holds", item 6 —
// a waiting version's card on its file's manage page: what a promotion would
// do to the citations of the file, and the two acts that end its waiting.
//
// **Each act names the version**, never "the candidate": a manager's click
// can't land on a version another manager uploaded since (`promoteFileVersion`
// checks it is still the file's candidate, under the file row's lock).
//
// **A success refreshes the page**, which is server-rendered behind no
// `ssr: false` boundary, so the refresh delivers the file's versions as they
// now are. A promotion's refresh takes this card away with the candidate it
// was about, so what its carry did is handed to the versions section, which
// stays mounted (`onEnded`).
//
// **The page map, where it has one, in numbers** (§13, "Matching the
// pages"): sheets paired, removed and unmapped, and the runs of sheets with a
// question open. The map itself is drawn under this card, sheet by sheet.
// Without one this offers to build it, and says what storing one means. The
// build is the section's (`onBuild`), which the upload box starts too, and
// it says "Matching its pages…" for as long as its request is open.
//
// **Where it has a map, what a promotion with the carry would move** (§13,
// "Moving a note forward"), asked of a Route Handler, since working it out
// reads both versions' sheets and takes seconds. **It is asked again when
// what it read has changed**: after a build and after an answer to a run,
// which `mapKey` says. The promotion is then offered both ways.
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
  /** Changes whenever the map does: built, or a run of it answered or un-paired. */
  mapKey: string;
  facts: CandidateFacts | null;
  /** Whether this page's request to build the map is open. */
  building: boolean;
  onBuild: () => void;
  /** A promotion or an abandoning worked: what a promotion's carry did, or null. */
  onEnded: (carried: CarryResult | null) => void;
  /** Whether to link the map page: not on a deleted file's page, where `/pdf/<slug>` is a 404 or another file's. */
  linked?: boolean;
};

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// One asking per state of the map for as long as the page is open, so a
// remount (a refresh that keeps the card, Strict Mode's second mount) asks
// nothing new.
const previews = new Map<string, Promise<VersionRequestAnswer<CarryPreview | null>>>();

function previewFor(versionId: string, mapKey: string): Promise<VersionRequestAnswer<CarryPreview | null>> {
  const key = `${versionId}\n${mapKey}`;
  let asked = previews.get(key);
  if (!asked) {
    asked = requestPromotionCarry(versionId);
    previews.set(key, asked);
  }
  return asked;
}

export default function PdfCandidateActions({ slug, versionId, number, latestNumber, map, mapKey, facts, building, onBuild, onEnded, linked = true }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmingAbandon, setConfirmingAbandon] = useState(false);
  // The answer, with the state of the map it was asked about: one about another state is not shown.
  const [carry, setCarry] = useState<{ key: string; answer: VersionRequestAnswer<CarryPreview | null> } | null>(null);
  const mapped = map !== null;

  useEffect(() => {
    if (!mapped) return;
    let current = true;
    void previewFor(versionId, mapKey).then((answer) => {
      if (current) setCarry({ key: mapKey, answer });
    });
    return () => {
      current = false;
    };
  }, [versionId, mapped, mapKey]);

  const run = (act: (id: string) => Promise<VersionActionResult>) => {
    setError(null);
    startTransition(async () => {
      const result = await act(versionId).catch((): VersionActionResult => ({ ok: false, error: "That didn't work. Reload the page and try again." }));
      if (result.ok) {
        onEnded(result.carried ?? null);
        router.refresh();
        return;
      }
      setError(result.error);
    });
  };

  const asked = carry !== null && carry.key === mapKey ? carry.answer : null;
  const wouldCarry = asked?.ok && asked.value ? asked.value : null;
  const carries = wouldCarry !== null && wouldCarry.notes + wouldCarry.parts > 0;

  return (
    <div className={styles.manage} data-testid="pdf-candidate-actions">
      {map ? (
        <p className={styles.versionFacts} data-testid="pdf-candidate-map">
          Its pages are matched with version {latestNumber}&apos;s: {count(map.paired, "sheet", "sheets")} paired, {map.removed} removed and {map.unmapped} unmapped.{" "}
          {map.openRuns > 0 && <>{count(map.openRuns, "question about a run of sheets is", "questions about runs of sheets are")} open, below. </>}
          {linked ? <a href={pdfMapPath(slug, number)}>Its page map</a> : "Its page map is below."}
        </p>
      ) : (
        <p className={styles.versionFacts} data-testid="pdf-candidate-no-map">
          Its pages are not matched with version {latestNumber}&apos;s. Matching them says the two versions hold the same text: a link written against either is
          then carried to the other, and notes can be carried forward.{" "}
          <button type="button" className={styles.manageButton} disabled={pending || building} data-testid="pdf-candidate-build-map" onClick={onBuild}>
            {building ? "Matching its pages…" : "Match its pages"}
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
        <div className={styles.versionFacts} data-testid="pdf-candidate-carry" data-carry-state={asked === null ? "working" : asked.ok ? "ready" : "failed"}>
          {asked === null && <p>Working out what a carry would move…</p>}
          {asked !== null && !asked.ok && <p>{asked.error}</p>}
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
      {building && <p className={styles.versionFacts}>A promotion made while its pages are being matched is one without the carry.</p>}
      {confirmingAbandon && <p className={styles.versionFacts}>Abandoning removes this version&apos;s bytes and page text. Its number is not used again.</p>}
      {error && (
        <p className={styles.manageError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
