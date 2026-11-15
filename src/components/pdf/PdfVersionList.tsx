import Link from "next/link";
import LocalTime from "@/components/LocalTime";
import { formatBytes } from "@/lib/file-format";
import { filesPath, pdfPath, type FileVersionState } from "@/lib/file-version";
import type { FileVersionSummary } from "@/lib/file-version-data";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "Addresses", and §14, "What the viewer keeps" — the
// file's versions in the Metadata pane as every reader sees them, newest
// first: each with its state, who uploaded it and when, who promoted it and
// when, a link to its own page and one to its download. Shown once a file
// has a second version, to a manager as to any reader.
//
// What a manager does with versions (the upload, a promotion, a carry, a
// page map) is on the file's manage page, which the pane links at its top.
//
// **A waiting version is pinned above the list, for every reader**
// (§14, "What the viewer keeps"): which version waits to replace which,
// whether its pages are matched with the latest's, who uploaded it and when,
// and a link to its page. It names both versions by number, since the pane is
// on every version's page and says the same on each, and it says the fact
// and never the kind of upload, which is stored nowhere. A manager also gets
// the count of its page map's open questions and a link to the manage page.
// The waiting version's own page pins nothing: its banner says as much.
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

type Props = {
  slug: string;
  versions: FileVersionSummary[];
  shownId: string;
  /** The file's manage page, for whoever may manage it; null for every other reader. */
  manageHref: string | null;
};

export default function PdfVersionList({ slug, versions, shownId, manageHref }: Props) {
  const waiting = versions.find((version) => version.state === "candidate");
  const latest = versions.find((version) => version.state === "latest");
  return (
    <section className={styles.versions} data-testid="pdf-version-list">
      <h3>Versions</h3>
      {waiting && latest && waiting.id !== shownId && <WaitingVersion slug={slug} waiting={waiting} latest={latest} manageHref={manageHref} />}
      <ol>
        {[...versions].reverse().map((version) => {
          const ref = { number: version.number, isLatest: version.state === "latest" };
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
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function WaitingVersion({
  slug,
  waiting,
  latest,
  manageHref,
}: {
  slug: string;
  waiting: FileVersionSummary;
  latest: FileVersionSummary;
  manageHref: string | null;
}) {
  // A candidate is uploaded over the latest, and a file has one at a time, so
  // the version its map is from is the latest (docs/PDF.md §13, "Versions").
  // Named from the latest here, since a reader is not sent `baseNumber`.
  const open = waiting.map?.openRuns ?? null;
  return (
    <div className={styles.waiting} data-testid="pdf-version-waiting">
      <p>
        <strong>
          Version {waiting.number} is waiting to replace version {latest.number}.
        </strong>
      </p>
      <p data-testid="pdf-version-waiting-matched">
        {waiting.hasMap ? `Its pages are matched with version ${latest.number}'s.` : `Its pages are not matched with version ${latest.number}'s.`}
      </p>
      <p className={styles.versionFacts}>
        Uploaded <LocalTime value={waiting.uploadedAt} />
        {waiting.uploadedBy && ` by ${waiting.uploadedBy}`}.{" "}
        <Link href={pdfPath(slug, { number: waiting.number, isLatest: false }, { own: true })}>See version {waiting.number}</Link>
      </p>
      {manageHref && (
        <p data-testid="pdf-version-waiting-manage">
          {open !== null && `${openQuestions(open)} `}
          <Link href={manageHref}>Review and promote it</Link> on the file&apos;s manage page.
        </p>
      )}
    </div>
  );
}

function openQuestions(count: number): string {
  if (count === 0) return "Its page map has no open questions.";
  return count === 1 ? "1 question about its pages is still open." : `${count} questions about its pages are still open.`;
}
