"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { IconGripVertical } from "@tabler/icons-react";
import {
  closeAnchoredLinkEdit,
  discardDraftLink,
  mintAnchoredLink,
  removeAnchoredLinkPart,
  reorderAnchoredLinkParts,
} from "@/app/actions/anchored-links";
import { clearOpenLink, refreshOpenLink, useOpenLink } from "./open-link-store";
import styles from "./AnchoredLinkTray.module.css";

// docs/ANCHORED_LINKS.md — the tray: the viewer's open link, a draft being
// assembled or a minted link reopened for editing. Mounted by both reading
// pages and the landing route as a self-fetching sibling: the store asks
// the server on mount and again on every tray-events notify, and the
// server row IS the cross-page persistence — navigate from a doc to a PDF
// and the same link is there. Renders nothing when nothing is open (or an
// empty draft is), so mounting it unconditionally costs one action round
// trip and no pixels.
//
// Deliberately not fed by props or router.refresh(): on the PDF page the
// part-adding popover lives inside an ssr:false island (CLAUDE.md's
// refresh trap), and this island fetching its own state is the same answer
// loadPdfAnnotationEntries already gives that problem.
//
// The two modes share the part list and its controls and differ in the
// title and the buttons. A draft ends in Copy link (mint) or Discard. A
// reopened link's edits are already live, so it ends in Done, and its Copy
// link copies the URL it has had all along.
//
// Reordering is a drag, by the grip or the text. Pointer events rather than
// HTML5 drag-and-drop, which iOS does not deliver for touch at all, and no
// library: the list is a handful of rows and the drop slot is a midpoint
// comparison. The grip keeps the arrow keys, so the keyboard lost nothing
// when the up/down buttons went.

const SNIPPET_CHARS = 60;

/** How far the pointer moves before a press on a handle counts as a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;

/** A press on a handle: which part is held, and — once it has moved far enough — the slot (0..n) it would drop into. */
type Drag = { from: number; startY: number; active: boolean; to: number | null };

type Copied = { url: string; clipboardFailed: boolean };

/** A clipboard-permission failure is not a failure of the link: the URL is shown as text instead. */
async function copyToClipboard(url: string): Promise<Copied> {
  try {
    await navigator.clipboard.writeText(url);
    return { url, clipboardFailed: false };
  } catch {
    return { url, clipboardFailed: true };
  }
}

