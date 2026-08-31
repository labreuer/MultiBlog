"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditorState, type Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { searchLinkableDocs } from "@/app/actions/docs";
import type { LinkableDocJson } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { relativeTime } from "@/lib/relative-time";
import { autoUpdate, computePosition, offset, shift } from "@floating-ui/dom";
import { POPOVER_GAP, popoverBoundsElement, sideForTallest } from "@/lib/popover-placement";
import styles from "./EditorChrome.module.css";

// "[[" at the caret opens a menu of readable docs that filters as you keep
// typing; Enter (or a click) replaces "[[" and the query with the chosen
// doc's title, linked to /doc/<slug>. The Obsidian / Roam / Notion gesture
// for dropping a reference into running text, and the other half of the
// link popover (LinkControls): Ctrl-K is for linking text you already have,
// this is for a reference you don't have text for yet — the query is
// transient, understood to be replaced, which is what the popover's title
// box could never assume.
//
// Built on @tiptap/suggestion, the utility under TipTap's own Mention: it
// owns the trigger (a "[[" in the text node before the caret, spaces
// allowed in the query, any prefix), the query and its range, the
// decoration around them, Escape — an exit that remembers the dismissed
// range, so typing on doesn't reopen the menu and a later "[[" does — the
// debounced, abortable items fetch, and the composition state an IME puts
// the view in. What's ours: `allow`, which keeps a closed "[[a]]" and a
// code block from being a context; the list itself, rendered from the
// props its render callbacks hand over; and placement, which uses its
// `clientRect` as the anchor but our own computePosition/autoUpdate pass
// rather than its floating-ui `mount`, sharing sideForTallest
// (src/lib/popover-placement.ts) so the menu follows the same
// tallest-height, pinned-edge rules as the link popover.
//
// What's typed right after a pick is kept out of the link. TipTap's Link is
// inclusive while autolink is on, and a reference dropped mid-sentence is
// always followed by more sentence — which would otherwise join the link.
// Clearing the stored marks on the pick isn't enough: ProseMirror drops
// stored marks on any step, and AuthorHighlight's appendTransaction adds
// its steps in the same dispatch. So a second, tiny plugin remembers where
// the link ends (`plainAt`), and its appendTransaction strips the link mark
// from whatever lands there next, then forgets. The menu is portaled and
// position: fixed for LinkControls' reasons.
const TRIGGER = "[[";
const CLOSE = "]]";
const SEARCH_DEBOUNCE_MS = 150;
// The same tallest as the link popover's list, and placed for it the same
// way: the side is decided from the tallest the menu can be (the shared
// sideForTallest), so results arriving and going never flip it
// (LinkControls on why).
const LIST_MAX_HEIGHT_REM = 17;

const suggestionKey = new PluginKey("docRefSuggestion");
const plainAfterKey = new PluginKey<number | null>("docRefPlainAfter");

type Session = {
  range: { from: number; to: number };
  query: string;
  items: LinkableDocJson[];
  loading: boolean;
  // When the items landed — the rows' "edited … ago" is relative to this,
  // taken then rather than at render, so re-renders don't shift it and
  // Date.now() stays off the render path.
  receivedAt: number;
  command: (doc: LinkableDocJson) => void;
  clientRect: (() => DOMRect | null) | null | undefined;
};

// Where a just-picked link ends, until something is typed there.
function plainAfterPlugin(): Plugin<number | null> {
  return new Plugin<number | null>({
    key: plainAfterKey,
    state: {
      init: () => null,
      apply(tr, prev, _old, newState) {
        const meta = tr.getMeta(plainAfterKey) as number | null | undefined;
        if (meta !== undefined) return meta;
        if (prev === null) return null;
        // Stays put under an insertion at itself (assoc -1), and is
        // forgotten the moment the caret goes anywhere else.
        const plainAt = tr.docChanged ? tr.mapping.map(prev, -1) : prev;
        const caret = newState.selection.from;
        if (caret < plainAt || (tr.selectionSet && !tr.docChanged && caret !== plainAt)) return null;
        return plainAt;
      },
    },
    // Text that just landed at plainAt came in wearing the link (Link is
    // inclusive): take the mark off it. One character is enough — what
    // follows inherits from that plain character.
    appendTransaction(transactions, _old, newState) {
      const plainAt = plainAfterKey.getState(newState) ?? null;
      if (plainAt === null || !transactions.some((tr) => tr.docChanged)) return null;
      const to = newState.selection.from;
      if (to <= plainAt) return null;
      const link = newState.schema.marks.link;
      const tr = newState.tr.setMeta(plainAfterKey, null);
      if (link && newState.doc.rangeHasMark(plainAt, to, link)) tr.removeMark(plainAt, to, link);
      return tr;
    },
  });
}

