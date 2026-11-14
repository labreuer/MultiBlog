"use client";

import { useState } from "react";
import { pageStampFor, pdfPath } from "@/lib/file-version";
import { formatFragmentPassages } from "@/lib/pdf-fragment";
import { carriedElsewhere, stampOfRead, type LinkAddress, type PageReading } from "@/lib/pdf-link-reading";
import { formatPageName, type PageName } from "@/lib/pdf-open-params";
import { pageLabelFor, pageNameForSheet } from "@/lib/pdf-page-labels";
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
//
// **A passage that was carried here says so only where that changed what it
// opens**: how it was read ("read as version 1: its sheet 50 is sheet 49
// here"), with the link as it is now, to copy. One carried to the sheet it
// would open anyway says nothing, which after a corrected scan is nearly
// every link into the file. A link without `v=` on the bare address is the
// one the reading can get wrong, since a hand that typed it meant the
// latest: its row also offers that reading. Words that aren't where the link
// was carried are reported as any miss is, and where the version the link
// names holds them, the row offers the passage there.
//
// **The offer is a plain `<a>`, never a `<Link>`**: a client navigation that
// carries a fragment leaves it on the path it reached, for every later client
// navigation there (PdfSurfaceClient's header has the mechanism), and this
// one carries `#sheet=…`.

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
  /** The labels the document itself gives, and its sheets: what says whether a carried page opens another sheet than it would have. */
  ownPageLabels: string[] | null;
  pageCount: number;
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

/** A page as its link wrote it: "sheet 50", or "page 49" for a printed one. */
function writtenPage(page: PageName): string {
  return "sheet" in page ? `sheet ${page.sheet}` : `page ${page.label}`;
}

export default function PdfFragmentBanner({
  regions,
  page,
  slug,
  shownVersion,
  address,
  versionCount,
  pageLabels,
  ownPageLabels,
  pageCount,
  onJumpToTarget,
  onJumpToPage,
  className,
}: Props) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || (regions.length === 0 && page === null)) return null;

  const stamped = (named: PageName) => ({ ...named, stamp: stampOfRead(named, address, versionCount) });
  // This page's own address, which a link written now names.
  const here = address.own ? versionPath(slug, shownVersion) : pdfPath(slug);
  const shownStamp = pageStampFor(shownVersion, versionCount);
  /** The sheet a carried link landed on, as a link written now names it. */
  const landedName = (sheetIndex: number) => ({ ...pageNameForSheet(ownPageLabels, pageCount, sheetIndex), stamp: shownStamp });
  /** A hand-typed link without `v=` on the bare address most likely meant the latest: that reading, offered beside the rule's. */
  const otherReading = (named: PageName, href: string) =>
    named.v === undefined && !address.own ? (
      <>
        {" "}
        If it was written for version {shownVersion},{" "}
        <a href={href} data-testid="pdf-fragment-other-reading">
          read its {writtenPage(named)} as version {shownVersion}&apos;s
        </a>
        .
      </>
    ) : null;

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
              <a href={`${versionPath(slug, page.reading.version)}#${formatPageName(stamped(page.page))}`}>Open it on version {page.reading.version}</a>
            </>
          ) : page.reading.kind === "carried" && page.reading.sheets.length > 0 ? (
            <span data-testid="pdf-fragment-carried">
              This link was read as version {page.reading.version}: its {writtenPage(page.page)} is sheet {page.reading.sheets[0] + 1} here.{" "}
              <a href={`${here}#${formatPageName(landedName(page.reading.sheets[0]))}`} data-testid="pdf-fragment-current-form">
                The link as it is now
              </a>
              .{otherReading(page.page, `${here}#${formatPageName({ ...page.page, stamp: shownStamp })}`)}
            </span>
          ) : page.reading.kind === "carried" ? (
            <>
              This link names {writtenPage(page.page)} of version {page.reading.version}, which has no counterpart on version {shownVersion}.{" "}
              {page.reading.state !== "abandoned" && (
                <a href={`${versionPath(slug, page.reading.version)}#${formatPageName(stamped(page.page))}`}>Open it on version {page.reading.version}</a>
              )}
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
                <a href={`${versionPath(slug, reading.version)}#${formatFragmentPassages([{ ...region.passage, page: stamped(region.passage.page) }])}`}>
                  Open it on version {reading.version}
                </a>
              </li>
            );
          }
          if (reading.kind === "carried") {
            const offerThere = region.heldByNamed && reading.state !== "abandoned" && (
              <>
                {" "}
                <a
                  href={`${versionPath(slug, reading.version)}#${formatFragmentPassages([{ ...region.passage, page: stamped(region.passage.page) }])}`}
                  data-testid="pdf-fragment-on-named"
                >
                  Open it on version {reading.version}
                </a>
              </>
            );
            if (!region.target) {
              // The first sheet of this version the link was carried to, where it was looked for.
              const carriedTo = region.named[0] ?? null;
              return (
                <li key={region.id}>
                  {carriedTo !== null ? (
                    <button type="button" className={styles.partButton} onClick={() => onJumpToPage(carriedTo)} title="Go to the page this passage was carried to" data-testid="pdf-fragment-miss">
                      <span style={quiet}>Not found on page {pageLabelFor(pageLabels, carriedTo)}</span>
                    </button>
                  ) : (
                    <span data-testid="pdf-fragment-miss" style={{ display: "block", padding: "0.1rem 0", ...quiet }}>
                      Version {reading.version}&apos;s {writtenPage(region.passage.page)} has no counterpart here, and its words aren&apos;t on exactly one page
                    </span>
                  )}
                  {offerThere}
                </li>
              );
            }
            const landed = region.target.pageIndex;
            const changed = carriedElsewhere(region.passage.page, landed, ownPageLabels, pageCount);
            return (
              <li key={region.id}>
                <button type="button" className={styles.partButton} onClick={() => onJumpToTarget(region.target!)} title="Jump to this passage">
                  {changed && (
                    <span data-testid="pdf-fragment-carried">
                      Read as version {reading.version}: its {writtenPage(region.passage.page)} is sheet {landed + 1} here:{" "}
                    </span>
                  )}
                  <span className={styles.partQuote}>{region.target.quote.exact}</span>
                </button>
                {changed && (
                  <span style={{ display: "block", padding: "0.1rem 0", ...quiet }}>
                    <a href={`${here}#${formatFragmentPassages([{ ...region.passage, page: landedName(landed) }])}`} data-testid="pdf-fragment-current-form">
                      The link as it is now
                    </a>
                    .
                    {otherReading(region.passage.page, `${here}#${formatFragmentPassages([{ ...region.passage, page: { ...region.passage.page, stamp: shownStamp } }])}`)}
                  </span>
                )}
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
