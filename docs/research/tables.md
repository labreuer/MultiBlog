# Tables in the editor: external vs. native — what others have done

A web survey commissioned 2026-09-17, before any table work starts, to answer one question:
as an alternative to TipTap's own table extension, has anyone explored rendering an
*external* table inside the editor — or external anything?

Short answer: **yes, widely, and it sorts into four patterns.** Nobody in the TipTap /
ProseMirror ecosystem ships a first-party "external table" block beyond an iframe. The two
real products closest to the idea are Google Docs' linked tables (a snapshot with a link back)
and Univer's sheet-in-a-doc (a spreadsheet block with live formulas, backed by its own store).
For this codebase, the decisive cost of any external block is that its cells hold no text in
the ydoc, so nothing in it can be quoted, annotated or tag-anchored. The verdict is at the end.

## The four patterns

### 1. Iframe embed of a third-party grid

Outline and Docmost — both ProseMirror/TipTap wikis — turn a pasted Airtable or Google
Sheets URL into an **atom node with a `url` attribute**, matched against a provider allowlist
and rendered in an iframe. Docmost runs the URL through `sanitizeUrl` before it reaches the
iframe and stores width/height as node attrs, so a resize syncs through Yjs like any other
attribute change. Outline keeps one component per provider under `shared/editor/embeds/`.
TipTap's own iframe extension exists only as an unpublished experiment ("copy the source").
BlockNote's embeds are file/image/video/audio only.

What you get: a live, interactive table for the price of one node type and a URL regex.
What you give up: the table is **opaque to the editor** — not searchable, not quotable, in
no snapshot, and every reader needs their own access to the third party. Docmost has an open
request for an admin switch to turn external embeds off, which says something about how the
pattern lands with self-hosters.

### 2. Snapshot with a link back

Google Docs' **linked tables** store a rendered copy of the Sheets range *in the document*,
with an explicit **Update** button that pulls from the sheet. Edits in the source override
edits made to the copy; edits to the copy never flow back. Viewers see the copy even without
access to the source. Tables above 400 cells paste unlinked, and a linked table cannot be
grown past 400. Unlinking is a menu item.

Confluence does the same with ADF's `extension` / `bodiedExtension` / `inlineExtension`
nodes: the node carries `extensionType`, `extensionKey` and `parameters`, and a macro renders
it; a renderer that doesn't know the extension gets a `replaceUnsupportedNode` hook. Bodied
macros wrap real document content, so the body stays editable and the frame is what's
external.

This is the pattern closest to an **immutable-post** model: the document owns a frozen copy,
and "external" is only where the copy came from.

### 3. A live external editor inside a node view

ProseMirror's canonical example embeds CodeMirror in a code-block node view. State is bridged
both ways behind an `updating` flag; `forwardUpdate` turns inner changes into outer
transactions with computed offsets, and the outer `update` diffs old vs. new text to apply
minimal inner changes so undo doesn't disrupt the widget. Undo/redo are bound to the *outer*
history so it stays unified. `selectNode` focuses the inner editor. The part the example
itself calls the hard part is **cursor motion across the widget's edges** — a custom keymap
detects the boundary and hands focus back out, or the user is trapped.

Excalidraw and Mermaid TipTap extensions follow the same shape (Mermaid: edit the source
when focused, render the SVG when blurred). TipTap's own drawing-tool example carries the
warning that matters for a collaborative stack: it **sends the whole widget state on every
change, "which can get pretty huge with Y.js."**

### 4. Transclusion from the same system

Notion's linked databases and synced blocks, AFFiNE/BlockSuite's `embed-synced-doc` block,
Coda's table views, and Univer all render a block **by reference to a separately stored
object** — the document holds an id, and the block's own store answers for its content and
its collaboration. Univer is the one that is literally a spreadsheet block inside a document,
formulas still running, with "a doc cites its source, and data stays synchronized across every
block" as the design statement. Notion's data model makes this cheap because *everything* is
already a block with an id that other blocks can reference; a ProseMirror document has no
such uniform store to lean on, so this pattern is a second persistence layer, not an
extension.

## Mechanics that recur whatever the pattern

