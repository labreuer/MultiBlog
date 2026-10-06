"use client";

import { useState } from "react";
import { pageLabelFor } from "@/lib/pdf-page-labels";
import type { PdfTarget } from "@/lib/pdf-anchor";
import type { FragmentRegion } from "./use-pdf-fragment";
import styles from "@/components/anchored-link/AnchoredLinkBanner.module.css";

// docs/PDF_FRAGMENT_LINKS.md §6 — what a fragment link's arrival shows: its
// passages as jump handles, the sibling of AnchoredLinkBanner on the same
// stylesheet. A sibling rather than a mode of that one, because nearly all of
// it is about a row a fragment link doesn't have: a name, an Edit button, the
// excerpt page, the other targets.
//
// **Each row shows the PDF's words at the match, never the URL's.** A
// fragment is whatever text its writer put in the address bar; echoing it
// would let a crafted link present arbitrary words as a quotation from this
// file. A passage that isn't found says so, with its page, rather than
// showing what it asked for.

type Props = {
  regions: FragmentRegion[];
  pageLabels: string[] | null;
  onJumpToTarget: (target: PdfTarget) => void;
  onJumpToPage: (pageIndex: number) => void;
  className?: string;
};

export default function PdfFragmentBanner({ regions, pageLabels, onJumpToTarget, onJumpToPage, className }: Props) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || regions.length === 0) return null;

  return (
    <aside className={`${styles.banner} ${className ?? ""}`} data-testid="pdf-fragment-banner">
      <div className={styles.headerRow}>
        <span className={styles.title}>{regions.length === 1 ? "Linked passage" : "Linked passages"}</span>
        <button
          type="button"
          className={styles.dismiss}
          onClick={() => setDismissed(true)}
          aria-label="Dismiss linked passages"
        >
          ✕
        </button>
      </div>
      <ul className={styles.partList}>
        {regions.map((region) => (
          <li key={region.id}>
            {region.target ? (
              <button
                type="button"
                className={styles.partButton}
                onClick={() => onJumpToTarget(region.target!)}
                title="Jump to this passage"
              >
                <span className={styles.partQuote}>{region.target.quote.exact}</span>
              </button>
            ) : (
              <button
                type="button"
                className={styles.partButton}
                onClick={() => onJumpToPage(region.passage.page - 1)}
                title="Go to the page this passage names"
                data-testid="pdf-fragment-miss"
              >
                <span style={{ color: "var(--text-secondary)" }}>
                  Not found on page {pageLabelFor(pageLabels, region.passage.page - 1)}
                </span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
