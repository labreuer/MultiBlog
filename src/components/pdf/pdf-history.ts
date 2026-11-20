import type { pdfjsViewer } from "@/lib/pdfjs-client";

// docs/PDF.md §10d — the browser history the viewer keeps: a link the document
// draws, an entry of its outline and the page box each leave an entry behind,
// so Back returns to where the reader was.
//
// **Handed to `PDFLinkService.setHistory` in place of pdfjs's `PDFHistory`**,
// with the five methods the link service calls (pdfjs 6.2.108:
// `goToDestination` and `goToPage` call `pushCurrentPosition` and then `push`
// or `pushPage` before they scroll; a document's GoBack/GoForward actions call
// `back`/`forward`). Nothing else in pdfjs reads it. `PDFHistory` itself
// doesn't fit this page, and §10d has the four reasons; the one that decides
// it is that it restores an entry by `setHash`, which reads only pdfjs's own
// fragment grammar, so Back to an entry reached by `#sheet=` does nothing.
//
// **An entry carries state and never a URL.** `pushState(state, "")` keeps the
// address as it is, so going back and forth between our entries fires no
// `hashchange` (half a dozen listeners on this page read the fragment, one of
// which can send the reader to another version), puts no fragment into Next's
// router (§0's last mistake) and raises no question of which version a `v=`
// should name. Next's patched `pushState` copies its own fields onto the
// state we hand it, so its router still owns the entry.
//
// **Never on an entry whose state is null.** That is an entry Next didn't
// write: a fragment link followed in the page, or a fragment typed into the
// address bar. Next reloads the whole page on a `popstate` to an entry whose
// state is an object without its own fields (16.2.11, app-router.js's
// `onPopState`), so state given to one, or an entry pushed from one (the patch
// has nothing to copy), costs the reader the page when they come back to it.
// From such an entry the viewer moves as it did before there was a history,
// and Back from it is the browser's fragment navigation.

/** The field of `history.state` an entry's view is kept under. */
const FIELD = "pdfView";

/**
 * How long the view stays still before the entry it is on is told where it
 * now is. A debounce, not a throttle: Safari refuses a page more than about a
 * hundred history calls in ten seconds, and a throttle while following
 * another reader would spend them.
 */
const SETTLE_MS = 1000;

/** What an entry keeps of the view. JSON-safe, as `history.state` must be structured-cloneable. */
type PdfView = {
  /** Which viewer the entry is for: the bytes' URL and the page's address (`keyFor`). */
  key: string;
  /** The entry's place among this viewer's entries, from 0 on the one it opened on. */
  index: number;
  /** The 1-based sheet. */
  page: number;
  /** The view's top-left in PDF user space, as pdfjs measures it for `updateviewarea`, once measured. */
  left?: number;
  top?: number;
  /** The destination a jump to this entry went to, for an entry Back reaches before its view is measured. */
  dest?: unknown[] | null;
  /** Where that jump left the view, as first measured: the same jump again from there adds no entry. */
  landed?: ViewLocation;
};

/** What `updateviewarea` reports, as far as this reads it: the top-left of the view, in the first visible page's space. */
type ViewLocation = { pageNumber: number; left: number; top: number };

const sameLocation = (a: ViewLocation, b: ViewLocation) => a.pageNumber === b.pageNumber && a.left === b.left && a.top === b.top;

export type PdfHistory = {
  pushCurrentPosition(): void;
  push(args: { namedDest: string | null; explicitDest: unknown[]; pageNumber: number }): void;
  pushPage(pageNumber: number): void;
  back(): void;
  forward(): void;
  /**
   * Whether `state` is an entry this viewer wrote. A `hashchange` that lands
   * on one is a Back or a Forward this history restores, so the viewer's own
   * fragment jumps stand down for it.
   */
  owns(state: unknown): boolean;
  destroy(): void;
};