- **Non-editable islands are still a per-app job.** The 2015 ProseMirror thread proposing
  "locked nodes" was asked about again in 2023 without an answer. An atom node with
  `contenteditable=false` makes arrow keys skip it (issue #553), and ProseMirror's selection
  polling steals focus from inputs and buttons inside it. The recommended fix is
  **`tabIndex = 0` on the node view's DOM** so the island is focusable in its own right,
  plus `stopEvent` / `ignoreMutation` for the events and mutations the widget owns.
  `stopPropagation` alone doesn't address the polling.
- **Async rendering is fine but must append, never replace.** Marijn's advice for a node view
  that fetches before rendering: return an empty element immediately, start the fetch on
  construction, cache by key, and fill the *existing* element in place — replacing the DOM
  node removes it from the document.
- **Widget state does not belong in node attrs** once it's large or changes often — that is
  exactly what the drawing-tool warning is about. Docmost gets away with it because an
  embed's attrs are a URL and two numbers.

## What this means for MultiBlog

- **Quotation is the big cost.** Comments and annotations anchor by text found in the ydoc
  (docs/COLLAB.md, docs/COMMENTS.md "The matcher"), and tags and anchored links go through
  the same `src/lib/anchors/` compiler. A native TipTap table keeps every cell as ordinary
  text nodes in the ydoc, so all of that works on table content unchanged. Any of patterns
  1, 3 or 4 puts **no text in the document**, so nothing inside the table can be quoted,
  annotated or tag-anchored, and the margin rails have nothing to align to.
- **Posts are immutable snapshots of the doc's JSON** (PLAN.md §15). A reference-only block
  means a published post's table changes after publish unless the snapshot freezes the
  table's state too — which is pattern 2 rebuilt in-house.
- **External state would need its own Y type or ydoc**, not node attrs — the precedent is
  already here: an annotation's body is its own ydoc (`ydoc:annotation:<id>`,
  docs/ANNOTATIONS.md). Pattern 3 or 4 on this stack means a `ydoc:table:<id>` namespace,
  a settle path, and snapshot rows, i.e. the whole annotation-body apparatus again.
- **Markdown import maps to native tables** (docs/DOC_IMPORT.md). The paste box and file
  import would have nothing to target with an external block.

**Verdict.** If the goal is authoring convenience — spreadsheet-like entry, pasting from
Sheets or CSV — the cheapest path that keeps every invariant is **pattern 2 on top of native
tables**: parse the paste or import into a real TipTap table, optionally storing the source
URL as a node attr with a "refresh from source" action that regenerates the cells. Patterns
3 and 4 only pay off if live external data or formulas are the actual requirement, and each
brings the cursor-edge, focus and collaboration-payload problems above plus the loss of
anchoring. Pattern 1 is the one to avoid here: it is the least work and gives up the most.

## CSV import and export: the CSV-only option

A follow-on to the survey above, 2026-09-18, after its verdict landed on native tables:
what does it take to get a table *into* a doc from a CSV file and *out* of one as a CSV
file, if CSV — comma-separated, RFC 4180 — is the only interchange format offered? Tab- or
semicolon-separated variants are deliberately out of scope for this option; where that
choice has a consequence, it is called out.

Short answer: **parsing and formatting are the small part** — a 60-line module or a 1.5 KB
library — and the real decisions are where import and export live, how a cell's block
content maps onto a flat field, and what caps stop a spreadsheet-sized file from reaching
the editor. Nothing in anchoring or the ydoc stack is touched: a CSV row becomes ordinary
`tableRow` / `tableCell` nodes with text in them, which is the whole reason the survey chose
native tables.

### The library question

Nothing CSV-shaped is installed, and Node 24 has no built-in parser. Measured 2026-09-17
from each package's npm tarball (`wc -c` of the minified build, `gzip -c | wc -c` for the
compressed size):

| | Version | License | Minified / gzipped | Types | Strips BOM | Detects delimiter |
|---|---|---|---|---|---|---|
| d3-dsv | 3.0.1 | ISC | 3.4 KB / 1.5 KB | `@types/d3-dsv` | no | no |
| PapaParse | 5.7.0 | MIT | 18.9 KB / 6.9 KB | `@types/papaparse` | yes | yes |
| csv-parse | 7.0.2 | MIT | 120 KB ESM sync build | shipped | yes | no |
| hand-rolled RFC 4180 | — | — | ~60 lines | — | trivial | one count on the first line |

csv-parse is a Node-first streaming parser and out of the question for a browser bundle.
The other two are both fine; the recommendation is to **hand-roll it** in one browser-safe
module (`src/lib/csv.ts`, parse and format together). Quoted fields, doubled quotes, CRLF
and embedded line breaks are the entire grammar, and CLAUDE.md's `test:unit` slot exists
for exactly this shape — a pure function whose *rejection surface* is the point: an
unterminated quote, ragged rows, a leading BOM, an empty file. Formatting is the easy half:
quote a field when it holds a quote, a comma or a line break, double the quotes, join rows
with CRLF. d3-dsv is the fallback if owning the parser is unwelcome, with BOM stripping
written around it. PapaParse only earns its size if delimiter detection is wanted without
writing the one-line version (see "Encoding and delimiters" below).

### Where import can live

Three placements; they are not exclusive.

