"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import {
  discardDraftLink,
  loadMyDraftLink,
  mintAnchoredLink,
  removeAnchoredLinkPart,
  type DraftLinkView,
} from "@/app/actions/anchored-links";
import { onAnchoredLinkChanged } from "@/lib/anchored-link-tray-events";
import styles from "./AnchoredLinkTray.module.css";

// docs/ANCHORED_LINKS.md — the draft-link tray. Mounted by both reading
// pages as a self-fetching sibling: it asks the server for the viewer's
// draft on mount and again on every tray-events notify, and the server row
// IS the cross-page persistence — navigate from a doc to a PDF and the
// tray re-fetches the same draft there. Renders nothing when there is no
// draft (or an empty one), so mounting it unconditionally costs one action
// round trip and no pixels.
//
// Deliberately not fed by props or router.refresh(): on the PDF page the
// part-adding popover lives inside an ssr:false island (CLAUDE.md's
// refresh trap), and this island fetching its own state is the same answer
// loadPdfAnnotationEntries already gives that problem.

const SNIPPET_CHARS = 60;

export default function AnchoredLinkTray() {
  const [draft, setDraft] = useState<DraftLinkView | null>(null);
  const [copied, setCopied] = useState<{ url: string; clipboardFailed: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const refresh = useCallback(() => {
    loadMyDraftLink()
      .then(setDraft)
      // Quiet: the tray simply keeps what it shows; the next notify retries.
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    return onAnchoredLinkChanged(refresh);
  }, [refresh]);

  function handleRemove(anchorId: string) {
    setError(null);
    startTransition(async () => {
      const result = await removeAnchoredLinkPart(anchorId);
      if (result.error) setError(result.error);
      refresh();
    });
  }

  function handleDiscard() {
    setError(null);
    startTransition(async () => {
      await discardDraftLink();
      setDraft(null);
    });
  }

  function handleCopy() {
    setError(null);
    startTransition(async () => {
      const result = await mintAnchoredLink();
      if ("error" in result) {
        setError(result.error);
        refresh();
        return;
      }
      // Minted before the clipboard is touched, so a clipboard-permission
      // failure still leaves a shareable URL — shown as text instead.
      let clipboardFailed = false;
      try {
        await navigator.clipboard.writeText(result.url);
      } catch {
        clipboardFailed = true;
      }
      setCopied({ url: result.url, clipboardFailed });
      setDraft(null);
    });
  }

  if (copied) {
    return (
      <aside className={styles.tray} data-testid="anchored-link-tray">
        <div className={styles.headerRow}>
          <span className={styles.title}>{copied.clipboardFailed ? "Link minted" : "Link copied"}</span>
          <button type="button" className={styles.dismiss} onClick={() => setCopied(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
        {copied.clipboardFailed && <p className={styles.copiedUrl}>{copied.url}</p>}
        <p className={styles.copiedNote}>Recipients see only the passages they have permission to read.</p>
      </aside>
    );
  }

  if (!draft || draft.parts.length === 0) return null;

  return (
    <aside className={styles.tray} data-testid="anchored-link-tray">
      <div className={styles.headerRow}>
        <span className={styles.title}>Draft link</span>
        <span className={styles.count}>
          {draft.parts.length} passage{draft.parts.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className={styles.partList}>
        {draft.parts.map((part) => (
          <li key={part.anchorId} className={styles.partRow}>
            <span className={styles.partText} title={part.quotedText}>
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
              aria-label="Remove this passage from the draft link"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.buttonRow}>
        <button type="button" className={styles.copy} onClick={handleCopy} disabled={busy}>
          Copy link
        </button>
        <button type="button" className={styles.discard} onClick={handleDiscard} disabled={busy}>
          Discard
        </button>
      </div>
    </aside>
  );
}
