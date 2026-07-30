"use client";

import type { DocLinkInput } from "@/lib/doc-link-anchor";
import styles from "./DocLinkChooser.module.css";

type Props = {
  top: number;
  left: number;
  candidates: DocLinkInput[];
  onSelect: (link: DocLinkInput) => void;
  onCancel: () => void;
};

// PLAN.md §14j — offered when a click lands on text covered by more than
// one doc link (and either no group is active, or several of the hits
// belong to the active group). This section's reading of "max 50 chars
// either side": each candidate's own selected text, elided in the middle
// — first 50 characters, "…", last 50 — rather than 50 characters of
// surrounding document context (§14n keeps the two open; swapping is a
// one-line change here).
function elideMiddle(text: string): string {
  if (text.length <= 103) return text;
  return `${text.slice(0, 50)}…${text.slice(-50)}`;
}

export default function DocLinkChooser({ top, left, candidates, onSelect, onCancel }: Props) {
  return (
    <div data-testid="doc-link-chooser" className={styles.chooser} style={{ top, left }}>
      <p className={styles.heading}>Which doc link?</p>
      {candidates.map((link) => (
        <button key={link.id} type="button" className={styles.candidate} onClick={() => onSelect(link)}>
          <span className={styles.swatch} style={{ backgroundColor: link.color }} />
          {link.mark ? elideMiddle(link.mark.text) : "(unanchored)"}
        </button>
      ))}
      <button type="button" className={styles.cancel} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
