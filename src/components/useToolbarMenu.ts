"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { popoverBoundsElement } from "@/lib/popover-placement";

// The dropdown half of the toolbar's split buttons (QuoteControls,
// TableControls, NumberedListControls): whether the menu is open, closing it
// on a mousedown outside the group and the menu or on Escape, and placing it.
// The caller renders the group (containerRef) and, while open, the menu
// (menuRef) through createPortal to <body>.
//
// The menu is position: fixed, placed by floating-ui and portaled to <body>,
// the same shape as LinkControls' popover. On phones the toolbar is a
// sideways scroller (EditorChrome.module.css), and a scroll container clips
// absolutely positioned children on *both* axes — CSS can't scroll x and
// leave y visible — so a menu hanging inside it would be cut off at the
// toolbar's bottom edge. The portal is for the toolbar's edge-fade mask,
// which applies to every descendant, fixed or not.
const MENU_GAP = 2;

export function useToolbarMenu() {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((was) => !was), []);

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

  return { open, close, toggle, containerRef, menuRef };
}
