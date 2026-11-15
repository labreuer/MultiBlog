"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import LocalTime from "@/components/LocalTime";
import PdfCandidateActions from "@/components/pdf/PdfCandidateActions";
import PdfCarryActions, { PdfCarryRecord } from "@/components/pdf/PdfCarryActions";
import PdfPageMapList from "@/components/pdf/PdfPageMapList";
import PdfVersionUploader, { useVersionsDropZone, type VersionKind } from "@/components/pdf/PdfVersionUploader";
import versionStyles from "@/components/pdf/PdfVersions.module.css";
import type { CarryResult } from "@/lib/file-anchor-move";
import { carryResultWords } from "@/lib/file-carry-words";
import { formatBytes } from "@/lib/file-format";
import { filesPath, pdfMapPath, pdfPath, type FileVersionState } from "@/lib/file-version";
import { requestVersionMap } from "@/lib/file-version-requests";
import type { ManagedVersions } from "./versions-data";
import styles from "./page.module.css";

// docs/PDF.md §14, "What the page holds", item 6 — a file's versions on its
// manage page, newest first: each with its state, who uploaded and promoted
// it and when, its page in the viewer and its download; the upload of a new
// version; a waiting version's card, with its page map sheet by sheet under
// it; the notes and link parts still on each earlier version with the carry
// that moves them; each carry's moves shown or hidden; and each version's
// page map. A file of any other format has its one version and its download.
//
// **This component is keyed on the file and stays mounted across every
// refresh**, so what outlives one is held here, never by a card a refresh
// takes away:
//
// - **what a promotion's carry did.** The promotion's own refresh removes the
//   candidate's card with the candidate it was about;
// - **that a map build is running**, which the upload box starts and the
//   candidate's card reports. The build is a Route Handler's, so it runs
//   beside the page's other saves (§14, item 6), and the page refreshes
//   itself when it answers. Nothing stored says a build is running, so a
//   page opened meanwhile offers the button again.
//
// On a deleted file the section is drawn disabled (the page's fieldset), and
// nothing in it links to the file by its slug.

const STATE_LABEL: Record<FileVersionState, string> = {
  latest: "the latest",
  earlier: "an earlier version",
  candidate: "waiting, not yet the latest",
  abandoned: "abandoned",
};

/** "2 posted notes and 1 link part are", or either alone. */
function stillHere(notes: number, parts: number): string {
  const said = [notes > 0 ? `${notes} posted ${notes === 1 ? "note" : "notes"}` : null, parts > 0 ? `${parts} link ${parts === 1 ? "part" : "parts"}` : null].filter(
    (part) => part !== null,
  );
  return `${said.join(" and ")} ${notes + parts === 1 ? "is" : "are"}`;
}

type Props = {
  fileId: string;
  slug: string;
  isPdf: boolean;
  deleted: boolean;
  managed: ManagedVersions;
};