- **Extend the `/docs` importer.** `DocImportButton` already takes a file or a paste and
  hands both to `importMarkdownDocAction`, which parses, seeds a ydoc, and only then inserts
  the row (docs/DOC_IMPORT.md §5). Accepting `.csv` there is a dispatch by extension to a
  parser returning the same body-plus-title shape `markdownToDocContent` returns; the
  seeding path is unchanged, and the title falls back to the filename exactly as a
  heading-less Markdown file's does. The paste panel is labelled Markdown and should stay
  that way: comma-separated text cannot be sniffed apart from prose, so pasted CSV needs its
  own control or none.
- **Insert into an existing doc from the editor.** A "Table from CSV…" item in the table
  dropdown, a file picker, a client-side parse, and `insertContent` at the caret. No server
  action, no request-body cap, and the change reaches the ydoc the way typing does. This is
  the placement authors will actually reach for — a doc is rarely just one table — and it
  is the one that needs the node-count cap below most.
- **Paste from a spreadsheet costs nothing.** Excel, Numbers and Google Sheets put an HTML
  `<table>` on the clipboard, and `@tiptap/extension-table@3.29.0`'s `parseHTML` accepts
  the `table` tag, so spreadsheet paste works the day native tables exist. Plain-text paste
  detection is where the CSV-only choice bites: there is no safe heuristic for commas, so
  this option offers none.

Today, for the record: a GFM pipe table in a Markdown import is **silently dropped** — a
probe through `MarkdownManager` over `contentExtensions` on 2026-09-17 returned the
paragraphs on either side and nothing between. The table extension ships a `parseMarkdown`
hook, so that fixes itself once it is in the shared list; CSV is the spreadsheet-shaped
input, not a replacement for it.

### Where export can live

- **Client-side, from the editor.** A "Download CSV" item in the same dropdown, reading the
  table node around the selection. A `Blob` and an `<a download>` is the mechanism
  (`AvatarCropper` already uses `URL.createObjectURL`). A **copy** affordance is the second
  place the CSV-only choice shows: a spreadsheet pastes comma-separated plain text into a
  single column and offers to split it afterwards, so "copy as CSV" is a worse experience
  than the download and is left out.
- **Client-side, from the reading views.** Readers of a public post cannot open the editor,
  so this is the placement that matters for them. Both reading surfaces already hold the
  document JSON — `AnnotatableArticle` takes it as a prop, and `DocReadingBody` has a live
  read-only editor. A small button in the corner of each table wrapper, mounted once the
  editor is ready and re-run on the content-pushed signal the margin-notes layout already
  listens to, covers both. **On the doc view it must read the live editor state, never
  `Doc.proseJson`** — that column is a store-debounce cache, stale by seconds while anyone
  is typing (CLAUDE.md, "Never position a doc annotation off `Doc.proseJson`"; the same
  staleness applies to content).
- **A server route** (a per-table `.csv` URL under the doc) is linkable and works without
  JavaScript, and the files route already shows the `Content-Disposition` shape. Rejected
  for a first build: it re-runs the read gate, a table has no stable identity (an index
  shifts when a table is added above), and the post page is static so it would be a
  separate dynamic route.

### What flattening costs

- **A cell is `block+`, not text.** `TableCell` holds paragraphs. Export joins a
  multi-paragraph cell with a line break inside a quoted field; import turns a field with
  line breaks into one paragraph per line, which is what the extension's own `parseMarkdown`
  produces per cell.
- **Marks are lost.** Bold, italic and links export as their text. Inherent to the format;
  one sentence in the user-facing docs, not a workaround.
- **Merged cells have no CSV form.** The honest export writes the value in the first cell
  and empty strings for the cells the span covers, keeping the grid rectangular. Import
  never produces a span.
- **The header row** imports as `tableHeader` cells by default, matching the Markdown
  path; export treats it as row one.
- **Ragged rows** are padded to the widest row before nodes are built. prosemirror-tables'
  `fixTables` would repair the shape anyway, but an explicit pad keeps the parser's output
  valid on its own and testable.

### Caps

`MAX_MARKDOWN_BYTES` (768 KB, `src/app/actions/docs.ts`) guards Next's 1 MB server-action
body limit (docs/DOC_IMPORT.md §6); it says nothing about the editor. At that size a CSV is
tens of thousands of cells, each a paragraph node in a DOM ProseMirror renders in full, and
PERFORMANCE.md already records the debounced revision diff going super-linear — 19.7 ms at
3.7k characters, 309–325 ms at 18k. **A rows-times-columns cap is the missing guard**, with
a message in the byte cap's style, and it applies to the editor insert path too, which has
no byte cap at all. The doc editor is not a spreadsheet, and the cap should say so in
numbers rather than let a 20,000-row file open and stutter.

### Encoding and delimiters

- **Read as UTF-8 and strip a leading BOM** — the same decision the Markdown importer made
  and for the same reason. **Write a BOM on export**: Excel on Windows otherwise reads UTF-8
  as the legacy code page. Excel's *default* "CSV" export is not UTF-8 either, and such a
  file arrives as mojibake; the rejection message can name "CSV UTF-8" as the format to
  choose.
