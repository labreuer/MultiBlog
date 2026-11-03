"use client";

import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { IconBlockquote, IconChevronDown } from "@tabler/icons-react";
import { useToolbarMenu } from "./useToolbarMenu";
import styles from "./EditorChrome.module.css";

// Split button: "Quote" keeps its existing toggle behavior (wrap/unwrap one
// level). The dropdown gives access to wrapIn/lift directly, which always
// add or remove a level regardless of current nesting — toggleBlockquote
// can't do that, since toggling while already inside a quote unwraps it
// rather than nesting deeper.
//
// The menu's open state, closing and placement are useToolbarMenu's, which
// says why it is portaled.

export default function QuoteControls({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const { open, close, toggle, containerRef, menuRef } = useToolbarMenu();

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
        title="Quote depth options"
        onClick={toggle}
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
