"use client";

import Link from "next/link";
import { useState } from "react";
import LocalTime from "@/components/LocalTime";
import { elapsedInLargestUnit, pdfPath, type ShownVersion } from "@/lib/file-version";
import type { FileVersionSummary, VersionManage } from "@/lib/file-version-data";
import PdfCandidateActions from "./PdfCandidateActions";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "Addresses" — the page of a version that is not the latest
// says so: which version it is, when it and the latest were uploaded, the time
// between them, and a link to the latest. A candidate's says it is not yet
// the latest. The latest's own page has none; its title names its version.
//
// **A candidate's banner also shows whoever may manage the file what a
// promotion would do**, with the two acts that end its waiting
// (`PdfCandidateActions`): the banner is what every reader of the page gets,
// and those are beside it for a manager alone (§13, "The upload").
//
// A plain `<Link>` to the latest: the surface is keyed on the version, so the
// navigation mounts a new one and nothing of this version's viewer is left on
// that page.

type Props = {
  slug: string;
  version: ShownVersion;
  versions: FileVersionSummary[];
  /** What a manager of the file is given; null for every other reader. */
  manage: VersionManage | null;
  className?: string;
};

export default function PdfVersionBanner({ slug, version, versions, manage, className }: Props) {
  const [dismissed, setDismissed] = useState(false);
  if (version.isLatest || dismissed) return null;
  const shown = versions.find((candidate) => candidate.id === version.id);
  const latest = versions.find((candidate) => candidate.state === "latest");
  if (!shown || !latest) return null;
  const between = elapsedInLargestUnit(new Date(latest.uploadedAt).getTime() - new Date(shown.uploadedAt).getTime());
  const latestIsLater = latest.number > shown.number;

  return (
    <aside className={`${styles.banner} ${className ?? ""}`} data-testid="pdf-version-banner">
      <div className={styles.bannerText}>
        <p>
          {version.state === "candidate" ? (
            <>
              This is <strong>version {shown.number}</strong>, uploaded <LocalTime value={shown.uploadedAt} />. It is not yet the latest.
            </>
          ) : (
            <>
              This is <strong>version {shown.number}</strong>, an earlier version, uploaded <LocalTime value={shown.uploadedAt} />.
            </>
          )}
        </p>
        <p>
          The latest is <Link href={pdfPath(slug)}>version {latest.number}</Link>, uploaded <LocalTime value={latest.uploadedAt} />, {between}{" "}
          {latestIsLater ? "later" : "earlier"}.
        </p>
        {version.state === "earlier" && <p>A note made here is on version {shown.number}.</p>}
        {version.state === "candidate" && <p>It takes no notes and no link parts until it is.</p>}
        {version.state === "candidate" && manage && (
          <PdfCandidateActions versionId={shown.id} number={shown.number} latestNumber={latest.number} facts={manage.candidateFacts} />
        )}
      </div>
      <button type="button" className={styles.dismiss} onClick={() => setDismissed(true)} aria-label="Dismiss the version notice">
        ✕
      </button>
    </aside>
  );
}