- **European locales write "CSV" with semicolons**, because the comma is their decimal
  separator. Under a CSV-only option this is the one delimiter question that cannot be
  waved away: either count `,` against `;` on the first line and pick the winner (one
  line), or reject the file with a message. Both are honest; silently importing every row
  as one cell is not.
- **Formula injection.** A field beginning with `=`, `+`, `-` or `@` runs as a formula when
  a spreadsheet opens the export (OWASP, "CSV Injection"). The usual defence prefixes a
  single quote, which changes the data on a round trip. A policy call, not a technical one:
  mangle and document it, or leave values intact and document that.
- **Rate limiting.** Doc creation has none today, so a CSV importer adds no exposure the
  Markdown importer doesn't already have.

### Testing precedents

`e2e/markdown-import.spec.ts` drives the file input with `setInputFiles`, and
`e2e/files.spec.ts` waits on Playwright's `download` event — a CSV spec is those two
joined: import a fixture, assert the cell text in the editor, download it back and compare
bytes. The parser itself is a `test:unit` table.

### Verdict

Build the module with unit tests; extend the `/docs` importer and add the editor insert in
the same change; rely on HTML-table paste for spreadsheets; ship client-side download from
the dropdown and from both reading views. Leave the server route out. The two things the
CSV-only choice costs are a copy affordance and any plain-text paste detection, and both
are cheap to live without.

**As built, 2026-09-18 (docs/TABLES.md), where it departs from the above:** the `/docs`
importer placement was dropped before any code — a table file goes into an *existing* doc
only, so there is no server action and no byte cap tied to Next's; a file *drop* onto the
editor was added beside the menu item, dispatched by extension like the picker; the cap
lives on the grid (`MAX_TABLE_CELLS`, `table-grid.ts`) rather than in the parser, for the
reason the xlsx section gives; the reading-view control is a line under the table rather
than a button in the wrapper's corner, because the wrapper is the scroll box; formula
fields are left intact and semicolons are sniffed. The menu item is "Table from file…", not
"Table from CSV…", because the format table (`table-codecs.ts`) is what names formats.

## Adding xlsx to the interchange formats

A second follow-on, 2026-09-18: once native tables and the CSV option above exist, what does
it cost to import and export **.xlsx** as well, given how much a spreadsheet file can carry
that a table cell cannot? Everything the CSV section decides — the two import placements, the
client-side download from the dropdown and both reading views, the header-row default, the
rows-times-columns cap — carries over unchanged. This section is only about what xlsx adds
and what it costs.

### The shape that keeps it cheap

The CSV module's parse and format should not know about ProseMirror, and neither should an
xlsx codec. One grid type — rows of cells, each carrying text, `colspan`, `rowspan` and an
optional link — and exactly one function from grid to `table` JSON. CSV, TSV and xlsx are
then three readers and three writers over the grid. Build the CSV module against that grid
from the start, even though CSV never fills the span or link fields, or xlsx becomes a second
grid-to-nodes path rather than a third codec.

### Four options, by how much of xlsx they take on

1. **Paste only, no xlsx code.** Already in hand: the CSV section's "paste from a spreadsheet
   costs nothing", and the HTML the spreadsheet puts on the clipboard carries `colspan`,
   `rowspan` and bold, which the CSV file path cannot. What it lacks is a *file*: a sheet
   nobody has open, or one too large to select and copy.
2. **Values and shape, via SheetJS.** Import takes each cell's *formatted text* as Excel
   displayed it, merged ranges become spans, hyperlinks become `link` marks. Export
   reverses it: text-only cells, spans as merges. Medium annoyance, concentrated in the
   sharp edges below.
3. **Styled round trip, via ExcelJS.** Option 2 plus bold, italic and strike runs inside
   cells, column widths, and bold header cells on export. ExcelJS reads and writes styles;
   the free SheetJS build does not. Medium-high annoyance: every style is a mapping you own,
   and nearly all of them have no target in the doc schema, so most of the code is explicit
   "drop this" rules. The library is also several times SheetJS's size.
4. **Hand-rolled minimal xlsx.** An xlsx is a zip of XML (`xl/worksheets/sheet1.xml`,
   `xl/sharedStrings.xml`), so a values-only *writer* is a few hundred lines over `fflate`.
   A reader is where shared strings, inline strings, cell types and date serials live, and
   is not worth writing. Only if dependency weight becomes the problem.

Not on the list: formulas, live linked sheets, a spreadsheet node. The survey's verdict
already rules those out for anchoring reasons, and nothing about xlsx changes it — cells stay
ordinary text in the ydoc, so quotes, annotations, tags and links work on table content
unchanged.

### What xlsx packs in, and what each one costs

