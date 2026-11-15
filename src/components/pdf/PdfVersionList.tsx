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
};

export default function PdfVersionList({ slug, versions, shownId }: Props) {
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
