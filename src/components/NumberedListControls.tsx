"use client";

import { createPortal } from "react-dom";
import { useEditorState, type Editor } from "@tiptap/react";
import { IconCheck, IconChevronDown, IconListNumbers } from "@tabler/icons-react";
import { ORDERED_LIST_STYLES, currentOrderedListType, setOrderedListType, type OrderedListType } from "@/lib/ordered-list-style";
import { useToolbarMenu } from "./useToolbarMenu";
import styles from "./EditorChrome.module.css";

// docs/TIPTAP.md "A numbered list's style is its `type`". Split button, in
// QuoteControls' shape: the main button is the plain numbered-list toggle it
// always was; the chevron opens the numbering styles. Inside a numbered list
// a pick restyles the innermost one; anywhere else it makes a numbered list
// first (from a bullet list, too: toggleOrderedList converts one) and styles
// that. The menu's open state, closing and placement are useToolbarMenu's.
export default function NumberedListControls({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const { open, close, toggle, containerRef, menuRef } = useToolbarMenu();

  // `current` is undefined outside every numbered list, so no item is
  // checked there. `canMakeList` gates the items only outside one — a code
  // block, say, can't become a list — and is a dry run cheap enough per
  // transaction; useEditorState deep-equals the object (EditorToolbar's note).
  const { current, canMakeList } = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      current: currentOrderedListType(e.state),
      canMakeList: e.can().toggleOrderedList(),
    }),
  });
  const inList = current !== undefined;

  const pick = (type: OrderedListType) => {
    close();
    const chain = editor.chain().focus();
    if (!inList) chain.toggleOrderedList();
    // A chain dispatches whatever its commands did even when one fails, so
    // this one changes nothing unless it finds the list to style.
    if (inList || type !== null) chain.command(({ tr }) => setOrderedListType(tr, type));
    chain.run();
  };

  return (
    <div className={styles.quoteGroup} ref={containerRef}>
      <button
        type="button"
        className={styles.toolbarButton}
        disabled={disabled}
        aria-label="Numbered list"
        title="Numbered list (Ctrl+Shift+7 / ⌘⇧7)"
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <IconListNumbers size={18} />
      </button>
      <button
        type="button"
        className={styles.quoteDropdownTrigger}
        aria-label="Numbering style"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title="Numbering style"
        onClick={toggle}
      >
        <IconChevronDown size={14} />
      </button>
      {open &&
        !disabled &&
        createPortal(
          <div ref={menuRef} className={styles.quoteMenu} role="menu">
            {ORDERED_LIST_STYLES.map((style) => (
              <button
                key={style.type ?? "1"}
                type="button"
                role="menuitemradio"
                aria-checked={current === style.type}
                className={styles.quoteMenuItem}
                disabled={!inList && !canMakeList}
                onClick={() => pick(style.type)}
              >
                <span className={styles.menuItemCheck} aria-hidden="true">
                  {current === style.type && <IconCheck size={14} />}
                </span>
                {style.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
