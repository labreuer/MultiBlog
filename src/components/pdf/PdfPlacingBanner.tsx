"use client";

import type { WorklistItem } from "@/lib/file-note-move";
import { worklistKindWords } from "@/lib/file-note-words";
import styles from "./PdfVersions.module.css";

// docs/PDF.md §13, "Moving a note forward" — shown over the document while a
// note of the viewer's worklist is being placed by hand: which note it is,
// and what to do. The worklist's own line says the same, but it is in the
// Annotations pane, which below the breakpoint lies over the document and is
// closed to make the selection.

const QUOTE_SHOWN = 80;

export default function PdfPlacingBanner({ item, versionNumber, onCancel, className }: { item: WorklistItem; versionNumber: number; onCancel: () => void; className?: string }) {
  const quote = item.quotedText.length > QUOTE_SHOWN ? `${item.quotedText.slice(0, QUOTE_SHOWN).trimEnd()}…` : item.quotedText;
  return (
    <aside className={`${styles.banner} ${className ?? ""}`} data-testid="pdf-placing-banner">
      <div className={styles.bannerText}>
        <p>
          Placing on version {versionNumber}: {worklistKindWords(item.what, item.kind === "link-part" ? item.text : "").toLowerCase()} from version {item.versionNumber}
          {quote && <>, “{quote}”</>}.
        </p>
        <p>Select its passage in the document, then choose “Move the note here”.</p>
      </div>
      <button type="button" className={styles.manageButton} onClick={onCancel}>
        Cancel
      </button>
    </aside>
  );
}