| Feature | Import | Export | Cost |
|---|---|---|---|
| Multiple sheets | pick one, first by default | one sheet | a selector, or a rule |
| Formulas | take the cached value, drop the formula | none | trivial |
| Numbers and dates | take the formatted text, never the raw serial | text | the one real trap |
| Merged cells | `colspan` / `rowspan` | merges | easy, one to one — the thing CSV cannot do |
| Hyperlinks | `link` mark | cell link | easy |
| Bold, italic, strike | option 3 only | option 3 only | medium |
| Fill, borders, fonts, widths | drop | drop | write the drop rule |
| Header row | the CSV default, first row | header cells become row one | nothing new |
| Rich text runs in a cell | option 3 only; flattened in 2 | option 3 only | medium |
| Comments, charts, images, validation, pivots | drop silently | none | write the drop rule |

The numbers-and-dates row is the one that bites. Excel stores a date as a serial number and
formats it at display time, so a raw read yields `45923` where the author saw a date. Reading
the formatted text sidesteps the whole class — and since a table cell is text anyway, nothing
is lost that could have been kept.

### The sharp edges

- **SheetJS packaging.** The npm copy (`xlsx@0.18.5`) is frozen with open advisories that
  `npm audit` will flag forever; the maintained builds ship only from SheetJS's own CDN, as a
  tarball URL in `package.json`. That works but is unusual enough to need a line in
  docs/ENV.md or DEPLOY.md. ExcelJS has no such problem.
- **Formatted text is locale-shaped.** Excel formats per the *saving* user's locale, so an
  imported `1.234,50` is exactly what they saw and nothing more. Right for a blog table,
  wrong if anyone later expects to sort it numerically.
- **Bundle weight is the placement question CSV never had.** The CSV section's editor
  insert and reading-view download are client-side, and a 60-line parser makes that free.
  An xlsx library is not free, so it goes behind a dynamic `import()` at the moment of use —
  the insert item's click, the download button's click — on every client placement, and the
  `/docs` importer's server action loads it the same way. The editor's own schema validates
  what `insertContent` receives, as it does for CSV, so nothing argues for moving the parse
  to the server.
- **The byte cap is a weaker guard than for CSV.** `MAX_MARKDOWN_BYTES` bounds the server
  action's request body, and an xlsx is a zip: the file that passes it can unpack to many
  times its size. The rows-times-columns cap from the CSV section is the guard that
  matters, applied after the sheet is read and before any node is built.
- **Empty space.** Sheets carry trailing empty rows and columns and sparse cells. Trim to
  the used rectangle and fill the gaps, or the imported table has phantom columns.
- **Formula injection goes away on export.** The CSV section's OWASP question exists
  because a CSV field has no type. An xlsx cell does: written as a string, a value beginning
  with `=` is a string, and no quote-prefix mangling is needed. Import is unaffected either
  way — a formula cell is read for its cached value, never evaluated.
- **Re-import replaces text.** A "refresh from source" action rewrites cells, so anchors on
  changed cells go orphan exactly as with any other text replacement. Not new, but the UI
  should say so.

### Recommendation

Option 1 arrives with the CSV verdict for free. Build the CSV module over the grid type so
that option 2 is a codec, then add it when a file import is actually asked for. Pick the
library by whether option 3 is a plausible later ask: if it is, take ExcelJS from the start
and use only its values in option 2, so option 3 is an extension rather than a library swap.
If it is not, SheetJS from the CDN is the lighter dependency.

## Word tables: paste, .docx import, and why the second is not a table feature

A third follow-on, 2026-09-18: the two sections above cover comma-separated files and
spreadsheets. What about a table that lives in a Word document? It splits into two
questions that xlsx did not raise, and only the first of them is a table feature.

### Paste is already covered

Word desktop and Word for the web both put an HTML `<table>` on the clipboard, with
`colspan` and `rowspan` on merged cells and one `<p>` per cell paragraph. That is the same
clause as the spreadsheet paste in the CSV section: the table extension's `parseHTML`
accepts the `table` tag, and ProseMirror's DOM parser drops the `mso-` styles, `<o:p>`
placeholders and `width` attributes the schema does not know. Word's notoriously messy paste
is its *lists*, which arrive as `MsoListParagraph` paragraphs with the bullet as styled text,
not its tables. This was read off the clipboard format, not measured; a real paste the same
day (the doc titled "From Word") settled it, and one clause above is wrong: `width`
attributes are *not* all dropped. The cells' `colwidth` attr is parsed from the pasted
`<colgroup>`, and the table arrives frozen at Word's column widths. The section after this
one, "Table-level width and borders", has the measurement and what honouring the rest of a
pasted table's presentation would take.

### A .docx file is a document, not a table container

An xlsx import asks "which sheet"; a docx import asks nothing, because the sensible unit is
the whole document, with tables as one node type among headings, lists and links. So a
`.docx` file is a **third format for the `/docs` importer beside Markdown**, dispatched by
extension the way the CSV section proposes, and not an item in the table dropdown. "Insert
table from .docx" would need a which-table picker for an ask nobody makes. Everything the
CSV section decides about the importer placement carries over; nothing about the editor
insert or the reading-view download applies.

