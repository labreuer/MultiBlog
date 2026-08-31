"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { IconBlockquote, IconChevronDown } from "@tabler/icons-react";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { popoverBoundsElement } from "@/lib/popover-placement";
import styles from "./EditorChrome.module.css";

// Split button: "Quote" keeps its existing toggle behavior (wrap/unwrap one
// level). The dropdown gives access to wrapIn/lift directly, which always
// add or remove a level regardless of current nesting — toggleBlockquote
// can't do that, since toggling while already inside a quote unwraps it
// rather than nesting deeper.
//
// The menu is position: fixed, placed by floating-ui and portaled to
// <body>, the same shape as LinkControls' popover. On phones the toolbar
// is a sideways scroller (EditorChrome.module.css), and a scroll container
// clips absolutely positioned children on *both* axes — CSS can't scroll x
// and leave y visible — so a menu hanging inside it would be cut off at
// the toolbar's bottom edge. The portal is for the toolbar's edge-fade
// mask, which applies to every descendant, fixed or not.
const MENU_GAP = 2;

export default function QuoteControls({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

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

  // floating-ui owns placement: the menu hangs under the split button's
  // group (offset: MENU_GAP on both axes), stock flip() moves it above when
  // the room below runs out, and shift() slides it back inside its bounds
  // on both axes. autoUpdate's ancestor-scroll listeners follow the button —
  // the toolbar itself scrolls on phones, so the anchor moves under an open
  // menu — and computePosition's answer lands in a microtask, before the
  // newly portaled menu first paints.
  useLayoutEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const reference = containerRef.current;
    if (!menu || !reference) return;
    const boundary = popoverBoundsElement(reference);
    const update = () => {
      void computePosition(reference, menu, {
        strategy: "fixed",
        placement: "bottom-start",
        middleware: [
          offset({ mainAxis: MENU_GAP, crossAxis: MENU_GAP }),
          flip({ crossAxis: false, boundary, fallbackStrategy: "initialPlacement" }),
          shift({ crossAxis: true, boundary }),
        ],
      }).then(({ x, y }) => {
        Object.assign(menu.style, { left: `${x}px`, top: `${y}px` });
      });
    };
    return autoUpdate(reference, menu, update);
  }, [open]);

  return (
    <div className={styles.quoteGroup} ref={containerRef}>
      <button
        type="button"
        className={styles.toolbarButton}
        disabled={disabled}
        aria-label="Quote"
        title="Quote (Ctrl+Shift+B / ⌘⇧B)"
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
        onClick={() => (open ? close() : setOpen(true))}
      >
        <IconChevronDown size={14} />
      </button>
      {open &&
        !disabled &&
        createPortal(
          <div ref={menuRef} className={styles.quoteMenu} role="menu">
            <button
              type="button"
              role="menuitem"
              className={styles.quoteMenuItem}
              title="Increase quote depth (Ctrl+Shift+. / ⌘⇧.)"
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
              title="Decrease quote depth (Ctrl+Shift+, / ⌘⇧,)"
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
