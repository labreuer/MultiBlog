"use client";

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import styles from "./PostEditor.module.css";

// Split button: "Quote" keeps its existing toggle behavior (wrap/unwrap one
// level). The dropdown gives access to wrapIn/lift directly, which always
// add or remove a level regardless of current nesting — toggleBlockquote
// can't do that, since toggling while already inside a quote unwraps it
// rather than nesting deeper.
export default function QuoteControls({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div className={styles.quoteGroup} ref={containerRef}>
      <button
        type="button"
        className={styles.toolbarButton}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        Quote
      </button>
      <button
        type="button"
        className={styles.quoteDropdownTrigger}
        aria-label="Quote depth options"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ▼
      </button>
      {open && (
        <div className={styles.quoteMenu} role="menu">
          <button
            type="button"
            role="menuitem"
            className={styles.quoteMenuItem}
            onClick={() => {
              editor.chain().focus().wrapIn("blockquote").run();
              setOpen(false);
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
              setOpen(false);
            }}
          >
            Decrease quote depth
          </button>
        </div>
      )}
    </div>
  );
}
