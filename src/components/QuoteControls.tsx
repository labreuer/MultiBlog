"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { IconBlockquote, IconChevronDown } from "@tabler/icons-react";
import {
  placePopover,
  popoverBoundsFor,
  provisionalPlacement,
  type PopoverAnchor,
  type PopoverPlacement,
} from "@/lib/popover-placement";
import styles from "./EditorChrome.module.css";

// Split button: "Quote" keeps its existing toggle behavior (wrap/unwrap one
// level). The dropdown gives access to wrapIn/lift directly, which always
// add or remove a level regardless of current nesting — toggleBlockquote
// can't do that, since toggling while already inside a quote unwraps it
// rather than nesting deeper.
//
// The menu is position: fixed, placed by placePopover and portaled to
// <body>, the same shape as LinkControls' popover. On phones the toolbar
// is a sideways scroller (EditorChrome.module.css), and a scroll container
// clips absolutely positioned children on *both* axes — CSS can't scroll x
// and leave y visible — so a menu hanging inside it would be cut off at
// the toolbar's bottom edge. The portal is for the toolbar's edge-fade
// mask, which applies to every descendant, fixed or not.
const MENU_GAP = 2;

function anchorOf(el: HTMLElement | null): PopoverAnchor | null {
  const rect = el?.getBoundingClientRect();
  return rect ? { top: rect.top, bottom: rect.bottom, left: rect.left } : null;
}

export default function QuoteControls({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPlacement(null);
  }, []);

  const openMenu = () => {
    const anchor = anchorOf(containerRef.current);
    if (!anchor) return;
    setPlacement(provisionalPlacement(anchor, MENU_GAP));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
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

  // Measure-then-place, and follow the button on scroll/resize — the
  // toolbar itself scrolls on phones, so the anchor moves under an open
  // menu. Capture phase: an inner scroller's scroll event doesn't bubble.
  useLayoutEffect(() => {
    if (!open) return;
    function reposition() {
      const menu = menuRef.current;
      const anchor = anchorOf(containerRef.current);
      if (!menu || !anchor) return;
      const { width, height } = menu.getBoundingClientRect();
      const next = placePopover(anchor, { width, height }, popoverBoundsFor(containerRef.current), MENU_GAP);
      setPlacement((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
    }
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open]);

  return (
    <div className={styles.quoteGroup} ref={containerRef}>
      <button
        type="button"
        className={styles.toolbarButton}
        disabled={disabled}
        aria-label="Quote"
        title="Quote"
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <IconBlockquote size={18} />
      </button>
      <button
        type="button"
        className={styles.quoteDropdownTrigger}
        aria-label="Quote depth options"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
      >
        <IconChevronDown size={14} />
      </button>
      {open &&
        !disabled &&
        placement &&
        createPortal(
          <div ref={menuRef} className={styles.quoteMenu} role="menu" style={placement}>
            <button
              type="button"
              role="menuitem"
              className={styles.quoteMenuItem}
              onClick={() => {
                editor.chain().focus().wrapIn("blockquote").run();
                close();
              }}
            >
              Increase quote depth
            </button>
            <button
              type="button"
              role="menuitem"
              className={styles.quoteMenuItem}
              onClick={() => {
                editor.chain().focus().lift("blockquote").run();
                close();
              }}
            >
              Decrease quote depth
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
