import type { Quad } from "./pdf-anchor";

// PLAN.md §19 Phase 4 / docs/PDF.md §9 — what one reader broadcasts about where
// they are, and the rules for not echoing it back.
//
// Pure and DOM-free, like src/lib/pdf-geometry.ts beside it: the decisions live
// here, the measuring lives in the components.

/**
 * One reader's ephemeral state. Lives in Yjs **awareness**, never in the ydoc
 * (docs/PDF.md invariant 5) — it is worthless a second later, and persisting it
 * would bloat an update log for a document that otherwise never changes.
 */
export type PdfPresence = {
  user: { id: string; name: string; color: string };
  /** Null until this reader's viewer has laid out a page. */
  viewport: ViewportState | null;
  /** This reader's live text selection, so others can see what they're looking at. */
  selection: { pageIndex: number; quads: Quad[] } | null;
  /** "I'm presenting — come join me." Passive: it invites, it does not drag. */
  leading: boolean;
  /** The awareness clientId this reader is following, if any. */
  following: number | null;
};

/**
 * docs/PDF.md §9's wire format.
 *
 * **Never `scrollTop`, `scrollLeft`, pixel offsets, or a raw scale.** All four
 * are meaningless on a different window size, zoom level or device pixel ratio
 * — the receiving reader would be scrolled somewhere arbitrary. A page index
 * plus a point in PDF user space means the same thing everywhere, and maps 1:1
 * onto a PDF destination array, which is also what PDF.js consumes.
 */
export type ViewportState = {
  pageIndex: number;
  /** Top-left of the visible region, in PDF user space. */
  pdfPoint: [left: number, top: number];
  zoomMode: "page-fit" | "page-width" | number;
  /** Monotonic, for staleness. Not a wall clock — only compared against values from the same sender. */
  t: number;
};

/** Outbound rate, per docs/PDF.md §9. Awareness coalesces, so intermediate states are dropped, not queued. */
export const PRESENCE_THROTTLE_MS = 100;

/**
 * How far a viewport must move before it is worth broadcasting, as a fraction
 * of the visible height — docs/PDF.md §9's second echo guard.
 *
 * The first guard (an `applyingRemote` flag) closes the obvious loop. This one
 * closes the subtle one: applying a remote position lands *near* it rather than
 * exactly on it, because scrollPageIntoView snaps to layout. Without a
 * tolerance, that small difference is itself a change worth broadcasting, and
 * two followers can push each other a few pixels at a time indefinitely.
 */
export const PRESENCE_TOLERANCE_FRACTION = 0.02;

/**
 * Whether `next` differs from `previous` enough to send.
 *
 * `visibleHeight` is in PDF points, so the tolerance scales with how much of
 * the document is on screen rather than with a pixel count that means different
 * things at different zooms.
 */
export function viewportChangedEnough(
  previous: ViewportState | null,
  next: ViewportState,
  visibleHeight: number,
): boolean {
  if (!previous) return true;
  if (previous.pageIndex !== next.pageIndex) return true;
  if (previous.zoomMode !== next.zoomMode) return true;
  const tolerance = Math.max(1, visibleHeight * PRESENCE_TOLERANCE_FRACTION);
  return (
    Math.abs(previous.pdfPoint[0] - next.pdfPoint[0]) > tolerance ||
    Math.abs(previous.pdfPoint[1] - next.pdfPoint[1]) > tolerance
  );
}

/**
 * docs/PDF.md §9's third guard: ignore an inbound state older than the last one
 * applied from that same sender.
 *
 * Compared per sender, never globally — `t` is each client's own monotonic
 * counter, so comparing across senders would be comparing unrelated clocks.
 */
export function isStale(lastApplied: number | null, incoming: ViewportState): boolean {
  return lastApplied !== null && incoming.t <= lastApplied;
}

/** Narrows an untrusted awareness value. Anything malformed is simply ignored — presence is best-effort. */
export function parsePresence(value: unknown): PdfPresence | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const user = raw.user as Record<string, unknown> | undefined;
  if (!user || typeof user.id !== "string" || typeof user.name !== "string" || typeof user.color !== "string") {
    return null;
  }

  let viewport: ViewportState | null = null;
  const v = raw.viewport as Record<string, unknown> | undefined | null;
  if (v && typeof v === "object") {
    const point = v.pdfPoint;
    if (
      Number.isInteger(v.pageIndex) &&
      Array.isArray(point) &&
      point.length === 2 &&
      point.every((n) => typeof n === "number" && Number.isFinite(n)) &&
      typeof v.t === "number"
    ) {
      viewport = {
        pageIndex: v.pageIndex as number,
        pdfPoint: [point[0] as number, point[1] as number],
        zoomMode: (v.zoomMode as ViewportState["zoomMode"]) ?? "page-width",
        t: v.t,
      };
    }
  }

  let selection: PdfPresence["selection"] = null;
  const s = raw.selection as Record<string, unknown> | undefined | null;
  if (s && typeof s === "object" && Number.isInteger(s.pageIndex) && Array.isArray(s.quads)) {
    const quads = s.quads.filter(
      (q): q is Quad => Array.isArray(q) && q.length === 8 && q.every((n) => typeof n === "number"),
    );
    if (quads.length > 0) selection = { pageIndex: s.pageIndex as number, quads };
  }

  return {
    user: { id: user.id, name: user.name, color: user.color },
    viewport,
    selection,
    leading: raw.leading === true,
    following: typeof raw.following === "number" ? raw.following : null,
  };
}