### The library is mammoth

The standard docx-to-HTML converter, semantic by design: it keeps structure and drops
formatting, which is exactly the trade the doc schema makes. Measured 2026-09-18 from the
npm tarball of `mammoth@1.12.3` (BSD-2-Clause):

| | |
|---|---|
| `mammoth.browser.min.js`, minified / gzipped | 637 KB / 137 KB |
| Header rows | rows Word marks as repeating headers (`w:tblHeader`) become `thead > tr > th` since 1.4.0, which maps straight onto `tableHeader` |
| Merged cells | `w:gridSpan` becomes `colspan`; `w:vMerge` becomes `rowspan` |
| Tracked changes | inserted text is kept; deleted table rows are ignored since 1.10.0 |
| Borders, shading, column widths | ignored, matching the drop rules the xlsx section writes |
| Nested tables | come through, and are legal here since a cell is `block+` |

The `vMerge` row is the reason not to hand-roll a reader, and the docx equivalent of the
xlsx section's date-serial trap: Word marks a vertical merge as a `restart` cell followed by
continuation cells in the rows below, so a `rowspan` has to be computed by walking down the
column and the continuation cells removed. Add numbering definitions, style names and the
relationship file that hyperlinks resolve through, and a reader is a project of its own.

### The catch: where the HTML parse runs

mammoth emits HTML, and the importer runs on the server with no DOM. That is deliberate —
docs/DOC_IMPORT.md §3 keeps embedded HTML as literal text, and names it as the injection
defence and the reason the parse stays server-side. So a docx import needs an HTML-to-nodes
step somewhere that the Markdown path deliberately does not have. Three ways through:

1. **Add `@tiptap/html`** (not installed today; nothing in the tree provides a server DOM).
   Its server-side `generateJSON` runs over `zeed-dom`, no jsdom. mammoth on the server,
   `generateJSON(html, contentExtensions)`, then the existing seed step. This is the clean
   path. The doc would need to say the Markdown importer must never start routing embedded
   HTML through it, since §3's promise is about that path — the HTML here is mammoth's own
   writer's output from the docx's XML, with text escaped, not the uploader's markup.
2. **Parse in the browser and post JSON.** Cheaper, and the editor's `DOMParser` is right
   there. But the server then seeds a ydoc from client-supplied JSON, so it needs a
   schema-validation step in front of the seed, the way `parseCommentBody` stands in front
   of a comment.
3. **Convert mammoth's document AST directly**, skipping HTML. The AST is exposed only
   through the transforms API, which the README marks unstable.

### What a whole-document import drops

Since the unit is the document, the drop rules are about the document too:

- **Images.** mammoth inlines them as data-URI `<img>` by default. The schema has no image
  node, so they have nowhere to go until one exists; a custom image converter could write
  them through the files route, but that is a separate feature.
- **Underline, superscript, subscript.** No marks in the schema; the schema parse discards
  them.
- **Footnotes and endnotes** come out as a list at the end of the document. **Comments** are
  ignored by default. **Text boxes** become a paragraph after the one that held them.
- **Custom paragraph styles** map to nothing without a style map; Word's built-in headings
  map to `h1`–`h6` by default.
- **Cells** hold paragraphs, lists and nested tables, all legal in `block+` — a docx cell
  round-trips more of its content than an xlsx cell ever can.

### Export

A single table as `.docx` is as odd as importing one. The natural ask is a doc or a post as
`.docx`, which is doc export, a different feature. When it comes, `docx@9.7.1` (MIT) is a
well-kept writer with a table API, and a docx table writer is a fourth writer over the grid
type from the xlsx section. Nothing to build until someone asks.

### Verdict

Paste arrives with native tables for free, same as spreadsheets. A `.docx` file is an
importer format, not a table feature: mammoth plus `@tiptap/html` on the server, behind a
dynamic `import()` as the xlsx section prescribes, seeding through the path Markdown already
uses. Don't hand-roll the reader. Leave export until doc export is asked for.

## Table-level width and borders: what a pasted table keeps, and what the rest would take

A fourth follow-on, 2026-09-18, from the first real paste: a table copied out of Word came
through with a 93px first column that nothing in the UI could widen. The question was what
TipTap keeps of a pasted table and what it discards, and what it would take to *tolerate* the
rest — a table-level width, and borders of various kinds or none. TipTap documents none of
it: the published Table and TableCell pages list settings only. Everything below is read from
`@tiptap/extension-table` 3.29.0's source and checked by rendering the stored doc through
`@tiptap/static-renderer` with `contentExtensions`.

### What a pasted table keeps

ProseMirror's parser keeps only the attributes a node declares, so the list is short:

