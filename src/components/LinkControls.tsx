"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { getMarkRange } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { IconLetterCase, IconLink } from "@tabler/icons-react";
import { searchLinkableDocs } from "@/app/actions/docs";
import type { LinkableDocJson } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { relativeTime } from "@/lib/relative-time";
import {
  placePopover,
  popoverBoundsFor,
  provisionalPlacement,
  type PopoverAnchor,
} from "@/lib/popover-placement";
import LinkBubble from "./LinkBubble";
import styles from "./EditorChrome.module.css";

// The toolbar's link button and its popover: a two-field form, title over
// URL, each box prefixed by an icon saying which it is — the Google Docs /
// Confluence arrangement. The title is the link's text and nothing else.
// The URL box is either a URL (saved as typed) or a search over readable
// docs' titles: while it has focus its results hang beneath it, and
// picking one fills it with /doc/<slug> — and the title box with the doc's
// title, but only if the title box is empty, so a selection's text is
// never overwritten by a search that was only ever aimed at the URL. A
// pick is a fill, not a save, so either box can still be adjusted. Left
// empty, the URL box offers the most recently edited docs. Anything
// starting with http://, https:// or "/" — the last being what a pick
// writes, so reopening such a link doesn't search its own path as a title
// — is taken as a URL and never searched.
//
// The URL box opens focused, with its contents selected so typing replaces
// them: it is where both the search and the paste happen, and the usual
// reason to edit a link is to swap its URL. The title is prefilled from
// the selection or the existing link, and left alone.
//
// The popover is portaled to <body>: on phones the toolbar is a sideways
// scroller with an edge-fade mask (EditorChrome.module.css), and a mask
// applies to every descendant — position: fixed included — so left in the
// toolbar's subtree the popover would be faded out wherever it hangs past
// the toolbar's box. Same reason QuoteControls' menu is portaled.
const URL_LIKE = /^(https?:\/\/|\/)/i;

// A search fires SEARCH_DEBOUNCE_MS after the last keystroke, or on every
// KEYS_PER_FORCED_SEARCH-th keystroke since the last search if the debounce
// hasn't fired yet — so a steady typist still sees results roll in.
const SEARCH_DEBOUNCE_MS = 150;
const KEYS_PER_FORCED_SEARCH = 3;

// The result list's tallest — about five and a half two-line rows; the half
// row is what says there's more below, since on a touch device the
// scrollbar is an overlay that only appears once you scroll, so a clean cut
// would read as the end. In rem so it scales with the root font size, and
// one constant applied inline rather than a CSS max-height, because the
// placement arithmetic needs the same number: the popover is placed for
// the tallest it can be (the layout effect below).
const LIST_MAX_HEIGHT_REM = 17;
// .linkPopover's gap (EditorChrome.module.css), between the list and its
// neighbours — part of that tallest height.
const LIST_GAP_PX = 8;

// Where the popover is pinned: by its top edge when it hangs below the
// anchor, by its bottom edge when it has flipped above — so the edge
// nearest the selected text is the one that holds still as the result list
// changes the box's height, and the far edge is the one that moves.
type PopoverStyle = { left: number; top: number } | { left: number; bottom: number };

function samePlacement(a: PopoverStyle, b: PopoverStyle): boolean {
  return a.left === b.left && ("top" in a ? "top" in b && a.top === b.top : "bottom" in b && a.bottom === b.bottom);
}

type LinkRange = { from: number; to: number; text: string };

// What Save marks: the link the caret is in — its whole mark range, by the
// same isActive test the bubble uses — else the selection; null for a bare
// caret, where Save inserts the link's own text. Read live each time rather
// than captured at open, since the document can change under an open
// popover (a collaborator's edit) and y-prosemirror maps the selection
// through those changes.
function targetRange(editor: Editor): LinkRange | null {
  const { state } = editor;
  const { selection } = state;
  const type = state.schema.marks.link;
  if (type && editor.isActive("link")) {
    const range = getMarkRange(selection.$from, type);
    if (range) return { from: range.from, to: range.to, text: state.doc.textBetween(range.from, range.to, " ") };
  }
  if (selection.empty) return null;
  return { from: selection.from, to: selection.to, text: state.doc.textBetween(selection.from, selection.to, " ") };
}

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

const NO_RESULTS = { query: "", docs: [] as LinkableDocJson[], receivedAt: 0 };