export default function DocRefMenu({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  // The live suggestion, as its render callbacks last reported it; null
  // between "[["s.
  const [session, setSession] = useState<Session | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // The suggestion stays active across a blur (its match is still in the
  // text); the menu shouldn't. TipTap's FocusEvents dispatches on focus and
  // blur, which is what makes this a selector rather than a listener.
  const focused = useEditorState({ editor, selector: ({ editor: e }) => e.isFocused });
  const listId = useId();
  const menuRef = useRef<HTMLDivElement>(null);

  // Read by the plugin's callbacks, which are created once per editor and
  // would otherwise close over the first render's props and state.
  const disabledRef = useRef(disabled);
  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);
  const keyRef = useRef<(props: SuggestionKeyDownProps) => boolean>(() => false);

  const { items = [], query = "", loading = false } = session ?? {};
  // "No docs match" only for a query whose own answer is in — never while
  // an earlier answer is standing in — so the line doesn't flash mid-word.
  const noMatch = !loading && items.length === 0 && query !== "";
  const visible = session !== null && focused && (items.length > 0 || noMatch);

  useEffect(() => {
    keyRef.current = ({ event, view }) => {
      // Mid-composition (an IME building a character) Enter and Escape
      // belong to the IME — confirm or cancel the candidate — not to the
      // menu. Escape itself is Suggestion's: it exits and records the
      // dismissal before this is even asked.
      if (view.composing || !session || !visible || items.length === 0) return false;
      if (event.key === "ArrowDown") {
        setActiveIndex((i) => Math.min(i + 1, items.length - 1));
        return true;
      }
      if (event.key === "ArrowUp") {
        setActiveIndex((i) => Math.max(i - 1, 0));
        return true;
      }
      if (event.key === "Enter") {
        const doc = items[activeIndex];
        if (!doc) return false;
        session.command(doc);
        return true;
      }
      return false;
    };
  });

  // Both plugins, once per editor. Suggestion's is *prepended*, ahead of
  // the keymaps, so Enter reaches the menu before the base keymap splits
  // the paragraph — the same reason LinkControls prepends its Ctrl-K.
  useEffect(() => {
    const toSession = (props: SuggestionProps<LinkableDocJson, LinkableDocJson>): Session => ({
      range: props.range,
      query: props.query,
      items: props.items,
      loading: props.loading,
      receivedAt: Date.now(),
      command: props.command,
      clientRect: props.clientRect,
    });
    editor.registerPlugin(plainAfterPlugin());
    editor.registerPlugin(
      Suggestion<LinkableDocJson, LinkableDocJson>({
        pluginKey: suggestionKey,
        editor,
        char: TRIGGER,
        allowSpaces: true,
        // Anywhere, not only after a space: "word[[" is as good a place to
        // drop a reference as " [[".
        allowedPrefixes: null,
        decorationClass: "doc-ref-query",
        debounce: SEARCH_DEBOUNCE_MS,
        // Not a context: a pair already closed ("[[a]]x" — Suggestion's
        // match runs to the caret and would carry the "]]" in its query),
        // or a code block, where brackets are code.
        allow: ({ state, range }) =>
          !disabledRef.current &&
          !state.selection.$from.parent.type.spec.code &&
          !state.doc.textBetween(range.from, range.to).includes(CLOSE),
        items: ({ query: q }) => searchLinkableDocs(q),
        command: ({ editor: e, range, props: doc }) => {
          e.chain()
            .focus()
            .insertContentAt(range, {
              type: "text",
              text: docTitleOrFallback(doc.title),
              marks: [{ type: "link", attrs: { href: `/doc/${doc.slug}` } }],
            })
            .command(({ tr }) => {
              tr.setMeta(plainAfterKey, tr.selection.from);
              return true;
            })
            .run();
        },
        render: () => ({
          onStart: (props) => {
            setSession(toSession(props));
            setActiveIndex(0);
          },
          // Suggestion reports every keystroke twice: at once with no
          // items and `loading`, then with the answer once the debounce
          // and the fetch are through. Showing the interim would blank
          // the menu for that whole gap on every keystroke, so the rows
          // shown are the last real answer until the next one lands —
          // and the highlight only resets then.
          onUpdate: (props) => {
            setSession((prev) =>
              props.loading && prev ? { ...toSession(props), items: prev.items, receivedAt: prev.receivedAt } : toSession(props),
            );
            if (!props.loading) setActiveIndex(0);
          },
          onExit: () => setSession(null),
          onKeyDown: (props) => keyRef.current(props),
        }),
      }),
      (plugin, plugins) => [plugin, ...plugins],
    );
    return () => {
      if (editor.isDestroyed) return;
      editor.unregisterPlugin(suggestionKey);
      editor.unregisterPlugin(plainAfterKey);
    };
  }, [editor]);

  // Keep the keyboard highlight in view.
  useEffect(() => {
    if (!visible) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [visible, activeIndex, listId]);

  // Under the "[[" — Suggestion's clientRect is the decoration it keeps on
  // the query. floating-ui places the menu: offset is the standard gap,
  // sideForTallest decides the side for the tallest the menu can be, and
  // shift slides it back inside its bounds on both axes. A top-placed menu
  // is laid out from the anchor up, so its bottom edge stays pinned to the
  // text while growth lands above — autoUpdate re-places on ancestor
  // scroll/resize and, via ResizeObserver, as rows arrive and go.
  // computePosition's answer lands in a microtask, before the newly
  // portaled menu first paints, so nothing provisional is ever shown.
  const from = session?.range.from ?? null;
  const clientRect = session?.clientRect;
  useLayoutEffect(() => {
    if (!visible || from === null) return;
    const menu = menuRef.current;
    if (!menu) return;
    let lastRect = new DOMRect(0, 0, 0, 0);
    const reference = {
      getBoundingClientRect: () => {
        const rect = clientRect?.();
        if (rect) {
          lastRect = rect;
        } else {
          try {
            const coords = editor.view.coordsAtPos(from);
            lastRect = new DOMRect(coords.left, coords.top, 0, coords.bottom - coords.top);
          } catch {
            // A position the current document can't resolve: hold the last
            // spot rather than jumping somewhere wrong.
          }
        }
        return lastRect;
      },
      contextElement: editor.view.dom,
    };
    const boundary = popoverBoundsElement(editor.view.dom);
    const update = () => {
      void computePosition(reference, menu, {
        strategy: "fixed",
        placement: "bottom-start",
        middleware: [
          offset({ mainAxis: POPOVER_GAP, crossAxis: POPOVER_GAP }),
          sideForTallest(() => {
            const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
            return LIST_MAX_HEIGHT_REM * rem;
          }),
          shift({ crossAxis: true, boundary }),
        ],
      }).then(({ x, y }) => {
        Object.assign(menu.style, { left: `${x}px`, top: `${y}px` });
      });
    };
    return autoUpdate(reference, menu, update);
  }, [visible, from, clientRect, editor]);

  if (!visible || !session) return null;

  return createPortal(
    <div
      ref={menuRef}
      id={listId}
      role="listbox"
      aria-label="Docs"
      className={`${styles.docRefMenu} ${styles.linkResults}`}
      style={{ maxHeight: `${LIST_MAX_HEIGHT_REM}rem` }}
      // The editor keeps focus through a click on a row: its blur would take
      // the menu away before the click landed.
      onMouseDown={(e) => e.preventDefault()}
    >
      {noMatch ? (
        <div role="presentation" className={styles.docRefEmpty}>
          No docs match
        </div>
      ) : (
        <>
          {query === "" && (
            <div role="presentation" className={styles.linkResultsHeading}>
              Recently edited
            </div>
          )}
          {items.map((doc, index) => (
            <button
              key={doc.id}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              tabIndex={-1}
              className={index === activeIndex ? `${styles.linkResult} ${styles.linkResultActive}` : styles.linkResult}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => session.command(doc)}
            >
              <span className={styles.linkResultTitle}>{docTitleOrFallback(doc.title)}</span>
              <span className={styles.linkResultMeta}>Edited {relativeTime(doc.updatedAt, session.receivedAt)}</span>
            </button>
          ))}
        </>
      )}
    </div>,
    document.body,
  );
}
