"use client";

import Link from "next/link";
import { useState } from "react";
import LocalTime from "@/components/LocalTime";
import { elapsedInLargestUnit, pdfPath, type ShownVersion } from "@/lib/file-version";
import type { FileVersionSummary } from "@/lib/file-version-data";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "Addresses" — the page of a version that is not the latest
// says so: which version it is, when it and the latest were uploaded, the time
// between them, and a link to the latest. An earlier version's also says
// where a note made on it is, and the two things its author can do with it
// (§13, "Moving a note forward"). A candidate's says it is not yet the
// latest. The latest's own page has none; its title names its version.
//
// **A candidate's banner links whoever may manage the file to its manage
// page** (§14, "What the viewer keeps"), where it is promoted or abandoned:
// every act on a version is made there, and this page is where the
// candidate is looked at first.
//
// A plain `<Link>` to the latest: the surface is keyed on the version, so the
// navigation mounts a new one and nothing of this version's viewer is left on
// that page.

type Props = {
  slug: string;
  version: ShownVersion;
  versions: FileVersionSummary[];
  /** The file's manage page, for whoever may manage it; null for every other reader. */
  manageHref: string | null;
  className?: string;
};

export default function PdfVersionBanner({ slug, version, versions, manageHref, className }: Props) {
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
        {version.state === "earlier" && (
          <p>
            {`A note made here is on version ${shown.number} until it is moved to version ${latest.number}: by its author, from that version's page, or by a manager's carry of the notes that place themselves there. Its author can mark it here as staying.`}
          </p>
        )}
        {version.state === "candidate" && <p>It takes no notes and no link parts until it is.</p>}
        {version.state === "candidate" && manageHref && (
          <p data-testid="pdf-version-banner-manage">
            <Link href={manageHref}>Promote or abandon it</Link> on the file&apos;s manage page, which says what a promotion would do.
          </p>
        )}
      </div>
      <button type="button" className={styles.dismiss} onClick={() => setDismissed(true)} aria-label="Dismiss the version notice">
        ✕
      </button>
    </aside>
  );
}
