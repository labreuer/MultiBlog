"use client";

import { useEffect } from "react";

// <details> has no native "close on outside click" — it only toggles via its
// own <summary>. Sets `.open` directly on the DOM node rather than lifting it
// into React state: nothing at any call site needs to react to open/closed,
// and lifting it would re-render every panel on a document mousedown
// anywhere on the page. Variadic so a component juggling more than one panel
// (SiteHeader's post/doc tool menus) closes both from one listener.
export function useCloseOnOutsideClick(...refs: React.RefObject<HTMLDetailsElement | null>[]) {
  useEffect(() => {
    function handlePointerDown(e: MouseEvent) {
      for (const ref of refs) {
        if (ref.current && !ref.current.contains(e.target as Node)) ref.current.open = false;
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
    // refs are stable useRef objects (or a stable array of them); spreading
    // them into the dep array would re-subscribe the listener every render
    // for no behavioral difference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