| node | kept | source in the pasted HTML |
|---|---|---|
| cell / header | `colspan`, `rowspan` | the `colspan` / `rowspan` attributes |
| cell / header | `colwidth` | a `colwidth` attribute, else the `width` attribute of the matching `<col>` in the table's `<colgroup>` (`parseColwidth`, `src/utils/parseColwidth.ts`) |
| cell / header | `align` | `style="text-align: …"` or an `align` attribute; only left, right or center |
| cell / header | content | cell contents; an empty cell is backfilled with an empty paragraph |
| table, row | nothing | matched by tag only |

Dropped: the `<table>`'s own `width`, `border` and `style`; cell `width`, `bgcolor` and
border styles; Word's `mso-*` classes; and `<caption>`, `<thead>` and `<tfoot>` wrappers
(their rows are lifted into the table). Marks inside cells follow StarterKit's rules, so bold
and italic survive.

The `colwidth` row is the one that bites. Word, Google Docs, Excel and Sheets all put a
`<colgroup>` with pixel widths on the clipboard, so every cell of a pasted table carries a
width. Once every column has one, `createColGroup` — shared by the static renderer's
`renderHTML` and the editor's `TableView` — emits `<col style="width: Npx">` per column
*and* an inline `style="width: <sum>px"` on the `<table>`, and the inline width beats
`prose.module.css`'s `width: 100%`. The Word table measured:

| column | stored `colwidth` |
|---|---|
| 1 | 93px |
| 2 | 178px |
| 3 | 136px |
| 4 | 135px |
| table | `style="width: 542px"` in an 800px column |

With `resizable` off there is no drag handle, so the widths Word chose are frozen in the
ydoc. docs/TIPTAP.md's tables section and TODO.md's column-width item record the two ways
out — strip the `<colgroup>` on paste, or honour widths and turn resizing on.

### Table-level width

The extension already has the hook, undocumented. Both `renderHTML` (`getTableStyle`) and
`TableView.updateColumns` check the table node for a `style` attribute containing `width:`;
when one is present it wins, and the node view skips its own colgroup-derived width. The
Table node simply declares no attributes, so nothing ever populates it. Required:

- **An attribute named exactly `style`** on Table, added with `Table.extend` in
  `tiptap-schema.ts` so the editor, the static renderer and `pmSchema` all see it. The name
  is fixed by the node view's check. Its `parseHTML` must normalise, not copy: Word sends
  `width=542` plus `style='width:406.5pt'`, Google Docs sends px, Excel sends px or nothing,
  and percentages occur. Emit only `width: <n>px` or `width: <n>%` and discard the rest of
  the style string — storing raw Word styles would also break STYLE.md's no-literal-colour
  rule.
- **A policy for the 800px column.** A 542px Word table staying 542px is arguably right. A
  1200px one is wider than the column and scrolls in `.tableWrapper`, which already works.
  The alternative is forcing pasted tables to 100% and keeping the colwidths only as
  proportions: browsers scale fixed-layout columns proportionally when they don't sum to
  the table width, so that needs no new attribute, just a `width: 100%` style written on
  paste. Pick one before writing the parser.
- **No migration.** The attribute defaults to null, existing ydocs decode with the default,
  and null renders exactly as today.
- **Tests need a browser.** A paste is a `ClipboardEvent` carrying `text/html`, so this is
  an e2e spec over captured vendor clipboard fixtures. `test:unit` has no DOM.

### Borders, and their absence

Here the extension offers nothing: cells have no border attribute, and the border comes
unconditionally from `prose.module.css` (`td, th { border: 1px solid var(--border) }`).
Required:

- **Per-cell, per-side parsing reduced to a small vocabulary.** The vendors disagree. Word
  puts `border=1` or `border=0` on the table plus per-cell `border:solid windowtext 1pt` or
  `border:none` (and `mso-border-alt`). Google Docs has no table-level signal at all, only
  per-cell, per-side `border-left:solid #000000 1pt`. Excel and Sheets are per-cell too. So a
  table-level attribute's `parseHTML` has to query the cells and decide by majority.
- **A vocabulary decision.** Recommend a table-level `borders` attribute with values `all`
  and `none`, perhaps `outer` and `rows`, rendered as a `data-borders` attribute. Per-cell
  four-side attributes are faithful but a much larger design with no UI to edit them. Colour
  and thickness are never kept: Word's `windowtext` and Docs' hex values map to the
  `--border` token.
- **CSS keyed on the data attribute** in `prose.module.css`, plus an editor-only faint dashed
  outline for borderless tables so the author can still see the grid, the way Word does. The
  static renderer's React path passes `data-*` attributes through unchanged.
- **A toggle in `TableControls`** that calls `updateAttributes` on the table, because paste
  detection will misjudge some tables and the author needs a way to correct it. Markdown pipe
  tables stay bordered by default.
