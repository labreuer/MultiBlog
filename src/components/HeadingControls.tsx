"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useEditorState, type Editor } from "@tiptap/react";
import { IconCheck, IconChevronDown, IconH1, IconH2, IconH3, IconH4 } from "@tabler/icons-react";
import { useToolbarMenu } from "./useToolbarMenu";
import styles from "./EditorChrome.module.css";

// docs/TIPTAP.md "The heading tool remembers its level". Split button, in
// TableControls' shape: the ▾ lists Heading 1–4, with the current block's
// level checked, and sets the block to the one picked; the main button
// toggles the level picked last, and wears its icon. Heading 2 until a pick.
// The memory is this toolbar's own, for as long as the editor is mounted.
// The menu's open state, closing and placement are useToolbarMenu's.
const LEVELS = [
  { level: 1, Icon: IconH1 },
  { level: 2, Icon: IconH2 },
  { level: 3, Icon: IconH3 },
  { level: 4, Icon: IconH4 },
] as const;

type Level = (typeof LEVELS)[number]["level"];

const DEFAULT_LEVEL: Level = 2;

// StarterKit's Heading binds Mod-Alt-<level> for every level it allows.
const shortcut = (level: Level) => `Ctrl+Alt+${level} / ⌘⌥${level}`;

export default function HeadingControls({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const { open, close, toggle, containerRef, menuRef } = useToolbarMenu();
  const [lastLevel, setLastLevel] = useState<Level>(DEFAULT_LEVEL);
  const { Icon } = LEVELS.find((entry) => entry.level === lastLevel)!;

  // The level of the block the selection starts in, or null outside a heading.
  const current = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const parent = e.state.selection.$from.parent;
      return parent.type.name === "heading" ? (parent.attrs.level as number) : null;
    },
  });

  const pick = (level: Level) => {
    close();
    setLastLevel(level);
    editor.chain().focus().setHeading({ level }).run();
  };

  return (
    <div className={styles.splitButton} ref={containerRef}>
      <button
        type="button"
        className={styles.toolbarButton}
        disabled={disabled}
        aria-label={`Heading ${lastLevel}`}
        title={`Heading ${lastLevel} (${shortcut(lastLevel)})`}
        onClick={() => editor.chain().focus().toggleHeading({ level: lastLevel }).run()}
      >
        <Icon size={18} />
      </button>
      <button
        type="button"
        className={styles.splitButtonTrigger}
        aria-label="Heading level"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title="Heading level"
        onClick={toggle}
      >
        <IconChevronDown size={14} />
      </button>
      {open &&
        !disabled &&
        createPortal(
          <div ref={menuRef} className={styles.toolbarMenu} role="menu">
            {LEVELS.map(({ level }) => (
              <button
                key={level}
                type="button"
                role="menuitemradio"
                aria-checked={current === level}
                className={styles.toolbarMenuItem}
                title={`Heading ${level} (${shortcut(level)})`}
                onClick={() => pick(level)}
              >
                <span className={styles.menuItemCheck} aria-hidden="true">
                  {current === level && <IconCheck size={14} />}
                </span>
                Heading {level}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
