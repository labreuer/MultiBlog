# MultiBlog — Importing Markdown into a doc

`/docs` can create a doc from Markdown two ways: **Import Markdown** picks a file, **Paste
Markdown** opens a box to paste into. Both are the same server action and the same parse;
they differ only in where the text came from and what to call a doc that carries no heading
to take a title from. Files can also be imported from the command line, through the same parse
and the same creation path, and be updated in place later: `scripts/import-claude-chats.ts
--markdown` (CLAUDE_IMPORT.md §8).

**Markdown is the only format that creates a doc here, on purpose.** A CSV (and, when it
comes, an xlsx) is a table, not a document: it goes into an *existing* doc through the
editor's table menu or a drop onto the text (docs/TABLES.md, `src/lib/table-codecs.ts`), and
nothing about it belongs in this action or its paste box. Don't add `.csv` to the accept
list below thinking it was overlooked.

The pieces:

| | |
|---|---|
| [`src/lib/markdown-import.ts`](../src/lib/markdown-import.ts) | Markdown → TipTap JSON, and the title rule |
| [`src/lib/ordered-list-markers.ts`](../src/lib/ordered-list-markers.ts) | which line opens an ordered list, and what the export writes for one (§12) |
| [`importMarkdownDocAction`](../src/app/actions/docs.ts) | validate → parse → create → redirect |
| [`createDocWithContent`](../src/lib/doc-create.ts) | seed the ydoc → insert the row → cache the body |
| [`src/components/DocImportButton.tsx`](../src/components/DocImportButton.tsx) | both controls, one `<form>` |
| [`e2e/markdown-import.spec.ts`](../e2e/markdown-import.spec.ts) | end to end |

