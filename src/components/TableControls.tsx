"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useEditorState, type Editor } from "@tiptap/react";
import { IconChevronDown, IconTable } from "@tabler/icons-react";
import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { popoverBoundsElement } from "@/lib/popover-placement";
import { TABLE_CODECS, TABLE_FILE_ACCEPT, type TableCodec } from "@/lib/table-codecs";
import { downloadTableNode, insertTableFromFile } from "@/lib/table-file-editor";
import { tableAroundSelection } from "@/lib/table-selection";
import { autoSizeTable, tableHasManualSizing } from "@/lib/table-sizing";
import styles from "./EditorChrome.module.css";

// PLAN.md §24 — the toolbar's table tool, QuoteControls' split-button shape
// reused verbatim: the main button inserts, the chevron opens a menu. The
// editing commands are all the table extension's own (`insertTable`,
// `addRowAfter`, … `deleteTable`); this component adds no editing logic,
// only the enabled-ness and a place to click.
//
// §24c added the two items that are not commands: "Table from file…" and
// "Download as <format>", one per codec in table-codecs.ts. The first is
// the reason the chevron is enabled *outside* a table too — it used to
// open only inside one, and an item that inserts a table has nowhere
// enabled to live under that gate. Each item is still dry-run
// individually, so the menu reads the same in both places and only the
// enabled set changes.
//
// The menu is position: fixed, placed by floating-ui and portaled to <body>
// — QuoteControls.tsx says why an absolute menu inside the toolbar cannot
// work on phones, and the same toolbar hosts this one.
const MENU_GAP = 2;

// A fresh table's size. Three by three with a header row is what every
// editor with this control defaults to, and the menu grows it from there.
const NEW_TABLE = { rows: 3, cols: 3, withHeaderRow: true };

type CommandName =
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

type MenuItem = {
  label: string;
  // A rule above the item, grouping file, rows, columns, headers, cells,
  // download, and the one destructive action.
  separator?: boolean;
} & (
  | {
      // Keyed by the command name so one `can()` dry run and one chained
      // call read the same word — a typo would fail typecheck rather than
      // silently enable a button that does nothing.
      kind: "command";
      command: CommandName;
    }
  | { kind: "import" }
  | { kind: "export"; codec: TableCodec }
  | { kind: "autosize" }
);

const COMMAND_ITEMS: (MenuItem & { kind: "command" })[] = [
  { kind: "command", label: "Add row above", command: "addRowBefore" },
  { kind: "command", label: "Add row below", command: "addRowAfter" },
  { kind: "command", label: "Delete row", command: "deleteRow" },
  { kind: "command", label: "Add column before", command: "addColumnBefore", separator: true },
  { kind: "command", label: "Add column after", command: "addColumnAfter" },
  { kind: "command", label: "Delete column", command: "deleteColumn" },
  { kind: "command", label: "Toggle header row", command: "toggleHeaderRow", separator: true },
  { kind: "command", label: "Toggle header column", command: "toggleHeaderColumn" },
  { kind: "command", label: "Merge cells", command: "mergeCells", separator: true },
  { kind: "command", label: "Split cell", command: "splitCell" },
];

const MENU_ITEMS: MenuItem[] = [
  { kind: "import", label: "Table from file…" },
  ...COMMAND_ITEMS.map((item, i) => (i === 0 ? { ...item, separator: true } : item)),
  // §24d — live only while the table carries widths (a pasted one), so an
  // author can tell from the menu whether there is anything to clear.
  { kind: "autosize", label: "Auto-size columns", separator: true },
  ...TABLE_CODECS.map((codec, i) => ({ kind: "export" as const, label: `Download as ${codec.label}`, codec, separator: i === 0 })),
  { kind: "command", label: "Delete table", command: "deleteTable", separator: true },
];

const itemKey = (item: MenuItem) =>
  item.kind === "command" ? item.command : item.kind === "export" ? `export:${item.codec.label}` : item.kind;

export default function TableControls({
  editor,
  disabled,
  onNotice,
}: {
  editor: Editor;
  disabled?: boolean;
  // Where a file's rejection is shown — the toolbar has no room of its own
  // for a sentence, so the embedder renders it (CollabEditorBody, under the
  // toolbar) and the drop handler there reports through the same seam.
  // Null clears it, which a successful insert does.
  onNotice: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // `inTable` gates the insert button and the file item: a cell is `block+`
  // and a table is a block, so the schema would happily nest one table
  // inside another, and nothing about the reading views or the file path
  // wants that. It also gates the download items the other way. The
  // command items are dry-run individually — mergeCells needs a multi-cell
  // selection, splitCell a merged cell, and so on — and useEditorState
  // deep-equals the object, so this re-renders only when a boolean flips,
  // not per keystroke (EditorToolbar's own selector note).
  const { inTable, canAutoSize, can } = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      inTable: e.isActive("table"),
      // A walk over the table's cells per transaction; a table is small.
      canAutoSize: (() => {
        const found = tableAroundSelection(e);
        return !!found && tableHasManualSizing(found.node);
      })(),
      can: Object.fromEntries(
        [...COMMAND_ITEMS, { command: "deleteTable" as const }].map((item) => [item.command, e.can()[item.command]()]),
      ) as Record<CommandName, boolean>,
    }),
  });

  const enabled = (item: MenuItem) => {
    switch (item.kind) {
      case "command":
        return can[item.command];
      case "import":
        return !inTable;
      case "export":
        return inTable;
      case "autosize":
        return canAutoSize;
    }
  };

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

  function run(item: MenuItem) {
    close();
    if (item.kind === "command") {
      editor.chain().focus()[item.command]().run();
      return;
    }
    if (item.kind === "import") {
      // The value is cleared HERE, not after a pick: `change` only fires on
      // a value that differs, so re-picking the same file after a rejected
      // import would otherwise do nothing (DocImportButton's own rule).
      if (fileRef.current) {
        fileRef.current.value = "";
        fileRef.current.click();
      }
      return;
    }
    if (item.kind === "autosize") {
      autoSizeTable(editor);
      return;
    }
    const found = tableAroundSelection(editor);
    if (!found) return;
    void downloadTableNode(found.node, item.codec, `table${item.codec.extensions[0]}`);
  }

  async function handleFile(file: File) {
    onNotice(null);
    const error = await insertTableFromFile(editor, file);
    if (error) onNotice(error);
  }

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
        disabled={disabled}
        title="Table options"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <IconChevronDown size={14} />
      </button>
      <input
        ref={fileRef}
        type="file"
        accept={TABLE_FILE_ACCEPT}
        hidden
        aria-label="Table file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
      {open &&
        !disabled &&
        createPortal(
          <div ref={menuRef} className={styles.quoteMenu} role="menu">
            {MENU_ITEMS.map((item) => (
              <button
                key={itemKey(item)}
                type="button"
                role="menuitem"
                className={`${styles.quoteMenuItem} ${item.separator ? styles.menuItemSeparated : ""}`}
                disabled={!enabled(item)}
                onClick={() => run(item)}
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
