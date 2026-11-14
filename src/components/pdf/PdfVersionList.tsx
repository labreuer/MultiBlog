import Link from "next/link";
import LocalTime from "@/components/LocalTime";
import { formatBytes } from "@/lib/file-format";
import { filesPath, pdfMapPath, pdfPath, type FileVersionState } from "@/lib/file-version";
import type { FileVersionSummary, VersionManage } from "@/lib/file-version-data";
import PdfCandidateActions from "./PdfCandidateActions";
import PdfCarryActions, { PdfCarryRecord } from "./PdfCarryActions";
import PdfVersionUploader from "./PdfVersionUploader";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "Addresses" — the file's versions in the Metadata pane,
// newest first: each with its state, who uploaded it and when, who promoted
// it and when, a link to its own page and one to its download. Shown once a
// file has a second version.
//
// **To whoever may manage the file it is also where a version is made and
// ended** (`manage`): the upload of a new one, a waiting version's promotion
// and abandoning, the posted notes and link parts still on each earlier
// version with the bulk carry that moves them forward, each carry that ran
// with its moves shown or hidden together, and each version's page map, with
// the questions it has open and a link to the page where they are answered
// or a map is built. A manager sees the section on a file with one version
// too, since the upload is how it gains a second.
//
// Rendered on the server and handed into the viewer island as part of its
// `metadata` prop (PdfSurfaceClient's header). Versions are in no listing of
// files, since they are not files; this is where a reader finds them.

const STATE_LABEL: Record<FileVersionState, string> = {
  latest: "the latest",
  earlier: "an earlier version",
  candidate: "not yet the latest",
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
  slug: string;
  versions: FileVersionSummary[];
  shownId: string;
  /** What a manager of the file is given; null for every other reader. */
  manage: VersionManage | null;
};

export default function PdfVersionList({ slug, versions, shownId, manage }: Props) {
  const latest = versions.find((version) => version.state === "latest");
  const waiting = versions.some((version) => version.state === "candidate");
  return (
    <section className={styles.versions} data-testid="pdf-version-list">
      <h3>Versions</h3>
      <ol>
        {[...versions].reverse().map((version) => {
          const ref = { number: version.number, isLatest: version.state === "latest" };
          const notes = manage?.notesOn[version.id] ?? 0;
          const parts = manage?.partsOn[version.id] ?? 0;
          const carries = manage?.carries.filter((carry) => carry.toVersionId === version.id) ?? [];
          return (
            <li key={version.id} data-version={version.number}>
              <div>
                {version.id === shownId ? (
                  <strong>Version {version.number}</strong>
                ) : (
                  <Link href={pdfPath(slug, ref, { own: true })}>Version {version.number}</Link>
                )}{" "}
                <span className={styles.state}>({STATE_LABEL[version.state]})</span>
              </div>
              <div className={styles.versionFacts}>
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
                <div className={styles.versionFacts}>
                  <a href={`${filesPath(slug, ref, { own: true })}/download`}>{version.filename}</a> ({formatBytes(version.byteSize)})
                </div>
              )}
              {manage && version.state === "earlier" && notes + parts > 0 && (
                <div className={styles.versionFacts} data-testid="pdf-version-notes-left">
                  {stillHere(notes, parts)} still on this version.
                </div>
              )}
              {manage && version.state === "earlier" && notes + parts > 0 && latest && (
                <PdfCarryActions versionId={version.id} number={version.number} latestNumber={latest.number} />
              )}
              {carries.map((carry) => (
                <PdfCarryRecord key={carry.id} carryId={carry.id} hidden={carry.hidden}>
                  A carry moved {carry.moves === 1 ? "1 note or link part" : `${carry.moves} notes and link parts`} here, <LocalTime value={carry.at} />.
                </PdfCarryRecord>
              ))}
              {manage && version.baseNumber !== null && version.state !== "candidate" && (version.map || version.state !== "abandoned") && (
                <div className={styles.versionFacts} data-testid="pdf-version-map">
                  {version.map ? (
                    <>
                      Pages matched with version {version.baseNumber}&apos;s
                      {version.map.openRuns > 0 && ` (${version.map.openRuns} ${version.map.openRuns === 1 ? "question" : "questions"} open)`}.{" "}
                      <a href={pdfMapPath(slug, version.number)}>Page map</a>
                    </>
                  ) : (
                    <>
                      Pages not matched with version {version.baseNumber}&apos;s. <a href={pdfMapPath(slug, version.number)}>Match them</a>
                    </>
                  )}
                </div>
              )}
              {manage && version.state === "candidate" && latest && (
                <PdfCandidateActions
                  slug={slug}
                  versionId={version.id}
                  number={version.number}
                  latestNumber={latest.number}
                  map={version.map}
                  facts={manage.candidateFacts}
                />
              )}
            </li>
          );
        })}
      </ol>
      {/* One candidate at a time: the upload is offered again once the waiting one is promoted or abandoned. */}
      {manage && manage.takesVersions && !waiting && <PdfVersionUploader fileId={manage.fileId} />}
    </section>
  );
}
