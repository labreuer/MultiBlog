"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ancestorIdsOf,
  defaultExpanded,
  levelPositions,
  visibleAncestorOf,
  visibleOrder,
  type OutlineNode,
} from "@/lib/pdf-outline";
import { pageLabelFor } from "@/lib/pdf-page-labels";
import type { PdfOutlineState } from "./use-pdf-outline";
import styles from "./PdfOutline.module.css";

// PLAN.md §19b — the Contents tab of /pdf/[slug]'s side panel.
//
// The document's own outline, as a tree that expands, jumps, and says where the
// reader is. Every *rule* it renders comes from src/lib/pdf-outline.ts; this
// component owns three things that are genuinely its own: which rows are open,
// which row has keyboard focus, and when to scroll the highlighted row into
// view.
//
// **Expansion lives here, not in the surface.** The highlight the reader sees
// is a function of the active row *and* the expanded set — a collapsed
// "Chapter 4" is what lights up while you read §4.2 — so keeping both on this
// side means the surface hands over one id and never has to know what the tree
// is currently showing.

/**
 * How long after the reader touches this pane its own scroll position is left
 * alone.
 *
 * Without it, scrolling the *document* while browsing the *contents* yanks the
 * list back to the current section under the reader's pointer. With it, the two
 * only fight if they are used in the same second and a half.
 */
const INTERACTION_QUIET_MS = 1500;

type Props = {
  state: PdfOutlineState;
  /**
   * The entry the reader is inside, from the surface's reading line — the *real*
   * one, before collapsed subtrees are taken into account. Which row shows the
   * highlight is this component's answer (`visibleAncestorOf`).
   */
  activeId: string | null;
  /** Jump the viewer to an entry's destination. */
  onJumpTo: (node: OutlineNode) => void;
  /**
   * What the document calls its pages (PLAN.md §19c), or null for the ordinary
   * 1…N. A contents list showing "4" against a sheet the book itself calls "iv"
   * is the exact thing a table of contents exists not to make the reader do.
   */
  pageLabels: string[] | null;
  /**
   * Whether this pane is the selected tab. Auto-scrolling a hidden pane is
   * wasted work, and worse, `scrollIntoView` inside a `display: none` subtree
   * silently does nothing — so a highlight change that happened while the tab
   * was elsewhere has to be re-applied when it comes back, which the effect
   * below gets by depending on this.
   */
  visible: boolean;
};

/**
 * What the reader has done to the tree, remembered **against the outline it was
 * done to**.
 *
 * Keyed rather than reset in an effect: a new document's rows would otherwise
 * render for one frame against the old document's open set, and correcting that
 * costs a cascading render. The seed is the PDF's own open/closed hints, and it
 * is never merged with what the reader had open — the only thing that replaces
 * `nodes` here is a different file.
 */
type TreeState = {
  nodes: readonly OutlineNode[];
  expanded: ReadonlySet<string>;
  focusedId: string | null;
};

