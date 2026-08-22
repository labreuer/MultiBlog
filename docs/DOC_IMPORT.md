# MultiBlog — Importing Markdown into a doc

`/docs` can create a doc from Markdown two ways: **Import Markdown** picks a file, **Paste
Markdown** opens a box to paste into. Both are the same server action and the same parse;
they differ only in where the text came from and what to call a doc that carries no heading
to take a title from.

The pieces:

| | |
|---|---|
| [`src/lib/markdown-import.ts`](../src/lib/markdown-import.ts) | Markdown → TipTap JSON, and the title rule |
| [`importMarkdownDocAction`](../src/app/actions/docs.ts) | validate → parse → seed → redirect |
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

Not `docContentExtensions`: its two extra marks (`authorHighlight`, `annotation`) are things
a doc acquires by being *edited*, and no Markdown source can produce either. The reading and
editing sides register that superset, so nothing written here is dropped when it's read back.

## 3. Raw HTML in the source becomes literal text, not nodes

`@tiptap/markdown` converts an embedded HTML token by handing it to `generateJSON`, but only
where `window.DOMParser` exists. With no DOM it falls back to `htmlAsLiteralText`
(`dist/index.js`, `parseHTMLToken`) rather than throwing. So a `<div>` in an imported `.md`
arrives as the five characters `<div>`.

That is a promise of this import, not an accident of where it happens to run — and it is the
reason the parse stays on the server rather than moving to the browser to "get proper HTML
support". An uploaded file's HTML turned into real nodes is an injection surface; literal
text is the safe reading of a document someone else wrote.

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
created ydoc (PLAN.md §12b) — differing only in that the ydoc is seeded with content instead
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

The collab server does **not** need to be running: nothing here applies an annotation mark
(contrast `seed-sample-data.ts`, which reaches a doc's live ydoc through it, §12i), and
`ydocStore` writes to Postgres directly.

The ydoc is built **before** the `Doc` row is inserted, unlike `createDoc`'s ordering.
Everything that can fail on a file someone else wrote — the parse, the schema encode — then
fails with nothing written, instead of leaving a contentless doc on `/docs` for the author to
notice and clean up.

### The slug follows the title

PLAN.md §12n has a doc slugged by its own cuid, because a doc is normally created titleless —
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
`resolveDocParam` tries id first, then slug (§12f) — so this is only about which URL the
author lands on and bookmarks.

## 6. The size cap exists to stay under Next's, not to be one

`MAX_MARKDOWN_BYTES` is **768 KB**, deliberately under Next's own server-action body limit,
which defaults to **1 MB** (`next/dist/server/app-render/action-handler.js`,
`defaultBodySizeLimit`) and is not overridden in `next.config.ts`.

That limit is enforced *while the request body is still being read*, so a payload above it
never reaches the action at all — it fails with an unstyled `413 Body exceeded 1 MB limit`
instead of any message the action writes. **A cap at or above 1 MB is not a cap; it is a
message that never prints.** The first version of this import shipped with a 2 MB cap and had
exactly that bug. The headroom between 768 KB and 1 MB is for multipart framing, which makes
the request a little larger than the file itself.

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
