"use client";

import { useEffect, useState } from "react";
import type { PdfViewerHandle } from "./PdfViewer";
import { locateFragmentMisses } from "@/app/actions/pdf-fragment";
import { parseFragmentPassages, resolvePassage, type FragmentPassage } from "@/lib/pdf-fragment";
import { readByWordsAlone, readPage, type LinkAddress, type LinkVersion, type PageReading } from "@/lib/pdf-link-reading";
import { pageFromHash, type PageName } from "@/lib/pdf-open-params";
import { sheetsNamed } from "@/lib/pdf-page-labels";
import { normalisePageText, textVersionFor, type NormalisedPage } from "@/lib/pdf-text";
import { quadSourceItems, quadsForRange, type MeasureText, type QuadSourceItem } from "@/lib/pdf-quads";
import { QUOTE_CONTEXT_LENGTH, type PdfTarget } from "@/lib/pdf-anchor";
import { PDFJS_VERSION } from "@/lib/pdfjs-client";

// docs/PDF_FRAGMENT_LINKS.md §6 — the passages a `#sheet=<n>&text=<words>`
// (or `#p=<label>&text=<words>`) fragment names, found in this document and
// measured into `PdfTarget`s the surface draws as link regions.
//
// Held in memory only: a fragment link has no row, so nothing here is ever
// posted, and every open finds its passages again from the text pdfjs
// extracts. That is the text the stored page text came from (the same
// `getTextContent()` through the same `normalisePageText`), so a passage the
// integrity check finds is one this finds.
//
// A passage is looked for on the sheets its page names, in order, which is
// one sheet for `sheet=` and every sheet carrying the label for `p=`. When
// none holds it, the server is asked where it is instead (§6, "A miss looks
// beyond its page"), once for every miss of the fragment, and the one page
// it answers is read here and drawn.
//
// **Each passage is read by the version it names** (docs/PDF.md §13, "Links
// into the file"; src/lib/pdf-link-reading.ts): its `v=`, or without one the
// file's first version, or on a version's own address that version. One that
// names the version shown is found as above. One that names another version
// is not looked for here at all: no page map joins the two, so its sheet and
// its words are another version's, and the banner offers it there. One that
// names an abandoned version, or a version the file never had, has no version
// to open instead, and is looked for by its words alone: drawn where exactly
// one sheet of the version shown holds it, once.

/** One passage of the fragment, and where it is: `target` is null when no page holds it. */
export type FragmentRegion = {
  id: string;
  passage: FragmentPassage;
  /** The 0-based sheets its page names, in order: none for a label no sheet carries, or a sheet past the end. */
  named: number[];
  target: PdfTarget | null;
  /** Whether `target` is on a sheet the link doesn't name, where the server found the passage instead. */
  elsewhere: boolean;
  /** How the passage's page was read against the file's versions. */
  reading: PageReading;
};

/** The link's context: the address this page is, and the file's versions. */
export type FragmentLinkContext = { address: LinkAddress; versions: readonly LinkVersion[] };

export type PdfFragment = {
  regions: FragmentRegion[];
  /**
   * A link without words, when its page is not one of the version shown: the
   * page and how it was read, for the banner to say so. Null for a link with
   * passages, and for a page of the version shown, which simply opens.
   */
  page: { page: PageName; reading: PageReading } | null;
  /** Bumps on every resolution, so the surface can jump once per fragment rather than once per render. */
  resolution: number;
};

type PageText = { items: QuadSourceItem[]; normalised: NormalisedPage };