export default function AnchoredLinkTray() {
  const open = useOpenLink();
  /** The mint's outcome — a panel that stands in for the (now empty) tray until dismissed. */
  const [minted, setMinted] = useState<Copied | null>(null);
  /** A reopened link's Copy link — an inline note; the tray stays. */
  const [copied, setCopied] = useState<Copied | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const [drag, setDrag] = useState<Drag | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  function handleRemove(anchorId: string) {
    setError(null);
    setCopied(null);
    startTransition(async () => {
      const result = await removeAnchoredLinkPart(anchorId);
      if (result.error) setError(result.error);
      // Re-read rather than splice locally: this also unpaints the passage on
      // whichever surface is showing it.
      refreshOpenLink();
    });
  }

  /** Moves the part at `from` into slot `to` (a gap index, 0..n) and persists the whole order. */
  function moveTo(from: number, to: number) {
    if (!open) return;
    const ids = open.parts.map((part) => part.anchorId);
    if (to < 0 || to > ids.length) return;
    const insertAt = to > from ? to - 1 : to;
    if (insertAt === from) return;
    const [held] = ids.splice(from, 1);
    ids.splice(insertAt, 0, held);
    setError(null);
    setCopied(null);
    startTransition(async () => {
      const result = await reorderAnchoredLinkParts(ids);
      if (result.error) setError(result.error);
      refreshOpenLink();
    });
  }

  function handleDragStart(index: number, event: React.PointerEvent<HTMLElement>) {
    if (busy || event.button !== 0) return;
    // Capture on whichever handle was pressed, so the moves and the release
    // reach it wherever the pointer goes; they bubble to the list's handlers.
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ from: index, startY: event.clientY, active: false, to: null });
  }

  function handleDragMove(event: React.PointerEvent<HTMLUListElement>) {
    if (!drag) return;
    if (!drag.active && Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
    // The slot is decided by row midpoints: above a row's middle is "before
    // it"; below the last one's is "at the end".
    const rows = Array.from(listRef.current?.querySelectorAll("li") ?? []);
    let to = rows.length;
    for (const [i, row] of rows.entries()) {
      const rect = row.getBoundingClientRect();
      if (event.clientY < rect.top + rect.height / 2) {
        to = i;
        break;
      }
    }
    setDrag({ ...drag, active: true, to });
  }

  function handleDragEnd() {
    if (!drag) return;
    if (drag.active && drag.to !== null) moveTo(drag.from, drag.to);
    setDrag(null);
  }

  function handleGripKey(index: number, event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveTo(index, index - 1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveTo(index, index + 2);
    }
  }

  function handleDiscard() {
    setError(null);
    startTransition(async () => {
      await discardDraftLink();
      clearOpenLink();
    });
  }

  function handleDone() {
    setError(null);
    setCopied(null);
    startTransition(async () => {
      await closeAnchoredLinkEdit();
      // Closed, so the surfaces drop the in-progress paint; a ?sel= page
      // still shows the followed link's own solid paint underneath.
      clearOpenLink();
    });
  }

  function handleMint() {
    setError(null);
    startTransition(async () => {
      const result = await mintAnchoredLink();
      if ("error" in result) {
        setError(result.error);
        refreshOpenLink();
        return;
      }
      // Minted before the clipboard is touched, so a clipboard-permission
      // failure still leaves a shareable URL — shown as text instead.
      setMinted(await copyToClipboard(result.url));
      // Minted, so it is no longer open anywhere — the surfaces drop their
      // in-progress highlights with it.
      clearOpenLink();
    });
  }

  function handleCopyUrl() {
    if (!open?.url) return;
    setError(null);
    void copyToClipboard(open.url).then(setCopied);
  }

  // The mint panel yields to a link opened since — an Edit on the same page
  // is how that happens, and it would be strange to keep saying "copied"
  // over a tray that is now editing something.
  if (minted && !open) {
    return (
      <aside className={styles.tray} data-testid="anchored-link-tray">
        <div className={styles.headerRow}>
          <span className={styles.title}>{minted.clipboardFailed ? "Link minted" : "Link copied"}</span>
          <button type="button" className={styles.dismiss} onClick={() => setMinted(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
        {minted.clipboardFailed && <p className={styles.copiedUrl}>{minted.url}</p>}
        <p className={styles.copiedNote}>Recipients see only the passages they have permission to read.</p>
      </aside>
    );
  }

  if (!open || open.parts.length === 0) return null;
  const editing = open.minted;
  const last = open.parts.length - 1;
  // Where the drop line draws — nowhere while the slot would leave the held
  // row where it is (either side of it), which would only say "no change".
  const dropSlot =
    drag?.active && drag.to !== null && drag.to !== drag.from && drag.to !== drag.from + 1 ? drag.to : null;

  return (
    <aside
      className={`${styles.tray} ${drag?.active ? styles.trayDragging : ""}`}
      data-testid="anchored-link-tray"
      data-mode={editing ? "editing" : "draft"}
    >
      <div className={styles.headerRow}>
        <span className={styles.title}>{editing ? "Editing link" : "Draft link"}</span>
        <span className={styles.count}>
          {open.parts.length} passage{open.parts.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul
        ref={listRef}
        className={styles.partList}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
      >
        {open.parts.map((part, index) => {
          const held = drag?.active && drag.from === index;
          const dropBefore = dropSlot === index;
          const dropAfter = dropSlot === open.parts.length && index === last;
          return (
            <li
              key={part.anchorId}
              className={[
                styles.partRow,
                held ? styles.dragging : "",
                dropBefore ? styles.dropBefore : "",
                dropAfter ? styles.dropAfter : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-drop={dropBefore ? "before" : dropAfter ? "after" : undefined}
            >
              <button
                type="button"
                className={styles.grip}
                aria-label="Drag to reorder"
                title="Drag to reorder"
                onPointerDown={(event) => handleDragStart(index, event)}
                onKeyDown={(event) => handleGripKey(index, event)}
                disabled={busy}
              >
                <IconGripVertical size={14} />
              </button>
              <span
                className={styles.partText}
                title={part.quotedText}
                onPointerDown={(event) => {
                  // The text is a handle too; the default here would begin
                  // a text selection.
                  event.preventDefault();
                  handleDragStart(index, event);
                }}
              >
                <span className={styles.partLabel}>{part.label}: </span>“
                {part.quotedText.length > SNIPPET_CHARS
                  ? `${part.quotedText.slice(0, SNIPPET_CHARS)}…`
                  : part.quotedText}
                ”
              </span>
              <button
                type="button"
                className={styles.removePart}
                onClick={() => handleRemove(part.anchorId)}
                disabled={busy}
                aria-label={editing ? "Remove this passage from the link" : "Remove this passage from the draft link"}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      {error && <p className={styles.error}>{error}</p>}
      {copied && (
        <p className={copied.clipboardFailed ? styles.copiedUrl : styles.copiedNote}>
          {copied.clipboardFailed ? copied.url : "Link copied."}
        </p>
      )}
      <div className={styles.buttonRow}>
        <button type="button" className={styles.copy} onClick={editing ? handleCopyUrl : handleMint} disabled={busy}>
          Copy link
        </button>
        {editing ? (
          <>
            <Link className={styles.view} href={`/link/${open.id}?noredirect=1`}>
              View
            </Link>
            <button type="button" className={styles.discard} onClick={handleDone} disabled={busy}>
              Done
            </button>
          </>
        ) : (
          <button type="button" className={styles.discard} onClick={handleDiscard} disabled={busy}>
            Discard
          </button>
        )}
      </div>
    </aside>
  );
}
