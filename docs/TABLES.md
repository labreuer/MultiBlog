# Tables — native nodes, CSV in and out, and auto-size

**Status: built.** Native TipTap tables landed 2026-09-18 on `tables`, CSV import and
export the same day, and "Auto-size columns" on 2026-09-19 (PLAN.md §24, now a stub that
points here). This file is the as-built account, per the house convention: the survey that
chose native tables over every external-block pattern is
[docs/research/tables.md](research/tables.md) and stays there with its alternatives; this
file says what the code does and why, so that a reader can work on tables without the
survey or the plan. The editor-level traps (the wrapper, pasted widths, the node view's two
quirks, a file drop) are in [docs/TIPTAP.md](TIPTAP.md), "Tables are four nodes beside
StarterKit", and are linked from here rather than repeated.

## Why native tables

The survey rejected iframes, snapshots-with-a-link-back, embedded external editors and
transclusion for one reason: an external table holds no text in the ydoc, so nothing in
it can be quoted, annotated or tag-anchored. TipTap's own table extension keeps every cell
as ordinary paragraphs in the document, and every anchoring mechanism (PLAN.md §20a's
compiler, docs/COLLAB.md's strategies, docs/COMMENTS.md's matcher) works on table content
unchanged — verified headless: `textBetween` reads straight across cells, and `check()`
passes on an imported node. Nothing about CSV or xlsx changes that: a file becomes ordinary
`tableRow` / `tableCell` nodes with text in them.

## What is built

- **The nodes.** `tableExtensions` (`src/lib/tiptap-schema.ts`): `Table`, `TableRow`,
  `TableHeader`, `TableCell` from `@tiptap/extension-table@3.29.0`, pinned to the installed
  TipTap line. In `contentExtensions` and therefore in every body variant (docs, posts, the
  front-page preamble, `/side-by-side`), and added by hand to `CollabEditorBody`'s live
  list. `Table` is configured twice over: `renderWrapper: true` so the static renderer
  emits the same `.tableWrapper` the editor's node view draws, and
  `View: TableViewWithClearedWidths` (`src/lib/table-view.ts`) for the node-view fix under
  "Auto-size columns" below. Losing either fails no typecheck; the first loses the post
  page's only horizontal scroll box, the second breaks auto-size on screen.
- **Not in annotation bodies.** `annotationContentExtensions` stopped being an alias of
  `authorHighlightExtensions` and is now its own `[StarterKit, AuthorHighlight]`, mirrored by
  `AnnotationBody.tsx`. A margin card is 340px wide; PLAN.md §13e's toolbar already withholds
  headings and numbered lists for the same reason. Comments were never in question: §23b
  lists tables among what a stranger may not put in a comment, and that schema is stated,
  not derived.
- **The toolbar** (`TableControls.tsx`): `QuoteControls`' split button. The main button
  inserts a 3×3 table with a header row and is disabled while the caret is already in one
  (the schema would nest tables; nothing wants that). The chevron opens a menu — file, rows,
  columns, header toggles, merge and split, auto-size, download, delete — each item dry-run
  so "Split cell" is only live on a merged cell and "Auto-size columns" only when there is a
  width to clear. The chevron is enabled outside a table too, because "Table from file…"
  inserts one; only the enabled set changes between the two places. Tab, Shift-Tab and
  Tab-in-the-last-cell-adds-a-row are the extension's own keys.