export function usePdfFragment(handle: PdfViewerHandle | null, fileId: string, fileVersionId: string, link: FragmentLinkContext): PdfFragment {
  const [state, setState] = useState<PdfFragment>({ regions: [], page: null, resolution: 0 });

  useEffect(() => {
    if (!handle) return;
    // A page's text is the same for every fragment this document is opened
    // with, so a second link into it (a hashchange) extracts nothing again.
    const pages = new Map<number, Promise<PageText | null>>();
    const measure = canvasMeasurer();
    // A hashchange can arrive while the previous fragment is still resolving;
    // the older run drops its result rather than publishing over the newer.
    let generation = 0;

    const resolve = async () => {
      const run = ++generation;
      const passages = parseFragmentPassages(window.location.hash);
      const regions = await Promise.all(
        passages.map(async (passage, index): Promise<FragmentRegion> => {
          const reading = readPage(passage.page, link.address, link.versions);
          // Only a page of the version shown names sheets of this document.
          const named = reading.kind === "here" ? sheetsNamed(passage.page, handle.ownPageLabels, handle.pdf.numPages) : [];
          let target: PdfTarget | null = null;
          for (const pageIndex of named) {
            target = await targetFor(handle, pages, pageIndex, passage, measure);
            if (target) break;
          }
          return { id: `fragment-${index}`, passage, named, target, elsewhere: false, reading };
        }),
      );
      const wordless = passages.length === 0 ? pageFromHash(window.location.hash) : null;
      const wordlessReading = wordless ? readPage(wordless, link.address, link.versions) : null;
      const page = wordless && wordlessReading && wordlessReading.kind !== "here" ? { page: wordless, reading: wordlessReading } : null;
      // One question for every miss, and only the pages answered are read. A
      // passage of another version that can be opened is not a miss: it is
      // offered there. One with no version to open is asked of every sheet.
      const misses = regions.filter((region) => region.target === null && (region.reading.kind === "here" || readByWordsAlone(region.reading)));
      if (misses.length > 0) {
        const answers = await locateFragmentMisses(
          fileId,
          fileVersionId,
          misses.map(({ passage: { prefix, segments, suffix }, named }) => ({ passage: { prefix, segments, suffix }, named })),
        ).catch((error: unknown) => {
          console.warn("[pdf] couldn't ask where a linked passage is instead:", error);
          return [];
        });
        await Promise.all(
          misses.map(async (region, n) => {
            const sheet = answers[n];
            if (typeof sheet !== "number" || sheet < 1 || sheet > handle.pdf.numPages) return;
            region.target = await targetFor(handle, pages, sheet - 1, region.passage, measure);
            region.elsewhere = region.target !== null;
          }),
        );
      }
      if (run !== generation) return;
      setState((previous) =>
        regions.length === 0 && previous.regions.length === 0 && page === null && previous.page === null
          ? previous
          : { regions, page, resolution: previous.resolution + 1 },
      );
    };

    void resolve();
    window.addEventListener("hashchange", resolve);
    return () => {
      generation++;
      window.removeEventListener("hashchange", resolve);
    };
  }, [handle, fileId, fileVersionId, link]);

  return state;
}

/** The passage on the sheet at `pageIndex`, measured, or null when that sheet doesn't hold it. */
async function targetFor(
  handle: PdfViewerHandle,
  pages: Map<number, Promise<PageText | null>>,
  pageIndex: number,
  passage: FragmentPassage,
  measure: MeasureText | undefined,
): Promise<PdfTarget | null> {
  if (pageIndex < 0 || pageIndex >= handle.pdf.numPages) return null;
  let pending = pages.get(pageIndex);
  if (!pending) {
    pending = pageTextFor(handle, pageIndex);
    pages.set(pageIndex, pending);
  }
  const page = await pending;
  if (!page) return null;

  const text = page.normalised.text;
  const range = resolvePassage(text, passage);
  if (!range) return null;
  const quads = quadsForRange(page.items, page.normalised.offsets, range.start, range.end, measure);
  if (quads.length === 0) return null;
  return {
    pageIndex,
    quads,
    quote: {
      exact: text.slice(range.start, range.end),
      prefix: text.slice(Math.max(0, range.start - QUOTE_CONTEXT_LENGTH), range.start),
      suffix: text.slice(range.end, range.end + QUOTE_CONTEXT_LENGTH),
    },
    position: range,
    textVersion: textVersionFor(PDFJS_VERSION),
  };
}

/**
 * One page's text items, as the selection capture reads them (pdfjs's
 * `getTextContent()`, never the rendered text layer: docs/PDF.md §11), with
 * each item's font metrics from `styles` for the quads.
 */
async function pageTextFor(handle: PdfViewerHandle, pageIndex: number): Promise<PageText | null> {
  try {
    const page = await handle.pdf.getPage(pageIndex + 1);
    const items = quadSourceItems(await page.getTextContent());
    return { items, normalised: normalisePageText(items) };
  } catch (error) {
    // The same fail-closed stance as the selection capture: a page pdfjs
    // can't read is a passage not found, never a broken surface.
    console.warn(`[pdf] couldn't read page ${pageIndex + 1}'s text for a linked passage:`, error);
    return null;
  }
}

/**
 * Text advances in a CSS font, measured the way pdfjs's text layer measures
 * an item before scaling its span to the item's width, so a passage's edges
 * fall where a selection's would (src/lib/pdf-quads.ts).
 */
function canvasMeasurer(): MeasureText | undefined {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return undefined;
  let font = "";
  return (text, fontFamily) => {
    const next = `100px ${fontFamily}`;
    if (font !== next) {
      context.font = next;
      font = next;
    }
    return context.measureText(text).width;
  };
}
