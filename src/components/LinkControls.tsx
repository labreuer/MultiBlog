"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { IconLink } from "@tabler/icons-react";
import { searchLinkableDocs } from "@/app/actions/docs";
import type { ReadableDoc } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import {
  placePopover,
  popoverBoundsFor,
  provisionalPlacement,
  type PopoverAnchor,
  type PopoverPlacement,
} from "@/lib/popover-placement";
import styles from "./EditorChrome.module.css";

// The toolbar's link button and its popover: one text box that is either a
// URL (saved as typed) or a search over readable docs' titles (picking a
// result links to /doc/<slug>). Anything starting with http:// or https://
// is taken as a URL and never searched.
//
// The popover is portaled to <body>: on phones the toolbar is a sideways
// scroller with an edge-fade mask (EditorChrome.module.css), and a mask
// applies to every descendant — position: fixed included — so left in the
// toolbar's subtree the popover would be faded out wherever it hangs past
// the toolbar's box. Same reason QuoteControls' menu is portaled.
const URL_LIKE = /^https?:\/\//i;

// A search fires SEARCH_DEBOUNCE_MS after the last keystroke, or on every
// KEYS_PER_FORCED_SEARCH-th keystroke since the last search if the debounce
// hasn't fired yet — so a steady typist still sees results roll in.
const SEARCH_DEBOUNCE_MS = 150;
const KEYS_PER_FORCED_SEARCH = 3;

// Where the popover hangs from. Opened by Ctrl/⌘-K it sits under the
// selection's end (`anchorPos`), the same spot the annotation popover
// takes — below the whole selection rather than over it; opened by the
// toolbar button it hangs under the button. Live coordinates each call,
// since the selection scrolls with the editor's own text box.
function anchorFor(editor: Editor, anchorPos: number | null, button: HTMLButtonElement | null): PopoverAnchor | null {
  if (anchorPos !== null) {
    try {
      return editor.view.coordsAtPos(anchorPos);
    } catch {
      // A position the document can't resolve any more (a collaborator's
      // edit under an open popover): fall through to the button.
    }
  }
  const rect = button?.getBoundingClientRect();
  return rect ? { top: rect.top, bottom: rect.bottom, left: rect.left } : null;
}

// The result list's query-match emphasis. Case-insensitive, first
// occurrence only, and only when lowercasing changed no string's length --
// a few scripts lowercase to a different length, which would put the
// <strong> on the wrong characters.
function emphasizeMatch(title: string, query: string): ReactNode {
  const lowerTitle = title.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery || lowerTitle.length !== title.length || lowerQuery.length !== query.length) return title;
  const at = lowerTitle.indexOf(lowerQuery);
  if (at < 0) return title;
  return (
    <>
      {title.slice(0, at)}
      <strong>{title.slice(at, at + query.length)}</strong>
      {title.slice(at + query.length)}
    </>
  );
}

function isLinkShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
}