export default function FileVersionsSection({ fileId, slug, isPdf, deleted, managed }: Props) {
  const router = useRouter();
  const zone = useVersionsDropZone();
  const [outcome, setOutcome] = useState<CarryResult | null>(null);
  const [building, setBuilding] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<{ versionId: string; error: string } | null>(null);
  const { versions } = managed;
  const latest = versions.find((version) => version.state === "latest");
  const waiting = versions.find((version) => version.state === "candidate");
  // A link by the slug only on a live file: `/pdf/<slug>` of a deleted one is a 404, or another file's.
  const link = (href: string, text: ReactNode) => (deleted ? <span>{text}</span> : <a href={href}>{text}</a>);

  const build = (versionId: string) => {
    setBuilding(versionId);
    setBuildError(null);
    void requestVersionMap(versionId).then((answer) => {
      setBuilding((now) => (now === versionId ? null : now));
      if (!answer.ok) setBuildError({ versionId, error: answer.error });
      router.refresh();
    });
  };

  const uploaded = (versionId: string, kind: VersionKind) => {
    setOutcome(null);
    // The refresh shows the candidate's card; a better copy's map is asked for beside it.
    router.refresh();
    if (kind === "better-copy") build(versionId);
  };

  const refused = deleted
    ? "This file is deleted. Restore it to upload a new version."
    : waiting
      ? `Version ${waiting.number} is waiting. Promote or abandon it before another version is uploaded.`
      : null;

  return (
    <section className={styles.section} aria-labelledby="file-versions" data-testid="file-versions" {...(managed.takesVersions ? zone.handlers : {})}>
      <h2 id="file-versions">Versions</h2>
      {outcome && (
        <aside className={versionStyles.banner} data-testid="pdf-carry-outcome">
          <div className={versionStyles.bannerText}>
            <p>Version {outcome.toNumber} is now the latest.</p>
            {carryResultWords(outcome).map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          <button type="button" className={versionStyles.dismiss} onClick={() => setOutcome(null)} aria-label="Dismiss what the carry did">
            ✕
          </button>
        </aside>
      )}
      {managed.takesVersions && (
        <PdfVersionUploader fileId={fileId} refused={refused} zone={zone} onUploaded={uploaded} />
      )}
      <ol className={styles.versionList} data-testid="pdf-version-list">
        {[...versions].reverse().map((version) => {
          const ref = { number: version.number, isLatest: version.state === "latest" };
          const notes = managed.notesOn[version.id] ?? 0;
          const parts = managed.partsOn[version.id] ?? 0;
          const carries = managed.carries.filter((carry) => carry.toVersionId === version.id);
          return (
            <li key={version.id} data-version={version.number} className={styles.version}>
              <div>
                <strong>Version {version.number}</strong> <span className={styles.muted}>({STATE_LABEL[version.state]})</span>
                {isPdf && <> · {link(pdfPath(slug, ref, { own: true }), version.state === "candidate" ? "look at it" : "read it")}</>}
              </div>
              <div className={versionStyles.versionFacts}>
                Uploaded <LocalTime value={version.uploadedAt} />
                {version.uploadedBy && ` by ${version.uploadedBy}`}
                {version.promotedAt && (
                  <>
                    ; promoted <LocalTime value={version.promotedAt} />
                    {version.promotedBy && ` by ${version.promotedBy}`}
                  </>
                )}
                {version.abandonedAt && (
                  <>
                    ; abandoned <LocalTime value={version.abandonedAt} />
                  </>
                )}
              </div>
              {version.state !== "abandoned" && (
                <div className={versionStyles.versionFacts}>
                  {link(`${filesPath(slug, ref, { own: true })}/download`, version.filename)} ({formatBytes(version.byteSize)})
                </div>
              )}
              {version.state === "earlier" && notes + parts > 0 && (
                <div className={versionStyles.versionFacts} data-testid="pdf-version-notes-left">
                  {stillHere(notes, parts)} still on this version.
                </div>
              )}
              {version.state === "earlier" && notes + parts > 0 && latest && (
                <PdfCarryActions versionId={version.id} number={version.number} latestNumber={latest.number} />
              )}
              {carries.map((carry) => (
                <PdfCarryRecord key={carry.id} carryId={carry.id} moves={carry.moves} shown={carry.shown}>
                  A carry moved {carry.moves === 1 ? "1 note or link part" : `${carry.moves} notes and link parts`} here, <LocalTime value={carry.at} />.
                </PdfCarryRecord>
              ))}
              {version.baseNumber !== null && version.state !== "candidate" && (version.map || version.state !== "abandoned") && (
                <div className={versionStyles.versionFacts} data-testid="pdf-version-map">
                  {version.map ? (
                    <>
                      Its pages are matched with version {version.baseNumber}&apos;s
                      {version.map.openRuns > 0 && ` (${version.map.openRuns} ${version.map.openRuns === 1 ? "question" : "questions"} open)`}.{" "}
                      {link(pdfMapPath(slug, version.number), "Its page map")}
                    </>
                  ) : (
                    <>
                      Its pages are not matched with version {version.baseNumber}&apos;s. {link(pdfMapPath(slug, version.number), "Match them")}
                    </>
                  )}
                </div>
              )}
              {version.state === "candidate" && latest && (
                <>
                  <PdfCandidateActions
                    slug={slug}
                    versionId={version.id}
                    number={version.number}
                    latestNumber={latest.number}
                    map={version.map}
                    mapKey={managed.candidateMapKey}
                    facts={managed.candidateFacts}
                    building={building === version.id}
                    onBuild={() => build(version.id)}
                    onEnded={(carried) => setOutcome(carried)}
                    linked={!deleted}
                  />
                  {buildError?.versionId === version.id && (
                    <p className={versionStyles.manageError} role="alert" data-testid="pdf-candidate-build-error">
                      Its pages couldn&apos;t be matched: {buildError.error}
                    </p>
                  )}
                  {managed.candidateMap && version.baseNumber !== null && (
                    <PdfPageMapList slug={slug} number={version.number} baseNumber={version.baseNumber} versionId={version.id} map={managed.candidateMap} heading="h3" linked={!deleted} />
                  )}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
