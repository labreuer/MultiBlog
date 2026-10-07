"use client";

import { useEffect, useState } from "react";
import type { PdfViewerHandle } from "./PdfViewer";
import { parseFragmentPassages, resolvePassage, type FragmentPassage } from "@/lib/pdf-fragment";
import { normalisePageText, textVersionFor, type NormalisedPage } from "@/lib/pdf-text";
import { quadSourceItems, quadsForRange, type MeasureText, type QuadSourceItem } from "@/lib/pdf-quads";
import { QUOTE_CONTEXT_LENGTH, type PdfTarget } from "@/lib/pdf-anchor";
import { PDFJS_VERSION } from "@/lib/pdfjs-client";

// docs/PDF_FRAGMENT_LINKS.md §6 — the passages a `#page=<n>&text=<words>`
// fragment names, found in this document and measured into `PdfTarget`s the
// surface draws as link regions.
//
// Held in memory only: a fragment link has no row, so nothing here is ever
// posted, and every open finds its passages again from the text pdfjs
// extracts. That is the text the stored page text came from (the same
// `getTextContent()` through the same `normalisePageText`), so a passage the
// integrity check finds is one this finds.

/** One passage of the fragment, and where it is: `target` is null when the page doesn't hold it. */
export type FragmentRegion = {
  id: string;
  passage: FragmentPassage;
  target: PdfTarget | null;
};

export type PdfFragment = {
  regions: FragmentRegion[];
  /** Bumps on every resolution, so the surface can jump once per fragment rather than once per render. */
  resolution: number;
};

type PageText = { items: QuadSourceItem[]; normalised: NormalisedPage };

export function usePdfFragment(handle: PdfViewerHandle | null): PdfFragment {
  const [state, setState] = useState<PdfFragment>({ regions: [], resolution: 0 });

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
        passages.map(async (passage, index): Promise<FragmentRegion> => ({
          id: `fragment-${index}`,
          passage,
          target: await targetFor(handle, pages, passage, measure),
        })),
      );
      if (run !== generation) return;
      setState((previous) =>
        regions.length === 0 && previous.regions.length === 0
          ? previous
          : { regions, resolution: previous.resolution + 1 },
      );
    };

    void resolve();
    window.addEventListener("hashchange", resolve);
    return () => {
      generation++;
      window.removeEventListener("hashchange", resolve);
    };
  }, [handle]);

  return state;
}

async function targetFor(
  handle: PdfViewerHandle,
  pages: Map<number, Promise<PageText | null>>,
  passage: FragmentPassage,
  measure: MeasureText | undefined,
): Promise<PdfTarget | null> {
  const pageIndex = passage.page - 1;
  if (pageIndex >= handle.pdf.numPages) return null;
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