export default function LinkControls({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  // Whether the selection carried a link when the popover opened — decides
  // Remove vs. Cancel. Captured at open time: applying either button closes
  // the popover, so it can't go stale while visible.
  const [hadLink, setHadLink] = useState(false);
  // The docs alongside the query that produced them, so the emphasis in the
  // list matches what was actually searched rather than what has been typed
  // since the request went out.
  const [results, setResults] = useState<{ query: string; docs: ReadableDoc[] }>({ query: "", docs: [] });
  // Keyboard highlight in the result list; -1 is "none" (Enter saves the
  // typed text instead of picking a doc).
  const [activeIndex, setActiveIndex] = useState(-1);
  const [anchorPos, setAnchorPos] = useState<number | null>(null);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Guards against out-of-order search responses: only the newest request's
  // result is allowed to land. Bumped on open/close too, so a response still
  // in flight when the popover closes can't populate a reopened one.
  const searchSeqRef = useRef(0);
  const searchTimerRef = useRef<number | null>(null);
  const keysSinceSearchRef = useRef(0);

  const cancelPendingSearch = useCallback(() => {
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }
  }, []);
  useEffect(() => cancelPendingSearch, [cancelPendingSearch]);

  const close = useCallback(() => {
    cancelPendingSearch();
    searchSeqRef.current += 1;
    setOpen(false);
    setPlacement(null);
    setAnchorPos(null);
  }, [cancelPendingSearch]);

  const openPopover = (atSelection: boolean) => {
    if (disabled) return;
    const pos = atSelection ? editor.state.selection.to : null;
    const anchor = anchorFor(editor, pos, buttonRef.current);
    if (!anchor) return;
    setAnchorPos(pos);
    setPlacement(provisionalPlacement(anchor));
    setValue((editor.getAttributes("link").href as string | undefined) ?? "");
    setHadLink(editor.isActive("link"));
    cancelPendingSearch();
    searchSeqRef.current += 1;
    keysSinceSearchRef.current = 0;
    setResults({ query: "", docs: [] });
    setActiveIndex(-1);
    setOpen(true);
  };

  // Read by the shortcut plugin, which is registered once per editor and
  // would otherwise close over the first render's openPopover.
  const openAtSelectionRef = useRef<() => void>(() => {});
  useEffect(() => {
    openAtSelectionRef.current = () => openPopover(true);
  });

  // Ctrl-K / ⌘-K, as a ProseMirror plugin *prepended* to the editor's list
  // rather than a DOM listener: it has to run before the keymaps, since on
  // macOS ProseMirror's base keymap binds Ctrl-K to "delete to end of line"
  // and would have eaten the text before a bubbling listener saw the key.
  // Returning true is what makes ProseMirror preventDefault the browser's
  // own Ctrl/⌘-K (address bar, search).
  useEffect(() => {
    const key = new PluginKey("linkShortcut");
    editor.registerPlugin(
      new Plugin({
        key,
        props: {
          handleKeyDown: (_view, event) => {
            if (!isLinkShortcut(event)) return false;
            openAtSelectionRef.current();
            return true;
          },
        },
      }),
      (plugin, plugins) => [plugin, ...plugins],
    );
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(key);
    };
  }, [editor]);

  // Same dismissal pair as QuoteControls: click outside the container, or
  // Escape anywhere.
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      close();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, close]);

  const runSearch = (query: string) => {
    cancelPendingSearch();
    keysSinceSearchRef.current = 0;
    const seq = ++searchSeqRef.current;
    void searchLinkableDocs(query).then((found) => {
      if (searchSeqRef.current !== seq) return;
      setResults({ query, docs: found });
      setActiveIndex(-1);
    });
  };

  // The doc search is driven from here rather than an effect on `value`, so
  // the debounce and the every-Nth-keystroke path share one timer and a
  // forced search cancels the pending debounced one instead of both firing.
  // URL-shaped input is never searched — it's a URL, not a title query.
  const handleChange = (next: string) => {
    setValue(next);
    setActiveIndex(-1);
    cancelPendingSearch();
    const query = next.trim();
    if (!query || URL_LIKE.test(query)) {
      keysSinceSearchRef.current = 0;
      setResults({ query: "", docs: [] });
      return;
    }
    keysSinceSearchRef.current += 1;
    if (keysSinceSearchRef.current >= KEYS_PER_FORCED_SEARCH) {
      runSearch(query);
    } else {
      searchTimerRef.current = window.setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
    }
  };

  // Two-phase placement, the popover-placement.ts bootstrap: openPopover
  // paints the unclamped provisional spot, this measures the rendered box
  // and placePopover slides/flips it inside bounds. Re-runs as the result
  // list grows and shrinks (the height being fitted changes) and on
  // scroll/resize, since a selection anchor moves with the editor's text
  // box. Capture phase for scroll: the editor's own scroller is what
  // scrolls, not the window, and an inner element's scroll doesn't bubble.
  useLayoutEffect(() => {
    if (!open) return;
    function reposition() {
      const popover = popoverRef.current;
      const anchor = anchorFor(editor, anchorPos, buttonRef.current);
      if (!popover || !anchor) return;
      // The result list is absolutely positioned (it hangs off the input,
      // over the button row) and so adds nothing to the popover's own box —
      // fit the union of the two, or the list could run off the viewport.
      const box = popover.getBoundingClientRect();
      const list = listRef.current?.getBoundingClientRect();
      const bottom = list ? Math.max(box.bottom, list.bottom) : box.bottom;
      const next = placePopover(anchor, { width: box.width, height: bottom - box.top }, popoverBoundsFor(buttonRef.current));
      setPlacement((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
    }
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, editor, anchorPos, value, results.docs.length]);

  // With a collapsed selection there is nothing for setLink to mark, so
  // insert the link's own text (the doc title, or the URL itself); with a
  // real selection or a caret inside an existing link, mark what's there.
  const applyHref = (href: string, fallbackText: string) => {
    if (editor.state.selection.empty && !editor.isActive("link")) {
      editor
        .chain()
        .focus()
        .insertContent({ type: "text", text: fallbackText, marks: [{ type: "link", attrs: { href } }] })
        .run();
    } else {
      editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    }
    close();
  };

  const saveTyped = () => {
    const href = value.trim();
    if (!href) return;
    applyHref(href, href);
  };

  const selectDoc = (doc: ReadableDoc) => applyHref(`/doc/${doc.slug}`, docTitleOrFallback(doc.title));

  const { docs } = results;
  const handleInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && docs.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, docs.length - 1));
    } else if (e.key === "ArrowUp" && docs.length > 0) {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const active = activeIndex >= 0 ? docs[activeIndex] : undefined;
      if (active) selectDoc(active);
      else saveTyped();
    }
  };

  const removeLink = () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    close();
  };

  return (
    <div className={styles.linkGroup} ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.toolbarButton}
        disabled={disabled}
        aria-label="Link"
        title="Link (Ctrl+K / ⌘K)"
        aria-expanded={open}
        onClick={() => (open ? close() : openPopover(false))}
      >
        <IconLink size={18} />
      </button>
      {open &&
        placement &&
        createPortal(
          <div ref={popoverRef} className={styles.linkPopover} style={placement}>
            <div className={styles.linkInputWrap}>
              <input
                className={styles.linkInput}
                value={value}
                autoFocus
                placeholder="Paste a URL or search docs by title"
                aria-label="Link URL or doc search"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={docs.length > 0}
                aria-controls={listId}
                aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
                onChange={(e) => handleChange(e.target.value)}
                onKeyDown={handleInputKey}
              />
              {docs.length > 0 && (
                <div
                  ref={listRef}
                  id={listId}
                  role="listbox"
                  className={styles.linkResults}
                  onMouseLeave={() => setActiveIndex(-1)}
                >
                  {docs.map((doc, index) => (
                    <button
                      key={doc.id}
                      id={`${listId}-${index}`}
                      type="button"
                      role="option"
                      aria-selected={index === activeIndex}
                      tabIndex={-1}
                      className={index === activeIndex ? `${styles.linkResult} ${styles.linkResultActive}` : styles.linkResult}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => selectDoc(doc)}
                    >
                      {emphasizeMatch(docTitleOrFallback(doc.title), results.query)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className={styles.linkButtons}>
              <button type="button" className={styles.toolbarButton} disabled={!value.trim()} onClick={saveTyped}>
                Save
              </button>
              {hadLink ? (
                <button type="button" className={styles.toolbarButton} onClick={removeLink}>
                  Remove
                </button>
              ) : (
                <button type="button" className={styles.toolbarButton} onClick={close}>
                  Cancel
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