- **Rendering**: one `.tableWrapper` on both surfaces, styled in `prose.module.css` as the
  `overflow-x: auto` box STYLE.md's wide-surface rule asks for, with `table-layout: fixed;
  width: 100%`, restored cell padding under `globals.css`'s reset, a `--surface-muted`
  header row, and prosemirror-tables' cell-selection class painted with the same `--link`
  wash as `.selection`. No color literals.
- **Markdown import** gains GFM pipe tables for free (docs/DOC_IMPORT.md §2); **spreadsheet
  and Word paste** work because every one of them puts an HTML `<table>` on the clipboard
  and the extension's `parseHTML` accepts it — with the column-width consequence below.

## Column widths

Column resizing is off (`resizable` unset): widths would be `colwidth` cell attrs synced
through Yjs, which is fine, but set by a drag handle the reading views cannot reproduce, and
the reading column is 800px wide. A table built in the editor or imported from Markdown has
equal columns from `table-layout: fixed; width: 100%`.

A **pasted** table is different: Word, Google Docs, Excel and Sheets all put a `<colgroup>`
with pixel widths on the clipboard, the cell parser reads them into `colwidth`, and the
node view and the static renderer both then emit `<col style="width: Npx">` per column
*and* an inline width on the `<table>` that beats the stylesheet's `width: 100%`. The
result is a table frozen at its source's widths, narrower than the reading column (a Word
table measured at 542px with a 93px first column, 2026-09-18). docs/TIPTAP.md has the
mechanism; "Auto-size columns" below is the per-table way out; the decision about what a
paste should *do* — strip the colgroup, or honour widths and turn resizing on — is TODO.md's
column-width item and is still open.

## CSV in and out of an existing doc

Built from the design in docs/research/tables.md ("CSV import and export: the CSV-only
option") with one change of scope decided before any code: **a table file goes into an
existing doc, through the editor, and never creates a doc.** The research note's
`/docs`-importer placement was dropped — a CSV is a table, not a document, and the Markdown
importer's paste box stays Markdown because commas cannot be sniffed apart from prose
(docs/DOC_IMPORT.md's opening says so at the importer). With it went the server action and
the request-body cap: everything below is client-side, and the change reaches the ydoc the
way typing does.

### The pieces, in dependency order

- `src/lib/table-grid.ts` — the `TableGrid` between a file and a `table` node: rows of
  cells carrying text (paragraphs joined by a line break), `colspan`, `rowspan` and an
  optional `href`. `gridToTableJson` (pads ragged rows, first row to `tableHeader`, one
  paragraph per line), `tableJsonToGrid` (marks dropped except the first link's href, spans
  kept), `gridToRectangle` (spans flattened to a rectangle of strings — the value in the
  first cell, empty strings under the span), and the cap. **CSV never fills the span or link
  fields; they are there so an xlsx codec is a third reader and writer over the same grid
  rather than a second grid-to-nodes path, and so the *CSV writer* is what flattens a span,
  never the grid reader** — the research note's "The shape that keeps it cheap". This is the
  one rule here that a tidy-up undoes without failing a check, which is why CLAUDE.md
  carries it.
- `src/lib/csv.ts` — RFC 4180, hand-rolled, string arrays only: `parseCsv`, `formatCsv`,
  `detectDelimiter`. Quoted fields, doubled quotes, CRLF/LF/CR, embedded line breaks, a
  leading BOM stripped on read and written on export (Excel on Windows). Rejections
  (`CsvParseError`, with the line): an unterminated quote, text after a closing quote, a
  quote inside an unquoted field, an empty file. Its `test:unit` table is the rejection
  surface.
- `src/lib/table-codecs.ts` — **the format table.** One `TableCodec` per format
  (`extensions`, `label`, `read(file) → grid`, `write(grid) → Blob`), each module reached
  through a dynamic `import()` at the moment of use. Every place that names a format — the
  menu's items, the file input's `accept`, the drop handler — reads `TABLE_CODECS`, so xlsx
  is one entry plus a library, and that library loads on click or drop and never at page
  load. `readTableFile` is the one door: extension check, a 4 MB read-sanity limit,
  decode, then the cell cap.
- `src/lib/table-file-editor.ts` — `insertTableFromFile(editor, file, at?)` and
  `downloadTableNode(node, codec, filename)`; `src/lib/table-selection.ts` finds the table
  at the caret for download and auto-size alike; `src/lib/download-blob.ts` is the
  `<a download>` route.
- `TableControls.tsx` — "Table from file…" (a hidden file input, enabled outside a table)
  and one "Download as <format>" per codec (enabled inside one).
- `CollabEditorBody.tsx` — `editorProps.handleDrop`: a file whose extension the format
  table knows is inserted at the drop point. Dispatched by extension, never by sniffing
  content, so plain-text paste stays untouched. The handler claiming the event is as
  important as the insert: ProseMirror reads nothing from a file drop and leaves the
  browser's default, which is to *navigate to the file* (docs/TIPTAP.md). Rejections from
  both paths land in one `role="alert"` line under the toolbar (`onNotice`, threaded
  through `EditorToolbar`), cleared by the next success or its ×.
- `TableDownloadButtons.tsx` — on both reading views, a "Download CSV" line under every
  table, portaled *into* the table's `.tableWrapper` after the `<table>`. Safe only because
  `TableView.ignoreMutation` ignores mutations inside the wrapper but outside its content
  (docs/TIPTAP.md). It reads the wrappers from the live editor's DOM, re-queried on the
  margin-notes content-changed signal, and the node through `posAtDOM` — never
  `Doc.proseJson`. A line under the table rather than a corner overlay: the wrapper is the
  horizontal scroll box, and an absolutely positioned child of a scroll box scrolls with
  the content.

### The cap

`MAX_TABLE_CELLS` (2,000; rows × widest row, spans counted by the cells they cover), applied
on the grid after decode and before any node is built — for every codec alike, which is why
it is not in the CSV parser: an xlsx is a zip, and a byte limit says nothing about what it
unpacks to. The number is a start (a 200×10 table); PERFORMANCE.md's super-linear diff is
the reason it exists, and real tables should move it (TODO.md).

### Policy calls the research note left open

- **Formula-leading fields are written intact** (`=SUM(A1)` stays `=SUM(A1)`). The
  quote-prefix defence changes the data on a round trip, and an xlsx cell is typed, so the
  same table exported two ways would otherwise carry different contents.
- **Semicolons are sniffed**, by which the first line has more of, outside quotes. One
  line, and the alternative is a support question from every European locale.
- **The first row is always the header.** No checkbox in the first build.
- **Nesting is refused, not allowed**: both insert paths return a message when the caret or
  drop point is inside a table, matching the toolbar's disabled insert button.

## Auto-size columns

A menu item that strips every manual size from the table at the caret, so it lays out like
one built in the editor. The case it exists for is the pasted table above.

- **What "sizing" is.** The cells' `colwidth` attr, and nothing else: `Table` declares no
  attributes, a row declares none, and a cell's others are `colspan`, `rowspan` and `align`.
  There is no stored row height anywhere — a row is as tall as its content — which is why
  the item is named for columns. The `<table>`'s inline width is *derived* from the
  colwidths at render time on both surfaces, so nulling the attrs removes it too.
  `src/lib/table-sizing.ts` says so at the top; if a table-level width or border attribute
  is ever added (docs/research/tables.md, "Table-level width and borders"), that file is
  where it joins the list.
- **One transaction**, `setNodeMarkup` per cell that has a width, positions collected
  before any is applied (attrs replaced in place, so none shift). Syncs through Yjs like
  any other edit and undoes as one step.
- **Dry-run like the rest of the menu**: enabled only while the table at the caret has at
  least one cell with a width, so the menu itself says whether there is anything to clear.
  The check walks the table's cells per transaction, stopping at cell boundaries — a
  nested table's widths are its own.
- **An upstream node-view bug, fixed by subclass.** The first run cleared every attr and
  changed nothing on screen: the extension's `updateColumns` leaves the old `width` on a
  `<col>` that has just lost its width, on every client. `tableExtensions` configures
  `View: TableViewWithClearedWidths` (`src/lib/table-view.ts`), whose `update` recomputes
  which columns have a width and strips the property from the rest. docs/TIPTAP.md has the
  mechanism.

## Testing

- `src/lib/csv.test.ts` and `src/lib/table-grid.test.ts` — the CSV grammar's rejection
  surface, and the grid's padding, spans, flattening and cap, every built node run through
  the real schema's `check()`.
- `e2e/table-csv.spec.ts` — the menu item, the drop, the rejection notice, the enabled set
  inside and outside a table, and both downloads compared as bytes (BOM and CRLF included),
  one from the editor's menu and one from the doc reading view's button.
- `e2e/table-sizing.spec.ts` — a Word-shaped paste through a `ClipboardEvent` built in the
  page (Playwright's `dispatchEvent` drops `clipboardData` for a type it doesn't know), the
  93px `<col>` and the derived table width, cleared, and the item disabled afterwards and on
  a table built in the editor. It asserts on the `<col>` styles, not the attrs, because of
  the node-view bug above.
- `e2e/table-post.spec.ts` — a pipe table imported from Markdown, its cells in the editor,
  published through "Publish as blog post" and the post editor, its cells on the public
  page, the post page's download button (one per table, the first compared as bytes), and
  at 390px a pasted width-carrying table scrolling inside its wrapper while the page does
  not. A pipe table can never overflow its wrapper under `table-layout: fixed; width: 100%`,
  so the spec pastes a wide one in beside it; that is the only table that can.
- Not covered: the pipe-table import on the post page at phone width is asserted through
  the pasted table, not the imported one, for the reason just given.

## Deviations from the research note

- The `/docs`-importer placement for CSV was dropped; a file drop onto the editor was added
  beside the menu item.
- The reading-view download is a line under the table rather than a button in the
  wrapper's corner, because the wrapper is the scroll box.
- The cap lives on the grid rather than in the parser.
- The menu item is "Table from file…", not "Table from CSV…", because the format table is
  what names formats.

## Deferred

In TODO.md: the xlsx codec (the format table is shaped for it; pick ExcelJS or SheetJS by
whether styled cells will be asked for), a header-row option, "replace this table from
file…" (cheap on the grid side, but every anchor on a changed cell goes orphan and the UI
must say so), measuring the cap, and the strip-on-paste-vs-honour-widths decision for
column widths.
