"use client";

import Link from "next/link";
import { useState } from "react";
import { pdfPath } from "@/lib/file-version";
import { formatFragmentPassages } from "@/lib/pdf-fragment";
import { stampOfRead, type LinkAddress, type PageReading } from "@/lib/pdf-link-reading";
import { formatPageName, type PageName } from "@/lib/pdf-open-params";
import { pageLabelFor } from "@/lib/pdf-page-labels";
import type { PdfTarget } from "@/lib/pdf-anchor";
import type { FragmentRegion, PdfFragment } from "./use-pdf-fragment";
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
//
// **A passage of another version says so** (docs/PDF.md §13, "Links into the
// file"). On a version's own address the viewer stays, since the address
// chose the version: a passage that names another version, which no page map
// brings here, is offered at that version's address. One that names an
// abandoned version, or a version the file never had, has no version to open
// instead: it was looked for by its words alone, and its row says that it was
// found that way, or that it wasn't found. A link without words gets one
// line saying the same of its page.

type Props = {
  regions: FragmentRegion[];
  /** A link without words whose page is not one of the version shown. */
  page: PdfFragment["page"];
  slug: string;
  /** The number of the version shown. */
  shownVersion: number;
  address: LinkAddress;
  /** How many versions the file has, for the stamp a link offered elsewhere carries. */
  versionCount: number;
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

/** Why a page has no version to be read on, as a row's lead-in says it. */
function goneVersion(reading: PageReading): string {
  return reading.kind === "abandoned" ? `Version ${reading.version} was abandoned and its sheets were never matched` : `This file has no version ${reading.version}`;
}

/** A version's own address, as a link elsewhere names it. */
function versionPath(slug: string, version: number): string {
  return pdfPath(slug, { number: version, isLatest: false }, { own: true });
}

const quiet = { color: "var(--text-secondary)" } as const;

export default function PdfFragmentBanner({ regions, page, slug, shownVersion, address, versionCount, pageLabels, onJumpToTarget, onJumpToPage, className }: Props) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || (regions.length === 0 && page === null)) return null;

  const stamped = (named: PageName) => ({ ...named, stamp: stampOfRead(named, address, versionCount) });

  return (
    <aside className={`${styles.banner} ${className ?? ""}`} data-testid="pdf-fragment-banner">
      <div className={styles.headerRow}>
        <span className={styles.title}>{regions.length > 1 ? "Linked passages" : regions.length === 1 ? "Linked passage" : "Linked page"}</span>
        <button
          type="button"
          className={styles.dismiss}
          onClick={() => setDismissed(true)}
          aria-label="Dismiss linked passages"
        >
          ✕
        </button>
      </div>
      {page && (
        <p data-testid="pdf-fragment-version-note" style={{ ...quiet, padding: "0.1rem 0" }}>
          {page.reading.kind === "elsewhere" ? (
            <>
              This link names version {page.reading.version}, and couldn&apos;t be brought to version {shownVersion}.{" "}
              <Link href={`${versionPath(slug, page.reading.version)}#${formatPageName(stamped(page.page))}`}>Open it on version {page.reading.version}</Link>
            </>
          ) : page.reading.kind === "abandoned" ? (
            <>{goneVersion(page.reading)}, so this link opens no sheet.</>
          ) : (
            <>{goneVersion(page.reading)}. The sheet is opened as the link wrote it.</>
          )}
        </p>
      )}
      <ul className={styles.partList}>
        {regions.map((region) => {
          const missAt = missPage(region);
          const { reading } = region;
          if (reading.kind === "elsewhere") {
            return (
              <li key={region.id} data-testid="pdf-fragment-other-version">
                <span style={quiet}>
                  On version {reading.version}, and couldn&apos;t be brought to version {shownVersion}.{" "}
                </span>
                <Link href={`${versionPath(slug, reading.version)}#${formatFragmentPassages([{ ...region.passage, page: stamped(region.passage.page) }])}`}>
                  Open it on version {reading.version}
                </Link>
              </li>
            );
          }
          if (reading.kind !== "here") {
            return (
              <li key={region.id}>
                {region.target ? (
                  <button type="button" className={styles.partButton} onClick={() => onJumpToTarget(region.target!)} title="Jump to this passage">
                    <span data-testid="pdf-fragment-words-alone">
                      {goneVersion(reading)}; found by its words alone, on page {pageLabelFor(pageLabels, region.target.pageIndex)}:{" "}
                    </span>
                    <span className={styles.partQuote}>{region.target.quote.exact}</span>
                  </button>
                ) : (
                  <span data-testid="pdf-fragment-miss" style={{ display: "block", padding: "0.1rem 0", ...quiet }}>
                    {goneVersion(reading)}, and its words aren&apos;t on exactly one page here
                  </span>
                )}
              </li>
            );
          }
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
                  <span style={quiet}>Not found on page {namedPage(region, pageLabels)}</span>
                </button>
              ) : (
                <span data-testid="pdf-fragment-miss" style={{ display: "block", padding: "0.1rem 0", ...quiet }}>
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
