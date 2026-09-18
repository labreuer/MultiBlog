"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { renderToReactElement } from "@tiptap/static-renderer";
import { loadQuotableTarget, searchQuotableTargets, type QuotableTargetBody, type QuotableTargetHit } from "@/app/actions/comments";
import { commentContentExtensions, contentExtensions } from "@/lib/tiptap-schema";
import type { QuoteRequest } from "./comment-quote-context";
import proseStyles from "@/styles/prose.module.css";
import bodyStyles from "./CommentBody.module.css";
import styles from "./CommentQuotePicker.module.css";

// PLAN.md §23h (Phase 4) — quoting something that is not on the page. A
// search over published posts and public comments (the audience rule's
// admitted set, §23e), then a passage chosen inside the chosen object: the
// body is rendered statically in a panel, the reader selects text there, and
// "Quote selection" hands the composer a request carrying the target — which
// is what lets the server load an off-page target as a match candidate.
//
// §14's doc-link picker and the `[[` doc-ref menu are the precedents; this
// one is a panel under the composer rather than a floating menu, because a
// body to select text in needs room a menu does not have.

type Props = {
  /** The post whose composer this is — never offered as a result (it is on the page already). */
  hostPostId: string;
  onQuote: (request: QuoteRequest) => void;
  onClose: () => void;
};

const SETTLE_MS = 200;

export default function CommentQuotePicker({ hostPostId, onQuote, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<QuotableTargetHit[]>([]);
  const [searching, startSearch] = useTransition();
  const [chosen, setChosen] = useState<QuotableTargetBody | null>(null);
  const [loading, startLoad] = useTransition();
  const [selectedText, setSelectedText] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  // Debounced search on every keystroke past the first two; a shorter query
  // shows nothing (derived below) rather than clearing state in the effect.
  const trimmedQuery = query.trim();
  const searchable = trimmedQuery.length >= 2;
  useEffect(() => {
    if (!searchable) return;
    const timer = window.setTimeout(() => {
      startSearch(async () => {
        setHits(await searchQuotableTargets(trimmedQuery, hostPostId));
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [trimmedQuery, searchable, hostPostId]);
  const visibleHits = searchable ? hits : [];

  // The selection inside the rendered body settles the same way every
  // selection surface here does (CLAUDE.md): selectionchange debounced,
  // pointerup short-circuiting it.
  useEffect(() => {
    if (!chosen) return;
    let timer: number | null = null;
    const settle = () => {
      timer = null;
      const selection = window.getSelection();
      const root = bodyRef.current;
      if (!selection || selection.isCollapsed || !root || selection.rangeCount === 0) {
        setSelectedText("");
        return;
      }
      const range = selection.getRangeAt(0);
      setSelectedText(root.contains(range.commonAncestorContainer) ? selection.toString() : "");
    };
    const onSelectionChange = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(settle, SETTLE_MS);
    };
    const onPointerUp = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(settle, 0);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerup", onPointerUp);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerup", onPointerUp);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [chosen]);

  function choose(hit: QuotableTargetHit) {
    startLoad(async () => {
      setChosen(await loadQuotableTarget(hit.kind, hit.id));
      setSelectedText("");
    });
  }

  // Rendered once per chosen target, never per render. `renderToReactElement`
  // builds a fresh closure for every node and mark type on each call, and
  // those closures are the elements' *types* — so a second call over the
  // same JSON hands React a tree it cannot reconcile with the first, and it
  // unmounts and remounts every DOM node of the body. This component
  // re-renders on every settled selection (`setSelectedText` above), which
  // put that remount in the middle of the reader's drag: the selection's
  // anchor node was removed from the document, the DOM's range-adjustment
  // rule moved that boundary to the body container at offset 0, and the
  // selection grew backwards to the start of the article as the drag went
  // on (docs/TIPTAP.md). Memoising on `chosen` passes React the identical
  // element each time, which it skips outright.
  const rendered = useMemo<ReactNode>(() => {
    if (!chosen) return null;
    try {
      return renderToReactElement({
        content: chosen.body as never,
        extensions: chosen.kind === "post" ? contentExtensions : commentContentExtensions,
      });
    } catch {
      return <p>This {chosen.kind} could not be shown.</p>;
    }
  }, [chosen]);

  return (
    <div className={styles.panel} data-testid="quote-picker">
      <div className={styles.header}>
        <span className={styles.title}>Quote from elsewhere</span>
        <button type="button" onClick={onClose} className={styles.close} aria-label="Close the picker">
          ×
        </button>
      </div>
      {!chosen ? (
        <>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search published posts and comments…"
            aria-label="Search for something to quote"
            className={styles.search}
            autoFocus
          />
          {searching && <p className={styles.note}>Searching…</p>}
          {!searching && searchable && visibleHits.length === 0 && <p className={styles.note}>Nothing public matches.</p>}
          <ul className={styles.results}>
            {visibleHits.map((hit) => (
              <li key={`${hit.kind}:${hit.id}`}>
                <button type="button" onClick={() => choose(hit)} className={styles.result} disabled={loading}>
                  <span className={styles.resultTitle}>
                    {hit.kind === "post" ? hit.title : `${hit.author}'s comment on ${hit.postTitle}`}
                  </span>
                  <span className={styles.resultExcerpt}>{hit.excerpt}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <p className={styles.note}>
            Select the passage of <strong>{chosen.label}</strong> to quote, then press Quote selection.{" "}
            <button type="button" onClick={() => setChosen(null)} className={styles.linkButton}>
              Choose something else
            </button>
          </p>
          <div ref={bodyRef} className={`${styles.body} ${proseStyles.prose} ${bodyStyles.body}`} data-testid="quote-picker-body">
            {rendered}
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={!selectedText.trim()}
              className={styles.quoteButton}
              // mousedown, so the click does not first collapse the selection.
              onMouseDown={(event) => {
                event.preventDefault();
                if (!selectedText.trim()) return;
                onQuote({ target: { kind: chosen.kind, id: chosen.id }, text: selectedText });
                window.getSelection()?.removeAllRanges();
                onClose();
              }}
            >
              Quote selection
            </button>
          </div>
        </>
      )}
    </div>
  );
}