export default function LinkControls({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  // The result list shows only while the URL box has focus — it sits
  // between that box and the buttons, and would otherwise stay in the way
  // while the title is being adjusted.
  const [urlFocused, setUrlFocused] = useState(false);
  // Whether the selection carried a link when the popover opened — decides
  // Remove vs. Cancel. Captured at open time: applying either button closes
  // the popover, so it can't go stale while visible.
  const [hadLink, setHadLink] = useState(false);
  // The docs alongside the query that produced them, so the emphasis in the
  // list matches what was actually searched rather than what has been typed
  // since the request went out. `receivedAt` anchors the rows' "edited … ago"
  // text: taken when the response lands, not at render, so it's stable
  // across re-renders and keeps Date.now() off the render path.
  const [results, setResults] = useState<{ query: string; docs: LinkableDocJson[]; receivedAt: number }>(NO_RESULTS);
  // Keyboard highlight in the result list; -1 is "none" (Enter saves the
  // typed URL instead of picking a doc).
  const [activeIndex, setActiveIndex] = useState(-1);
  const [anchorPos, setAnchorPos] = useState<number | null>(null);
  const [placement, setPlacement] = useState<PopoverStyle | null>(null);
  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  // Guards against out-of-order search responses: only the newest request's
  // result is allowed to land. Bumped on open/close/pick too, so a response
  // still in flight can't populate a popover that has moved on.
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

  // An empty query is a real search: the action answers it with the most
  // recently edited docs.
  const runSearch = (query: string) => {
    cancelPendingSearch();
    keysSinceSearchRef.current = 0;
    const seq = ++searchSeqRef.current;
    void searchLinkableDocs(query).then((found) => {
      if (searchSeqRef.current !== seq) return;
      setResults({ query, docs: found, receivedAt: Date.now() });
      setActiveIndex(-1);
    });
  };

  const dropResults = () => {
    cancelPendingSearch();
    searchSeqRef.current += 1;
    keysSinceSearchRef.current = 0;
    setResults(NO_RESULTS);
    setActiveIndex(-1);
  };

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
    const initialUrl = (editor.getAttributes("link").href as string | undefined) ?? "";
    setAnchorPos(pos);
    setPlacement(provisionalPlacement(anchor));
    setTitle(targetRange(editor)?.text ?? "");
    setUrl(initialUrl);
    setUrlFocused(false);
    setHadLink(editor.isActive("link"));
    dropResults();
    setOpen(true);
    // Nothing URL-shaped in the box (usually: nothing at all) — offer the
    // recent docs straight away rather than waiting for a keystroke.
    if (!URL_LIKE.test(initialUrl.trim())) runSearch(initialUrl.trim());
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

  // Focus the URL box and select its text on open (the header comment on
  // why that box), instead of wherever focus() happened to leave the
  // caret, which differs by browser. An empty box has nothing to select
  // and select() is a no-op on it. A layout effect so both are in place
  // before the first paint.
  useLayoutEffect(() => {
    if (!open) return;
    urlRef.current?.focus();
    urlRef.current?.select();
  }, [open]);

  // The doc search is driven from here rather than an effect on `url`, so
  // the debounce and the every-Nth-keystroke path share one timer and a
  // forced search cancels the pending debounced one instead of both firing.
  // URL-shaped input is never searched — it's a URL, not a title query. An
  // emptied box goes back to the recent list, through the same debounce.
  const handleUrlChange = (next: string) => {
    setUrl(next);
    setActiveIndex(-1);
    cancelPendingSearch();
    const query = next.trim();
    if (URL_LIKE.test(query)) {
      // Through dropResults, which also bumps the sequence: a search for the
      // first few characters of a pasted-slowly URL ("htt") can still be in
      // flight, and must not land on a box that has since become a URL.
      dropResults();
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
  // and placePopover slides/flips it inside bounds.
  //
  // Placed once, for the *tallest* the popover can be — the form plus the
  // result list at LIST_MAX_HEIGHT_REM — rather than re-measured as results
  // come and go. Fitted to its live height, the box flipped above the
  // selection when the recent docs landed and back below on a pick: the
  // author was typing into a box that walked. Placed for its tallest, it
  // never needs to flip later, and the side decides which edge is pinned
  // (PopoverStyle): below the anchor, the top, so the box grows downward;
  // above it, the bottom — the tallest box's bottom, which is the gap above
  // the selection — so the box grows *upward* and collapses back down
  // toward the text, its near corner never leaving it. And since whatever
  // sits above the list moves when it grows, the flipped popover puts the
  // list at its top (.linkPopoverAbove), above the whole form, so title,
  // URL and buttons hold still on either side. The width is fixed, so the
  // horizontal slide never changes either. Re-runs only on scroll/resize,
  // which move the anchor, not the box. Capture phase for scroll: the
  // editor's own scroller is what scrolls, not the window, and an inner
  // element's scroll doesn't bubble.
  const listShown = urlFocused && results.docs.length > 0;
  useLayoutEffect(() => {
    if (!open) return;
    function reposition() {
      const popover = popoverRef.current;
      const anchor = anchorFor(editor, anchorPos, buttonRef.current);
      if (!popover || !anchor) return;
      const box = popover.getBoundingClientRect();
      const list = listRef.current?.getBoundingClientRect();
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const formHeight = box.height - (list ? list.height + LIST_GAP_PX : 0);
      const tallest = formHeight + LIST_GAP_PX + LIST_MAX_HEIGHT_REM * rem;
      const spot = placePopover(anchor, { width: box.width, height: tallest }, popoverBoundsFor(buttonRef.current));
      const bottom = spot.top + tallest;
      const next: PopoverStyle =
        bottom <= anchor.top ? { left: spot.left, bottom: window.innerHeight - bottom } : { left: spot.left, top: spot.top };
      setPlacement((prev) => (prev && samePlacement(prev, next) ? prev : next));
    }
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, editor, anchorPos]);

  // Save: with a bare caret there is nothing to mark, so insert the title
  // (or the URL itself) as the link's text; over a link or a selection whose
  // text the title still matches, mark it in place and keep whatever other
  // marks it carries; otherwise replace its text with the title.
  const save = () => {
    const href = url.trim();
    if (!href) return;
    const text = title.trim() || href;
    const link = { type: "link", attrs: { href } };
    const range = targetRange(editor);
    const chain = editor.chain().focus();
    if (!range) chain.insertContent({ type: "text", text, marks: [link] });
    else if (title === range.text) chain.setTextSelection(range).setLink({ href });
    else chain.insertContentAt(range, { type: "text", text, marks: [link] });
    chain.run();
    close();
  };

  // A pick fills the URL box, and the title box when it has nothing yet —
  // a title already there came from the selection or the link, and is the
  // text the author meant. The list goes, since what's in the URL box is
  // no longer a query, and Enter now saves. Focus stays in the URL box: a
  // keyboard pick never left it, and a mouse pick's click landed on a
  // result button the list's onMouseDown kept from taking focus (below).
  const selectDoc = (doc: LinkableDocJson) => {
    dropResults();
    setUrl(`/doc/${doc.slug}`);
    if (!title.trim()) setTitle(docTitleOrFallback(doc.title));
    urlRef.current?.focus();
  };

  // Keep the keyboard highlight in view: the menu shows about five rows and
  // scrolls for the rest.
  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listId]);

  const { docs } = results;
  const handleUrlKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
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
      else save();
    }
  };
  // Enter in the title box saves once there is a URL; before that it moves
  // on to the URL box, the way Tab would.
  const handleTitleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (url.trim()) save();
    else urlRef.current?.focus();
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
      {/* The bubble under a link the caret is in (LinkBubble.tsx). Hidden
          while this popover is open, and its Edit is this popover, at the
          selection. */}
      <LinkBubble editor={editor} disabled={disabled} suppressed={open} onEdit={() => openPopover(true)} />
      {open &&
        placement &&
        createPortal(
          <div
            ref={popoverRef}
            className={"bottom" in placement ? `${styles.linkPopover} ${styles.linkPopoverAbove}` : styles.linkPopover}
            style={placement}
            data-testid="link-popover"
          >
            <div className={styles.linkField}>
              <span className={styles.linkFieldIcon} aria-hidden="true">
                <IconLetterCase size={16} />
              </span>
              <input
                className={styles.linkInput}
                value={title}
                placeholder="Title"
                aria-label="Link title"
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={handleTitleKey}
              />
            </div>
            <div className={styles.linkField}>
              <span className={styles.linkFieldIcon} aria-hidden="true">
                <IconLink size={16} />
              </span>
              <input
                ref={urlRef}
                className={styles.linkInput}
                value={url}
                placeholder="Paste a URL or search docs by title"
                aria-label="Link URL or doc search"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={listShown}
                aria-controls={listId}
                aria-activedescendant={listShown && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
                onChange={(e) => handleUrlChange(e.target.value)}
                onKeyDown={handleUrlKey}
                onFocus={() => setUrlFocused(true)}
                onBlur={() => setUrlFocused(false)}
              />
            </div>
            {/* A direct child of the popover, not of the URL field's wrap, so
                the flipped popover can lift it to the top (.linkPopoverAbove)
                with a single `order`. */}
            {listShown && (
              <div
                ref={listRef}
                id={listId}
                role="listbox"
                className={styles.linkResults}
                style={{ maxHeight: `${LIST_MAX_HEIGHT_REM}rem` }}
                // Keep a click on a result from moving focus off the URL
                // box: its blur would take the list — and the button being
                // clicked — away before the click could land.
                onMouseDown={(e) => e.preventDefault()}
                onMouseLeave={() => setActiveIndex(-1)}
              >
                {results.query === "" && (
                  <div role="presentation" className={styles.linkResultsHeading}>
                    Recently edited
                  </div>
                )}
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
                    <span className={styles.linkResultTitle}>
                      {emphasizeMatch(docTitleOrFallback(doc.title), results.query)}
                    </span>
                    <span className={styles.linkResultMeta}>Edited {relativeTime(doc.updatedAt, results.receivedAt)}</span>
                  </button>
                ))}
              </div>
            )}
            {/* The same onMouseDown as the list, for the same reason: the
                buttons sit below the list, so the URL box's blur would pull
                the list out from under a click on Save before it landed. */}
            <div className={styles.linkButtons} onMouseDown={(e) => e.preventDefault()}>
              <button type="button" className={styles.toolbarButton} disabled={!url.trim()} onClick={save}>
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
