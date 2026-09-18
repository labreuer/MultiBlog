"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditorState, type Editor } from "@tiptap/react";
import { IconChevronDown, IconTable } from "@tabler/icons-react";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { popoverBoundsElement } from "@/lib/popover-placement";
import styles from "./EditorChrome.module.css";

// PLAN.md §24 — the toolbar's table tool, QuoteControls' split-button shape
// reused verbatim: the main button inserts, the chevron opens a menu of the
// operations that only mean something once the caret is in a table. The
// commands are all the table extension's own (`insertTable`, `addRowAfter`,
// … `deleteTable`); this component adds no editing logic, only the
// enabled-ness and a place to click.
//
// The menu is position: fixed, placed by floating-ui and portaled to <body>
// — QuoteControls.tsx says why an absolute menu inside the toolbar cannot
// work on phones, and the same toolbar hosts this one.
const MENU_GAP = 2;

// A fresh table's size. Three by three with a header row is what every
// editor with this control defaults to, and the menu grows it from there.
const NEW_TABLE = { rows: 3, cols: 3, withHeaderRow: true };

type MenuItem = {
  label: string;
  // Keyed by the command name so one `can()` dry run and one chained call
  // read the same word — a typo would fail typecheck rather than silently
  // enable a button that does nothing.
  command:
    | "addRowBefore"
    | "addRowAfter"
    | "deleteRow"
    | "addColumnBefore"
    | "addColumnAfter"
    | "deleteColumn"
    | "toggleHeaderRow"
    | "toggleHeaderColumn"
    | "mergeCells"
    | "splitCell"
    | "deleteTable";
  // A rule above the item, grouping rows, columns, headers, cells, and the
  // one destructive action.
  separator?: boolean;
};

const MENU_ITEMS: MenuItem[] = [
  { label: "Add row above", command: "addRowBefore" },
  { label: "Add row below", command: "addRowAfter" },
  { label: "Delete row", command: "deleteRow" },
  { label: "Add column before", command: "addColumnBefore", separator: true },
  { label: "Add column after", command: "addColumnAfter" },
  { label: "Delete column", command: "deleteColumn" },
  { label: "Toggle header row", command: "toggleHeaderRow", separator: true },
  { label: "Toggle header column", command: "toggleHeaderColumn" },
  { label: "Merge cells", command: "mergeCells", separator: true },
  { label: "Split cell", command: "splitCell" },
  { label: "Delete table", command: "deleteTable", separator: true },
];

export default function TableControls({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // `inTable` gates the insert button: a cell is `block+` and a table is a
  // block, so the schema would happily nest one table inside another, and
  // nothing about the reading views or the CSV follow-up wants that. The
  // dropdown's items are dry-run individually — mergeCells needs a
  // multi-cell selection, splitCell a merged cell, and so on — and
  // useEditorState deep-equals the object, so this re-renders only when a
  // boolean flips, not per keystroke (EditorToolbar's own selector note).
  const { inTable, can } = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      inTable: e.isActive("table"),
      can: Object.fromEntries(MENU_ITEMS.map((item) => [item.command, e.can()[item.command]()])) as Record<
        MenuItem["command"],
        boolean
      >,
    }),
  });

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

  // Placement: QuoteControls' arrangement, unchanged — see its comment.
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
        disabled={disabled || inTable}
        aria-label="Insert table"
        title={inTable ? "Already in a table — use the menu to add rows or columns" : "Insert table"}
        onClick={() => editor.chain().focus().insertTable(NEW_TABLE).run()}
      >
        <IconTable size={18} />
      </button>
      <button
        type="button"
        className={styles.quoteDropdownTrigger}
        aria-label="Table options"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || !inTable}
        title={inTable ? "Table options" : "Put the caret in a table for its options"}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <IconChevronDown size={14} />
      </button>
      {open &&
        !disabled &&
        createPortal(
          <div ref={menuRef} className={styles.quoteMenu} role="menu">
            {MENU_ITEMS.map((item) => (
              <button
                key={item.command}
                type="button"
                role="menuitem"
                className={`${styles.quoteMenuItem} ${item.separator ? styles.menuItemSeparated : ""}`}
                disabled={!can[item.command]}
                onClick={() => {
                  editor.chain().focus()[item.command]().run();
                  close();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
