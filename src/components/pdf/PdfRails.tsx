"use client";

import { SAFE_COLOR } from "@/lib/safe-css";
import { NEUTRAL_THREAD_COLOR } from "@/lib/author-colors";
import { documentFraction, thumbIsWorthDrawing, type PageOffsets } from "@/lib/pdf-geometry";
import type { RemoteReader } from "./use-pdf-presence";
import styles from "./PdfRails.module.css";

// PLAN.md §19 Phase 4 — the two rails.
//
// Both are pure presentation over a **document fraction** (0..1), which is the
// only position that means the same thing to two readers at different zooms.
// The arithmetic lives in src/lib/pdf-geometry.ts; these components measure
// nothing and decide nothing.

/** A colour is only ever written to a style attribute after SAFE_COLOR validates it (STYLE.md). */
function safeColor(color: string): string {
  return SAFE_COLOR.test(color) ? color : NEUTRAL_THREAD_COLOR;
}

/**
 * Left rail — where everyone else is reading.
 *
 * Passive presence, which docs/PDF.md §9 argues for as the default: seeing that
 * three people are clustered around page 40 is most of the value, and it costs
 * the reader nothing. Following is opt-in on top (the toolbar control), never
 * automatic.
 */
export function PdfPresenceRail({
  readers,
  offsets,
  onJumpTo,
}: {
  readers: RemoteReader[];
  offsets: PageOffsets | null;
  onJumpTo: (reader: RemoteReader) => void;
}) {
  return (
    <div className={`${styles.rail} ${styles.leftRail}`} aria-label="Other readers">
      {offsets &&
        readers.map((reader) => {
          const viewport = reader.presence.viewport;
          if (!viewport) return null;
          // `pdfPoint[1]` is PDF user space — origin bottom-left, y increasing
          // *upward* — while a document fraction measures downward from the
          // page's top edge. The page height is what converts between them, and
          // getting this backwards puts everyone on the wrong end of the
          // document in a way that looks plausible.
          const pageHeight = pageHeightAt(offsets, viewport.pageIndex);
          const yFromTop = Math.max(0, pageHeight - viewport.pdfPoint[1]);
          const fraction = documentFraction(offsets, viewport.pageIndex, yFromTop);
          const color = safeColor(reader.presence.user.color);

          return (
            <button
              key={reader.clientId}
              type="button"
              className={`${styles.readerDot} ${reader.presence.leading ? styles.leadingDot : ""}`}
              style={{ top: `${fraction * 100}%`, background: color }}
              title={
                reader.presence.leading
                  ? `${reader.presence.user.name} is presenting — click to jump to them`
                  : `${reader.presence.user.name} — click to jump to them`
              }
              aria-label={`Jump to ${reader.presence.user.name}`}
              onClick={() => onJumpTo(reader)}
            />
          );
        })}
    </div>
  );
}

export type AnnotationTick = { id: string; fraction: number; color: string; label: string };

/**
 * Right rail — where *you* are, and where the annotations are.
 *
 * The thumb is a range rather than a point on purpose: a reader zoomed out over
 * three pages and one filling the screen with half of one are in genuinely
 * different places, and a single marker cannot say so.
 */
export function PdfIndicatorStrip({
  ticks,
  visibleRange,
  railHeightPx,
  onJumpTo,
}: {
  ticks: AnnotationTick[];
  visibleRange: { start: number; end: number } | null;
  /** Measured by the parent; the threshold below is in pixels, so it needs a real height. */
  railHeightPx: number;
  onJumpTo: (id: string) => void;
}) {
  const showThumb = visibleRange !== null && thumbIsWorthDrawing(visibleRange, railHeightPx);

  return (
    <div className={`${styles.rail} ${styles.rightRail}`} aria-label="Document map">
      {showThumb && (
        <div
          className={styles.viewportThumb}
          style={{
            top: `${visibleRange.start * 100}%`,
            height: `${(visibleRange.end - visibleRange.start) * 100}%`,
          }}
        />
      )}
      {ticks.map((tick) => (
        <button
          key={tick.id}
          type="button"
          className={styles.annotationTick}
          style={{ top: `${tick.fraction * 100}%`, background: safeColor(tick.color) }}
          title={tick.label}
          aria-label={`Jump to annotation: ${tick.label}`}
          onClick={() => onJumpTo(tick.id)}
        />
      ))}
    </div>
  );
}

/**
 * The follow control. Lists whoever is present, marks anyone broadcasting an
 * invitation, and lets this reader lead or follow.
 *
 * One-directional only: there is no "follow me" that drags anyone. docs/PDF.md
 * §9 is explicit that symmetric mutual following is unusable in practice — two
 * followers chase each other and neither can steer.
 */
export function PdfFollowBar({
  readers,
  leading,
  onSetLeading,
  following,
  onFollow,
}: {
  readers: RemoteReader[];
  leading: boolean;
  onSetLeading: (leading: boolean) => void;
  following: number | null;
  onFollow: (clientId: number | null) => void;
}) {
  // Always wrapped in the same labelled container, including the
  // nobody-else-here case: the label is what lets a caller (and a test)
  // distinguish these chips from the left rail's dots, which carry the same
  // reader names in their own aria-labels.
  if (readers.length === 0 && !leading) {
    return (
      <div className={styles.followBar} aria-label="Reader presence">
        <button type="button" className={styles.followChip} onClick={() => onSetLeading(true)}>
          Present
        </button>
      </div>
    );
  }

  return (
    <div className={styles.followBar} aria-label="Reader presence">
      <button
        type="button"
        className={`${styles.followChip} ${leading ? styles.followChipActive : ""}`}
        aria-pressed={leading}
        onClick={() => onSetLeading(!leading)}
      >
        {leading ? "Presenting" : "Present"}
      </button>

      {readers.map((reader) => {
        const isFollowed = following === reader.clientId;
        return (
          <button
            key={reader.clientId}
            type="button"
            className={`${styles.followChip} ${isFollowed ? styles.followChipActive : ""}`}
            aria-pressed={isFollowed}
            onClick={() => onFollow(isFollowed ? null : reader.clientId)}
            title={
              isFollowed
                ? `Following ${reader.presence.user.name} — click to stop, or just scroll`
                : `Follow ${reader.presence.user.name}`
            }
          >
            <span className={styles.swatch} style={{ background: safeColor(reader.presence.user.color) }} />
            {isFollowed ? `Following ${reader.presence.user.name}` : reader.presence.user.name}
            {reader.presence.leading && !isFollowed ? " (presenting)" : ""}
          </button>
        );
      })}
    </div>
  );
}

/** A page's height at scale 1, recovered from the cumulative offset table. */
function pageHeightAt(offsets: PageOffsets, pageIndex: number): number {
  const top = offsets.tops[pageIndex];
  if (top === undefined) return 0;
  const next = offsets.tops[pageIndex + 1] ?? offsets.total;
  return next - top;
}
