"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AVATAR_EXPORT_SIZE } from "@/lib/avatar-url";
import styles from "./AvatarCropper.module.css";

/**
 * Lets a contributor choose which part of their photo lands in the circle
 * (PLAN.md §17n), by dragging and zooming it behind a circular mask.
 *
 * **The crop happens here, not in `processAvatar`.** The alternative — POST
 * the original plus crop parameters and `.extract()` server-side — needs this
 * exact UI anyway, *plus* a wider FormData contract and parameter validation,
 * so it is strictly more code. Cropping client-side also means what gets
 * uploaded is an ~AVATAR_EXPORT_SIZE square of tens of KB rather than the
 * user's multi-megabyte original, which is what keeps the upload under Next's
 * 1MB Server Action body limit and nginx's 1MB `client_max_body_size` without
 * either of them having to be raised.
 *
 * None of this weakens ingestion. `processAvatar` still decodes and re-encodes
 * whatever arrives, still sniffs the real format, and still caps input pixels —
 * a hand-crafted POST that skips this component entirely is exactly as
 * constrained as it was before.
 *
 * The crop is baked into the stored bytes and the parameters are deliberately
 * *not* persisted. Storing them so a user could re-adjust later would require
 * keeping the original in the database too — and the original is the copy that
 * still has the GPS EXIF in it, which would quietly break §17n's "location
 * data is removed" claim. Re-adjusting means re-uploading.
 *
 * One browser dependency worth naming: the export reuses the very `<img>`
 * element on screen as `drawImage`'s source, so preview and result cannot
 * disagree about EXIF orientation — whatever `image-orientation: from-image`
 * did to the preview is what the canvas draws. (Every current browser applies
 * it. If one didn't, the photo would be visibly sideways in the frame and the
 * server's `.rotate()` could no longer help, since a canvas export carries no
 * EXIF at all.)
 */

/** Diameter of the on-screen crop circle, in CSS px. */
const FRAME = 220;

/**
 * Zoom is a multiple of the "cover" scale, so 1 — the image's shorter side
 * exactly filling the circle — is the minimum, and the photo always fills the
 * frame.
 *
 * A per-image minimum of the *contain* scale (0.75 for a 3:4 portrait)
 * would let the whole photo fit, letterboxed against transparency. That was
 * tried and rejected: a circular avatar that doesn't fill its circle reads as
 * broken rather than as deliberate, and choosing which part of a photo shows
 * is the job this control exists to do.
 */
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

/** Arrow-key nudge, in CSS px. Shift gives single-pixel precision. */
const NUDGE = 8;

type Offset = { x: number; y: number };

type Natural = { w: number; h: number };

export type AvatarCropperProps = {
  /** The file the user picked. Its object URL is owned by this component. */
  file: File;
  /** Disables every control while an upload is in flight. */
  busy: boolean;
  onCancel: () => void;
  onConfirm: (cropped: File) => void;
};

/**
 * The geometry, in one place because the CSS transform and the canvas export
 * *must* agree — a preview that doesn't match the result is the classic bug in
 * a cropper, and it comes from computing the two independently.
 *
 * `baseScale` is the "cover" scale: the factor at which the image's shorter
 * side exactly fills the frame, so zoom 1 always covers the circle no matter
 * the source's aspect ratio. `offset` then translates the image's centre away
 * from the frame's centre, bounded so an edge can never be dragged inside the
 * circle.
 */
function geometry(natural: Natural, zoom: number) {
  const baseScale = FRAME / Math.min(natural.w, natural.h);
  const scale = baseScale * zoom;
  const width = natural.w * scale;
  const height = natural.h * scale;
  return {
    width,
    height,
    maxOffsetX: Math.max(0, (width - FRAME) / 2),
    maxOffsetY: Math.max(0, (height - FRAME) / 2),
  };
}

function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

