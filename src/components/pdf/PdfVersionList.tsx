import Link from "next/link";
import LocalTime from "@/components/LocalTime";
import { formatBytes } from "@/lib/file-format";
import { filesPath, pdfPath, type FileVersionState } from "@/lib/file-version";
import type { FileVersionSummary } from "@/lib/file-version-data";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "Addresses" — the file's versions in the Metadata pane,
// newest first: each with its state, who uploaded it and when, who promoted
// it and when, a link to its own page and one to its download. Shown once a
// file has a second version.
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

export default function PdfVersionList({ slug, versions, shownId }: { slug: string; versions: FileVersionSummary[]; shownId: string }) {
  return (
    <section className={styles.versions} data-testid="pdf-version-list">
      <h3>Versions</h3>
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
