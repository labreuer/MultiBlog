"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import styles from "./ClampedBody.module.css";

// docs/ANNOTATIONS.md, "Clamping a long body" — a long annotation or comment
// body shows its first CLAMP_LINES lines, faded at the cut, until the reader
// asks for the rest. A default the reader lifts per card per visit, not a
// preference: nothing is stored, and a remount (a reload, a collapse and
// reopen) clamps again. Collapsing a card is the remembered choice, and is
// a separate thing (collapsed-annotations.ts).

// The box's height while clamped, in lines of the body's own type. Handed to
// the CSS as `--clamp-lines`, so the stylesheet and the measure below read
// one number.
const CLAMP_LINES = 12;
// How much further a body has to run before it is clamped at all: a button
// that reveals two more lines costs more than the two lines do.
const SLACK_LINES = 4;
// A line of the body, in ems of its font size: .prose's line-height.
// ClampedBody.module.css's `--clamp-line` is the same 1.5.
const LINE_EM = 1.5;

type Props = {
  children: ReactNode;
  /** The body's word count, which the button names. */
  words: number;
  /**
   * False while the body's slot holds an editor (an annotation's edit
   * session, a comment's edit box), or the history panel stands in for it:
   * shown whole, no button. The wrapper stays mounted either way, so an
   * expansion outlives an edit, and the children are never remounted by a
   * change of state here.
   */
  clamp: boolean;
  /**
   * The attribute that marks a passage a reply quotes, holding the replies'
   * ids space-separated (`data-annotation-ids` on an annotation body). The
   * button counts the replies whose passage starts below the cut, since a
   * reply card shows no quote of its own: its only context is that
   * highlight. Omitted where nothing quotes into the body.
   */
  quoteAttribute?: string;
};

type Shift = { kind: "reveal"; by: number } | { kind: "keep"; top: number };

// The box whose scroll a shift of the body has to be made up in: the PDF
// panel scrolls itself, the doc and post pages scroll the window.
function scrollerOf(el: HTMLElement): Element {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

export default function ClampedBody({ children, words, clamp, quoteAttribute }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const boxId = useId();
  // Null until measured, which the server render and the first client render
  // both are, so hydration agrees and the button arrives with the measure.
  const [long, setLong] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Replies quoting a passage that starts below the cut.
  const [hiddenQuotes, setHiddenQuotes] = useState(0);
  // A scroll to make up once the expansion or contraction has laid out.
  const shiftRef = useRef<Shift | null>(null);

  // Measured from the content, whose height the box's max-height doesn't
  // change, so the answer is the same clamped or not. The observer's first
  // callback, which every `observe` delivers, is the first measure; later
  // ones follow the content's size — the server copy swapped for the
  // editor's, a newly settled version pushed in, the rail's width. Where
  // replies quote into the body, a change to its decorations re-measures
  // too, since one can move a highlight across the cut without changing any
  // size; that waits a frame, for the layout the mutation hasn't had yet.
  useEffect(() => {
    const box = boxRef.current;
    const content = contentRef.current;
    if (!box || !content) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const height = content.offsetHeight;
      // A card the PDF rail hides with `display: none` says nothing about its length.
      if (height === 0) return;
      const line = LINE_EM * parseFloat(getComputedStyle(box).fontSize);
      if (!line) return;
      setLong(height > (CLAMP_LINES + SLACK_LINES) * line);
      if (!quoteAttribute) return;
      const cut = box.getBoundingClientRect().top + CLAMP_LINES * line;
      const hidden = new Set<string>();
      for (const el of content.querySelectorAll<HTMLElement>(`[${quoteAttribute}]`)) {
        // The pre-ready static copy is `display: none`, and carries no decorations anyway.
        if (el.getClientRects().length === 0) continue;
        if (el.getBoundingClientRect().top < cut) continue;
        for (const id of (el.getAttribute(quoteAttribute) ?? "").split(" ")) if (id) hidden.add(id);
      }
      setHiddenQuotes(hidden.size);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const resizes = new ResizeObserver(measure);
    resizes.observe(content);
    const mutations = quoteAttribute ? new MutationObserver(schedule) : null;
    mutations?.observe(content, { subtree: true, childList: true, attributeFilter: [quoteAttribute!] });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizes.disconnect();
      mutations?.disconnect();
    };
  }, [quoteAttribute]);

  useLayoutEffect(() => {
    const shift = shiftRef.current;
    shiftRef.current = null;
    const box = boxRef.current;
    if (!shift || !box) return;
    const by = shift.kind === "reveal" ? shift.by : (buttonRef.current?.getBoundingClientRect().top ?? shift.top) - shift.top;
    if (by) scrollerOf(box).scrollBy(0, by);
  }, [expanded]);

  const open = !clamp || expanded || long === false;
  const state = open ? "open" : long ? "clamped" : "pending";

  // The box clips with `overflow: hidden`, not `clip`, so it is still a
  // scroll container — and a browser bringing hidden text into view scrolls
  // it: find in page, Tab into a link below the cut, a `#:~:text=` link.
  // Nothing else ever scrolls it, so any scroll is the reader going looking:
  // open the body, and move its scroller by the same amount, which leaves
  // what they were looking for where the browser put it.
  const onScroll = () => {
    const box = boxRef.current;
    if (!box || open || box.scrollTop === 0) return;
    shiftRef.current = { kind: "reveal", by: box.scrollTop };
    setExpanded(true);
  };

  const toggle = () => {
    const box = boxRef.current;
    const button = buttonRef.current;
    // Closing from far down a long body would leave the reader below the
    // card, so when the body's top is above the screen the button stays
    // under the pointer. Otherwise nothing moves but the button.
    if (expanded && box && button && box.getBoundingClientRect().top < 0) {
      shiftRef.current = { kind: "keep", top: button.getBoundingClientRect().top };
    }
    setExpanded(!expanded);
  };

  const label = expanded
    ? "Show less"
    : `Show all ${words.toLocaleString("en-US")} words` +
      (hiddenQuotes > 0 ? ` · ${hiddenQuotes} ${hiddenQuotes === 1 ? "reply quotes" : "replies quote"} the hidden part` : "");

  return (
    <>
      <div
        ref={boxRef}
        id={boxId}
        className={styles.box}
        data-clamp={state}
        style={{ "--clamp-lines": CLAMP_LINES } as CSSProperties}
        onScroll={onScroll}
      >
        <div ref={contentRef} className={styles.content}>
          {children}
        </div>
      </div>
      {clamp && long && (
        <button
          ref={buttonRef}
          type="button"
          className={styles.toggle}
          onClick={toggle}
          aria-expanded={expanded}
          aria-controls={boxId}
        >
          {label}
        </button>
      )}
    </>
  );
}

/** A body's word count, for `words`. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
