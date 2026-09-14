"use client";

import { useEffect, useState } from "react";
import { documentFraction, pageHeightAt } from "@/lib/pdf-geometry";
import {
  destPageTarget,
  destinationYFromTop,
  flattenOutline,
  refKey,
  type OutlineNode,
  type OutlinePosition,
  type PdfOutlineItem,
} from "@/lib/pdf-outline";
import type { PdfViewerHandle } from "./PdfViewer";

// PLAN.md §19b — the document's own table of contents, read once per file and
// resolved into document fractions.
//
// The split with src/lib/pdf-outline.ts is the one src/lib/pdf-geometry.ts has:
// every *rule* lives there and is unit-tested; what lives here is the part that
// needs the worker — turning a destination's page **ref** into a page index,
// which only pdfjs can answer and only over a round trip.

export type PdfOutlineState = {
  /**
   * - `loading` — the document is open, the outline is on its way
   * - `absent` — the document has no outline at all, which is the common case
   * - `ready` — `nodes` is non-empty
   * - `error` — `getOutline` threw; the pane says so rather than looking empty
   */
  status: "loading" | "absent" | "ready" | "error";
  nodes: OutlineNode[];
};

const EMPTY: PdfOutlineState = { status: "loading", nodes: [] };

export function usePdfOutline(handle: PdfViewerHandle | null): PdfOutlineState {
  // **Keyed on the handle it was read from, and derived during render.** The
  // alternative — resetting to `loading` in an effect when the handle changes —
  // renders one frame of the *previous* document's outline against the new one,
  // and costs a cascading render to correct. Same shape as the surface's
  // `refetched` local copy, for the same reason.
  const [result, setResult] = useState<{ handle: PdfViewerHandle; state: PdfOutlineState } | null>(null);

  useEffect(() => {
    if (!handle) return;
    let cancelled = false;

    void (async () => {
      try {
        const items = (await handle.pdf.getOutline()) as PdfOutlineItem[] | null;
        if (cancelled) return;
        if (!items || items.length === 0) {
          setResult({ handle, state: { status: "absent", nodes: [] } });
          return;
        }

        const positions = await resolvePositions(handle, items);
        if (cancelled) return;

        const nodes = flattenOutline(
          items,
          (item) => positions.get(item) ?? null,
          (position) => documentFraction(handle.offsets, position.pageIndex, position.yFromTop),
        );
        setResult({ handle, state: { status: "ready", nodes } });
      } catch (error) {
        if (cancelled) return;
        // Logged rather than swallowed: an outline that fails to parse is a
        // property of somebody's file, and the console line is the only way to
        // tell that from "this PDF has none".
        console.error("[usePdfOutline] couldn't read the outline:", error);
        setResult({ handle, state: { status: "error", nodes: [] } });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [handle]);

  return handle !== null && result?.handle === handle ? result.state : EMPTY;
}

/**
 * Every entry's landing point, keyed by the pdfjs item object itself.
 *
 * By identity rather than by path id because the flatten that assigns ids
 * happens *after* this — and the items are the same objects throughout, since
 * `getOutline()` is called once and its tree is never rebuilt.
 *
 * Two round-trip economies, both of which matter on the kind of document that
 * has a 500-entry outline:
 *
 * - **Named destinations are fetched as a dictionary**, once, rather than one
 *   `getDestination(name)` apiece. Skipped entirely when no entry uses one.
 * - **Page refs are deduped** before `getPageIndex`. Sibling entries on one
 *   page are the norm, not the exception, and each unique ref is a worker
 *   round trip.
 */
async function resolvePositions(
  handle: PdfViewerHandle,
  items: readonly PdfOutlineItem[],
): Promise<Map<PdfOutlineItem, OutlinePosition | null>> {
  const flat: PdfOutlineItem[] = [];
  const collect = (level: readonly PdfOutlineItem[]) => {
    for (const item of level) {
      flat.push(item);
      if (item.items?.length) collect(item.items);
    }
  };
  collect(items);

  // A named destination's array is the same shape as an inline one; the name is
  // only how it is reached. So resolve names to arrays first, and the rest of
  // this function has one case to handle instead of two.
  //
  // A `Map`, verified against 6.2.108 (`Catalog.destinations` builds one and it
  // survives the structured clone out of the worker). Older pdfjs returned a
  // plain object here, so the shape is checked rather than assumed — docs/PDF.md
  // §10's version coupling, in the one place where guessing wrong would silently
  // cost every named destination its position instead of throwing.
  const named = flat.some((item) => typeof item.dest === "string")
    ? await handle.pdf.getDestinations().catch(() => null)
    : null;
  const destOf = (item: PdfOutlineItem): unknown[] | null => {
    if (Array.isArray(item.dest)) return item.dest;
    if (typeof item.dest === "string" && named instanceof Map) {
      const resolved: unknown = named.get(item.dest);
      return Array.isArray(resolved) ? resolved : null;
    }
    return null;
  };

  const pageIndexByRef = new Map<string, Promise<number | null>>();
  const pageIndexFor = (dest: unknown[]): Promise<number | null> => {
    const target = destPageTarget(dest);
    if (target === null) return Promise.resolve(null);
    if (target.kind === "index") return Promise.resolve(target.pageIndex);
    const key = refKey(target.ref);
    let pending = pageIndexByRef.get(key);
    if (!pending) {
      // A ref to an object that isn't a page — or to one this document doesn't
      // have — rejects. That costs the entry its highlight and nothing else.
      pending = handle.pdf.getPageIndex(target.ref as Parameters<typeof handle.pdf.getPageIndex>[0]).catch(() => null);
      pageIndexByRef.set(key, pending);
    }
    return pending;
  };

  const resolved = await Promise.all(
    flat.map(async (item): Promise<[PdfOutlineItem, OutlinePosition | null]> => {
      const dest = destOf(item);
      if (!dest) return [item, null];
      const pageIndex = await pageIndexFor(dest);
      // Out of range as well as null: a destination naming page 900 of a
      // 300-page document is a real thing in a badly-merged file, and a
      // fraction computed from it would be a confident lie.
      if (pageIndex === null || pageIndex < 0 || pageIndex >= handle.pdf.numPages) return [item, null];
      const pageHeight = pageHeightAt(handle.offsets, pageIndex);
      return [item, { pageIndex, yFromTop: destinationYFromTop(dest, pageHeight) }];
    }),
  );

  return new Map(resolved);
}