/** The address an entry belongs to: the path and query, without the fragment, which our entries share. */
function here(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createPdfHistory({
  viewer,
  eventBus,
  fileUrl,
}: {
  viewer: InstanceType<typeof pdfjsViewer.PDFViewer>;
  eventBus: InstanceType<typeof pdfjsViewer.EventBus>;
  /** The bytes' URL, which names the version: an entry restores only onto the sheets it was measured on. */
  fileUrl: string;
}): PdfHistory {
  const address = here();
  const key = `${fileUrl} ${address}`;
  let latest: ViewLocation | null = null;
  let settle: ReturnType<typeof setTimeout> | null = null;
  /** The furthest index an entry has been pushed at, so a document's GoForward never leaves the page. */
  let maxIndex = 0;

  const viewOf = (state: unknown): PdfView | null => {
    const view = isObject(state) ? state[FIELD] : null;
    if (!isObject(view) || view.key !== key) return null;
    return Number.isInteger(view.page) && Number.isInteger(view.index) ? (view as PdfView) : null;
  };
  {
    const opened = viewOf(window.history.state);
    if (opened) maxIndex = opened.index;
  }

  const cancelSettle = () => {
    if (settle !== null) clearTimeout(settle);
    settle = null;
  };

  /** Tells the current entry where the view is, keeping how it was reached. */
  const record = () => {
    cancelSettle();
    const state = window.history.state;
    // Mid-navigation the address is already the next page's, and its entry is not ours to write.
    if (!isObject(state) || here() !== address) return;
    const current = viewOf(state);
    const at = latest ? { page: latest.pageNumber, left: latest.left, top: latest.top } : { page: viewer.currentPageNumber };
    const view: PdfView = { key, index: current?.index ?? 0, dest: current?.dest ?? null, ...at };
    const landed = current?.landed ?? (current?.dest && latest ? latest : undefined);
    if (landed) view.landed = landed;
    window.history.replaceState({ ...state, [FIELD]: view }, "");
  };

  const pushView = (page: number, dest: unknown[] | null) => {
    const state = window.history.state;
    if (!isObject(state) || here() !== address) return;
    const current = viewOf(state);
    // The same jump again, before the view has moved from where the last one
    // left it, adds nothing for Back to undo. Asked of where the jump landed
    // rather than of the entry's view, which the link service has just had
    // brought up to date (`pushCurrentPosition`).
    if (current?.dest && dest && JSON.stringify(current.dest) === JSON.stringify(dest)) {
      if (!current.landed || (latest !== null && sameLocation(current.landed, latest))) return;
    }
    record();
    const index = (current?.index ?? 0) + 1;
    maxIndex = index;
    const view: PdfView = { key, index, page, dest };
    window.history.pushState({ [FIELD]: view }, "");
  };

  const onViewArea = ({ location }: { location: ViewLocation }) => {
    latest = { pageNumber: location.pageNumber, left: location.left, top: location.top };
    cancelSettle();
    settle = setTimeout(record, SETTLE_MS);
  };

  const onPopState = (event: PopStateEvent) => {
    // A pending write is the entry just left's, and would land on this one.
    cancelSettle();
    const view = viewOf(event.state);
    if (!view) return;
    // Straight to the viewer, not through the link service, which would push.
    if (view.left !== undefined && view.top !== undefined) {
      // `null` zoom keeps the reader's own; a top above the page's edge is the gap above it, as pdfjs's own restore allows.
      viewer.scrollPageIntoView({ pageNumber: view.page, destArray: [null, { name: "XYZ" }, view.left, view.top, null], allowNegativeOffset: true });
    } else if (view.dest) {
      viewer.scrollPageIntoView({ pageNumber: view.page, destArray: view.dest, ignoreDestinationZoom: true });
    } else {
      viewer.currentPageNumber = view.page;
    }
  };

  eventBus.on("updateviewarea", onViewArea);
  window.addEventListener("popstate", onPopState);

  return {
    pushCurrentPosition: record,
    push: ({ explicitDest, pageNumber }) => pushView(pageNumber, explicitDest),
    // The page box submits on every blur, so the page the reader is on adds nothing.
    pushPage: (pageNumber) => {
      if (pageNumber !== viewer.currentPageNumber) pushView(pageNumber, null);
    },
    back: () => {
      const view = viewOf(window.history.state);
      if (view && view.index > 0) window.history.back();
    },
    forward: () => {
      const view = viewOf(window.history.state);
      if (view && view.index < maxIndex) window.history.forward();
    },
    owns: (state) => viewOf(state) !== null,
    // Writes nothing: by the time a page's effects are cleaned up, Next has
    // already written the next page's entry.
    destroy: () => {
      cancelSettle();
      eventBus.off("updateviewarea", onViewArea);
      window.removeEventListener("popstate", onPopState);
    },
  };
}
