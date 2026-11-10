import { IconDownload } from "@tabler/icons-react";
import { downloadHref, EXPORT_FORMAT_ORDER, EXPORT_FORMATS } from "@/lib/references/export-formats";
import styles from "./Bibliography.module.css";

// docs/CITATIONS.md, "Downloads", "Where the links are" — a download icon
// beside a References heading, opening a menu of the four formats. A
// `<details>`, so it works in a static first paint, and every link a plain
// one with `rel="nofollow"`, so a crawler reading a public page doesn't
// fetch four files for each work on it. No "use client": the reading view
// renders it on the server.

/**
 * `floated` draws it before a post's References heading, floated to the
 * heading's line, as the read-only editor's widget draws it
 * (src/lib/post-references-download.ts).
 */
export default function DownloadMenu({ selection, label = "Download these references", floated = false }: { selection: string; label?: string; floated?: boolean }) {
  return (
    <details className={`${styles.download} ${floated ? styles.floated : ""}`}>
      <summary aria-label={label} title={label}>
        <IconDownload size={16} aria-hidden="true" />
      </summary>
      <ul className={styles.downloadMenu}>
        {EXPORT_FORMAT_ORDER.map((format) => (
          <li key={format}>
            <a href={downloadHref(format, selection)} rel="nofollow">
              {EXPORT_FORMATS[format].label}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