The parse is [`@tiptap/markdown`](https://tiptap.dev/docs/editor/markdown/getting-started/installation),
Tiptap's own extension since 3.7.0 — pinned to the same exact version as `@tiptap/core`,
like every other `@tiptap/*` package here, because its peer dependency names one exact
version and npm rejects the install otherwise.

## 1. Parsing headless: `MarkdownManager`, not an `Editor`

The documented entry point is `editor.markdown.parse()`, which needs a live `Editor` —
a DOM and a mounted view, none of which exists inside a server action. The package also
exports the `MarkdownManager` that the extension wraps, and its constructor takes
`extensions` directly instead of an editor. So the parse runs against exactly the schema
we hand it, with nothing rendered and no DOM shimmed in.

One manager is built per process. It keeps no per-parse state that outlives a call (the
lexer is built per parse), and constructing it walks and flattens the whole extension
list — not work to repeat per upload.

## 2. The parse schema *is* the encode schema

`markdown-import.ts` parses with `contentExtensions`, deliberately the same exported value
the caller encodes with, rather than an equivalent list. Whatever the parse returns has to
survive `TiptapTransformer.toYdoc(json, "default", contentExtensions)`, and **a node type
registered in one and missing from the other is dropped silently on encode** rather than
reported — CLAUDE.md's "picking the wrong variant silently drops marks", restated for
another consumer.

The parse is not over `docContentExtensions`: its two extra marks (`authorHighlight`,
`annotation`) are things a doc acquires by being *edited*, and no Markdown source can produce
either. The reading and editing sides register that superset, so nothing written here is
dropped when it's read back.

**The one thing a source can produce beyond that list is an entity chip**
([ENTITY_CHIPS.md](ENTITY_CHIPS.md), MCP item 7): `[@Name](/authors/<handle>)` is a mention's
Markdown, and an import reads it as one, so a doc exported from another instance arrives with
its mentions. `markdownToDocContent(markdown, { chips: true })` parses with the same list but
for its Link, which yields a placeholder holding the handle; `resolveParsedChips` then makes
each a chip under the rule the `@` menu lists by. A handle that names no account here, or one
this importer may not mention, stays the link the Markdown also is: a person shouldn't lose a
file to one handle. (`create_doc` refuses instead, since an agent can look the handle up and
try again.) So `createDocWithContent` encodes with `docContentExtensions`, the one list with
the chip node; for a body with no chip the result is what `contentExtensions` gave.

A GFM pipe table is the worked example of the rule cutting the other way. Until docs/TABLES.md's native tables put
`@tiptap/extension-table` into `contentExtensions`, a table in the source was **silently
dropped** — a probe on 2026-09-17 returned the paragraphs on either side and nothing between,
because the fallback parser knows no `table` token and the extension that does was not
registered. Now it is, its `parseMarkdown` builds real `tableHeader`/`tableCell` rows (with
`align` from the delimiter row), and the same list encodes them. §11's comment path keeps its
table shim precisely because *that* list has no Table.

## 3. HTML in the source: tags stay text, entities get decoded

These two look adjacent and pull in opposite directions, so both halves are stated here.

### Tags become literal text, not nodes

`@tiptap/markdown` converts an embedded HTML token by handing it to `generateJSON`, but only
where `window.DOMParser` exists. With no DOM it falls back to `htmlAsLiteralText`
(`dist/index.js`, `parseHTMLToken`) rather than throwing. So a `<div>` in an imported `.md`
arrives as the five characters `<div>`.

That is a promise of this import, not an accident of where it happens to run — and it is the
reason the parse stays on the server rather than moving to the browser to "get proper HTML
support". An uploaded file's HTML turned into real nodes is an injection surface; literal
text is the safe reading of a document someone else wrote.

### Entity references *are* decoded, and that does not weaken the above

Nothing in the parse chain decodes more than four entities. `marked` decodes none — it is an
HTML *emitter*, so leaving `&nbsp;` encoded is correct for its purpose, since the browser
would decode it downstream. `@tiptap/markdown` then calls `@tiptap/core`'s
`decodeHtmlEntities`, which is:

```js
text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
```

Four references out of the ~2200 named ones in the HTML spec, and no numeric ones at all. So
`&nbsp;`, `&mdash;`, `&#8203;`, `&#x2019;` and the rest reach a ProseMirror text node
verbatim and render as their own source. `markdownToDocContent` therefore walks the parse
output and decodes with the `entities` package, which is what `parse5` and `cheerio` use.

**This does not touch the security property above.** Decoding turns `&lt;div&gt;` into the
*text* `<div>` — still a text node, still never an element. The four-entity decode already
did exactly that before any of this was added; the change is only how many references it
covers.

**Decoding is all that happens.** A reference names a character and becomes that character,
including the invisible ones — a `&#8203;` in the source arrives as a real zero-width space,
not as nothing. Deleting characters an author wrote is a separate decision from decoding
them, and the importer does not make it. Anything that should be removed rather than decoded
is a content question, to be settled deliberately and not as a side effect of parsing.

One exemption, and it is load-bearing:

- **Code is untouched, in both forms.** CommonMark does not decode entity references inside a
  code span or a fenced block, so `&lt;` there is genuinely those four characters and
  rewriting it would corrupt the sample. A `codeBlock` node is returned unwalked; a text node
  carrying the `code` mark keeps its text.

## 4. Which heading becomes the title

A leading heading is **consumed** as the doc's title rather than kept as the body's first
block. A doc's title is a separate Yjs fragment (PLAN.md §3d), not a node inside the body,
so keeping the heading too would render the same words twice on `/doc/[slug]` — once as the
heading the reading view draws from the title fragment, once as a body heading right under it.

*Which* heading counts is relative to the document, not fixed at `# H1`. Plenty of files
reserve `#` for nothing and start at `## `, and their leading H2 is that document's name every
bit as much as an H1 would be. The rule: **consume the first block if it is a heading at the
shallowest level the document uses.**

| Source | Title | Body keeps |
|---|---|---|
| `# Name` … `## Section` | `Name` | the H2s |
| `## Name` … `### Sub` | `Name` | the H3s |
| `## Preamble` … later `# Real Title` | *(fallback)* | **both** headings |
| `### Name` … `### Other` | `Name` | the other H3 |
| no headings | *(fallback)* | everything |

The third row is the one the rule exists to get right: a file whose first heading is an H2
*but which also uses H1* keeps that H2 in the body, because there it's a section of the
document rather than its name. "Starts with `##`" alone is not the condition.

Only **top-level** blocks are scanned for that minimum. A heading nested in a blockquote or a
list item is quoted or nested content, not part of the document's own outline, and letting one
veto the title would make the answer depend on something the reader doesn't think of as a
heading. A heading with no text (a bare `##`) is not consumed either.

The fallback, when nothing is consumed:

- **File import** — the filename minus directories and extension. Not "Untitled": a doc
  created this way has a name its author chose, and the file's is the only one on offer.
- **Paste** — nothing. The title stays empty, which is exactly what `+ New doc` produces and
  what `doc-title.ts` renders as "Untitled" without it ever being real content. There is
  nothing to invent a better name from, and the editor it redirects into opens with the title
  field waiting at the top.

`markdownToDocContent` always returns a valid `doc` node with at least one block: the schema's
content is `block+`, so an empty content array doesn't merely look wrong, it fails to encode.
An empty or heading-only source yields one empty paragraph.

## 5. Seeding the doc

The same creation path as `createDoc` — one row, slugged by its own id, with an eagerly
created ydoc (DOCS.md, "The ydoc behind a doc") — differing only in that the ydoc is seeded with content instead
of left empty. The seeding is [`scripts/seed-front-page.ts`](../scripts/seed-front-page.ts)'s,
and both of that script's non-obvious steps are load-bearing here for the same reasons:

- **The title goes into the doc's own `title` fragment, not just the `Doc.title` column.**
  The fragment is canonical (§3d), and `server/doc-cache.ts` writes an empty title straight
  over the column on the collab server's first flush. A column-only title therefore survives
  the redirect and then *silently vanishes a few seconds into the editing session* — which
  reads as "the import didn't save". This is the failure the spec's reload guards against.
- **`Doc.proseJson` is derived from the ydoc that was just built**, not from the parse result,
  so the cache says exactly what the canonical thing says, down to the attribute defaults Yjs
  normalizes in.

The seeding and the insert are `createDocWithContent` (`src/lib/doc-create.ts`), a plain server
module rather than part of the action module, because every export of a `"use server"` file is
callable from a browser and this one takes the creating user's id as an argument. The action
checks the session first. `scripts/import-claude-chats.ts` checks the importing account and
then calls the same function (CLAUDE_IMPORT.md §3).

The collab server does **not** need to be running: nothing here applies an annotation mark
(contrast `seed-sample-data.ts`, which reaches a doc's live ydoc through it, §12i), and
`ydocStore` writes to Postgres directly.

The ydoc is built **before** the `Doc` row is inserted, unlike `createDoc`'s ordering.
Everything that can fail on a file someone else wrote — the parse, the schema encode — then
fails with nothing written, instead of leaving a contentless doc on `/docs` for the author to
notice and clean up.

### The slug follows the title

DOCS.md, "The editor", has a doc slugged by its own cuid, because a doc is normally created titleless —
the title is a live collaborative field, so there is nothing to build a slug from at creation.
An imported doc is the exception: it arrives *with* a name, from its leading heading or its
filename (§4), so the slug is generated from that instead and the doc gets a readable URL
without anyone renaming it.

`insertDocRow` branches on the title, not on the caller. The two happen to line up — only the
import is ever handed a name at creation time — but stating it as a property of the title is
what keeps `+ New doc` on the cuid without a flag saying so.

Two edges:

- **A title that slugifies to nothing** — punctuation only, or a script with no ASCII in it at
  all — falls back to the cuid. Not to `slugify`'s own `"doc"` placeholder, which is in
  `RESERVED_SLUGS` and would come back out as `doc-doc`, then `doc-2`, `doc-3`, … for every
  such import. A meaningless-but-unique slug beats a misleadingly generic one.
- **Two imports of same-named docs landing together** can compute the same candidate, because
  `uniqueDocSlug` reads outside the insert. The loser gets a `P2002` on `Doc.slug` and asks
  again; by then the winner's row is visible, so it takes the `-2`. Bounded at three attempts
  and then the cuid, so it always terminates.

The action redirects to `/doc/<slug>/edit` rather than `/doc/<id>/edit`. Both resolve —
`resolveDocParam` tries id first, then slug (DOCS.md, "Routes") — so this is only about which URL the
author lands on and bookmarks.

## 6. The size cap exists to stay under Next's, not to be one

`MAX_MARKDOWN_BYTES` is **768 KB**, deliberately under Next's own server-action body limit,
which defaults to **1 MB** (`next/dist/server/app-render/action-handler.js`,
`defaultBodySizeLimit`) and is not overridden in `next.config.ts`.

That limit is enforced *while the request body is still being read*, so a payload above it
never reaches the action at all — it fails with an unstyled `413 Body exceeded 1 MB limit`
instead of any message the action writes. **A cap at or above 1 MB is not a cap; it is a
message that never prints.** The headroom between 768 KB and 1 MB is for multipart framing,
which makes the request a little larger than the file itself.

If `serverActions.bodySizeLimit` is ever raised, raise `MAX_MARKDOWN_BYTES` with it — and not
past it. Raising the Next limit alone widens the body *every* server action in the app will
accept, which is a bigger change than it looks.

Pasted text is measured with `Buffer.byteLength`, not `.length`: the cap is about the request
body, and any character outside ASCII is two to four bytes of it. A paste of CJK text would
otherwise be counted at a third of its real weight.

## 7. The clipboard: a textarea is the mechanism, `readText()` is a shortcut

`navigator.clipboard.readText()` **cannot** be the mechanism:

- **It needs a secure context.** `http://localhost` qualifies; the LAN IP in
  `next.config.ts`'s `allowedDevOrigins` — the whole point of which is reaching this dev
  server from another device — does not. The API is simply absent exactly where that config
  exists to help.
- **It is never one click outside Chromium.** Firefox and Safari implement no `clipboard-read`
  permission and do not intend to; they surface an ephemeral "Paste" menu the user must click,
  every time. Chromium may prompt for the permission instead.
- **It needs transient user activation and a focused document**, so it can't run on mount or
  after an `await`.
- **Every failure looks the same.** Denied, unsupported, prompt dismissed, and a clipboard
  holding something unreadable all arrive as the same rejected promise or `""`, with nothing
  to tell them apart by. They also all have the same remedy, so the handler offers that rather
  than guessing which happened and being wrong.

A `paste` into a textarea has none of that: the user performed it, so the browser hands the
text over with no permission and no prompt, in every browser and any context. Hence the
textarea is the substrate, and **Read clipboard** is feature-detected decoration on top of it
that falls back to focusing the box beside it.

The feature detection goes through `useSyncExternalStore`, not an effect that `setState`s on
mount. `navigator` doesn't exist while a client component renders on the *server* (the App
Router renders these in both places), and a button present in the browser's first paint but
absent from the SSR HTML is a hydration mismatch. `useSyncExternalStore` takes a separate
server snapshot, which is precisely the "false on the server, real value in the browser" shape
this needs — and it does it without the `set-state-in-effect` that `react-hooks` rejects. The
subscribe function never fires; the answer can't change for the life of the page.

## 8. Two controls, one form

Both live in one `<form>` and one action. The textarea is rendered **only while the paste
panel is open**, so a field that doesn't exist isn't submitted, and a file import can't also
carry a stale `markdown` field the action would have to arbitrate between. If both somehow
arrive, the file wins — picking one is the more deliberate act.

Two mechanics in `DocImportButton` that look incidental and aren't:

- **`requestSubmit()`, never `submit()`.** `submit()` bypasses the submit event entirely, so
  React never sees it, the server action never runs, and the browser does a plain multipart
  POST to the current URL.
- **The file input's value is cleared before opening the picker**, not after a submit. `change`
  only fires on a value that differs from the one already there, so after a rejected import
  (wrong extension, too big) the obvious "fix the file and pick it again" would otherwise do
  nothing at all.

## 9. Layout

`+ New doc` holds the left of the row, the import controls the right, via `space-between` on
`/docs`' own flex row rather than a margin on either child — so it keeps working as the import
block changes width, which it does the moment the paste panel opens.

`DocImportButton` then right-aligns its *own* button row as well. The page pushes the whole
`<form>` right, but a form is only as wide as its widest child, so once the panel opens the
form is wide and the buttons would otherwise sit at its **left** — jumping leftward when the
panel opens and back when it closes.

The panel's width is `min(40em, 70vw)`. **Not a percentage**: the panel's containing block is
the form, and the form is a shrink-to-fit flex item, so its width is decided *by* its contents.
A percentage width resolves against that and collapses the box to the width of the two buttons
above it — measured at ~300px rather than the 640px `40em` asks for. A viewport unit has no
such circularity, and the form's own flex-shrink still narrows it when the row runs out of room.

## 10. Testing notes

Two things about [`e2e/markdown-import.spec.ts`](../e2e/markdown-import.spec.ts) worth knowing
before editing it:

- **The untitled-paste test deletes its own doc.** The teardown sweep finds docs by an `E2E `
  *title* prefix, and that doc deliberately has no title at all. Left to the sweep it survives
  the run in a real database — and outlives its author too, once the sweep removes the e2e
  admin, leaving an authorless doc that `scripts/test-doc.ts` would then refuse to touch.
- **The `Read clipboard` test is Chromium-only**, via `test.skip(browserName !== "chromium")`.
  Playwright can only grant `clipboard-read` there, because Firefox and Safari have no such
  permission to grant — the same fact that makes the button feature-detected rather than always
  drawn. This is also the practical argument for the textarea: `fill()` works everywhere.

The size-cap test pastes 800 KB — above our cap, below Next's — and asserts *our* message
appears. That gap is the whole point of §6, so the test fails if the two numbers are ever
brought together.

## 11. The second consumer: a comment typed as Markdown (PLAN.md §23m; docs/COMMENTS.md)

`markdownToCommentContent` in the same file parses a comment's Markdown box, and it breaks
§2's rule on purpose. §2 says the parse list *is* the encode list; here the parse list is
**`commentContentExtensions` plus three shims**, and the schema the result is validated against
(`pmCommentContentSchema`, via `parseCommentBody`) is the list *without* them.

The reason is a measurement, on `@tiptap/markdown@3.29` with the comment extension list alone:

| Source | What the parser's own fallback emits |
|---|---|
| `# Title` | a `heading` node — **not in the schema, so `nodeFromJSON` throws** and the whole comment is refused for one `#` |
| a fenced code block | nothing: the block is silently deleted |
| a table | nothing |
| a rule | nothing (fine) |
| `![alt](src)` | the alt text, plain (fine — the src is exactly what §23b excludes) |
| raw HTML | literal text, per §3 (fine, and the reason this stays server-side) |
| a soft line break | a newline *inside* a text node, which the editor renders as a break and the static renderer collapses |

So a restricted extension list does not give a restricted parse: the fallback in
`parseFallbackToken` knows about `heading` and `text` regardless of what is registered, and
knows nothing about `code`, `table` or `hr`. Each shim is a bare `Extension` whose
`markdownTokenName` is the token the fallback mishandles and whose `parseMarkdown` returns
something the schema *does* define. The manager dispatches by token name, and an `Extension`
contributes nothing to `getSchema`, so the shims are parse-only by construction:

| Token | Becomes |
|---|---|
| `heading` | a paragraph, bold |
| `code` (a fence) | a paragraph of `code`-marked lines joined by `hardBreak` |
| `table` | its raw source, one row per line, joined by `hardBreak` |

A newline inside a text node becomes a space afterwards (`collapseSoftBreaks`). Then
`parseCommentBody` runs `nodeFromJSON` and `node.check()` on the result anyway — after the
conform pass that should throw only on a bug in the shims, and `src/lib/markdown-comment.test.ts`
is the table that says so, case by case.

The reverse, `commentContentToMarkdown`, serializes a stored body back for the edit box; there is
deliberately no second stored form (§23m). It runs over the same manager, so a body parsed from
Markdown and serialized again re-parses to itself — the last case in that test file.

## 12. Which line opens an ordered list

One rule decides which lines open an ordered list. It applies in every Markdown parse here: a
doc import or the paste box, the Claude-chat importer, an MCP doc create or edit and an MCP
note, a comment's Markdown box and an annotation's Markdown. It also applies to a plain-text
paste into any editor. The rule is in
[`src/lib/ordered-list-markers.ts`](../src/lib/ordered-list-markers.ts), and `OrderedList` and
`ListItem` in `tiptap-schema.ts` carry it: TipTap's own nodes with the package's Markdown
tokenizer, paste rule and item marker replaced. The nodes and the schema are unchanged.

### The package's rule, and why it is replaced

`@tiptap/extension-list` 3.29 gives `orderedList` a Markdown tokenizer of its own, ahead of
marked's CommonMark list. It takes as a marker any digits, any run of the letters `ivxlcdm`,
or any one or two letters, followed by `.` or `)` and whitespace. So on its own it reads the
start of an ordinary paragraph as a list:

| Paragraph opens with | The package reads |
|---|---|
| `N. T. Wright` | a list lettered from N (`<ol type="A" start="14">`) |
| `C. S. Lewis` | a Roman list from C, 100 |
| `cf. Barth` | a lettered list from "cf", 84 |
| `St. Augustine`, `Dr. Jones`, `No. 5` | a list from 1, **with the word deleted** |
| two of these, a blank line apart | one list of two items |

A deleted word can't be recovered: the marker is not stored anywhere. And the MCP read hides
the rest, because the export writes the marker back out, so a paragraph stored as a list
reads as an ordinary "N. T. Wright, who says…". The package's paste rule does the same to a
plain-text paste (a clipboard with no HTML on it) when every non-blank line is an item and
the markers run in sequence. A single line of "C. S. Lewis wrote" passes that test.

Upstream this is [tiptap#8395](https://github.com/ueberdosis/tiptap/issues/8395), still open.
[tiptap#8377](https://github.com/ueberdosis/tiptap/pull/8377), merged to tiptap's main but in
no 3.x release, refuses only mixed-case and invalid markers (`Ms.`, `Dr.`, `St.`). It still
reads "N. T. Wright", "C. S. Lewis", "cf." and "v. 23" as lists, so it does not retire this
rule. TODO.md says what to re-check when it ships.

### The rule

| Marker | Opens an item when followed by |
|---|---|
| digits, then `.` or `)` | whitespace: the package's rule, unchanged |
| one letter or a valid Roman numeral, then `.` | two spaces, a tab, or the end of the line |
| one letter or a valid Roman numeral, then `)` | a space, or the end of the line |
| anything else: `St`, `cf`, `Dr`, `ok`, `Iv`, `iiii` | never |

A valid Roman numeral is one in its canonical form, all in one case: `iv` and `IV`, not `Iv`
or `iiii`. Two spaces after a period is what Pandoc asks of a capital initial, here asked of
every letter, since "v. 23", "c. 1200", "n. 4", "p. 240" and "e. e. cummings" take one
space. An intended lettered list has two plain ways in: `a)` with one space, or `A.` with
two.

Letters past `z` (`aa`, `ab`, …) are the one exception to "one letter". Such a marker is an
item where the item before it at the same depth is the letter before it. As a list's first
item, it is one where the next item at its depth is the letter after it. That is how a
lettered list longer than 26, or one starting past `z`, is written, and no sentence opens
that way.

A line that fails the rule is ordinary text. Directly under an item, with no blank line
between, it is lazy continuation text of that item, as any such line is. So `a. one` then
`b. two`, with one space each, is one paragraph.

### Where a list ends

The package runs a list on through every item at its depth, of any style and across blank
lines. So two lists with nothing between them read as one, in the first list's style: a
lettered list directly above a Roman one loses the Roman list on the way back in. Here **a
lettered or Roman list goes on only with its next marker**. Any other item at its depth, a
restart at `a)` or a list in another style, opens a new list. A numbered list goes on with
any number, as in CommonMark (`1.`, `1.`, `1.` is one list), and ends at a letter.

The export writes every list's markers in sequence, so two adjacent lists it wrote read back
as two, nested ones included. The exception is two adjacent *numbered* lists, which read back
as one. CommonMark reads them as one too, unless the delimiter changes. A hand-written
lettered list with a marker out of sequence (`a)`, `b)`, `d)`) splits at it.

### Two readings of one letter

`i`, `v`, `x`, `l`, `c`, `d` and `m` are letters and numerals both. A list's first marker
reads as Pandoc's fancy_lists reads it (`anyOrderedListMarker` tries `romanOne`, then the
letter, then the numeral). `i` or `I` is Roman 1. Any other single letter is a letter, so
`c.` is 3, not 100. A longer valid numeral (`ii`, `xiv`, `cv`) is Roman.

Pandoc then requires every later item to be in the first one's style, so its `v.` then
`vi.` is two lists, a letter and then a numeral. Here **a second marker that continues the
other reading decides instead**, and the two are one list:

| Markers | Reads as |
|---|---|
| `i)`, `ii)` | Roman from 1 |
| `i)`, `j)` | letters from 9 |
| `v)`, `vi)` | Roman from 5 |
| `v)`, `w)` | letters from 22 |
| `c)`, `d)` | letters from 3 |
| `c)`, `ci)` | Roman from 100 |
| `cv)`, `cw)` | letters from 100 |
| `v)` alone | letters from 22 (Pandoc's reading) |

The two successors never coincide, so no pair is ambiguous. A **one-item list** has no second
marker, so one starting at an ambiguous value reads back in Pandoc's style: Roman 5 as
letters from 22, letters from 9 as Roman 1. Its one marker draws the same letter either way;
the difference shows only when a second item is added. A one-item lettered list starting past
`z` opens nothing and reads back as a paragraph, marker and all. These are the known gaps in
the round trip, along with two adjacent numbered lists ("Where a list ends"), and
`ordered-list-markers.test.ts` pins them.

### Compared with Pandoc

From Pandoc's source (`orderedListStart` in `src/Text/Pandoc/Readers/Markdown.hs`,
`anyOrderedListMarker` in `src/Text/Pandoc/Parsing/Lists.hs`), read rather than run:

| | Pandoc's fancy_lists | Here |
|---|---|---|
| a capital letter, then `.` | two spaces | two spaces |
| a capital numeral that is one letter (`I`, `V`, `X`, `L`, `C`, `D`, `M`), then `.` | two spaces | two spaces |
| a lower-case letter or numeral, then `.` | one space, except `p.` before a digit | two spaces |
| a numeral of two or more letters, then `.` (`II.`, `iv.`) | one space | two spaces |
| a letter or numeral, then `)` | one space | one space |
| `(a)`, both parentheses | a marker | not a marker (nor is it to the package) |
| two letters that aren't a numeral | never | only past `z`, in sequence |
| `i` first | Roman 1 | Roman 1, unless the next marker is `j` |
| another single letter first | a letter | a letter, unless the next marker continues the numeral |
| a later item in another style | ends the list | ends the list; a lettered or Roman list also ends at any item out of sequence |

### What the export writes

`1.` for a numbered list, as the package writes it. For every other style it writes `a)`,
`C)`, `iv)` and so on: the delimiter that needs one space. `a.` with two spaces would read
back too, but two spaces don't survive being retyped, by a person or by a model editing a doc
over MCP. Each such line would then be text, and turn the list into a paragraph. The schema
stores no delimiter, so writing `)` loses nothing, and `)` is a lettered list to Pandoc as
well. `start` is written as the first marker, `0` included (the package reads and writes
`start: 0` as 1), and nested lists keep their own style. An item with nothing after its marker
reads back as an item with an empty paragraph, which is what the schema requires of a list
item. The package's tokenizer gives it no content at all, which is invalid.

### Where it is, and the one way to break it

- `ordered-list-markers.ts` holds the matcher, the reading of a first marker, the tokenizer,
  the paste parser and the export's marker. The tokenizer is a port of the package's
  (`collectOrderedListItems` and `buildNestedStructure`, which it does not export), with the
  matcher in place of its regex, plus "Where a list ends" above. How lines group into
  items and nest is the package's.
- `tiptap-schema.ts` defines `OrderedList` and `ListItem`. `StarterKit` puts them in place of
  the kit's own, at the same positions, and `commentContentExtensions` lists them. So the
  three managers in `markdown-import.ts` and every editor have them.
- **The three managers share marked's single global instance**, because `MarkdownManager`
  uses it unless handed another. Each manager registers its extensions' tokenizers on that
  instance, and marked tries the next one whenever one declines. So a manager built anywhere
  in the process with the package's `OrderedList` would put its tokenizer beside ours (ahead
  or behind, by which was built first), and either way it would take the lines ours refuses. `eslint.config.mjs` refuses the package's
  `OrderedList`, `ListItem` and `ListKit` everywhere but `tiptap-schema.ts`.
- `src/lib/ordered-list-markers.test.ts` holds the table of cases through all three parsers,
  the round trips through all three exporters, the paste, and a check that each list and an
  editor's StarterKit resolve to these nodes. `e2e/markdown-import.spec.ts` imports a file
  with initials and lettered lists, and pastes plain text into the editor.
