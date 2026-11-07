"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useEditorState, type Editor } from "@tiptap/react";
import type { PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { autoUpdate, computePosition, offset, shift } from "@floating-ui/dom";
import { POPOVER_GAP, popoverBoundsElement, sideForTallest } from "@/lib/popover-placement";
import styles from "./EditorChrome.module.css";

// A menu that opens on a trigger typed in the text and filters as the typing
// goes on: "[[" for a doc reference (DocRefMenu), "@" for a mention
// (MentionMenu). One component for both, so their keyboard handling,
// placement and focus rules can't drift apart; each menu supplies only its
// trigger, its search, its rows and what picking one inserts.
//
// Built on @tiptap/suggestion, the utility under TipTap's own Mention: it
// owns the trigger, the query and its range, the decoration around them,
// Escape — an exit that remembers the dismissed range, so typing on doesn't
// reopen the menu and a later trigger does — the debounced, abortable items
// fetch, and the composition state an IME puts the view in. What's ours: the
// list itself, rendered from the props its render callbacks hand over; and
// placement, which uses its `clientRect` as the anchor but our own
// computePosition/autoUpdate pass rather than its floating-ui `mount`,
// sharing sideForTallest (src/lib/popover-placement.ts) so the menu follows
// the same tallest-height, pinned-edge rules as the link popover.
//
// The menu is portaled and position: fixed for LinkControls' reasons.

const SEARCH_DEBOUNCE_MS = 150;
// The same tallest as the link popover's list, and placed for it the same
// way: the side is decided from the tallest the menu can be (the shared
// sideForTallest), so results arriving and going never flip it
// (LinkControls on why).
const LIST_MAX_HEIGHT_REM = 17;

/** What a row's renderer is told beside its item. */
export type SuggestionRowContext = {
  /** When the items landed: a row's "edited … ago" is relative to this, so re-renders don't shift it. */
  receivedAt: number;
};

type Session<T> = {
  range: { from: number; to: number };
  query: string;
  items: T[];
  loading: boolean;
  receivedAt: number;
  command: (item: T) => void;
  clientRect: (() => DOMRect | null) | null | undefined;
};

type Props<T> = {
  editor: Editor;
  disabled?: boolean;
  /** One per menu and editor: the plugin is registered and unregistered by it. */
  pluginKey: PluginKey;
  /** What opens the menu. */
  trigger: string;
  /** What may come before the trigger. Null: anything. Suggestion's own default is a space or a line's start. */
  allowedPrefixes?: string[] | null;
  /** The class of the decoration Suggestion keeps on the trigger and query. */
  decorationClass: string;
  /** A further veto on a match, beside "not disabled" and "not in a code block". */
  allow?: (state: EditorState, range: { from: number; to: number }) => boolean;
  search: (query: string) => Promise<T[]>;
  /** Replaces the trigger and query with whatever picking `item` inserts. */
  pick: (editor: Editor, range: { from: number; to: number }, item: T) => void;
  itemKey: (item: T) => string;
  renderRow: (item: T, context: SuggestionRowContext) => ReactNode;
  ariaLabel: string;
  /** A heading over the rows shown for an empty query. */
  emptyQueryHeading?: string;
  /** The line shown when a query matches nothing. Omitted, the menu closes instead. */
  noMatchText?: string;
};

export default function SuggestionMenu<T>({
  editor,
  disabled,
  pluginKey,
  trigger,
  allowedPrefixes,
  decorationClass,
  allow,
  search,
  pick,
  itemKey,
  renderRow,
  ariaLabel,
  emptyQueryHeading,
  noMatchText,
}: Props<T>) {
  // The live suggestion, as its render callbacks last reported it; null
  // between triggers.
  const [session, setSession] = useState<Session<T> | null>(null);
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
  const allowRef = useRef(allow);
  const searchRef = useRef(search);
  const pickRef = useRef(pick);
  useEffect(() => {
    disabledRef.current = disabled;
    allowRef.current = allow;
    searchRef.current = search;
    pickRef.current = pick;
  });
  const keyRef = useRef<(props: SuggestionKeyDownProps) => boolean>(() => false);

  const { items = [], query = "", loading = false } = session ?? {};
  // The no-match line only for a query whose own answer is in — never while
  // an earlier answer is standing in — so the line doesn't flash mid-word.
  const noMatch = noMatchText !== undefined && !loading && items.length === 0 && query !== "";
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
        const item = items[activeIndex];
        if (!item) return false;
        session.command(item);
        return true;
      }
      return false;
    };
  });

  // The plugin, once per editor. It is *prepended*, ahead of
  // the keymaps, so Enter reaches the menu before the base keymap splits
  // the paragraph — the same reason LinkControls prepends its Ctrl-K.
  useEffect(() => {
    const toSession = (props: SuggestionProps<T, T>): Session<T> => ({
      range: props.range,
      query: props.query,
      items: props.items,
      loading: props.loading,
      receivedAt: Date.now(),
      command: props.command,
      clientRect: props.clientRect,
    });
    editor.registerPlugin(
      Suggestion<T, T>({
        pluginKey,
        editor,
        char: trigger,
        allowSpaces: true,
        ...(allowedPrefixes !== undefined ? { allowedPrefixes } : {}),
        decorationClass,
        debounce: SEARCH_DEBOUNCE_MS,
        // Never a context: a code block, where the trigger is code.
        allow: ({ state, range }) =>
          !disabledRef.current &&
          !state.selection.$from.parent.type.spec.code &&
          (allowRef.current?.(state, range) ?? true),
        items: ({ query: q }) => searchRef.current(q),
        command: ({ editor: e, range, props: item }) => pickRef.current(e, range, item),
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
      editor.unregisterPlugin(pluginKey);
    };
    // The trigger, prefixes and decoration class are a menu's constants; the
    // callbacks are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, pluginKey]);

  // Keep the keyboard highlight in view.
  useEffect(() => {
    if (!visible) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [visible, activeIndex, listId]);

  // Under the trigger — Suggestion's clientRect is the decoration it keeps on
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
      aria-label={ariaLabel}
      className={`${styles.docRefMenu} ${styles.linkResults}`}
      style={{ maxHeight: `${LIST_MAX_HEIGHT_REM}rem` }}
      // The editor keeps focus through a click on a row: its blur would take
      // the menu away before the click landed.
      onMouseDown={(e) => e.preventDefault()}
    >
      {noMatch ? (
        <div role="presentation" className={styles.docRefEmpty}>
          {noMatchText}
        </div>
      ) : (
        <>
          {query === "" && emptyQueryHeading && (
            <div role="presentation" className={styles.linkResultsHeading}>
              {emptyQueryHeading}
            </div>
          )}
          {items.map((item, index) => (
            <button
              key={itemKey(item)}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              tabIndex={-1}
              className={index === activeIndex ? `${styles.linkResult} ${styles.linkResultActive}` : styles.linkResult}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => session.command(item)}
            >
              {renderRow(item, { receivedAt: session.receivedAt })}
            </button>
          ))}
        </>
      )}
    </div>,
    document.body,
  );
}