- **Default null means bordered**, so nothing existing changes.

One caveat that applies to both: the `<table>` parse rule is tag-only, so all detection
lives in attribute parsers that receive the table element. That is fine, but a table nested
inside a pasted cell is parsed as a real nested table, which the schema allows and the
toolbar only discourages.

### Verdict

Nothing here is a table feature to build now. The width finding is a decision TODO.md
already carries; the borders design is written down so that when a pasted borderless layout
table shows up with a full grid, the vocabulary and the vendor encodings don't have to be
re-derived. If the strip-on-paste option wins for widths, borders can still be added
independently — the two attributes don't share anything but the `Table.extend` call.

## Sources

- [ProseMirror embedded editor example](https://prosemirror.net/examples/codemirror/)
- [Async node view rendering, discuss.ProseMirror](https://discuss.prosemirror.net/t/async-node-view-rendering/3201)
- [ProseMirror ready for widgets (islands of non-editable content), discuss.ProseMirror, 2015](https://discuss.prosemirror.net/t/prosemirror-ready-for-widgets-islands-of-non-editable-content/12)
- [Allow focus on uneditable node view, discuss.ProseMirror](https://discuss.prosemirror.net/t/allow-focus-on-uneditable-node-view/1863)
- [ContentEditable=false with NodeViews causing weird selection behavior, ProseMirror issue #553](https://github.com/ProseMirror/prosemirror/issues/553)
- [Tiptap node view examples (drag handles, drawing tool)](https://tiptap.dev/docs/editor/extensions/custom-extensions/node-views/examples)
- [Tiptap React node views](https://tiptap.dev/docs/editor/guide/node-views/react)
- [Tiptap iframe experiment](https://tiptap.dev/docs/examples/experiments/iframe)
- [Docmost content types and node views (DeepWiki)](https://deepwiki.com/docmost/docmost/3.3-content-types-and-node-views)
- [Docmost issue #2496: admin setting to disable external embeds](https://github.com/docmost/docmost/issues/2496)
- [Outline embeds guide](https://docs.getoutline.com/s/guide/doc/embeds-bqUBtgpqR0)
- [Outline Airtable integration](https://www.getoutline.com/integrations/airtable)
- [Outline embeds source](https://github.com/outline/outline/tree/main/shared/editor/embeds)
- [Google Docs: link a chart, table, or slides](https://support.google.com/docs/answer/7009814?hl=en&co=GENIE.Platform%3DDesktop)
- [Atlassian: using rich-text bodied macros](https://developer.atlassian.com/platform/forge/using-rich-text-bodied-macros/)
- [Atlassian ADF renderer](https://developer.atlassian.com/platform/forge/ui-kit/components/adf-renderer/)
- [tiptap-excalidraw-extension](https://github.com/chenxiaoyao6228/tiptap-excalidraw-extension)
- [tiptap-extension-mermaid](https://github.com/md2docx/tiptap-extension-mermaid/)
- [BlockSuite v0.12.0: embeds, sync engine](https://github.com/toeverything/blocksuite/discussions/6299)
- [Univer capabilities](https://univer.ai/capabilities)
- [Univer collaboration](https://docs.univer.ai/guides/sheets/features/collaboration)
- [Notion's data model](https://www.notion.com/blog/data-model-behind-notion)
- [The Notion user's guide to Coda: tables and views](https://coda.io/@ben-parker/the-notion-users-guide-to-coda/tables-views-5)
- [BlockNote embeds](https://www.blocknotejs.org/docs/features/blocks/embeds)
- [GitBook ContentKit](https://docs.gitbook.com/developers/integrations/contentkit)
- [RFC 4180: Common Format and MIME Type for CSV Files](https://www.rfc-editor.org/rfc/rfc4180)
- [OWASP: CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection)
- [d3-dsv](https://github.com/d3/d3-dsv)
- [PapaParse](https://www.papaparse.com/)
- [csv-parse](https://csv.js.org/parse/)
- [Tiptap Table extension](https://tiptap.dev/docs/editor/extensions/nodes/table)
- [Tiptap TableCell extension](https://tiptap.dev/docs/editor/extensions/nodes/table-cell)
- `node_modules/@tiptap/extension-table/src/utils/parseColwidth.ts`, `src/table/TableView.ts`, `src/table/table.ts` (3.29.0) — the only description of the `colwidth` fallback and the `style`-attribute width hook
- [SheetJS installation (CDN tarball vs. the frozen npm package)](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)
- [ExcelJS](https://github.com/exceljs/exceljs)
- [prosemirror-tables](https://github.com/ProseMirror/prosemirror-tables)
- [mammoth.js](https://github.com/mwilliamson/mammoth.js)
- [@tiptap/html: generateJSON on the server](https://tiptap.dev/docs/editor/api/utilities/html)
- [docx (writer)](https://github.com/dolanmiu/docx)
