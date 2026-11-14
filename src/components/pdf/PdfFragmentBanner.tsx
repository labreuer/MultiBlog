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
// showing what it asked for. One found on a page the link doesn't name (§6)
// names both pages.
//
// **Every page is named by its label**, as the rest of the viewer names it
// (`pageLabelFor`), whichever form the link used: a `sheet=53` miss reads "Not
// found on page 49" where sheet 53 is labelled 49. The one exception is a
// `p=` whose label no sheet carries, named as the link wrote it.

type Props = {
  regions: FragmentRegion[];
  pageLabels: string[] | null;
  onJumpToTarget: (target: PdfTarget) => void;
  onJumpToPage: (pageIndex: number) => void;
  className?: string;
};

/** The page a passage's link names, as the banner names it. */
function namedPage(region: FragmentRegion, pageLabels: string[] | null): string {
  const page = region.passage.page;
  if ("sheet" in page) return pageLabelFor(pageLabels, page.sheet - 1);
  return region.named.length > 0 ? pageLabelFor(pageLabels, region.named[0]) : page.label;
}

/** Where a miss's row goes: the first sheet the link names, or a sheet past the end clamped by the jump; null for a label no sheet carries. */
function missPage(region: FragmentRegion): number | null {
  const page = region.passage.page;
  return "sheet" in page ? page.sheet - 1 : (region.named[0] ?? null);
}

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
        {regions.map((region) => {
          const missAt = missPage(region);
          return (
            <li key={region.id}>
              {region.target ? (
                <button
                  type="button"
                  className={styles.partButton}
                  onClick={() => onJumpToTarget(region.target!)}
                  title="Jump to this passage"
                >
                  {region.elsewhere && (
                    // Before the quote, which the row clamps, so both pages stay in view.
                    <span data-testid="pdf-fragment-elsewhere">
                      On page {pageLabelFor(pageLabels, region.target.pageIndex)}, not {namedPage(region, pageLabels)}:{" "}
                    </span>
                  )}
                  <span className={styles.partQuote}>{region.target.quote.exact}</span>
                </button>
              ) : missAt !== null ? (
                <button
                  type="button"
                  className={styles.partButton}
                  onClick={() => onJumpToPage(missAt)}
                  title="Go to the page this passage names"
                  data-testid="pdf-fragment-miss"
                >
                  <span style={{ color: "var(--text-secondary)" }}>Not found on page {namedPage(region, pageLabels)}</span>
                </button>
              ) : (
                <span
                  data-testid="pdf-fragment-miss"
                  style={{ display: "block", padding: "0.1rem 0", color: "var(--text-secondary)" }}
                >
                  Not found on page {namedPage(region, pageLabels)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