export default function PdfOutlinePanel({ state, activeId, onJumpTo, pageLabels, visible }: Props) {
  const { status, nodes } = state;
  const [tree, setTree] = useState<TreeState | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const interactedAtRef = useRef(0);

  const seeded = useMemo(() => defaultExpanded(nodes), [nodes]);
  const current: TreeState = tree?.nodes === nodes ? tree : { nodes, expanded: seeded, focusedId: null };
  const { expanded, focusedId } = current;

  const positions = useMemo(() => levelPositions(nodes), [nodes]);
  const rows = useMemo(() => visibleOrder(nodes, expanded), [nodes, expanded]);
  const highlightId = activeId === null ? null : visibleAncestorOf(activeId, expanded);
  const chainIds = useMemo(() => new Set(activeId === null ? [] : ancestorIdsOf(activeId)), [activeId]);

  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (!next.delete(id)) next.add(id);
    setTree({ ...current, expanded: next });
  };
  const setFocusedId = (id: string | null) => setTree({ ...current, focusedId: id });

  const rowElement = useCallback(
    (id: string) => treeRef.current?.querySelector<HTMLElement>(`[data-outline-id="${CSS.escape(id)}"]`) ?? null,
    [],
  );

  // Scroll the highlighted row into view — but only if the reader isn't
  // currently working in this pane, and never past `nearest`, which is a no-op
  // when the row is already on screen.
  useEffect(() => {
    if (!visible || highlightId === null) return;
    if (Date.now() - interactedAtRef.current < INTERACTION_QUIET_MS) return;
    rowElement(highlightId)?.scrollIntoView({ block: "nearest" });
  }, [highlightId, visible, rowElement]);

  // Roving tabindex: the tree is one tab stop and the arrow keys move inside
  // it, the same pattern (and the same reasoning) as PdfViewer's tab strip.
  // Where the tab stop sits when nothing has been focused yet is the *current*
  // row, so tabbing in lands a reader where they are reading rather than at the
  // top of a 300-entry list.
  const focusTarget =
    (focusedId !== null && rows.some((row) => row.id === focusedId) ? focusedId : null) ??
    (highlightId !== null && rows.some((row) => row.id === highlightId) ? highlightId : null) ??
    rows[0]?.id ??
    null;

  const focusRow = (id: string) => {
    setFocusedId(id);
    rowElement(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    interactedAtRef.current = Date.now();
    if (focusTarget === null) return;
    const index = rows.findIndex((row) => row.id === focusTarget);
    if (index === -1) return;
    const node = rows[index];

    switch (event.key) {
      case "ArrowDown":
        if (index + 1 < rows.length) focusRow(rows[index + 1].id);
        break;
      case "ArrowUp":
        if (index > 0) focusRow(rows[index - 1].id);
        break;
      case "ArrowRight":
        // Open, then step in — the APG tree pattern: one press reveals the
        // children, the next moves to the first of them. (After the first,
        // `rows` is a render behind, so stepping in waits for the next press
        // rather than guessing at a list that hasn't been rebuilt.)
        if (node.hasChildren && !expanded.has(node.id)) toggle(node.id);
        else if (node.hasChildren && index + 1 < rows.length) focusRow(rows[index + 1].id);
        break;
      case "ArrowLeft":
        if (node.hasChildren && expanded.has(node.id)) toggle(node.id);
        else if (node.parentId !== null) focusRow(node.parentId);
        break;
      case "Home":
        if (rows.length > 0) focusRow(rows[0].id);
        break;
      case "End":
        if (rows.length > 0) focusRow(rows[rows.length - 1].id);
        break;
      case "Enter":
      case " ":
        onJumpTo(node);
        break;
      default:
        return;
    }
    // Only for the keys the switch handled — `default` returns above. Space and
    // the arrows scroll the pane otherwise, which would fight the movement.
    event.preventDefault();
  };

  if (status === "loading") {
    return <p className={styles.notice}>Reading the table of contents…</p>;
  }
  if (status === "error") {
    return <p className={styles.notice}>This PDF&apos;s table of contents couldn&apos;t be read.</p>;
  }
  if (status === "absent" || nodes.length === 0) {
    // Most PDFs have none. Said plainly rather than left blank, so the tab
    // reads as answered rather than as broken.
    return <p className={styles.notice}>This PDF has no table of contents.</p>;
  }

  return (
    // **Flat, not nested.** Every visible row is a sibling, with
    // `aria-level`/`aria-posinset`/`aria-setsize` carrying the shape ARIA would
    // otherwise read off nested `role="group"` elements. Nesting them would put
    // the focus ring around a row *and* its entire subtree, and make each
    // level's indentation compound with every ancestor's padding.
    <div
      ref={treeRef}
      role="tree"
      aria-label="Table of contents"
      className={styles.tree}
      onKeyDown={onKeyDown}
      onPointerDown={() => {
        interactedAtRef.current = Date.now();
      }}
      onWheel={() => {
        interactedAtRef.current = Date.now();
      }}
    >
      {rows.map((node) => {
        const open = expanded.has(node.id);
        const isHighlight = node.id === highlightId;
        // The chain above the highlight gets a quieter mark of its own: it says
        // "the current section is somewhere under here" without competing with
        // the row that actually carries the position.
        const onChain = !isHighlight && chainIds.has(node.id);
        const place = positions.get(node.id);

        return (
          <div
            key={node.id}
            role="treeitem"
            aria-level={node.depth + 1}
            aria-posinset={place?.posInSet}
            aria-setsize={place?.setSize}
            aria-expanded={node.hasChildren ? open : undefined}
            // "location" rather than "true": this says where in the document
            // the reader is, not which step of a process is current.
            aria-current={isHighlight ? "location" : undefined}
            // Required of a treeitem, and the honest answer here: this tree's
            // "selection" is the place in the document the reader is at.
            aria-selected={isHighlight}
            data-outline-id={node.id}
            data-outline-depth={node.depth}
            tabIndex={node.id === focusTarget ? 0 : -1}
            className={`${styles.item} ${isHighlight ? styles.current : ""} ${onChain ? styles.onChain : ""}`}
            style={{ paddingLeft: `${0.4 + node.depth * 0.85}rem` }}
            onFocus={() => setFocusedId(node.id)}
            onClick={() => {
              interactedAtRef.current = Date.now();
              onJumpTo(node);
            }}
          >
            {/* Not a <button>: a treeitem may not contain interactive
                descendants, or a screen reader announces two things where the
                reader sees one row. Keyboard users open and close with the
                arrow keys (the APG pattern); this is the pointer affordance for
                the same act, and stopping propagation is what keeps opening a
                chapter from also jumping to it. */}
            <span
              className={`${styles.twisty} ${node.hasChildren ? "" : styles.twistyEmpty}`}
              aria-hidden="true"
              onClick={(event) => {
                if (!node.hasChildren) return;
                event.stopPropagation();
                interactedAtRef.current = Date.now();
                toggle(node.id);
              }}
            >
              {node.hasChildren ? (open ? "▾" : "▸") : ""}
            </span>

            <span className={styles.title}>{node.title || "Untitled"}</span>

            {/* The page number earns its place: it is how a reader decides
                whether a jump is worth making, and how they find the same spot
                in a printed copy. Absent when the destination didn't resolve —
                which is also exactly when the row can't be highlighted. */}
            {node.position && (
              <span className={styles.page}>{pageLabelFor(pageLabels, node.position.pageIndex)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