export default function AvatarCropper({ file, busy, onCancel, onConfirm }: AvatarCropperProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; from: Offset } | null>(null);
  const [natural, setNatural] = useState<Natural | null>(null);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * The object URL is created *and* revoked inside one effect, and handed to
   * the DOM node directly rather than through state — which is why the `<img>`
   * below has no `src` in its JSX.
   *
   * **Creating it outside the effect is broken under StrictMode**, which is
   * on by default for the App Router (`__NEXT_STRICT_MODE_APP`, Next 13.5.1+).
   * StrictMode double-invokes effects as setup → cleanup → setup; a cleanup
   * that revokes a URL created elsewhere (a `useState` initializer, a
   * `useMemo`) kills it on that first cleanup and nothing recreates it, so the
   * image fails to load on *every* pick with a dead `blob:` URL. Keeping both
   * halves in the effect means the second setup mints a fresh one.
   *
   * This is also the shape react-hooks/set-state-in-effect is asking for —
   * synchronizing an external system (the DOM node) with a prop, rather than
   * copying a derived value into state.
   */
  useEffect(() => {
    const img = imageRef.current;
    if (!img) return;
    const url = URL.createObjectURL(file);
    img.src = url;
    // Revoked rather than left to the document's lifetime: picking several
    // photos in a row is the normal case here, not the edge case.
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const move = useCallback(
    (next: Offset) => {
      if (!natural) return;
      const { maxOffsetX, maxOffsetY } = geometry(natural, zoom);
      setOffset({ x: clamp(next.x, maxOffsetX), y: clamp(next.y, maxOffsetY) });
    },
    [natural, zoom],
  );

  // Zooming out shrinks the bounds, which can leave the current offset outside
  // them — so the offset is re-clamped here rather than only on drag.
  function handleZoom(next: number) {
    if (!natural) return;
    const { maxOffsetX, maxOffsetY } = geometry(natural, next);
    setZoom(next);
    setOffset((current) => ({ x: clamp(current.x, maxOffsetX), y: clamp(current.y, maxOffsetY) }));
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (busy || exporting || !natural) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, from: offset };
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    move({ x: drag.from.x + (e.clientX - drag.startX), y: drag.from.y + (e.clientY - drag.startY) });
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  // The keyboard equivalent of the drag. Without it the position is settable
  // by pointer only, which would make the control unusable for anyone who
  // can't drag — and the frame is focusable purely so this can exist.
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (busy || exporting || !natural) return;
    const step = e.shiftKey ? 1 : NUDGE;
    const delta: Record<string, Offset> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault(); // or the dashboard scrolls under the cropper
    move({ x: offset.x + d.x, y: offset.y + d.y });
  }

  /**
   * Draws the visible circle's contents into a square canvas.
   *
   * The mapping is a single uniform scale from frame space to canvas space
   * (`k`), applied to the *same* width/height/offset the CSS transform uses —
   * which is what makes "what you see is what you get" a property of the code
   * rather than something to test for.
   *
   * No circular mask is applied: the stored image is a square that every
   * consumer renders inside `border-radius: 50%` (`Avatar`), and baking
   * transparent corners in would only make the WebP larger and the image
   * useless anywhere square.
   */
  function exportCrop() {
    const img = imageRef.current;
    if (!img || !natural) return;
    setError(null);
    setExporting(true);

    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_EXPORT_SIZE;
    canvas.height = AVATAR_EXPORT_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setExporting(false);
      setError("Your browser couldn't prepare the image.");
      return;
    }

    const { width, height } = geometry(natural, zoom);
    const k = AVATAR_EXPORT_SIZE / FRAME;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      img,
      AVATAR_EXPORT_SIZE / 2 + offset.x * k - (width * k) / 2,
      AVATAR_EXPORT_SIZE / 2 + offset.y * k - (height * k) / 2,
      width * k,
      height * k,
    );

    // No fallback branch for the type: toBlob is specified to produce PNG when
    // it doesn't support the requested format, and the server re-encodes to
    // WebP either way — so a browser without canvas WebP encoding costs a few
    // KB on one request and nothing else.
    canvas.toBlob(
      (blob) => {
        setExporting(false);
        if (!blob) {
          setError("Your browser couldn't prepare the image.");
          return;
        }
        onConfirm(new File([blob], "avatar.webp", { type: blob.type }));
      },
      "image/webp",
      0.92,
    );
  }

  const bounds = natural ? geometry(natural, zoom) : null;
  const disabled = busy || exporting || !natural;

  return (
    <div className={styles.cropper}>
      <div
        className={styles.frame}
        style={{ width: FRAME, height: FRAME }}
        // A focusable non-interactive container: the pointer handlers below are
        // a drag, not a click, and handleKeyDown is their keyboard equivalent.
        // No ARIA widget role fits ("2-D position" isn't one), so it's a group
        // with a label that says what the keys do.
        role="group"
        aria-label="Photo position. Drag, or use the arrow keys."
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
      >
        {/* No `src` here — the effect above assigns it, and owns its lifetime.
            Note it must stay *absent* rather than empty: `src=""` resolves
            against the page URL and fires onError before the effect runs. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- a blob: URL from the user's own file picker; next/image has nothing to optimize and cannot fetch it. */}
        <img
          ref={imageRef}
          alt=""
          className={styles.image}
          draggable={false}
          style={
            bounds
              ? {
                  width: bounds.width,
                  height: bounds.height,
                  transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                }
              : { visibility: "hidden" }
          }
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setError("That file couldn't be read as an image.")}
        />
      </div>

      <label className={styles.zoomRow}>
        <span>Zoom</span>
        <input
          type="range"
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          step={0.01}
          value={zoom}
          disabled={disabled}
          onChange={(e) => handleZoom(Number(e.target.value))}
        />
      </label>

      <p className={styles.hint}>Drag the photo to choose what shows in the circle, or focus it and use the arrow keys.</p>

      <div className={styles.actions}>
        <button type="button" onClick={exportCrop} disabled={disabled}>
          {busy ? "Uploading…" : "Use this photo"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy || exporting} className={styles.cancel}>
          Cancel
        </button>
      </div>

      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
