# The PDF viewer — external annotations, file storage, and pdfjs

Reference for work on the in-browser PDF viewer (`/pdf/[slug]`, `src/components/pdf/`,
`src/lib/pdf-*.ts`): annotations stored **outside** the PDF, the file's bytes and who may
read them, multi-client viewport sync, and pdfjs's many non-obvious failures.

**How to read this file.** It began as the design PLAN.md §19 adopted and is now the account
of what is built: every statement is current unless it says otherwise, and where the
implementation settled differently from the original design, the section concerned says so
in place rather than in an appendix. The split with PLAN.md §19 is deliberate — PLAN records
*why* the feature is shaped this way and in what order it was built; this file records *how
the surface behaves and what will bite you*. The renderer choice (PDF.js) and the
"annotations live outside the file" constraint are settled. Treat everything else as a strong
default — if you find a concrete reason it's wrong, say so rather than silently working
around it.

---

## 0. Invariants — do not violate without an explicit decision

1. **The PDF file is read-only.** Never write annotations into the PDF. No PDF mutation, no
   `pdf-lib` round-trips, no flattening.
2. **Anchors never reference the DOM.** No span indices, div indices, node paths, client
   rects, `scrollTop`, or CSS pixel values in stored data. These change with viewer
   version, zoom, window size, and device.
3. **The annotation schema is renderer-neutral.** Nothing PDF.js-specific in stored records.
   Swapping to another renderer must be a rendering change, not a data migration.
4. **Never mutate PDF.js's `.textLayer` or `.annotationLayer` DOM.** PDF.js owns and rebuilds
   them. Put our content in our own sibling layer.
5. **Viewport state is ephemeral.** It goes in Yjs *awareness*, never into the ydoc.
6. **Pin `pdfjs-dist` to an exact version.** `PDFViewerApplication` and `PDFViewer` internals
   are not a public API and break across releases.

---

## 1. Why PDF.js

Chosen over EmbedPDF (PDFium/WASM) primarily because PDF.js renders a **DOM text layer**,
which gives real `Range` objects. That buys two independent anchoring paths — geometric
(quads) and textual (quote search over the DOM) — where a geometry-only engine gives one.
It also makes Hypothesis's tested anchoring libraries directly usable.

Accepted costs: no stable public API for viewer internals; text-layer spans do not
correspond to visual lines; only rendered pages have a text layer.

EmbedPDF remains a viable future swap *if and only if* invariant 3 holds. Note that PDFium
and PDF.js extract text differently (whitespace insertion, ligatures, reading order), so
text selectors computed under one will not reliably match under the other — which is why
quads are the primary anchor, not the quote.

---

## 2. Data model

```ts
/** Stable identity for the document itself — content hash of the PDF bytes, not a URL. */
type DocId = string;

interface Annotation {
  id: string;
  docId: DocId;
  target: Target;
  body: unknown;          // app-specific: comment, tag, link, whatever
  createdBy: string;
  createdAt: string;      // ISO 8601
  updatedAt: string;
}

interface Target {
  pageIndex: number;      // 0-based

  /** PRIMARY anchor. PDF user space: points, origin bottom-left, y increases upward.
   *  One quad per visual line fragment. Same convention as a real PDF /QuadPoints. */
  quads: Quad[];

  /** CHECK. Used to verify a resolved location is still the right text. */
  quote: { exact: string; prefix: string; suffix: string };   // prefix/suffix ~32 chars

  /** HINT ONLY. Character offsets into the normalised page text. Never authoritative. */
  position: { start: number; end: number };

  /** Identifies the extractor + normaliser that produced `quote` and `position`.
   *  Format: `${pdfjsVersion}/${normaliserVersion}`. Bump on any normaliser change. */
  textVersion: string;
}

/** [x1,y1, x2,y2, x3,y3, x4,y4] in PDF user space, PDF /QuadPoints ordering. */
type Quad = [number, number, number, number, number, number, number, number];
```

**Resolution status is derived, never stored.** Compute `anchored | shifted | orphaned` at
load time and hold it in client state.

As built, `DocId` is `StoredFile.sha256`, and `Target` is stored verbatim in
`Annotation.pdfTarget` — one jsonb column rather than seven (invariant 3; PLAN.md §19
Phase 1) — on a row that is otherwise an ordinary `Annotation` with `fileId` set instead of
`docId`. Only roots carry a target: a reply anchors into its parent's body exactly as on the
doc side (PLAN.md §13p). The `Annotation` type above is the shape the reasoning is about,
not the Prisma model.

---

## 2a. The file's bytes — on disk, not a `bytea`

An uploaded PDF is bytes on the filesystem (PLAN.md §19), content-addressed at
`FILE_STORAGE_DIR/<sha256[0:2]>/<sha256>` and served from `/api/files/<id>/<hash>` with
`Range` support, so PDF.js can render page 1 of a large scan without transferring all of it.

**Prisma cannot stream a `Bytes` column, which is the whole argument**: a 50MB file would
land in Node's heap on upload *and* on every one of pdfjs's range requests. `UserAvatar`'s
in-Postgres bytes are not a counter-precedent — those are ~10KB and served whole.

Consequences worth remembering:

- **`FILE_STORAGE_DIR` is a second backup surface `pg_dump` does not cover** (DEPLOY.md).
- **Never delete a file's bytes without counting references first.** Content addressing means
  two `StoredFile` rows can legitimately share one blob; `deleteBytesIfUnreferenced` takes the
  surviving count as an argument for exactly that reason.
- The Prisma model is **`StoredFile`**, `@@map("file")`. The table is `file`; the generated TS
  type must not be `File`, which is a DOM/Node global the upload path uses.
- Upload is a **Route Handler taking a raw body** — not a Server Action and not multipart.
  Actions carry a 1MB `bodySizeLimit` that raising would raise site-wide, and
  `request.formData()` buffers the whole upload before user code sees it. nginx needs
  `client_max_body_size` raised to match (`deploy/nginx-app.conf.sample`); the uploader names
  the proxy explicitly on a 413 or a severed connection, since neither mentions nginx.
- **Access is docs' PRIVATE/SHARED model** (`src/lib/file-authz.ts`, docs/PERMISSIONS.md),
  and an annotation on a file is an ordinary `Annotation` row, so it inherits DRAFT privacy,
  soft delete and `requireOwnOrAdmin` unchanged.

### A file's listed users are `FileOwner`s, not authors

Nobody on that list wrote the PDF. The list is seeded with the uploader, is editable
afterwards, and grants `/files`' Owner(s) line, the right to rename / re-slug / re-own /
delete, and read access to a `PRIVATE` file.

The uploader is recorded apart from it, in `file.created_by_user_id`. That column is set once
at upload and never edited, and it grants nothing. It stays correct after the owner list drops
the uploader. A file older than the column holds its first owner by `owner_order`, filled by the
`add_doc_file_created_by` migration, or NULL if it had no owner left.

`DocAuthor`/`PostAuthor` are "author" because a doc's or post's listed users really did write
it, and the shared filter kit (`AuthorFilterPanel`, `authorFilterWhere`, `AuthorMode`) is
named for those two surfaces. `/files` reaches it through the
`ownerFilterWhere`/`listOwnerFilterOptions` wrappers and an aliased import, and every option
it added defaults to what `/docs` and `/posts` pass — which is what keeps those two tables out
of it.

**Don't "unify" the two vocabularies in either direction.**

---

## 3. Text normalisation

Anchoring correctness depends entirely on this being **deterministic and versioned**.

Pipeline, applied per page to `page.getTextContent()`:

1. Join `items` in order. PDF.js frequently omits inter-item spaces — insert a space when
   the gap between item bounding boxes exceeds a fraction of the font size, and a newline
   when `item.hasEOL` is set.
2. Unicode NFKC — **per character, not over the joined string**. Whole-string NFKC can merge
   or reorder across characters, which is incompatible with the exact offset map below;
   per-character keeps the map exact and the function deterministic.
3. Decompose ligatures (ﬁ, ﬂ, ﬀ, ﬃ, ﬄ, ﬅ, ﬆ).
4. Strip soft hyphens (U+00AD) and zero-width characters, and control characters: C0 other
   than the whitespace ones step 6 folds, and DEL. An unmapped glyph can extract as U+0000
   (JSTOR's stamped download footer does), and Postgres `text` cannot store it at all.
5. Normalise dashes and quote characters to ASCII.
6. Collapse runs of whitespace to a single space; trim.

While joining, build an **offset map**: normalised char index → `{ itemIndex, charOffset }`.
This is what makes `position` → `quads` recoverable without a rendered text layer, and it is
the reason normalisation must be a pure function of `getTextContent()` output.

The normalised text of every page is **stored** — `file_page_text`, extracted once at upload
(PLAN.md §19 Phase 1) — and the browser caches text + offset map per
`(fileId, pageIndex, textVersion)`, which is expensive to build and completely stable for a
given version. Storing it is what makes `quotedText`'s server-side derivation (§4) a string
slice rather than a re-parse of the PDF per post; search over it is a free consequence, not
the reason. Both sides that matter — upload extraction and selection capture — call the same
function (`src/lib/pdf-text.ts`), so they agree by construction.

When `textVersion` changes, a file's **page text** is re-extracted lazily: the first capture
that asks for a file at the version this server produces, and finds no rows there, extracts
the whole file and stores the new rows beside the old ones (`src/lib/pdf-page-text.ts`).
Without that, every new anchor on every older file would be stored with an empty quote,
silently, since the server-side derivation (§4) slices text *at the client's version*. The
lazy path never touches the old rows: every stored anchor names its own `textVersion`, and
the integrity check verifies it against exactly that extraction.

`scripts/upgrade-pdf-text-version.ts` does the same for every file at once, and adds the
cleanup the lazy path doesn't: an anchor whose page reads identically at both versions has
its stamp moved to the new one (its offsets and quote are then true there by construction),
and an old version is deleted once no anchor names it. An anchor on a page whose text
changed keeps its version, and so keeps that version's rows alive. Dry run by default; the
script's header has the details.

Re-anchoring the stored **anchors** themselves is meant to be lazy as well, on next open,
rewriting `quote`/`position` if resolution succeeds — never a batch migration. **Not built
yet**: it is deferred together with §4's fuzzy match, and the quads carry every annotation
meanwhile.

---

## 4. Anchoring algorithm

Resolve order, per annotation:

1. **Exact quote match** in normalised page text, searching outward from `position.start`.
   Cheap, and correct in the overwhelming majority of cases.
2. **Fuzzy quote match** — bounded edit distance, within a window around `position.start`.
   Only if step 1 misses. **Not built**: it matters only after a `textVersion` bump, and
   doing it properly needs a worker (below); steps 1, 3 and 4 make the viewer correct
   without it, because the quads always resolve.
3. **Quads fallback** — use `target.quads` directly. Always available; correct unless the
   PDF bytes changed, which `docId` already rules out.
4. **Orphaned** — if the text under the resolved quads fails the quote check, mark orphaned
   and surface it in the UI rather than rendering a highlight in the wrong place.

**Do not run step 2 synchronously on the main thread.** Hypothesis shipped a bug where serial
fuzzy resolution of many short, generic quotes blocked page execution for over ten seconds.
Batch fuzzy resolution into a worker, or yield between annotations, and render steps 1 and 3
immediately so the page is usable while stragglers resolve.

Because `docId` is a content hash, the PDF cannot have changed underneath us. Steps 1–2 exist
to survive *our own* extractor/normaliser changes, not document edits.

**So a PDF anchor cannot drift, and its implementation is far smaller than a text
document's.** No tracking plugin, no per-transaction re-resolution, no version stamp — a
ydoc update id is meaningless for a file. Two obligations replace all of that:

- **Bump the normaliser's version on *any* behavioural change, however small**
  (`NORMALISER_VERSION`, `src/lib/pdf-text.ts`). It is the only thing that can invalidate a
  stored `position`, and steps 1–2 above are the only recovery.
- **Keep deriving `quotedText` server-side** from the page text extracted at upload, so §12i's
  "the selected text is a request field only, never a column" holds here too. That is a claim
  written down once rather than a value anything recomputes, so nothing would notice it
  breaking — `scripts/integrity/check-pdf-anchors.ts` exists to be the thing that does.

**Fragment links are the one reader that finds a passage again on every open**
([PDF_FRAGMENT_LINKS.md](PDF_FRAGMENT_LINKS.md)): a URL naming a passage by its words, with no
stored quads, whose viewer measures quads from `getTextContent()` through the `offsets` map
above (`src/lib/pdf-quads.ts`, [PDF_QUADS.md](PDF_QUADS.md)). It matches by skeleton, letters and digits only, which no step
of the normaliser changes, so a `NORMALISER_VERSION` bump can't break one. A pdfjs bump that
extracts different letters, or the same ones in another order, can, and
`scripts/integrity/check-pdf-fragment-links.ts` is what notices.

---

## 5. Coordinates

The only conversion API to use:

```ts
const viewport = page.getViewport({ scale, rotation });
viewport.convertToPdfPoint(x, y);         // page-relative CSS px -> PDF user space
viewport.convertToViewportPoint(x, y);    // PDF user space -> page-relative CSS px
```

There is no rectangle conversion in pdfjs 6 — `convertToViewportRectangle` exists in neither
the types nor the shipped `pdf.mjs`. Convert a box's two opposite corners as points and take
min/max; for an axis-aligned rectangle, which is all a quad's bounding box ever is here, that
is exactly equivalent (`src/lib/pdf-anchor-resolve.ts`).

Rules:

- `x`/`y` passed to `convertToPdfPoint` must be relative to the page element's **content**
  box — and `getBoundingClientRect()` returns its **border** box, which is not the same
  origin. pdfjs draws a `--page-border` (9px a side as of 6.2.108) and every layer we add is
  `inset: 0`, so it positions from the padding box while the rect starts a border-width
  earlier. Add the border widths back when converting client coordinates
  (`pageContentOrigin`, `src/lib/pdf-anchor-capture.ts`). The resulting error is constant in
  CSS pixels and independent of zoom, which makes it read as a rounding artefact.
- **The page element must be `content-box`.** pdfjs's stylesheet sets `.page`'s width and
  height to the scaled page size and then adds that border *outside* it. A global
  `* { box-sizing: border-box }` reset makes the border eat into the declared size instead,
  so the rendered content ends up ~18px narrower than the viewport transform believes — a
  ~2% **scale** error that grows with the length of whatever is being measured, not the
  layout error a box-sizing bug sounds like. Restore `content-box` for the viewer subtree.
- Test these two by asserting **alignment within a couple of pixels at several zooms**, not
  by asserting overlap. Both shipped together here and every test passed, because an overlap
  assertion tolerated 4.5px of error — and they failed differently: the border offset was
  constant in CSS pixels, the box-sizing error scaled.
- Use CSS pixels from `getBoundingClientRect()`, never canvas backing-store pixels. The
  canvas is scaled by `devicePixelRatio`; the viewport transform is not.
- Always pass the page's **current** `rotation` into `getViewport`. Rotation changes invalidate
  every cached viewport rect.
- `range.getClientRects()` returns one rect per rendered line fragment, not per selection.
  Store all of them as separate quads — that is what makes a multi-line highlight render
  correctly.
- **`viewer.currentScale` is not the conversion scale.** A page viewport is built at
  `currentScale * PixelsPerInch.PDF_TO_CSS_UNITS` — the 96/72 converting PDF's 72dpi points
  to CSS pixels — and it is that *product* which maps a point to a screen position. Anything
  deriving a length or an offset in PDF space from the bare zoom level is out by exactly 4/3.
  Prefer `pageView.viewport`, which is already the product; reach for `currentScale` only
  when the page you need has not been built, and multiply. 4/3 is small enough to read as a
  chosen value rather than a unit error, and that is how it once cost a release cycle:
  "scroll a jumped-to passage 25% down the viewport" computed its offset from `currentScale`
  and landed the passage at 0.333. Nothing threw, no test could see it, and a third of the
  way down looks exactly like a value somebody chose; it was found by measuring the rendered
  position against the container, which is the only thing that would have found it.

Selection → stored anchor:

```
window.getSelection().getRangeAt(0)
  -> split by page (walk from startContainer's page to endContainer's page)
  -> per page: getClientRects()
  -> subtract page div rect
  -> convertToPdfPoint each corner
  -> quads
  -> plus quote/position from the normalised page text
```

### Navigating to a point

```ts
viewer.scrollPageIntoView({
  pageNumber,                                     // 1-based, unlike destArray[0]
  destArray: [pageIndex, { name: "XYZ" }, left, top, zoom],
});                                               // zoom null preserves the reader's own
```

- `top` names the point pdfjs puts at the **top edge of the view**, not the centre.
- **Landing a passage flush against that edge is usually wrong.** It leaves no context above
  it, so a quote beginning mid-sentence arrives with its lead-in off screen; and on a layout
  carrying a rail or an overlay along the top, it puts the passage's own card out of sight.
  Offset by a fraction of the viewport height instead.
- PDF user space has y increasing **upward**, so moving the view's top edge *higher up the
  page* means a **larger** `top`: the offset is **added**. The wrong sign scrolls the same
  distance the wrong way, which reads as a tuning problem rather than a reversal.
- Convert the offset with the combined scale from the rules above —
  `viewportHeightPx * fraction / (currentScale * PDF_TO_CSS_UNITS)`.
- A `top` above the page's own top edge needs **no clamp**. pdfjs scrolls into the inter-page
  gap and the page before it, which is the context the offset exists to show.

---

## 6. Layer structure

Per page, inside PDF.js's `.page` element:

```
.page
  .canvasWrapper       (PDF.js)
  .annoLayer           OURS — position:absolute; inset:0; pointer-events:none; z-index below textLayer
  .textLayer           (PDF.js) — native selection must keep working
  .annotationLayer     (PDF.js) — link annotations
```

- Individual highlight rects inside `.annoLayer` get `pointer-events: auto` only if they need
  hover affordances. Otherwise leave the whole layer inert and hit-test on click (§7).
- Build `.annoLayer` on the `textlayerrendered` event (it implies the canvas is up). Tear it
  down when PDF.js evicts the page — PDF.js virtualises, so pages outside the buffer have no
  DOM at all.
- Highlights are re-derived from quads on every render at the current scale/rotation. Never
  cache positioned DOM across a scale change.

**CSS Custom Highlight API** (`new Highlight(range)` + `CSS.highlights.set()` + `::highlight()`)
is available as an *optional* second pass for non-interactive emphasis, e.g. search results.
It is cheap and does not touch the DOM. It cannot be used for clickable annotations: custom
highlights receive no pointer events, and the workaround `CSS.highlights.highlightsFromPoint()`
is Chromium-only (shipped Chrome 140, absent in Firefox and Safari).

---

## 7. Click handling

One delegated listener on the viewer container. Not per-rect listeners — there can be
thousands of rects.

```ts
container.addEventListener('click', (e) => {
  if (dragDistanceExceeded) return;        // don't fire when the user was selecting text
  const hits = document.elementsFromPoint(e.clientX, e.clientY)
    .filter(el => el.hasAttribute('data-anno-id'));
  if (!hits.length) return;
  // topmost wins; if hits.length > 1, offer a disambiguation menu for overlapping annotations
});
```

Track pointer movement between `pointerdown` and `click` and suppress the handler past a small
threshold (~4px). Otherwise every text selection that starts on a highlight fires a click.

Overlapping annotations are normal and expected — `elementsFromPoint` returns all of them,
which is the right primitive.

---

## 8. Viewport observation

```ts
eventBus.on('updateviewarea', ({ location }) => { /* pageNumber, scale, top, left, rotation */ });
eventBus.on('pagechanging', ...);
eventBus.on('scalechanging', ...);
eventBus.on('rotationchanging', ...);
```

`updateviewarea` fires extremely often — Mozilla's own tracker notes over a thousand fires
while scrolling a short document. **Coalesce to one rAF tick before anything reads it**, and
throttle again before anything network-facing.

If visible-*fraction* per page is needed (not just "which page"), use an `IntersectionObserver`
per page element with a threshold array; `intersectionRect` gives the visible slab, which
converts to PDF space via §5.

---

## 9. Multi-client sync

### Wire format

```ts
type PdfPresence = {                                  // src/lib/pdf-presence.ts
  user: { id, name, color },                          // author palette — a remote cursor is attributable
  viewport: {
    pageIndex: number;
    pdfPoint: [left: number, top: number];            // PDF user space, top-left of visible region
    zoomMode: 'page-fit' | 'page-width' | number;
    t: number;                                        // monotonic, for staleness
  } | null,
  selection: { pageIndex, quads: Quad[] } | null,     // in progress — visible before it becomes an annotation
  leading: boolean,                                   // "I'm presenting — come join me"
  following: string | null,                           // clientId being followed
};
```

`viewport` is the part the rules below are about. `user`, `selection` and the
`leading`/`following` pair are what presence needs beyond following a scroll — the original
design's `ViewportState` was the `viewport` field alone, and PLAN.md §19 Phase 4 records the
widening.

Never broadcast `scrollTop`, `scrollLeft`, pixel offsets, or a raw scale — they are meaningless
on a different window size, zoom level, or DPR.

`viewport` maps 1:1 onto a PDF destination array, which is also what PDF.js consumes:

```ts
pdfViewer.scrollPageIntoView({
  pageNumber: pageIndex + 1,
  destArray: [pageIndex, { name: 'XYZ' }, left, top, null],
});
```

Passing `null` for zoom preserves the local user's zoom, which is almost always what you want —
followers should see the same *content*, not be forced into the leader's zoom level.

**Two pdfjs details make the round trip lossy at a page boundary, and they compose into a snap
that reads as a network problem.** Both are fixed in `use-pdf-presence.ts`; re-check them on any
`pdfjs-dist` bump.

- **`viewer.currentPageNumber` is the *most-visible* page, not the topmost one.** `update()`
  asks `_getVisiblePages()` with `sortByVisibility: true` and takes `visiblePages[0].id`; the
  `stillFullyVisible` shortcut that would hold the number steady needs `percent === 100`, which
  page-width on a phone never reaches. So it flips to page N+1 at the *area* crossover — about
  half a screen before the container's top edge reaches page N+1 — and measuring the visible
  region against that page produces a `pdfPoint` above its own top edge. Derive the page from
  geometry instead (`topmostVisiblePageIndex`). pdfjs does the same thing internally for
  `_updateLocation`, using `visible.first`, which is captured *before* the visibility sort.
- **`scrollPageIntoView` clamps with `Math.max(…, 0)` unless you pass `allowNegativeOffset`.** A
  destination above its page's top edge therefore becomes "put this page's top edge at the top of
  the viewport". Combined with the above that is a jump forward of up to half a screen, then a
  dead zone while every further broadcast clamps to the same 0 — jumpy at every page boundary,
  tight everywhere else. A point outside the page is not malformed: it is what "the visible
  region starts in the previous page" looks like.

One more sign error to not repeat: **CSS px per PDF point is `currentScale * PDF_TO_CSS_UNITS`,
never `currentScale`** (§5). The tolerance compare below is in PDF points and got this wrong for
as long as it existed, which made it ~33% looser than the 2% it claims.

### Transport

- **Annotations → Postgres rows**, not a `Y.Map` in the per-file ydoc. The ydoc
  `ydoc:pdf:<fileId>` exists and stays empty, carrying awareness only. A `Y.Map` would have
  bought CRDT merge and offline creation, and lost five things specific to this codebase —
  chiefly that Hocuspocus authorizes the connection rather than the keys (every DRAFT
  readable, every entry deletable, unattributed) and that `/annotations` could not see them.
  PLAN.md §19, *Decisions taken*, has the full comparison.
- **Viewport → awareness.** Ephemeral and unpersisted by design. Putting viewport updates in
  the ydoc would bloat the update log badly, which matters given the `gc: false` work.
- **The presence connection is the page's socket.** Every annotation opened on the file
  attaches to it as another document rather than opening a socket of its own, the same
  arrangement `/doc/[slug]` has with its live tap (docs/YDOC.md "One socket per page"). That
  is why `DocPresenceProvider` sits in `PdfSurfaceClient`, above the surface whose hook
  needs it.

### Echo suppression

Applying a remote viewport fires the local scroll handler, which broadcasts, which the peer
applies, which fires theirs. Guard with all three:

1. An `applyingRemote` flag set before `scrollPageIntoView` and cleared on the next rAF after
   the resulting `updateviewarea`.
2. A tolerance compare — skip the broadcast if the new state is within ~2% of viewport height
   of the last state received.
3. A timestamp guard — ignore inbound states older than the last one applied.

Throttle outbound to ~10 Hz and drop intermediate states. Awareness already coalesces, so do
not queue.

### Follow semantics

Default to **passive presence**: render remote viewports as scrollbar ticks or edge markers.
Snapping is opt-in and one-directional ("follow Alice"), with any local scroll gesture
immediately dropping the follow. Symmetric mutual following is unusable in practice.

A tick strip beside the scroller has a coordinate problem the ticks themselves don't hint
at: a platform scrollbar insets its track by an arrow button at each end, no API reports
that inset, and a strip drawn over the full height therefore disagrees with the scrollbar
worst at both ends and not at all in the middle. STYLE.md's "Custom scrollbars, and anything
positioned beside one" has the measurements and the fix.

---

## 10. Version coupling

The viewer is built on **`PDFViewer` + `EventBus` + `PDFLinkService` from
`pdfjs-dist/web/pdf_viewer.mjs`** — not `PDFViewerApplication`, which is the bundled
`web/viewer.html` *application* rather than an importable library entry. Those classes,
`pageView.div`, and the `eventBus` event names are all internals with no stability promise.
`pdfjs-dist` is pinned exactly (invariant 6), every browser-side import of it goes through
`src/lib/pdfjs-client.ts` so the internals we depend on are named in one place, and the
first test in `e2e/pdf-viewer.spec.ts` asserts they still exist — so an upgrade fails loudly
there rather than silently at runtime.

Hypothesis — who have done exactly this integration for over a decade — ship a standing warning
that new PDF.js releases may be incompatible with their client. Budget for upgrade work; do not
float the version.

### Traps verified against 6.2.108

Each of these fails in a way that does not look like its cause. Re-check them on any bump.

- **Turbopack rewrites `require.resolve("pdfjs-dist/…")` to a virtual module id**, even under
  `serverExternalPackages`. pdfjs then reports `Invalid factory url: … must include trailing
  slash`, which reads like a malformed URL of ours. Anchor `createRequire` at the project
  root *and* build the specifier from a variable so it is not statically analysable
  (`src/lib/pdf-extract.ts`). This fails **only through Next** — the same code under `npx
  tsx` is fine.
- **`workerSrc`, never `workerPort`.** A supplied port is shared, so destroying one loading
  task marks that PDFWorker destroyed and the *second* mount dies with `PDFWorker.create -
  the worker is being destroyed` — which reads like a missing `await` in our own teardown.
  React StrictMode trips it on every dev page load.
- **`workerSrc` wants a `file://` URL; `standardFontDataUrl` wants a bare path.** Same
  library, opposite spellings, because one goes through Node's ESM loader and the other
  through pdfjs's own filesystem read.
- **`PDFDocumentProxy.destroy()` is gone in 6.x.** It has `cleanup()`, which drops cached
  fonts and leaves the worker alive. Destroy the *loading task* instead.
  `convertToViewportRectangle` is gone in 6.x too (§5).
- **There are FOUR runtime asset directories, not two**, all fetched by URLs pdfjs builds by
  concatenation, so no bundler can see them: `standard_fonts/`, `cmaps/`, **`wasm/`** (the
  JBIG2 and JPEG 2000 decoders) and `iccs/`. Copy all four into `public/` from a `prebuild`/
  `predev` step so it cannot be skipped (`scripts/copy-pdfjs-assets.ts`). Miss `wasm/` and a
  **scanned** PDF renders as blank pages with a working text layer floating over them —
  which reads as "the viewer is broken", not as a decoder problem. An unset URL concatenates
  onto `null`, so the tell is `Failed to resolve module specifier
  'nullopenjpeg_nowasm_fallback.js'`. **Generated fixtures cannot catch this**: a text-only
  PDF exercises no image decoder at all, so the guard has to be a test that each directory is
  actually served (`e2e/pdf-assets.spec.ts`).

### Engine coupling — the built-ins pdfjs assumes

Pinning `pdfjs-dist` fixes the API you call. It does nothing about the second coupling, which
is to the *JavaScript runtime* pdfjs assumes underneath it — and pdfjs tracks new built-ins
closely, while WebKit ships them late or not at all. **Baseline: Safari 26 / iPadOS 18.4+.**

**Two built-ins are patched**, both in `src/lib/pdfjs-webkit-polyfills.ts`. They fail for
different reasons, and the difference decides when each may be removed:

- **`ReadableStream.prototype[Symbol.asyncIterator]`** — WebKit has *never* implemented it, in
  either realm, and does not at Safari 26.6.1. `getTextContent` iterates its stream with
  `for await (const value of readableStream)`, so without the patch **every text extraction
  throws** — which on this surface means a selection is captured and then dies before it can
  be published or become an annotation. This one does not age out.
- **`Map.prototype.getOrInsert` / `.getOrInsertComputed`** — absent below **Safari 26.2**
  ([MDN compatibility data](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/getOrInsert#browser_compatibility):
  Safari 26.2, Safari on iOS mirroring it, Chrome 145, Firefox 144, Node 26 — Baseline "newly
  available" since February 2026), which is *inside* the baseline's own range, so every
  supported engine below that lacks them. pdfjs calls `.getOrInsertComputed` 68 times and
  `.getOrInsert` twice, across `pdf.mjs`, `pdf.worker.mjs` and `pdf.sandbox.mjs`, and guards
  none of them — so the first `Map` either realm touches throws
  (`this.#methodPromises.getOrInsertComputed is not a function`), which is why the symptom is
  a viewer that mounts its toolbar and renders **no document at all** rather than one that
  fails partway. This patch may be deleted once the baseline's floor rises past 26.2 —
  measured, per the rule below, not assumed.

A third gap, the **`Iterator` global**, needs no patch: it shipped in Safari 18.4, the
baseline's floor. Its shape is worth keeping in mind anyway, because it is the one that
defeats a `typeof` guard. pdfjs polyfills `Iterator.prototype.join` itself, guarded by
`typeof Iterator.prototype.join !== "function"` — and that guard dereferences the *global*.
On an engine without it the failure is a `ReferenceError` out of pdfjs's top-level module body
before a line of its own logic runs: the viewer never mounts, and the stack points at our
`import * as pdfjs`. **A `typeof` guard protects the property, not the object it hangs off.**

**Measure the floor, not the ceiling.** `npx tsx scripts/probe-engine.ts` runs the checks on
the main thread *and* inside a module worker of whatever browser is on this machine, and
prints both columns. `npx tsx scripts/remote-console.ts` runs the same list on a **real
phone** over the LAN, which is the only way to reach the bottom of the supported range —
Playwright's WebKit will not launch on macOS 14, and Appium needs an Xcode newer than macOS
14 accepts, so neither fence moves without a newer Mac (docs/ENV.md).

So the rule has two halves, and the second is the one that is easy to miss: **add a patch on a
failure, remove one on a measurement — and take that measurement on the oldest engine the
baseline claims to support, not the newest one to hand.** A measurement from a single current
desktop Safari says nothing about an 18.x device, and is blind to this class in exactly the way
a chromium-only suite is. Delete a patch on the strength of one and the viewer breaks
completely — toolbar, no document — for every reader on an in-baseline iPhone or iPad.

Two columns below are measured, on the dates given. The *shipped in* column is orientation and
not evidence — prefer MDN's compatibility data, which is where the 26.2 above comes from.

| built-in | Safari 26.6.1 (2026-08-22) | iOS 18.6.2 (2026-08-25) | shipped in |
| --- | --- | --- | --- |
| `ReadableStream.prototype[Symbol.asyncIterator]` (and `.values`) | **absent** | **absent** | never |
| `Map.prototype.getOrInsert` / `.getOrInsertComputed` | present | **absent** | 26.2 |
| `Iterator` global | present | present | 18.4 |
| `Iterator.prototype.join` | absent | absent | — (pdfjs polyfills it itself) |
| `URL.parse` / `URL.canParse` | present | present | 18.0 / 17.0 |
| `Response.prototype.bytes`, `Uint8Array.fromBase64` / `.toBase64` / `.toHex` | present | present | 18.0 / 26 |
| `Float16Array`, `Promise.withResolvers`, `AbortSignal.any`, `Set.prototype.intersection` | present | present | 26 / 17.4 |
| `DecompressionStream` | present | present | — |

iPhone 13 Pro, iOS 18.6.2, Safari 18.6, both realms — every absence above is absent in the
worker too, which is what makes the source-string arrangement load-bearing rather than
tidy. Note what the iOS column settles in the *other* direction: `Float16Array` and
`Uint8Array.fromBase64` were the rows to suspect if the baseline ever moved backwards, and
they are present at 18.6.2. The row that broke was the one already believed settled.

`Iterator.prototype.join` is absent in both measured columns, and that is fine: pdfjs's own
polyfill for it fires and works, now that the global its guard dereferences exists. The guard
was the bug, never the method. Of the rest, `Float16Array` is feature-detected by pdfjs
(`FeatureTest.isFloat16ArraySupported`, falling back to `Float32Array`), while
`Uint8Array.fromBase64` is **not** guarded — it is used for XFA images and signature
decompression, a narrow path, and the one to watch if the baseline's floor ever drops below
Safari 18.

Four things generalise beyond the specific patches:

1. **A patch has to reach both realms, and may need to land before pdfjs's module body rather
   than merely before its first call.** pdfjs runs a worker, which is its own realm and
   inherits nothing from the main thread's prototypes — and both surviving gaps are used on
   both sides (the worker iterates a `DecompressionStream`'s readable side the same way, and
   was measured missing the `Map` upsert methods too). There is
   no hook to run code before the vendor worker's own top-level body, so `ensurePdfWorker`
   builds the worker script as a Blob, which is why the polyfill is exported as a *source
   string* and not merely executed. **The obvious spelling of that Blob is wrong.**
   `<polyfill source>` followed by `import "<vendor>"` puts the patches in the module's *own
   body*, and static imports are hoisted, so the vendor worker script runs before them. The
   surviving patches tolerate that (each is needed before pdfjs's first call, and lands in
   the gap); the deleted `Iterator` one did not, because it was dereferenced during evaluation.
   The polyfill is therefore its own Blob module imported ahead of the vendor's — kept that
   way after `Iterator` left, because the inlined form was right by luck rather than design.
2. **The failure never names the missing built-in.** WebKit reports the async-iterator gap as
   `undefined is not a function (near '...value of readableStream...')` — it names the loop
   variable. It reads as a pdfjs bug, and every stack frame in it belongs to pdfjs.
3. **A chromium-only test suite is structurally blind to this class.** Chromium has all of it;
   the bug can only exist where the tests do not run. `e2e/pdf-webkit-gaps.spec.ts` closes that
   by *deleting* the built-in in chromium and asserting the viewer still works — which also
   sidesteps the fact that Playwright's WebKit will not launch on every developer machine
   (`playwright.config.ts` records the macOS 14 pin that stops it). Its reach stops at the
   page: `addInitScript` does not touch workers, so the worker half of the patch is asserted
   by nothing, and `scripts/probe-engine.ts` is what covers that realm instead.
4. **A polyfill is a claim about an engine, and claims expire.** Nothing in this repo notices
   when one goes stale, and that is structural rather than an oversight:
   `pdf-webkit-gaps.spec.ts` verifies by *deleting* the built-in, so it keeps passing whether
   or not any real engine still lacks it — the right design for a regression guard, and
   useless as an expiry check. `scripts/probe-engine.ts` is the counterpart, asking what the
   engine actually has. So **add a patch on a failure and remove one on a measurement**, never
   on an assumption about who has updated.

**So: when bumping `pdfjs-dist`, re-run `scripts/probe-engine.ts` and open a PDF in a real
Safari** — not only the smoke test in §10 above. The smoke test asserts pdfjs's API surface,
which is the coupling that pinning already protects; this is the one it doesn't. The probe
answers "what does the engine have", the real Safari answers "does the viewer work", and
neither substitutes for the other: a bump can start using a built-in the probe has never
heard of.

**And after the bump, run `scripts/upgrade-pdf-text-version.ts`, then
`scripts/integrity/check-pdf-fragment-links.ts`.** A fragment link finds its passage in freshly
extracted text on every open (§4), so a change in what pdfjs extracts shows up there first, as
a passage no longer on its page.

The same asymmetry applies to input. Anything reading `window.getSelection()` must settle on
`selectionchange` (debounced) as well as `pointerup`, and the reason is **shift+arrow
selection, which emits no pointer event on any platform.**

Touch does *not* need that fallback, which is worth stating plainly because the opposite is
widely believed and was written here once. Measured 2026-08-25 with
`scripts/remote-console.ts`, instrumenting 18 event types in the page:

| gesture | iPhone 13 Pro, iOS 18.6.2 | iPad, iPadOS 18.6 |
| --- | --- | --- |
| long-press to select | `pointerdown` → `selectionchange` (+660ms) → **`pointerup`** (+1375ms) | `pointerdown` → `selectionchange` (+741ms) → **`pointerup`** (+1155ms) |
| dragging a selection handle | 74 `pointermove` over 113px, 36 `selectionchange`, **`pointerup`** | 76 `pointermove` over 290px, 36 `selectionchange`, **`pointerup`** |
| `pointercancel` in either | **0** | **0** |

The selection handles are not opaque to the page: every `pointermove` carries live coordinates
and targets the text-layer element under the touch.

`pointercancel` belongs to **scrolling**, not selection — 5 of 5 scroll gestures produce one,
pointer events stopping at the cancel while `touchmove` keeps flowing. That is ordinary
behaviour on every touch platform, and it is the thing to expect when a gesture turns out to
be a scroll rather than a drag.

So both triggers are live on touch, and both earn their place. **`pointerup` fires on every
touch selection** — do not remove that branch as desktop-only; it is what settles a selection
promptly instead of after the debounce. **`selectionchange` fires long before it** (~660-740ms
into a long-press, against ~1.2-1.4s to `pointerup`) and is the only signal that reports a
selection *growing* mid-drag, which is what the keyboard case needs and what makes overlapping
async runs reachable — see the note just below on the generation counter.

Having two triggers instead of one has a consequence worth stating before you write the
handler: **overlapping async runs become reachable**, which a lone `pointerup` never made
them. Dragging an iOS selection handle emits a `selectionchange` per pixel while a capture
is still in flight, so the handler needs a generation counter to drop superseded results,
and must `cloneRange()` — `getRangeAt` returns the *live* range, which otherwise mutates
under the await. Anything awaited in there also needs its own `catch`: behind the capture
is a worker round trip and a parse of an untrusted PDF, and an unhandled rejection presents
as a selection captured and silently dropped, indistinguishable from the trigger never
firing. See `PdfAnnotationSurface`'s trigger comment for the implemented form.

---

## 10a. The outline (table of contents)

What `pdf.getOutline()` gives back, and what it takes to turn it into a position. Written
down because three of the four steps have a silent failure mode.

**The shape.** An array of `{ title, dest, url, count, items[] }`, nested. Two things about
the shipped types matter: `items` is typed `Array<any>`, so the generated `.d.ts` cannot
describe a tree at all (we declare `PdfOutlineItem` in `src/lib/pdf-outline.ts` instead — a
real pdfjs node satisfies it structurally), and `count` is present only for a parent, where
**its sign is the author's open/closed choice** (PDF 32000-1 §12.3.3) rather than a
count of anything we display — we carry it and do not obey it, opening two levels by depth
instead (PLAN.md §19b).

**`dest` is one of three things**, and conflating any two of them costs every entry its
position without throwing:

1. **A string** — a *named* destination, looked up in the catalog. Fetch the whole
   dictionary once with `pdf.getDestinations()`, not `getDestination(name)` per entry.
   Verified against 6.2.108 it comes back as a **`Map`** (`Catalog.destinations` builds one,
   and it survives the structured clone out of the worker); older pdfjs returned a plain
   object, so check the shape rather than assuming it.
2. **An array leading with an integer** — a page index outright.
3. **An array leading with a `{num, gen}` ref** — a page *object*, which only the worker can
   turn into an index (`pdf.getPageIndex(ref)`, one round trip each; dedupe by `num/gen`,
   since sibling entries on one page are the norm). A named destination's array almost always
   takes this form, so a resolver that only handles case 2 quietly sends everything to page 1.

**The y is in a different slot per destination type**, and there isn't always one: `XYZ` →
`dest[3]` (which may be `null`, meaning "keep the current position"), `FitH`/`FitBH` →
`dest[2]`, `FitR` → `dest[5]` (the rectangle's *top*), and `Fit`/`FitB`/`FitV`/`FitBV` carry
no vertical position at all. Missing or unusable means the page's top — which is where pdfjs
scrolls to as well, so the highlight and the jump agree rather than differing by a screenful.
It is then PDF user space (y up from the page's bottom) and has to be flipped against the
page height like every other §5 conversion.

**Don't re-implement the jump.** `PDFLinkService.goToDestination(dest)` takes any of the
three forms above and every `Fit` variant, and keeps the reader's zoom where the destination
doesn't set one. It is on `PdfViewerHandle` for this. The anchoring machinery
(`jumpDestinationY`) stays for annotations, whose quads are ours rather than the document's.

**Most PDFs have no outline**, and `getOutline()` resolves to `null` for them — an ordinary
answer, not an error. The pane says so. `scripts/make-test-pdf.ts` can write one (an inline
array, a named destination, and a closed-by-default subtree) because nothing else in the repo
has one to test against.

**A title can hold NULs**, as a page label can, in a literal string or a UTF-16 one alike.
The stored copy drops them, for §10b's reason.

---

## 10b. Page labels

`pdf.getPageLabels()` returns what the document prints on its pages — `["i","ii","iii","1",…]`
— or `null`. Five things about it are worth knowing before touching it:

- **The array is always full length or absent.** pdfjs builds an entry per page (a page
  outside any labelling range gets `""`), so there are no holes to iterate around — but there
  *are* empty strings, and a blank page box is worse than a number.
- **Labels are not unique.** Front matter numbered 1–12 followed by a body restarting at 1
  gives two pages called "1". Resolving a label back to a page takes the first match
  (`PDFViewer.pageLabelToPageNumber`, and our page box through it).
- **Many files carry labels that are just `1…N`.** Using them changes nothing on screen, so
  `usablePageLabels` (`src/lib/pdf-page-labels.ts`) treats that set, and an all-empty set, as
  absent.
- **`setPageLabels` has to be called after `pagesinit`.** It walks `PDFViewer._pages` to put
  `data-page-label` on each page div, and that list doesn't exist until the pages are laid out
  — call it earlier and it stores the labels while labelling nothing, with no error. Same
  ordering trap as `currentScaleValue`; both are done in `completeReady`.
- **A label can hold NULs.** pdfjs passes them through from the PDF's strings, and a prefix
  padded with them puts one *mid*-label: `/P (A-\0)` gives `"A-\u00001"`. The copy stored on
  `file` (docs/MCP.md §8) can't keep them, because `jsonb` refuses U+0000 and one NUL fails
  the whole upload, so `extractPdfMetadata` drops every NUL rather than trimming a trailing
  run. The viewer uses its own copy as pdfjs returns it.

Anchoring, presence and geometry all keep counting **sheets** (1-based indices). A label
never enters a computation — only a rendering, and the lookup that finds the sheets a printed
page names, for a `p=` link or a citation's page ([PDF_FRAGMENT_LINKS.md](PDF_FRAGMENT_LINKS.md)
§2, "Which sheet"). PLAN.md §19c.

---

## 10c. Zoom gestures, and who gets to handle them

Pinch and ctrl-wheel resize the **document**, not the page (PLAN.md §19d). Capturing them is
per-engine, and the parts that are settled are worth separating from the part that is not.

**A trackpad pinch is not a touch event anywhere.** Chrome and Firefox report it as a `wheel`
with `ctrlKey` set — the same shape as a held ctrl — so one handler serves both, and a handler
that looks for touches will never see a MacBook or a Windows precision trackpad at all (Safari
sends its `gesture*` events instead, and no wheel at all; both measured below). Treat
`metaKey` the same way: Cmd-scroll is macOS's own page zoom, and the document takes it for the
same reason it takes the pinch.

**A wheel notch has no cross-browser size, so don't measure it — count it.** Chrome and Safari
report pixels (`deltaMode` 0): a notch is **100 on Windows at the default three-lines setting**
— measured below, at two display scalings, and *not* the 100-times-the-setting this file claimed
before anyone had measured Windows — moving with the *page* zoom and with that setting (about
33.3 px per line) but not with the display scaling, about 53 on Linux, and a few accelerated
pixels for a macOS mouse. Set to scroll by screens, Windows sends `deltaMode` **2** carrying a
*fraction* of a page rather than a pixel count at all — 1/`devicePixelRatio`, measured below. Firefox reports lines (`1`): a notch is 3 on Linux and
Windows whatever the OS setting, and **1 on macOS** (measured, below) — so even the line count
is not a constant, only the *unit* is. Any pixels-per-tick divisor therefore makes one notch worth one, three or thirty steps
depending on the machine — the shape of mozilla/pdf.js#16325, which pdf.js has left open for
Chrome since 2023 (its own viewer counts one tick per event in line mode and divides by 30 in
pixel mode). `readWheel` (`src/lib/pdf-zoom.ts`) instead treats any pixel delta of 40 or more,
any page event whatever its magnitude, and any line event of a whole line or more, as **one
notch = one tick = ×1.1**, pdfjs's own step. Below about 5
pixels with no `deltaX` is a trackpad pinch and takes the exponential; the band between is
fractional ticks, carried forward by `createTickAccumulator`. That band holds for a *slow*
pinch; a quick one sends frames of 12–72 px (measured below), so the band is only how a pinch
*opens*: `createWheelReader` keeps every pixel-mode, `deltaX`-free frame within
`PINCH_FOLLOW_MS` of a pinch frame on the exponential, whatever its size.

**Read `deltaMode` before `deltaX`/`deltaY`, always.** Since Firefox 88, a wheel event whose
deltas are read first silently switches itself to pixel mode with the lines converted — a
compatibility shim for pages that assume pixels (Bugzilla 1392460). Reading the deltas inside a
single call's argument list (`f(event.deltaY, event.deltaMode)`) is enough to trigger it, which is
why `readWheel` takes the event and reads the mode first, and why a unit test asserts the order
with getters. pdf.js hit this exact regression in Firefox 96 (mozilla/pdf.js#14476). **Measured
real on Firefox 155.0.1** (2026-09-14, macOS): a capture listener on `window` that read `deltaY`
first turned a 1-line notch into mode 0, `deltaY` −17 for every listener after it, ours
included — and 17 px is inside the fractional band, so the notch banked 0.57 of a tick and
**zoomed nothing**. On Linux or Windows the same shim yields about −51 px, which still clears
`NOTCH_MIN_PIXELS`; a Mac is where a delta-first reader anywhere on the page costs a whole
notch. Any wheel listener registered earlier in the capture chain than ours is a suspect.

**What Playwright actually delivers, measured** (2026-09-14, Playwright 1.62 on Fedora 44:
chromium 1234, firefox 1538, webkit 2336; one `mouse.wheel` per row, read on
`[data-pdf-container]` with `deltaMode` first). All three engines agreed on every row:

| sent | arrives as | document scale | page zoom |
|---|---|---|---|
| `mouse.wheel(0, -240)`, Control held | mode 0, `deltaY` −240, `ctrlKey` | ×1.10 | unchanged |
| `mouse.wheel(0, -100)` / `(0, -53)`, Control held | mode 0, −100 / −53 | ×1.10 | unchanged |
| `mouse.wheel(0, -3)`, Control held | mode 0, −3 | ×1.016 (pinch curve, at the then `WHEEL_SOFTNESS` of 200; today exp(3 × `TRACKPAD_PINCH_GAIN` / 100)) | unchanged |
| `mouse.wheel(0, -240)`, Meta held | mode 0, −240, `metaKey` | ×1.10 | unchanged |
| dispatched `WheelEvent` 3 lines / 1 page / 53 px, `ctrlKey` | as sent | ×1.10 per event | n/a (untrusted) |
| dispatched −15 px twice, `ctrlKey` | mode 0 | ×1, then ×1.10 | n/a |

The finding in that table is the first column: **Playwright's Firefox sends pixels too**, so no
run of the suite exercises Gecko's line-mode notch or the read-order shim — the line branch is
covered by dispatched events in `e2e/pdf-zoom.spec.ts` and the read order by the getter unit test.
The ratios read ×1.096–1.102 rather than 1.1 exactly because pdfjs rounds the scale to a
hundredth.

**What a real Gecko mouse delivers, measured** (2026-09-14, Firefox 155.0.1 on macOS 14.8.9,
Retina; native events posted with `scripts/macos/native-wheel.c`, read on the app's own page through
`scripts/remote-console.ts` — recipe in e2e/MACOS.md). Every row is `isTrusted`, and Firefox's
own zoom never fired: `devicePixelRatio` stayed 2, `innerWidth` stayed 966, `visualViewport.scale`
stayed 1.

| posted | arrives as | `defaultPrevented` | document scale |
|---|---|---|---|
| 1 line up, ctrl | mode 1, `deltaY` −1, `ctrlKey` | yes | ×1.10 |
| 1 line down, ctrl | mode 1, +1 | yes | ×0.91 |
| 1 line up, ⌘ | mode 1, −1, `metaKey` | yes | ×1.10 |
| 3 lines up, ctrl (the Linux/Windows shape) | mode 1, −3 | yes | ×1.10 |
| 2 px up, ctrl | mode 0, −2 | yes | ×1.013 (pinch curve, at the then `WHEEL_SOFTNESS` of 200; today exp(2 × `TRACKPAD_PINCH_GAIN` / 100)) |
| 60 px up, ctrl | mode 0, −60 | yes | ×1.10 |
| 1 line up, no modifier | mode 1, −1 | no | ×1, container scrolled |
| 1 line up, ctrl, after a delta-first listener | mode **0**, −17 | yes | ×1 (0.57 tick carried) |

So a macOS Firefox notch is **one line, not three**, and the read-order trap is not
theoretical there. Still unmeasured: a Chrome or Safari *mouse* on real Mac hardware, and
Windows with lines-per-notch changed. (The trackpad pinch in Firefox and Chromium is measured
two tables down; a magnify gesture is something no public CGEvent creates, so it took a hand on
the trackpad.)

**What a real trackpad pinch delivers in Safari, measured** (2026-09-14, Safari 26.6.1 on
macOS 14.8.9, MacBook trackpad; a capture-phase listener on `window` installed through
`scripts/remote-console.ts`, recording every `wheel` with ctrl or ⌘ and every `gesture*` event
with the viewer's `--scale-factor` beside it). A slow spread and a quick pinch, by hand:

| gesture | events | ctrl-wheel events | document scale |
|---|---|---|---|
| slow spread, ~2.4 s | `gesturestart` (scale 1.001), 60 × `gesturechange` at 27–50 ms, `gestureend` (2.058) | **0** | 1.72 → 3.52, ratio 2.04 |
| quick pinch, ~0.5 s | `gesturestart` (0.999), 3 × `gesturechange`, `gestureend` (0.836) | **0** | 3.52 → 2.95, ratio 0.84 |
| tail of the quick pinch | a **second `gesturestart`** carrying 0.836, then `gestureend` **twice**, all within 2 ms | — | unchanged |

Three findings. **Safari's trackpad pinch is `gesture*` only** — not one ctrl-wheel in 75
events — so on Safari the whole of `readWheel`, `WHEEL_SOFTNESS` included, is never on the
path; the user had set the constant to 30 and felt nothing, which is how this was found. The
scale tracks the cumulative `scale` to within pdfjs's hundredth-rounding, so before the gain
the gesture path was an exact finger-follow. And the doubled `gesturestart` in the tail is
why `onGestureStart` now takes its baseline from the event's own `scale` rather than 1:
with a baseline of 1 and a `gesturechange` after it, the 0.836 would have replayed as one more
full step out. `navigator.maxTouchPoints` is 0 on this Mac and `(pointer: coarse)` is false,
which is the discriminator `TRACKPAD_PINCH_GAIN` is gated on.

**What a real trackpad pinch delivers in Firefox and Chromium, measured** (2026-09-14, evening;
Firefox 155.0.1 and Playwright's Chromium 151 bundle — Chrome itself is not installed on this
Mac, and the bundle is the same headed Blink with the same macOS input path — on macOS 14.8.9,
MacBook trackpad, Retina; the Safari run's window-level capture recorder, `deltaMode` read first,
routed to each tab by user agent — e2e/MACOS.md). One slow spread and one quick pinch by hand in
each, pointer over the document. The browser's own zoom never fired: `devicePixelRatio` stayed 2,
`innerWidth` 966 (Firefox) and 1200 (Chromium), `visualViewport.scale` 1.

| browser | gesture | events | per-frame `deltaY` | Σ `deltaY` | fingers, exp(−Σ/100) | document scale |
|---|---|---|---|---|---|---|
| Firefox | slow spread, 1.37 s | 78 × `wheel`, mode 0, `ctrlKey`, `deltaX` 0, 5–36 ms apart | −0.10 … −2.96, every one under 5 | −71.3 | 2.04 | 0.87 → 7.43, **×8.58** (2.04³ = 8.48) |
| Firefox | quick pinch, 0.18 s | 10 × the same | +0.1, +3.4, then **+12 … +38** | +143 | 0.24 | 7.43 → 4.57, **×0.62** |
| Chromium | slow spread, 1.38 s | 73 × `wheel`, mode 0, `ctrlKey`, `deltaX` 0, 5–43 ms apart | −0.20 … −2.51, every one under 5 | −64.8 | 1.91 | 1.23 → 8.60, **×6.98** (1.91³ = 6.99) |
| Chromium | quick pinch, 0.11 s | 4 × the same | +2.1, +15, **+72**, +12 | +101 | 0.36 | 8.60 → 7.33, **×0.85** |

Not one `gesture*`, touch or non-mouse pointer event in either browser, never a non-zero
`deltaX`, and every event `isTrusted` and `defaultPrevented`. Replaying each log through
`readWheel` and `createTickAccumulator` reproduces all four ratios to three decimals
(8.48, 0.615, 6.99, 0.853), so what follows is the code's arithmetic, not a model of it.

Two findings. **For a slow pinch the wheel branch is at parity with Safari's gesture path.**
Both browsers encode the pinch as ctrl-wheel pixels whose exponential is the finger
magnification — Gecko's `−100·M` and Blink's `−100·ln(1 + M)` for Apple's per-event
magnification `M`, the same to first order (sources and the measurement against the OS's own
stream, next section) — every frame fell inside the pinch band, and the document moved by
fingers^`TRACKPAD_PINCH_GAIN`. So the gain is real on this path, not only on Safari's.
**A quick pinch overshoots the pinch band.** Frames still arrive at about 60 Hz, so a fast
gesture packs its magnification into a few large frames — 12–38 px in Firefox, one of 72 px in
Chromium — and `readWheel` reads those as fractional or whole *mouse notches*: Chromium's 72 px
frame became one ×0.91 tick, and the 12–17 px frames half a tick each, paid out on alternate
frames by the accumulator's carry. The fingers said ×0.24 and ×0.36; the document did ×0.62 and
×0.85. A quick pinch therefore zooms **less** than a slow one, and the gain never touches it.
Nothing in a large frame's shape separates it from a mouse notch except its timing — a notch
does not arrive 17 ms after a sub-pixel frame — so the fix is temporal rather than a wider band,
which would hand every accelerated mouse to the exponential: `createWheelReader` remembers when
the last pinch frame was, and a pixel-mode frame with no `deltaX` inside `PINCH_FOLLOW_MS` of
it is a pinch frame at any size, clamped per frame like every other. Every measured pinch opened
with a sub-5 px frame, and within a gesture frames were 5–79 ms apart against 1.9 s between
gestures, which is where the window's value comes from. Replayed through the fixed reader, the
two quick pinches become ×0.15 (Firefox) and ×0.48 (Chromium) against the fingers' ×0.24 and
×0.36 — the per-frame clamp now the only thing between the fingers and the document.

**What each engine makes of the OS's magnification, measured against the OS itself**
(2026-09-15, macOS 14.8.9). The fix above made Firefox "zoom a lot more than Safari", which
could have been an encoding difference or a frame-rate one. It was neither. The measurement
put the OS's own event stream beside each browser's: `scripts/macos/magnify-tap.m` logs every
magnify event's `magnification` `M` as AppKit reads it, the app's recorder logged what the
page saw, and once the two clocks were lined up every browser gesture could be checked
against the exact frames the OS delivered. Then `scripts/macos/native-magnify.c` — private CGEvent
fields found by probing, e2e/MACOS.md — posted one *identical* 20-frame pinch of `M` 0.02
(fingers ×1.486, so fingers³ = ×3.28) into all three browsers, at 16 ms and at 100 ms per
frame.

The encodings, from source. **Gecko**: `PinchGestureInput::ComputeDeltaY` (widget/InputData.cpp)
sends `deltaY = −100·M` — multiplied by the backing scale in the widget event and divided back
in `WheelEvent::DeltaY`, so the DOM value is `−100·M` on Retina too; the code comment calls
Chrome's log formula "unfortunately incorrect" because Apple's `M` is already a relative
change. **Blink**: `components/input/touchpad_pinch_event_queue.cc` sends
`deltaY = −100·ln(scale)` with `scale = M + 1` from `web_input_event_builders_mac.mm`; the
comment gives the design goal, deltas that add across frames (`f(s1·s2) = f(s1) + f(s2)`).
**WebKit**: `NativeWebGestureEventMac.mm` puts the per-event `M` on the gesture event, and the
accumulation into the DOM `scale` is in `<WebKitAdditions/EventHandlerMacGesture.cpp>`, which is
closed — so Safari's rule had to be measured.

| | sent by the OS | arrives as | measured against `M` |
|---|---|---|---|
| Firefox 155.0.1 | 129, 129, 14, 9 frames (four hand gestures) | 112, 121, 13, 8 ctrl-wheels | Σ`deltaY` = −100·Σ`M` to **four decimals**, every gesture — frames coalesced by *summing* |
| Chromium 151 | 116 frames (the one gesture not muddled by a focus fumble) | 91 ctrl-wheels | Σ`deltaY` = −100·Σln(1+`M`) within 0.7% |
| Safari 26.6.1 | 169, 60, 174, 19 frames | **28, 4, 10, 6** `gesturechange`s | `scale` = Π(1+`M`) over the *delivered* frames only: 21%, 9%, ~0%, 22% of Σ`M` kept |

The synthetic pinch, same 20 frames everywhere, on the real `/pdf/[slug]` page:

| cadence | Safari | Firefox | Chromium |
|---|---|---|---|
| 16 ms/frame | 5 frames delivered, document **×1.35** | 20, ×3.28 | 20, ×3.31 |
| 100 ms/frame | 9 frames delivered, document **×1.70** | 20, ×3.34 | 20, ×3.28 |

And on `scripts/macos/pinch-test.html`, a page with nothing on it but the recorder, to separate a
delivery policy from page load:

| handler | Safari, 16 ms | Safari, 100 ms | Firefox, 16 ms | Chromium, 16 ms |
|---|---|---|---|---|
| cheap, preventDefault | **20 of 20**, scale 1.4859 (= 1.02²⁰) | 20 of 20 | — | — |
| 60 ms of synchronous work per event | **6 of 20**, scale 1.126 | 20 of 20 | 17 wheels, Σ exact (exp(0.4) = 1.4918) | 7 wheels, Σ exact (1.4859) |
| passive, no preventDefault | 1 frame, then Safari's page zoom took it (×1.486) | | | |

Three findings. **Safari drops gesture frames a busy page can't take, and the dropped
magnification is gone.** Each delivered `gesturechange` multiplies `scale` by its own frame's
1+`M` (1.02 per delivered frame in the synthetic run, 1.02⁵ for five delivered) — nothing is
carried over from the frames WebKit discarded while the main thread was busy. An idle page gets
every frame; a page doing 60 ms of work per event gets a third of them at trackpad cadence and
all of them at 100 ms. pdfjs's `updateScale`, even with `drawingDelay`, is that busy page on a
2-core Mac at any real zoom. **Gecko and Blink coalesce by summing**, so the same load costs
them nothing: 20 frames arrived as 17 and 7 wheels whose deltas summed to the finger ratio
exactly. **So the gain was tuned on a lossy path.** `TRACKPAD_PINCH_GAIN` was set by feel in
Safari, where a busy pdfjs was delivering a fraction of each pinch; the fix above then gave
Firefox and Chromium the same gain on a path that loses nothing, and one identical gesture
moved the document ×3.3 there against ×1.35–1.7 in Safari. Nothing in the wheel branch is
wrong; Safari's gesture branch under-delivers, by an amount that depends on how busy the page
is. PLAN.md §19d records the decision to leave it. Two side findings: Firefox's own page
zoom crept to 1.084 under the 60 ms handler — Gecko stops waiting for a slow `preventDefault`
— which the app's fast handler never triggers; and Safari stops sending `gesture*` events
after the first one a page fails to prevent.

**What Windows delivers, measured** (2026-09-15, Windows 11 26200 on a Dell XPS 15 9510 with
both a precision touchpad and a touchscreen; recorded on the app's own `/pdf/[slug]` through
`scripts/remote-console.ts`, `deltaMode` read first, every listener passive so the app's own
handler saw an unaltered event). Two browsers and three `devicePixelRatio`s, which is what let
the notch rule be separated from the machine: **Vivaldi** on Chromium 152 — see the warning at
the end — on the laptop's 250%-scaled panel at **110% page zoom** (dpr 2.75), and **Chrome
152.0.7977.84** at 100% zoom on that panel (dpr 2.5) and on a 150%-scaled external monitor
(dpr 1.5). The browser's own zoom never fired in any row: `visualViewport.scale` stayed 1 and
`innerWidth` never moved.

| gesture | browser | events | per-frame `deltaY` | Σ `deltaY` | fingers, exp(−Σ/100) | document |
|---|---|---|---|---|---|---|
| trackpad, slow spread, 1.93 s | Vivaldi | 87 × `wheel`, mode 0, `ctrlKey`, `deltaX` 0, 7–38 ms apart | −0.16 … −3.61, every one under 5 | −94.26 | 2.5666 | 1.502 → 3.813, **×2.5395** |
| trackpad, slow spread, 2.88 s | Chrome | 137 × the same, 4–35 ms apart | −0.02 … −2.54 | −128.99 | 3.6326 | 1.800 → 6.547, **×3.6370** |
| trackpad, quick pinch, 0.375 s | Vivaldi | 17 × the same | +0.14 … **+24.21** | +117.54 | 0.3087 | 3.813 → 1.187, **×0.3112** |
| touchscreen, slow spread, 1.80 s | Vivaldi | 84 × `touchmove` (2 touches), **0 `wheel`, 0 `gesture*`** | — | — | — | 1.187 → 5.00 |
| touchscreen, quick pinch, 0.56 s | Vivaldi | 24 × the same | — | — | — | 5.00 → 0.893 |

One ctrl + wheel notch, up and down, at each of the three settings Windows offers:

| OS setting | browser, dpr | arrives as | × dpr | read as | document |
|---|---|---|---|---|---|
| 3 lines (the default) | Chrome, 2.5 | mode 0, ∓**100.000** | 250 | notch (≥ `NOTCH_MIN_PIXELS`) | ×1.1013 / ×0.9060 |
| 3 lines | Chrome, 1.5 | mode 0, ∓**100.000** | 150 | notch | ×1.1000 / ×0.9091 |
| 3 lines | Vivaldi, 2.75 (110% zoom) | mode 0, ∓**90.909** | 250 | notch | ×1.1045 / ×0.9054 |
| 1 line | Vivaldi, 2.75 (110% zoom) | mode 0, ∓**30.303** | 83.33 | **1.0101 fractional ticks** | ×1.1045 / ×0.9054 |
| one screen at a time | Vivaldi, 2.75 | mode **2**, ∓**0.364** = 1/2.75 | — | **0.364 ticks — nothing** | **×1, ×1, ×1, ×1, ×1** |
| one screen at a time | Vivaldi, 2.625 (105% zoom) | mode 2, ∓**0.381** = 1/2.625 | — | — | — |
| one screen at a time | Chrome, 1.5 | mode 2, ∓**0.667** = 1/1.5 | — | one notch, *after the fix* | ×1.1000 / ×0.9091 |

Four findings, and the third was a live bug.

**The trackpad gain is off on Windows, because the discriminator means something else here.**
`TRACKPAD_PINCH_GAIN` is gated on `navigator.maxTouchPoints === 0` — true on a Mac, where it
reads as "no touchscreen, so these frames are a trackpad". This machine reports `maxTouchPoints`
**10** and `(pointer: coarse)` **false**, so the two discriminators disagree and the trackpad
took the touch branch: **fingers¹, not fingers³**, in both browsers (×2.5395 against fingers of
×2.5666, and ×3.6370 against ×3.6326). Blink encodes the pinch exactly as it does on the Mac —
sub-5 px ctrl-wheel frames at ~60 Hz, no `deltaX`, no `gesture*` — so the encoding is not what
differs; only the gate is. `(pointer: coarse)` is the discriminator that would get both
platforms right, and PLAN.md §19d records why the gain was nonetheless left alone.

**The quick-pinch follow window holds on a third platform.** Frames of up to 24.21 px sit above
`PINCH_MAX_PIXELS` and below `NOTCH_MIN_PIXELS`; without `PINCH_FOLLOW_MS` they would have gone
through the `PIXELS_PER_TICK` band as 117.54/30 ≈ 3.9 ticks and zoomed ×0.69 against fingers of
×0.3087. Measured ×0.3112 — 0.8% off the fingers, inside pdfjs's hundredth-rounding.

**"One screen at a time" sends a *fractional page*, and the document did not move at all.**
Windows' third wheel setting switches Blink to `deltaMode` 2, and the delta is not 1 page but
**1/`devicePixelRatio`** — measured at three of them, 0.364, 0.381 and 0.667, each exactly the
reciprocal. `readWheel` treated a sub-1 line-or-page delta as a fraction to accumulate, on the
reasoning that "a fractional line is nothing any device is known to send", so one 10% step cost
three notches; and since `createTickAccumulator` drops its carry on a reversal, a reader
alternating in and out never reached 1.0 and the scale did not change once in five notches.
Fixed by reading a page-mode event as one notch at any magnitude — a fraction of a screenful is
still one wheel click — while a fractional *line* keeps accumulating, since Gecko is the only
engine that reports lines and does not divide by the backing scale (the Retina table above).
Verified after the fix in both browsers and at two DPRs: one notch, one 10% step, both
directions. The zoomed rows are why the fix cannot be "round 0.364 up": the magnitude is the
reciprocal of a number that moves with the monitor and the page zoom, not a constant to
special-case.

**A notch is ~100 CSS px at the default setting, and display scaling has nothing to do with it.**
100.000 at dpr 2.5 and 100.000 at dpr 1.5: the *device*-pixel count tracks the display scale
(250 and 150) and the CSS value that reaches the page does not. What does move it is **page
zoom** — 90.909 at Vivaldi's 110%, which is 100/1.1 — and the lines-per-notch setting, which is
a plain multiplier of about 33.3 CSS px per line (30.303 measured at 1 line and 110% zoom, ×1.1
= 33.33). So this file's original "100 px on Windows" was right and its "*multiplied by* the
lines setting" was not: the default *is* the multiplied value. Only that default clears
`NOTCH_MIN_PIXELS`. At 1 line a notch is 33.3 px and reaches one whole step through the
`PIXELS_PER_TICK` band instead (1.11 ticks at 100% zoom), which is the same outcome by a
different rule — and it survives only while the number stays above 30. **At 1 line and 125% page
zoom a notch is 26.7 px, 0.89 of a tick: the first notch would bank a fraction and zoom
nothing**, and the second would spend it. Unmeasured, two keystrokes away, and the reason
`PIXELS_PER_TICK` must not be raised.

> **The browser cannot be identified from inside the page.** The first pass of all of the above
> was recorded believing it was Chrome: `navigator.userAgent` says `Chrome/152.0.0.0` and
> `navigator.userAgentData.brands` lists `Google Chrome 152` and `Chromium 152`, with nothing
> naming Vivaldi. Only the user's own remark — that ctrl-minus steps by 5%, which Chrome does
> not do — revealed it, and a second pass in real Chrome then showed that Vivaldi had also been
> sitting at 110% page zoom, which had made a notch look like 90.909 px rather than 100. Every
> row above is labelled with the browser it came from, and **a browser name taken from a UA
> string is a guess wherever this file states one**.

**`preventDefault` needs a non-passive listener.** `{ passive: true }` (or the default, for
`wheel`/`touchmove`, in every current engine) silently ignores the call, so the document zooms
*and* the page does. Nothing throws; it just looks broken on a machine that isn't yours.

**`touch-action` is how the engine is told, and `none` is the wrong value here.** The container
takes `pan-x pan-y`: one-finger scrolling, momentum and the scrollbars stay native while pinch
and double-tap zoom come to us. `none` would take the scrolling with it and freeze the document
on a phone — a far worse bug than the one being fixed.

**A named scale is computed once, not maintained.** `currentScaleValue = "page-width"` resolves
to a number there and then; `PDFViewer` has no resize handling of its own (that lives in
Mozilla's viewer application, which is not what we build on — §10). Assigning the same string
back is what recomputes it, which reads as a no-op and is not. PLAN.md §19e.

**Zoom around a point, not around the scale.** `PDFViewer.updateScale({ scaleFactor, origin })`
takes `origin` as a client-space `[x, y]` and adjusts `scrollLeft`/`scrollTop` around it, which
is the whole difference between a gesture and a lurch. Pass `drawingDelay` (< 1000) during a
gesture so it restyles now and re-renders once the fingers stop.

### The part that is not settled: iOS

Safari fires its own non-standard `gesturestart` / `gesturechange` / `gestureend` alongside (or
instead of) two-finger `touchmove`, carrying a cumulative `scale`. The implementation prefers
them and stands the touch path down as soon as one arrives, or the two would compose and square
the zoom.

**Whether `touch-action: pan-x pan-y` alone stops iOS's own pinch zoom is a measurement, not a
fact to be looked up** — CLAUDE.md's standing rule, and this file already records two claims
about iOS touch behaviour that were measured false. To take it, with the phone on the LAN:

```
npx tsx scripts/remote-console.ts          # terminal A; open the printed URL on the phone,
                                           # then navigate it to a /pdf/[slug]
curl -s --data-binary '
  window.__pinch = { gesture: 0, touchmove: 0, scaleAtStart: visualViewport.scale };
  const c = document.querySelector("[data-pdf-container]");
  c.addEventListener("gesturechange", () => window.__pinch.gesture++, true);
  c.addEventListener("touchmove", (e) => { if (e.touches.length === 2) window.__pinch.touchmove++; }, true);
  "armed"' localhost:4322/eval
# …pinch the document on the phone, then:
curl -s --data-binary '({ ...window.__pinch, pageScaleNow: visualViewport.scale,
  docScale: getComputedStyle(document.querySelector(".pdfViewer")).getPropertyValue("--scale-factor") })' localhost:4322/eval
```

`pageScaleNow` still `1` is the answer that matters: the page did not zoom. A rising
`docScale` says ours did. Which counter moved says which path the engine took.

---

## 11. Prior art worth reading before reimplementing

- `hypothesis/client` — `src/annotator/anchoring/pdf.js` is the reference implementation of
  everything in §3–§4.
- `hypothesis/dom-anchor-text-quote`, `hypothesis/dom-anchor-text-position` — usable directly.
- `hypothesis/anchoring-test-tools` — harness for regression-testing anchoring against real
  annotated PDFs. Worth adopting the pattern even if not the tool.
- W3C Web Annotation Data Model — `TextQuoteSelector` / `TextPositionSelector` are the
  standardised versions of §2's `quote` and `position`. Staying compatible costs nothing and
  buys interoperability.

Known trap from Hypothesis's tracker: they attach highlights to a placeholder element on
un-rendered pages, and quote selectors ended up capturing the placeholder's own text
("Loading annotations…") in prefix/suffix. Never compute selectors from DOM that isn't the
real text layer — compute them from normalised `getTextContent()` output (§3), which is
available without rendering.

---

## 12. Open

- **Behaviour when the same logical document arrives with different bytes** — a new edition,
  a re-export, a copy with its embedded annotations stripped: re-anchor across editions, or
  treat as unrelated. Content-addressed storage makes the two *share* bytes when they are
  identical and stay wholly separate when they are not; nothing bridges editions today, and
  every anchor is keyed on one edition's `sha256` by construction (§4). §13 plans new bytes for
  a file, its anchors reconciled one by one onto pages that may have moved; whether a different
  edition should be such a replacement stays open.
- **The Contents pane's expansion default, and remembering what a reader opened** — TODO.md,
  "The PDF Contents pane forgets its expansion state". An item with enough design in it to
  act on, so it lives there rather than here.

---

## 13. Replacing a file's bytes — plan

**Not built**, and the one exception to this file's "every statement is current". When it
lands, it is rewritten as an account of what exists. §2a, §3, §4 and CLAUDE.md's "A PDF anchor
cannot drift" are then amended where they say the bytes cannot change, and so is
PDF_FRAGMENT_LINKS.md §1. CLAUDE.md's "One anchor row shape" gains the version column,
PDF_FRAGMENT_LINKS.md §2 gains `v=`, and docs/PERMISSIONS.md gains rows for uploading a
version, reviewing, promoting, abandoning and purging. docs/DATABASE.md's data-only load
gains a line: a file's row loaded before its versions gets a search vector without its
filename, which `check-search-index.ts --repair` refills.

Whoever may manage a file (`canUserManageFile`) may give it new bytes: typically a new scan of
the same book, or the same scan with a corrected text layer. The new bytes may have a different
number of pages and put the same words in different places. That is not writing into a PDF,
so §0's invariant 1 holds.

A file has **versions**, numbered from 1. Every version stays readable, at an address of its
own, by whoever may read the file. One of them is the **latest**: the one `/pdf/<slug>` shows,
search ranks and a citation resolves on. A new note goes on whichever version its writer is
reading, the latest or an earlier one. A replacement has three stages:

1. **Upload**: the new bytes become the file's next version, a *candidate*, readable at once
   at its own address.
2. **Reconcile**: every anchor on the latest version is given a place on the candidate's
   pages, mostly automatically, with the rest left to a person.
3. **Promote**: one transaction makes the candidate the latest, and rewrites every anchor
   that was given a place.

Until the promotion `/pdf/<slug>` shows what it always did, and a link to either version
works.

### Two kinds of new version (this overrides what follows)

**This subsection overrides the rest of §13 wherever the two disagree.** The subsections below
were written for one case, a better copy of the same text, where every anchor has a place on the
new pages and a person accounts for each one that doesn't find it. A file's versions are kept
for good, and that serves a second case as well: a revised text, such as the drafts of a paper,
where some notes don't apply to the next version and stay on the one they were made on. The
subsections this one overrides are rewritten to it, and it is folded into them, before step 5 is
built (What is rewritten, below).

**Two kinds of new version, one operation.**

- **A better copy** of the same text: a new scan, or the same scan with a corrected text layer.
  Whether a note carries is a mechanical question. Where its words are found, it applies.
- **A revised text**: a later draft. A sentence that survives doesn't mean a note on it still
  applies, since the author may have answered it elsewhere. Moving the note asserts that it
  does, so nothing moves without a person's judgement.

Both rest on **moving a note forward**: an anchor on an earlier version is given a target on the
latest, found by the placing rules (Placing each anchor), and the latest becomes its version. A
better copy runs that in bulk, for everything that places itself. A revised text runs nothing,
and each note is moved, or not, one at a time and at any later date.

- **The uploader's choice decides only what runs, and nothing stores it as a mode.** No reader
  branches on it. A reader looks at data: which version an anchor is on, and whether a page map
  has a counterpart for a sheet. Otherwise every read path gains a second behaviour that can
  fail with nothing to show it.
- **A selective move is as available after a better copy** as after a revised text, for the
  notes the bulk carry couldn't place.

**Nothing holds up a promotion.** The candidate stage stays, so the uploader can open the new
bytes at their own address and see what would carry. Promotion then makes the candidate the
latest, whatever is undecided. An anchor nobody moved stays on the version it is on. It is drawn
there and listed on the latest's page under that version, as The review says of a note left
behind.

**The bulk carry** moves forward everything that places itself.

- **It is an action.** It is offered at the upload: the candidate's page then shows what would
  carry, and the promotion carries it. It stays available afterwards on the file's page, for
  what is still on an earlier version.
- **Whoever may manage the file runs it**, and it moves everyone's posted notes and the parts of
  everyone's minted links. Otherwise a corrected scan would leave every other author's notes
  behind until each of them acted.
- **It moves nothing else**: no DRAFT, its runner's own included, no soft-deleted note, and no
  part of a link not yet minted. Each stays on its version, and its author moves it as any
  other note.
- **What places itself** is what Placing each anchor calls placed, and also a quote found
  exactly once in the latest version, its `prefix` and `suffix` agreeing, on whatever sheet and
  whether or not that sheet is mapped. That second rule is the bulk carry's alone. Everything
  else stays where it is, for its author's worklist.
- **It builds the page map** between the two versions (Matching the pages), with its unmapped
  sheets and its runs of sheets. Run after the promotion, it builds the map then, and the
  `page=` links written against the earlier version land on the latest from then on.
  - **The question a run of sheets raises stays open.** The carry asks it, of whoever may
    manage the file: whether the map should pair those sheets as the text does, where the
    labels pair them otherwise. It is on the file's page, and any manager may accept or
    decline at any time, the promotion closing nothing. Until one accepts, the sheets are
    unmapped. Accepting writes the text's sheets into the map, and carries the notes on those
    sheets that then place themselves, as a carry would.
  - **A map pairs one sheet with one sheet, or with none.** A revised text that reflows puts
    one page's words on two, and no sheet of it is the counterpart. Such a sheet is left
    unmapped, as any sheet no rule can place. Pairing a sheet with a part of another is under
    Open.
- **Its moves are hidden by default** (The history of moves, below).

**A selective move** is one note, moved by a person who judges that it still applies.

- **Only the note's author moves it**, or, for a note a bot wrote, the person the bot works for
  (`user.works_for_user_id`; a bot works for exactly one person, PERMISSIONS.md "Bots"). A bot
  given to another person takes its notes to them. A manager of the file who is neither moves
  nobody's note this way, and no role curates other people's notes.
- **A part of an anchored link** follows the same rules, with the link's creator as its author.
- **A reply travels with its root.**
- **Forward only, and offered to the latest version only.** Nothing moves a note to an earlier
  version, and a worklist offers no destination but the latest. A decision made against a
  version that a promotion has since replaced is still written (Writing a move, below).
- **Where a note would go is worked out when it is asked for.** The placing rules run for that
  anchor against the latest version when its worklist is opened, starting from where the note is
  now: a note placed by hand on one version is looked for on the next by the quote and the page
  it was given there. Their answer is a suggestion, whether they would call it placed or
  proposed. In a revised text a match of the
  words is never more than that. The author accepts the suggestion, places the note by selecting
  text or drawing a rectangle on the latest, as an annotation is captured, or marks the note as
  staying.
- **"Stays here" is the author's mark on their own note**: it has been looked at, and it belongs
  on its version. Without the mark, a note kept on a first draft on purpose looks the same as
  one nobody has looked at, and no worklist ever empties. The mark holds when a later version
  arrives, so the note is not asked about again.
- **Its move is shown by default.**

**The worklist** is "my notes on earlier versions": the viewer's notes and link parts, and those
of the bots that work for them, on any version but the latest, less the ones marked as staying.
It is on the file's page, and it is a filter in `/annotations`. Nothing is emailed.

**Only decisions are stored**: the moves, and the "stays here" marks. No pass stores a proposal
for every anchor. So there is no item per anchor, nothing to rerun when an anchor or the text
version changes, and nothing for a promotion to check under its lock. A note captured on the
outgoing version while a carry ran stays there, and running the carry again moves it.

**Writing a move** is one transaction with the file row locked, for one note or for a carry's
hundreds. Working out where each note goes comes first and outside it, since that reads a
version's pages and takes seconds: each version's document is opened once and each page read
once.

- **Three checks are the file's, and are made once**: the destination is a promoted version
  later than the one the notes are on; the mover may make the move; and the destination has page
  text at the text version the new targets name.
- **The fourth is each note's, and is the write's own condition.** One `UPDATE` for each anchor
  table takes the whole batch as one parameter. It sets a row's target, quote and version where
  the row is still on the version, and at the target, its placement was worked out from, and it
  returns the rows it changed. A difference in text version alone passes, since the text-version
  script restamps only a page that reads the same. One `INSERT` then writes the history of the
  rows returned. Both are raw SQL: Prisma has no update that sets different values on different
  rows. A carry of any size is about six statements, and one of several thousand notes splits
  its parameter inside the one transaction.
- **A row not returned was skipped**: moved from another tab, or by a carry that got there
  first. A bulk carry counts it, and the next carry takes it. A selective move shows a fresh
  suggestion.
- **The destination need not still be the latest.** A person's decision made against a version
  that was the latest when they made it is written to that version, where a refusal would
  discard their work. The note is then on an earlier version again, and its next suggestion
  starts from where they put it.
- **At a promotion, the switch and the carry's writes are one transaction**, so the latest is
  never shown without its notes.
- **Nothing is staged.** Each decision is written as it is made, and a placement the app worked
  out and couldn't write is worked out again.

**The history of moves.** A note has one location, the newest version it was moved to. Each move
is a row:

- the row moved: one nullable foreign key per kind, with a CHECK that exactly one is set, the
  anchor tables' own pattern (CLAUDE.md, "One anchor row shape");
- the version and the target it left, and the version and the target it reached;
- who moved it, and when;
- whether the move is hidden.

A shown move appears on the note's card, which names who moved it and from which version where
that is not its author, and in the earlier version's list, as "moved to version n". A hidden
move appears on neither. That suits a corrected scan, where the move tells a reader nothing. The
flag is on each move, so a carry that turns out to be mistaken can be shown. The row keeps the
target the note left, which is what an undo would replay. Undo is not part of this plan.

`scripts/upgrade-pdf-text-version.ts` doesn't read these rows. A kept target's page, quads and
quote stay true, since a version's bytes never change. Its offsets and its text version may
name an extraction the script has since deleted, and an undo would find them again from the
quote.

**Links.** A revised text has no page map until a carry is run, and a link written against an
earlier version then opens that version. So does a `page=` link without words to a sheet that a
map leaves unmapped, which Links into the file reports as unmatched and sends nowhere.

- **A `p=` names a version as a `page=` does.** While a file has one version, a link of either
  form needs no `v=`. Once it has a second, every link into it that the app writes carries
  one, by printed page or by sheet, and a `v=` belongs to the `p=` or the `page=` before it. A
  link of either form without one means the file's first version. On a version's own address
  it counts that version's pages, as Links into the file has it.
- **So a `p=` link is carried as a `page=` link is.** Its label is read on the version it
  names, the sheet found there goes through the page maps to the version shown, and its words
  are looked for on that sheet. Where no map reaches the version shown, it opens its own
  version. Links into the file reads a `p=` on the latest version's labels, gives it no stamp
  and steers linkers to it for that reason. All three go.
- **The checks read a link against the version it names.** Words that are gone from the latest
  version are no fault in a link that names an earlier one. The integrity check's warning for
  a link without `v=` written after its file's second version, and MCP's refusal of one,
  cover a `p=` too. A link that names an earlier version still lands, and every link written
  before a file's second version is one, so the integrity check lists such a link only under
  `--verbose`, where Links into the file has it reported as stale.
- **A sheet is written `sheet=`.** `page=` is read as the same thing for good, so every link
  already written keeps working, and the app writes it no more. Beside `p=`, "page" is the
  word a reader takes for the printed page. The two words are page, for the one printed on
  the paper, and sheet. MCP's tools use them that way: a parameter or an answer that says
  `page` for a sheet says `sheet`. It is a pull request of its own, ahead of `v=`, and the
  rest of §13 is rewritten to it.
- **A citation's page is a printed page, never a sheet**: `/references/<key>/p/<page>`, read
  on the latest version's labels. A work is one fixed text, so its file takes better copies
  and no revisions, and its printed pages are the same in each.

**Search and citations stay on the latest version.** What a set of drafts wants from them is
under Open.

**No version is purged.** A version goes only as its file does, by the soft deletion that
exists. `purgeFileVersion`, its row in PERMISSIONS.md, its test and its half of step 10 leave
the plan. The page of a version that is gone is needed for an abandoned candidate alone.
`FILE_STORAGE_DIR` grows by a whole copy per version, and nothing shrinks it.

**What stands:**

- Versions, Addresses and The upload;
- what is drawn and listed on which version's page;
- `v=`, and the rest of Links into the file but for the paragraph above;
- the placing rules, as the engine behind a move;
- Matching the pages, for the bulk carry and for the `page=` links without words;
- Rejected designs, and the accepted outage on the first migration's deploy;
- steps 1 to 4 as the first pull request, with one change: `file_reconciliation_item` leaves
  step 1's migration. Its successor is the history of moves with the "stays here" mark, and that
  arrives with the step that builds a move.

**What is rewritten:**

- **The section's name and opening.** It plans versions of a file, where it says a replacement
  in three stages. The pointers that use the old name follow: CLAUDE.md's row for this file,
  PLAN.md §33, TODO.md's entry, and the lines in CITATIONS.md and PDF_FRAGMENT_LINKS.md. The
  opening's list of rows for PERMISSIONS.md loses reviewing and purging, and gains running the
  bulk carry and moving a note.
- **The review** becomes the worklist, and the page that answers a map's runs of sheets. Its two
  warnings (a candidate without usable labels; citations that name a sheet of a file without
  labels) move to the candidate's page.
- **Promotion** becomes switching the latest and, where it was asked for, the bulk carry. Its
  refusals and its first step go.
- **Placing each anchor** keeps its rules and loses the reconciliation item: its three outcomes
  are what a suggestion says, or what the bulk carry acts on. The refusal over a `PDF_TEXT` row
  in `tag_anchor` or `comment_quote_anchor` goes with the gate, since such a row simply stays on
  its version. The integrity check for one stays.
- **The upload** loses the items an abandonment deletes, and the pass that reruns after a
  restore.
- **Earlier versions** loses the purge, and what the text-version script does about items.
- **Open** loses "Moving notes forward". It gains: a map for pages that reflow; search and
  citations across a set of drafts; a curator who moves other people's notes; moving a note
  back, or undoing a move; a nudge by email; the purge; decisions made against a candidate
  before its promotion and written with it, which need a table of pending moves and a rule for
  an abandoned candidate; and the answers given about the runs of an abandoned candidate's map,
  which the next candidate's map asks again.
- **Building it** from step 5 on, with its tests, and TODO.md's races, most of which the gate
  made.

**Left for the rewrite to settle**, each said plainly when it is, since none of them is decided:

- what becomes of a citation's `/pdf/` referent written with `page=`, and of a cited page in a
  file without usable labels, now that a citation names a printed page and never a sheet.
  Proposed and not confirmed: a referent takes `p=` and a sheet is refused there, and a file
  without usable labels keeps the reading of `p=<n>` as a sheet, with its warning;
- whether the bulk carry moves a note its author has marked "stays here";
- which map a carry builds when the notes are on a version that is not the latest's base, and
  whether their sheet is found by chaining maps;
- what a second run of the carry does to a map already built, and to the runs already answered
  on it;
- which rules decide that a sheet was removed, where Matching the pages names only rule 4: a
  label no new sheet carries under rule 1, and a sheet the alignment pairs with nothing under
  rule 3;
- whether rule 1's sheets with a repeated label and unequal counts go on to rules 3 to 5, as its
  sheets with an empty label do, where today they are left unmapped;
- a sheet without text inside a stretch of shifted labels. Rule 2 checks only the pairs where
  both sheets have text, so such a sheet keeps the labels' answer and splits the run;
- the similarity measure on a revised text. It is fixed against better copies, and on pages that
  reflow it could pair a sheet with the one holding most of its words;
- whether a move row keeps the target the note reached. Nothing reads it: the note holds that
  target, and a later move's row records it as the one left;
- the names of MCP's parameters for a page and a sheet. `page` means a sheet in its tools today,
  so a prompt that passes it for one changes meaning;
- the link cases Links into the file and Placing each anchor leave unsaid: a link with words on
  an unmapped sheet whose passage occurs on several sheets; a link carried backwards onto a
  sheet with no counterpart in the base; a chain of maps with one missing in the middle; an
  anchor on a removed sheet; and where "found more than once" ends and a tie broken by `prefix`
  and `suffix` begins.

**How the rewrite is checked.** Two cases are walked through the rewritten text, each from the
upload to the last note: what the uploader sees, what each note's author sees, where every note
and every kind of link lands, and what is stored.

1. **A corrected scan**: the same pages, with the text layer corrected.
2. **A paper's next draft**: 12 pages become 14, the text is reflowed, a section is cut and
   three paragraphs are rewritten. There are no labels, and thirty notes.

A step either case can't get through, or a sentence that still assumes every anchor is given a
place, is a fault in the rewrite.


### Versions

- **`file_version`** has one row per version of a file. It holds:
  - `file_id` and `number`;
  - what the bytes decide: `sha256`, `byte_size`, `content_type`, `page_count`,
    `page_labels`, `outline` and `filename`;
  - who uploaded it and who promoted it, with when;
  - `base_version_id`, the version that was the latest when it was uploaded, and the page
    map from that version (Matching the pages). The base is stored, since it can't be worked
    out from the numbers once a version between two others has been abandoned;
  - `uploaded_at_update_id` and `promoted_at_update_id`, the highest `ydoc_update.id` when
    the row was made and when it was promoted: a clock for dating links (Links into the
    file);
  - `abandoned_at` and `purged_at`.

  Every file has a version 1, a file that is not a PDF included. It is made promoted, by its
  uploader at its upload, so it is never a candidate, and both its update ids come from one
  read of the highest `ydoc_update.id` in `recordUpload`'s transaction. The migration makes
  one for each file that exists, from the file's own `created_*` values, with both update ids
  the highest `ydoc_update.id` whose `created_at` is no later than the file's.
  - **A migrated version 1 takes its file's id as its own.** So `file_page_text` is re-keyed
    by renaming its column, and an anchor's version is filled from its `file_id`, with no row
    of page text rewritten.
  - **A version made after the migration has an id of its own**, and no fixture shares the
    two. Code that passes one id for the other works on every migrated file, so the suite is
    what catches it.
- **`file.current_version_id` names the latest.** A version's state is read from its row: a
  *candidate* is neither promoted nor abandoned, and an *earlier* version is promoted and not
  the latest. *Promoted* means `promoted_at` is set. Who promoted it can be NULL: a migrated
  version 1 has no uploader where its file has no `created_by_user_id`, and a deleted user's
  id is set to NULL.
- **A file and its first version are made in one transaction, in a fixed order**: the file
  with `current_version_id` NULL, then the version, then the pointer. The two rows name each
  other, so one of them has to be written before the other exists.
  - **The column is nullable for that step alone.** An integrity check reports a file without
    a latest version (Building it). Prisma types the relation as optional, so the readers go
    through one helper that throws on such a file, and none handles NULL for itself.
  - **The order is the search trigger's.** It runs before the file's insert, when the file
    has no version, so the update that sets the pointer is what puts the filename in the
    vector (below). A deferred foreign key, with the pointer filled at the insert, would
    leave the filename out and nothing would fire later.
  - **The pointer's foreign key is on the pair** `(current_version_id, id)`, as an anchor's
    is, so the latest is one of the file's own versions.
- **What the bytes decide leaves the `file` row.** `sha256`, `byte_size`, `content_type`,
  `page_count`, `page_labels`, `outline` and `filename` are a version's alone, and a reader
  that means the latest selects them through `current_version_id`. About forty modules read
  them from the file row today, and the compiler finds each once the columns go. It does not
  find raw SQL: `scripts/integrity/check-search-index.ts` builds `file_search_vector(title,
  filename)` over `file` and keys `file_page_text` on `file_id`, for its check and its
  `--repair`, and breaks only when run.
  - `/files` sorts by size, pages and filename through that to-one relation.
  - The file's search vector holds its filename (FULLTEXT.md §3), from a trigger on
    `UPDATE OF title, filename`. It reads the latest version's filename, and fires on
    `current_version_id` as well, so a promotion refreshes it, and so does the update that
    ends a file's creation.
  - `fill` (`src/lib/pdf-metadata.ts`) writes labels and an outline to the version it parsed.
- **Page text is keyed by version**: `file_page_text`'s key becomes `(file_version_id,
  page_index, text_version)`. Its functions take a version's id where they take a file's
  today, so the compiler names every caller, and one that means the latest passes
  `current_version_id`.
  - Search ranks the latest version's pages alone (`src/lib/search/pdfs.ts`), or a hit would
    come from text that `/pdf/<slug>` doesn't show.
  - The two lazy writers (`extract` in `src/lib/pdf-page-text.ts`, and `fill`) write under
    the version whose bytes they parsed, so text can't land on other bytes.
- **An anchor names its version.** `annotation` and the anchor tables gain
  `file_version_id` beside `file_id`, set exactly when the row holds a PDF target (a
  `pdfTarget`, a `PDF_TEXT` selector), with a foreign key on the pair so the version is one of
  that file's. It is the version whose pages the quads were measured on.
  - The column is part of the row shape the anchor tables share (`src/lib/anchors/`), beside
    the selector and outside it: a `PdfTarget` stays what the viewer measured. It is not in
    the target arc either, since a tag's target is a file and no version of it.
  - A reply has no target and so no version. It is on its root's version and is shown with
    its root. Replies nest, and `/annotations`, search, a reference's cited-by, mentions and a
    link's groups each list single rows. So one helper answers which version a note is on,
    its own or its root's at any depth, and every such listing goes through it.
  - **A root with no target is the file's, and has no version.** The panel's "Write an
    annotation..." makes one, and so does MCP's `add_note` without a quote. It is listed on
    every version's page, a candidate's included, and may be written from any of them, since
    no page of it was measured. The reconciliation and the purge ignore it. A stored target
    that no longer parses is listed the same way.
  - A tag is on the whole file and has none.
  - A reference has none. It names the work, and a citation's page is resolved on the
    latest version's labels and text at every click (Links into the file).
- **A number is never reused.** An abandoned or purged version keeps its row, without its
  bytes or its page text. The next number is one more than the file's rows. So version 3 of
  a file never comes to mean other bytes. An address is only as lasting as its slug: a
  deleted file's slug is free, and whatever takes it answers at `/pdf/<slug>/v/1` too.
- **One candidate per file**, held by a partial unique index on `file_id` where the row is
  neither promoted nor abandoned. An upload while one stands is refused, naming it, until it
  is promoted or abandoned. A soft-deleted file takes none, and neither does a file that is
  not a PDF.
- **Whoever may read the file may read every version of it**: the candidate, the latest and
  the earlier ones. A version has no visibility, owners or deletion of its own, so there is
  no second read rule to keep in step with the file's. Uploading a version, reviewing,
  promoting and abandoning take `canUserManageFile`.
- **A new note or link part goes on the version it was made on**: the latest, or an earlier
  version from its own address.
  - **A candidate takes none**, since abandoning it removes the pages the anchor was
    measured on. Only the reconciliation records anything against it.
  - **A note on an earlier version stays there.** A reconciliation reads the latest version's
    anchors alone, so it is never carried forward. It is drawn at its version's address and
    listed wherever a note is (Addresses), and the latest version's page lists it (The
    review). Moving notes forward is a later feature (Open).
  - **A capture names the version its viewer loaded and the address it loaded it from**, and
    the write checks them inside the transaction that inserts, with the file row locked: a
    posted note, a draft opened on a selection, a part added to a link, and MCP's
    `anchorPdfQuote`.
    - **From `/pdf/<slug>`, the version must still be `current_version_id`.** A viewer left
      open there across a promotion still shows the old bytes and isn't told, and its writer
      means the latest. Its capture is refused with a reload message, as the schema gate
      refuses a stale tab, rather than landing on an earlier version unseen.
    - **From `/pdf/<slug>/v/<n>`, the version must be promoted and not purged.** Its page
      has said which version it is. A candidate isn't promoted, and neither is an abandoned
      one, so a tab left open on a candidate across its abandoning is refused too. Its page
      text is gone, and the capture would otherwise keep the quads and drop the quote.

### Addresses

- **`/pdf/<slug>` shows the latest version. `/pdf/<slug>/v/<n>` shows version n, whatever
  its state**: a candidate, the latest or an earlier one. It never redirects to the bare
  address, so a link to version 2 still shows version 2 after version 3 is promoted.
  `/pdf/<slug>/v<n>` redirects to it.
- **The page of a version that is not the latest says so in a banner**: which version it is,
  when it and the latest were uploaded, and the time between them in the largest unit that
  fits (years, months, days, hours, minutes or seconds), rounded to the nearest, with a link
  to the latest. On an earlier version it adds that a note made there stays on that version.
- **`/files/<slug>/v/<n>`** is a version's download page, and `…/download` its download. A
  download is saved under the version's own `filename`, so two versions uploaded as
  `book.pdf` both save as `book.pdf`. The download redirects to the byte URL with `&v=<n>`,
  and the route takes the filename from that version once it has checked that the version
  holds the hash. Without `v`, the newest version holding the hash names the download. So
  the same bytes uploaded twice under two names each save under their own.
- **The byte route serves the hash its URL names** (`/api/files/<id>/<sha256>`) when a
  version of the file that is neither abandoned nor purged holds those bytes, `immutable`.
  Such a row keeps its `sha256` without the bytes. Any other hash answers 404, where
  today it gets the current bytes. So a viewer open on one version reads that version's bytes
  for as long as it is open, never splicing another's in by range.
- **A version has no slug.** A renamed file's old slug redirects as it does today, and the
  redirect keeps the rest of the address: `/pdf/book/v/1` goes to `/pdf/barfield/v/1`. A file
  restored as `book-2` has `/pdf/book-2/v/1`.
- **An abandoned or purged version's address answers with a page that says so**, to whoever
  may read the file: which version it was, that it was abandoned or purged and when, and a
  link to the latest. A number the file never had answers 404.
  - **The link carries the fragment over.** The version's row and page map are kept so that a
    link written against it still finds its page, and that has to hold for a link to its own
    address too. `/pdf/book/v/2#page=49` offers `/pdf/book#page=49&v=2`, which the latest's
    viewer resolves through the page maps (Links into the file). The server never sees a
    fragment, so a client component completes the link.
  - **It lists the notes still on that version**: those restored after a purge, which have no
    page to be drawn on. So a note's link in a listing never leads to a 404.
  - MCP's `read` of such an address answers the same: the version is gone, and where the
    latest is.
- **The viewer is mounted per version.** `PdfSurfaceClient`'s `key` is the version's id, where
  it is the file's today. A client navigation between two versions of one file (the banner's
  link to the latest, the version list, a link's parts on two versions) then mounts a new
  surface. Keyed on the file, the old surface would stay, with one version's viewer, ready
  flag and once-only jump on the other's page.
- **A card's link on the bare address still finds a note on another version.**
  `/pdf/<slug>#<card>` is what `/annotations`, MCP's answers and every body written before a
  replacement hold. The latest version's page lists the notes on earlier versions (The
  review), and each entry there carries its card's fragment id. So the link lands on the
  entry, which links the note at its own version (`/pdf/<slug>/v/<n>#<card>`). MCP's `read`
  of a card's URL answers the thread on whichever version holds it, and names that version.
- **A version that is not the latest is called `<title>, version <n>`**, on its page and
  wherever a note on it is listed: `/annotations`, search, a reference's cited-by, mentions,
  MCP's threads and a link's groups. Each links the note at `/pdf/<slug>/v/<n>`, and so does
  the email sent when a note is raised.
- **A `/link/<id>` landing on a PDF part goes to the part's version.** Where a link's parts in
  one file are on several versions, it goes to the newest of those, the latest wherever a
  part is on it, and the viewer's banner names the parts on the others, each linked at its
  own version (`/pdf/<slug>/v/<n>?sel=`). The file stays one group, so a link that went
  straight into the PDF before a promotion still does after it.
- **What is drawn on a page is one version's.** Three sources of stored targets are drawn,
  and each is narrowed to the version shown:
  - **the notes**, which reach the surface by two paths (the page's `pdfAnnotationEntriesFor`
    and the `loadPdfAnnotationEntries` action), both through one query that takes the
    version;
  - **a followed link's parts**, which the surface picks out of the link by file id, in the
    browser;
  - **the open link's parts**, from the client store, picked the same way.

  The last two are another table's rows, filtered in the browser, so `AnchoredLinkPart` and
  `OpenLinkPart` carry `fileVersionId` and the surface compares it with the version it shows.
  This is the read where a missed filter fails silently, drawing a note or a part over other
  ink. No integrity check can see a filter in the browser, so the e2e covers each of the
  three (Building it).
- **What is listed is the file's.** The viewer's own drafts ("Your private notes") are listed
  on every version's page, each naming the version it is on and linking there, so a draft
  left behind is on the page its author opens. MCP's threads on the bare address answer the
  latest version's and then those on other versions, each naming its version, as the page
  does. Filtered to the latest alone, a RAISED note left on version 1 would leave the reply
  queue. On a version's own address they answer that version's. An entry for a note on
  another version carries its replies' card ids as well as its root's.
- **`PdfMetadataPanel` lists the versions**, each with its state, who uploaded it and when,
  who promoted it and when, a download link and a link to its page. Versions are in no
  listing of files, since they are not files.
- **MCP's `read` takes `/pdf/<slug>/v/<n>`**, and the latest without it. Its byte route
  (`/api/mcp/files/<id>`) takes no hash and serves the latest version's bytes.
  - **A fragment in the URL is read by the viewer's rules** (Links into the file): an
    unstamped `#page=50` on the bare address is the first version's sheet, carried to the
    latest. The tool's own `page` argument is a sheet of the version read. The two can be
    the same number and different pages, so the answer names the page it read in its
    stamped form.
  - **`add_note`, `create_link` and search's `within` take a version's address** as `read`
    does. A note or a part on a candidate is refused, as from the viewer.
- **The presence channel is per version** (`ydocIdForFile` gains the version), so a reader
  following a presenter is never led to a page of other bytes.

### The upload

`PUT /api/files/<id>?filename=…`, a Route Handler for the upload's reasons (§2a), sent through
`FileUploader`'s streaming with its 413 and severed-connection messages. It runs
`stageUpload`, extracts as any upload does, and makes the version row with its page text. It
refuses anything but a PDF.

- **Bytes identical to the latest version's** answer "unchanged" and write nothing.
- **Bytes identical to an earlier version's, or to another file's,** make a version as any
  others do, sharing the blob on disk. Going back to an earlier scan is therefore an ordinary
  replacement, reconciled like one.
- **MCP's upload of bytes a readable file already holds** (`recordUpload`'s `reuseReadable`)
  answers with that file only where its latest version holds them. Bytes that only an earlier
  version holds make a new file, since the file found would show other bytes.
- **Whether bytes are still referenced** is counted over `file_version` rows that hold them,
  where `discardStagedUpload` and `deleteBytesIfUnreferenced`'s other callers count `file`
  rows today.
- **Abandoning** a candidate marks its row, and deletes its page text, its reconciliation
  items and its bytes, unless another row holds them. The row keeps its page map, so a link
  written against it still finds its page (Links into the file), and its address says where
  the latest is (Addresses).
- **A candidate waits with its file.** Deleting the file leaves the candidate as it is.
  Reviewing, promoting and abandoning are refused while the file is deleted, and after a
  restore the pass reruns and the review resumes.

### Matching the pages

A **page map** gives each sheet of the latest version a sheet in the candidate, or none: the
sheet was removed, or no rule could place it. It is built in order of trust:

1. **By label**, where both versions have usable labels (`usablePageLabels`). Each sheet maps
   to the sheet with the same label, each version's own labels read as a `p=` reads them
   (`sheetsLabelled`). A label on several sheets maps the k-th sheet carrying it in the old
   version to the k-th in the new, when both have the same number of sheets with that label.
   Otherwise those sheets are left unmapped. A sheet whose own label is empty has none to match
   by, as for `p=` (PDF_FRAGMENT_LINKS.md §2, "Which sheet"), and is placed by rules 3 to 5.
2. **Checked by text.** Where both sheets have text, a label's answer stands only if the two
   pages' skeletons (PDF_FRAGMENT_LINKS.md §4) largely agree. Where they disagree neither
   answer is taken, since the replacement may exist to correct the labels: the sheet is left
   unmapped, and rule 3's alignment proposes its sheet for a person to accept (A run of
   sheets, below).
3. **By text**, where labels can't decide: a version without them, or with them on one side
   only. The two sequences of pages are aligned as a diff aligns lines, on the similarity of
   their skeletons.
4. **Blank pages** have no text and draw nothing, so a blank page added is a known insertion
   and a blank page removed a known deletion. "Draws nothing" is read from pdfjs's operator
   list, which holds no painting operator for such a page. Nothing on the server asks for one
   today, so `src/lib/pdf-extract.ts` gains that read. A blank sheet in a scan usually still
   paints the scan's image, so it is a page with ink and no text, under rule 5.
   - **The read opens the document with `wasmUrl`**, which the server's `openPdf` doesn't pass
     today. Without it JBIG2 and JPEG 2000 images fail to decode on the server ("JBig2 failed
     to initialize", measured on two scans). pdfjs adds an image *mask*'s operator only once
     the mask has decoded, and drops one that fails with a warning. So a page whose only ink
     is a JBIG2 mask would read as drawing nothing, and be taken for a blank page.
   - **A page with an image that failed to decode counts as ink**, whatever its operator
     list holds, and step 6's measurement includes a scan whose pages are JBIG2 masks.
5. **Pages with ink but no text**, such as plates, figures and image-only scans, are placed
   between their aligned neighbours when the run between them has the same length in both
   versions. Otherwise they are left unmapped.

**A sheet no rule can place is left unmapped**, and a promotion doesn't wait for it. The map
records which of the two a sheet without a counterpart is: removed, which a rule decided, or
unmapped, which none could. An unmapped sheet costs two things:

- a `page=` link to it that has no words is not carried, and is reported as one whose sheet
  couldn't be matched (Links into the file);
- no anchor on it is placed automatically (Placing each anchor).

Nothing pairs such a sheet by hand (Open).

**A run of sheets** is what the review is asked about, never one sheet. Consecutive sheets
whose labels and text disagree under rule 2 are one run. Whenever rule 2 finds a disagreement,
rule 3's alignment is made over the whole of both versions, and it gives each sheet of the run
the sheet proposed for it. The review shows the run once, with the sheets the labels give
beside those the alignment gives, and the reviewer accepts the alignment's for the whole run
or declines it.

- **For example**, a scan whose labels start one sheet late has printed page 1 on sheet 11
  and the label `1` on sheet 12. Its replacement is the same 311 sheets with the labels
  corrected. By label, sheet 12 goes to sheet 11 and every numbered sheet after it goes back
  one, and each pair's text disagrees. The alignment pairs every sheet with itself. Sheets 12
  to 311 are one run, accepted in one act where sheet by sheet would take three hundred.
- **Accepting writes the alignment's sheets into the map**, and the pass is rerun over the
  anchors on them. Where the alignment gives a sheet of the run no counterpart, that sheet
  stays unmapped.
- **Declined or unanswered, the run stays unmapped.** The proposal is kept in the map beside
  each sheet, marked as not accepted, and the map's readers treat such a sheet as unmapped.
- **A run is answered before the promotion.** After it the review is closed, and the run
  stays as it was (Open).

**How alike two pages must be** is one measure, which rules 2 and 3 share. It and its threshold
are settled by measurement before the pass is written: on a scan before and after its text
layer is corrected, where every page should pair with itself, and on two scans of one book.

The page map stays on the candidate's row for good: `page=` links are resolved through it
(Links into the file).

### Placing each anchor

Two kinds of row point into a file with a `PdfTarget` today:

- an annotation's `pdfTarget`, with its `quotedText`;
- an `anchored_link_anchor`'s `PDF_TEXT` selector, with its `quoted_text`.

`tag_anchor` and `comment_quote_anchor` have the same row shape and no such row. A tag is on a
whole file (TAGS.md), by the file's id, and needs nothing. A comment's quotation of a file is
refused (`canQuoteTargetInto`). Each joins the reconciliation when it gains a writer. Until
then, promotion refuses a file on which either table holds a `PDF_TEXT` row, and the integrity
check reports one (Building it), so a writer added later can't leave anchors the reconciliation
never saw. `scripts/upgrade-pdf-text-version.ts` already reads all four tables.

Each such row on the latest version gets one **reconciliation item**, whose outcome is one of
three. **Every row gets one, whatever its state**: a soft-deleted annotation, a link not yet
minted and a deleted link too, since a restore or a mint would draw it. Those follow the rule
for a DRAFT (The review, below).

**Placed** automatically when the quote is found once by skeleton on the mapped sheet, with its
`prefix` and `suffix` breaking a tie. The new target is measured on the candidate's page as MCP
measures one (MCP.md §8, `anchorPdfQuote`'s pipeline):

- quads from `quadsForRange` over the candidate's text items;
- `position` and quote derived by `capturePdfTextAnchor`;
- `textVersion` the current one.

A rectangle selection is a target whose `position` is null. A text selection whose quote the
capture dropped (`capturePdfTextAnchor`, on a mismatch) has a position and an empty quote. It
has no words to find, so it is carried as a rectangle is, and written with its `position`
null: its offsets were into the old version's page text. Either is placed automatically, its
quads unchanged, when the mapped page has the same page box and rotation and its text items
sit where they did.

**Proposed**, for a person to confirm:

- the quote found once in the candidate, on a sheet other than the mapped one, or from a
  sheet that is unmapped;
- the quote's words changed ("modem" to "modern"). The old range is mapped through a diff of
  the two pages' text (`diffText` over `tokenizeFine`'s tokens, `src/lib/diff.ts`), and the
  review shows the old quote beside the new;
- a rectangle selection whose page moved: its quads are carried by a transform fitted to the
  text items the two pages share, when the fit is close;
- a rectangle selection on a page with no text items, a plate or an image-only scan: its
  quads unchanged, when the page box and rotation agree. Nothing on such a page says whether
  the ink sits where it did.

**Needs a person**: the quote isn't found, is found more than once, or now crosses a page break,
which one target can't hold; or a rectangle's sheet is unmapped, its transform doesn't fit, or
its page has no text and a different box.

### The review

A page under the candidate (`/pdf/<slug>/v/<n>/review`), open to whoever may manage the file,
lists the runs of sheets the page map asks about, to accept or decline (Matching the pages),
and then the proposed items and those needing a person. The runs come first, since accepting
one places anchors that would otherwise be listed. Each item shows the passage on the latest
version beside the candidate. The reviewer either:

- **accepts** the proposal;
- **places** the anchor by selecting text or drawing a rectangle on the candidate, as an
  annotation is captured; or
- **leaves it behind**, so it stays on the version it is on.

**Left behind** means the promotion doesn't touch the anchor. It keeps its target and its
version, and is drawn on that version's pages, where its quads are still right. An anchor that
can't be carried across is therefore never drawn over the wrong ink. That matters most for a
rectangle selection, which the viewer can never report as orphaned (§4: it has no quote to
check). The latest version's page lists the notes on earlier versions, under the version each
is on: those left behind and those made there since.

**A reviewer is never shown someone else's DRAFT.** A draft is its author's alone, and showing
it would show a private choice of passage to someone else. It is placed automatically like
everything else, and one that can't be is left behind for its author to find, and to post
where it stands or discard. The same holds for the other rows a reviewer isn't shown: a
soft-deleted annotation, a link not yet minted, and a deleted link. A deleted root that still
has a reply that is not deleted is shown, since its thread is still listed.

### Promotion

`promoteFileVersion(actor, fileId)` in `src/lib/file-manage.ts`, so an MCP front door, if one
is wanted, is a wrapper (CLAUDE.md, "A write the UI and the MCP server share"). It is refused
while any item is proposed or needs a person. An unmapped sheet doesn't refuse it, and neither
does a run of sheets left unanswered. Anchors written on the latest version since the
review began are placed automatically first. One that can't be goes to the review and
refuses the promotion, if the reviewer is shown it. One they aren't shown, someone else's
draft or a part of a link not yet minted, is left behind, as in the review.

One transaction, the file row locked:

1. **Every anchor on the latest version is checked against its item.** Each row with a PDF
   target there must have an item that is placed or left behind, and whose recorded old
   target is the row's target still. If one doesn't, the transaction writes nothing, the pass
   places those rows, and the promotion is tried again. A row that can't be placed refuses
   it or is left behind, as above.
2. **`current_version_id` becomes the candidate.**
3. **Every placed anchor's new target is written**, with its quote and its version. An anchor
   left behind is not touched.
4. **The candidate's row records who promoted it and when**, and `promoted_at_update_id`, the
   highest `ydoc_update.id` at that moment.
5. `updatedAt`, and `updatedByUserId` set to the promoter.

Step 1 is there because placing can't be done under the lock: it reads the candidate's bytes
and takes seconds. A capture can therefore commit between the last pass and the lock, and its
own check passes, since its version is still the latest. Without the step that anchor would
stay on the outgoing version with no item, left behind by nobody's choice. The same step
catches a row whose target was rewritten after its item was made.

Each item keeps its anchor's old target, which is what an undo would replay. Undo itself is
not part of this plan.

Nothing else changes. The file's id, slug, title, visibility, owners, tags, references and
slug history are as they were, every version's address answers as it did, and only
`/pdf/<slug>` shows other bytes.

**After it:**

- **The promoter's page reloads in full.** `router.refresh()` is not enough, since the viewer is
  behind `ssr: false` (CLAUDE.md).
- **A viewer left open keeps the version it loaded.** Its bytes come by hash and its note list
  by version, so it shows what stayed on that version, and the notes that were carried leave
  its view. Nothing tells it to reload, and a capture from it is refused with a message that
  does.

### Links into the file

Links are href text in other people's bodies, and a promotion rewrites none of them.

- **A `p=` link with text needs nothing** (PDF_FRAGMENT_LINKS.md §2, "Which sheet"). Its page
  is found by label and its passage by its words. Where the labels were corrected, the miss
  finds the passage elsewhere in the file (§6 there, step 3).
- **A citation needs nothing, unless its referent is a `/pdf/` URL written with `page=`.** Its
  link is the cited-page route's, `/references/<key>/p/<page>?…` (CITATIONS.md, "A passage in
  a citation"). The route reads the latest version's labels and page text at every click, for
  a post's frozen href as for a doc's.
  - **A `quote:*` passage is found by its words**, on the sheets carrying the cited page
    (`placeCitedQuotation`), and by the viewer's miss when it isn't there.
  - **A `/pdf/` referent carries pages of its own**, which ride in the route's query as the
    referent wrote them (`fragmentPairs`). Written with `p=`, they need nothing either, and
    the conversion of the hand-written citations writes `p=` wherever the file has usable
    labels. Written with `page=`, each names a sheet of one version, as a `page=` link does
    (below). So `v=` is kept from a referent (`fragmentPairs`, whose filter drops every
    parameter but `page`, `p` and `text` today) and in the route's query
    (`parseCitedQuery`), and `citedPageTarget` resolves the sheet through the page maps on the
    server and redirects to the latest one.
  - **A file without usable labels** takes a citation's page as a sheet number of the latest
    version (`sheetsLabelled`). So a replacement that moves its sheets misdirects the
    citations of it that name a page and no passage. The review warns of that, counting those
    in bodies the reviewer may read. They are not carried through the page maps as an
    unstamped `page=` link is. A `page=` is a sheet by definition, and the maps carry it
    exactly. A locator is a printed page, read as a sheet only for want of labels, so the maps
    would carry a guess forward. Labels on the candidate are what fix it.
- **A `page=` link names a sheet of one version**, and is carried to the version shown
  through the page maps between the two. A link written against a page that has since gone is
  reported as such, not sent to a neighbour. One written against a sheet a map leaves unmapped
  is reported as unmatched, in its own words, and likewise sent nowhere.
  - **Each version's map is from its base**, the version that was the latest when it was
    uploaded. A link is carried along those maps in either direction: forwards to a later
    version, and backwards to an earlier one or off an abandoned one. A link stamped `v=4`,
    where version 4 was abandoned over version 3, is carried from 4 to 3 and on to the
    latest.
  - **A `v=` that names no version of the file** opens the sheet as written, with a banner
    saying the file has no such version. A passage is still looked for by its words. This is
    what `v=2` gets on another file that has taken a deleted file's slug.
  - **The map comes first, then the words.** The passage is looked for on the mapped sheet, and
    the miss (PDF_FRAGMENT_LINKS.md §6, step 3) still finds one that isn't there. The miss
    alone already carries a passage that occurs once in the file. The map is what carries a
    page link, which has no words, and a passage the unmapped sheet also holds, which would be
    drawn there with nothing to say it is the wrong one.
  - **The viewer holds the page maps**, among its props: `PdfViewer` applies `#page=` on its
    own, before any passage is found (`pageFromHash`).

**Which version a `page=` link was written against** is carried in the link:

- **`v=<n>`**, the version's number: the one in its address, which a person can read, type
  and check.
  - **A `v=` belongs to the `page=` before it**, and is written straight after it:
    `#page=50&v=2&text=…`. Parameters are read left to right (PDF_FRAGMENT_LINKS.md §2,
    "Pairing"), so a `v=` before any page, or after a `p=`, is ignored.
  - **A link with several passages stamps each `page=` of its own.** The app writes one
    version on all of them. A hand-written link whose stamps differ has each passage read by
    its own stamp.
- **A `page=` link without `v=` means the file's first version, always.** That holds for
  every link that exists before a file's second version does.
- **Once a file has a second version, every `page=` URL the app writes for it carries `v=`**,
  a candidate counting as one, and a link to version 1 included. Each is written by
  `formatPageName` (`src/lib/pdf-open-params.ts`), so the stamp is a field of `PageName`'s
  sheet arm, and the compiler names every writer:
  - search's page links (`src/lib/search/pdfs.ts`) and the cited-page links (`pdfPageHref`),
    wherever `pageNameForSheet` or `pageNameForLabel` answers a sheet: a file without usable
    labels, a sheet whose own label is empty, a label an earlier sheet carries
    (PDF_FRAGMENT_LINKS.md §8, "Which page form a writer takes"). A `p=` needs no stamp;
  - every passage written through `formatFragmentPassages`: the cited-page route's redirect
    (`placedFragment`), the one-quote CLI's, and the corrected hrefs this plan has the check
    and MCP's refusals give (below).
- **The address says which version is shown, and `v=` whose sheets the link counts.**
  `/pdf/book#page=50&v=1` shows the latest version, at the sheet that version 1's sheet 50
  became. `/pdf/book/v/1#page=50&v=1` shows version 1 itself.
- **On a version's own address, a `page=` without `v=` counts that version's sheets**: the
  address has already named it. `/pdf/book/v/2#page=49` is sheet 49 of version 2. This is the
  one place an unstamped link is not read as the first version, and only a hand-typed one
  reaches it.
- **A hand-typed link without `v=`, to the bare address of a file with several versions,** is
  the case this reading gets wrong. The viewer's banner says how it read the link ("read as
  version 1: its page 50 is page 49 now") and offers the other reading.

**The integrity check can date a link, which the viewer can't.** `ydoc_update.id` is one
sequence across every doc and every annotation body, and an id is never given twice, so the
two ids on a version's row are a clock. Rows are deleted only with their whole body, a
discarded annotation's, which takes its links with it.

- A body whose last update is below a mark was written wholly before it, and one whose first
  is above it wholly after. Neither needs a replay.
- A body edited on both sides is replayed once to the mark, as MCP's `since` replays a doc,
  for the hrefs it held then.
- A post holds the hrefs its doc held at the snapshot it was published from
  (`ydoc_snapshot.last_ydoc_update_id`), which is only the latest that any of them can have
  been written. A post published before a mark was written wholly before it. For one
  published after it, the doc is replayed to the mark, and a link the doc held then is dated
  before it. An event that has lost its snapshot is dated by its time, as a comment is.
- A comment's link is dated by the earliest of its revisions that holds the href: that
  revision's time, against the times the version was uploaded and promoted.
- An update whose transaction was open when a mark was read can carry an id below the mark
  and commit after it. The check only warns, so that is accepted.

The check warns of a `page=` link without `v=` written after its file's second version was
uploaded, which only a hand can have typed. The viewer has only the URL, so it reads by the
rules above. A link pasted from an older body is dated at its paste.

**Linkers are pushed toward `p=`.** A `page=` link into a file with several versions can't
drop its `v=`, since without one it means the first. `p=` is the form that needs none.

- **The integrity check reports a link stamped with a version other than the latest as
  stale**, not wrong, since it still lands. It gives the link's `p=` form where the file has
  usable labels, and its `page=` form for the latest version otherwise.
- **MCP refuses a `page=` link without `v=` into a file with several versions**, and gives
  the same two forms. Its `read` of a page of such a file names the page in its stamped form,
  so a model has it before it writes.
  - **A link with `text` is placed by its words**, and the corrected form names the page they
    were found on.
  - **A page link has nothing to say which reading was meant**: the first version's sheet, by
    the rule, or the latest's, which a model that has just read the file means. The refusal
    gives both, each with the page it would open.
- **A link to a version's own address is a link into that version**:
  `/pdf/<slug>/v/<n>#page=…&text=…`, which is what a reader on an earlier version copies from
  the address bar. Three parsers take only `/pdf/<slug>` today and would pass over it
  unchecked: the integrity check's `parseFragmentLinkHref`, MCP's `parseRef`, and a
  citation's `referentKind`, which calls it a link elsewhere.
  - The check and MCP read it against version n's text and labels, and don't call it stale:
    its writer named the version.
  - As a citation's referent it is a `/pdf/` referent whose pages are version n's. They ride
    in the route's query with `v=<n>`, and the route redirects to the latest as for any
    other.
- **Both cover a page link too**, `#page=5` with no `text`, which the check already reads
  (PDF_FRAGMENT_LINKS.md §8).
- **The viewer's banner**, on a link it read through a page map, offers the current form to
  copy.
- **The review warns when the candidate has no usable labels**: every `page=` link written into
  the file from then on carries a `v=`, and every citation of it takes its page as a sheet
  number. A scan from a pipeline that can write `/PageLabels` is better given them before it
  is uploaded.

**A version's number and an update id are one instance's own.** A doc copied to another
instance carries links whose `v=`, and whose dating, mean nothing there. That is left for the
work that makes docs portable between instances, which update ids need as well.

Rejected, with reasons:

- **Rewriting the page numbers in other people's bodies at promotion.** Nothing edits a body's
  text but its own writers: a renamed slug redirects rather than rewriting hrefs, and a chip's
  refreshed label is a cache beside the text. Docs, comments, annotation bodies and posts each
  have their own write path and history. And links from outside the site can't be rewritten at
  all. A batch a person runs over the bodies they may edit is a different thing (Open).
- **Reading a link without `v=` as the latest version.** A link typed by hand would then be
  right, and every older link nobody rewrote would land on the wrong page with nothing to say
  so: the viewer can't tell when a URL was written. Which bytes a link means matters most
  when a replacement exists to correct them.
- **A hash for `v=`**, the first digits of the bytes' `sha256`. It can't be read, typed or
  compared by eye, it is a second name beside the number in the address, and the same bytes
  uploaded twice give two versions one stamp. What it adds is noticing bytes other than the
  ones a link was written against, which matters only between instances (above).

### Earlier versions

- **An earlier version stays readable** at its address, with its bytes, its page text at
  every version it was extracted at, and the anchors on it.
- **`FILE_STORAGE_DIR` grows by a whole copy per version**, and a purge is the only thing that
  shrinks it.
- **Purging** a version deletes its bytes, unless another row holds them, and its page text.
  `purgeFileVersion(actor, fileId, versionId)` in `src/lib/file-manage.ts`.
  - **Its row stays**, with its number and its page map. So a `page=` link written against a
    purged version, stamped or not, still resolves through the page maps, and the byte route
    answers its hash 404, unless another version of the file holds those bytes.
  - ADMIN only, and only on a file they may manage, so a PRIVATE file is still its owners'
    alone.
  - **Refused while anything live is on that version**: a posted note that is not deleted, a
    DRAFT, or a part of a link that is not deleted, minted or not. A deleted root with a
    reply that is not deleted counts as a posted note. The refusal counts them by kind. A
    draft left behind because it couldn't be placed blocks the purge until its author
    discards it. The count is taken with the file row locked, as a capture checks its
    version, so a note made on the version can't commit beside the purge.
  - **What is soft-deleted on it stays in its table.** The version's row is still there, so
    nothing cascades. A note restored afterwards is listed with its quote and has no page to
    be drawn on.
  - Refused for the latest version and for a candidate, which is abandoned instead.
- **`scripts/upgrade-pdf-text-version.ts` works version by version**, over every version that
  has its bytes, where it works file by file today: it extracts, moves anchors and deletes
  older extractions within one version. An abandoned or purged version has no bytes to
  extract from and is skipped. A soft-deleted anchor on a purged version keeps the text
  version it names, with no page text behind it.
  - **It knows the reconciliation's items.** An item's old target is restamped with its
    anchor's, and a target proposed or placed on the candidate counts as naming its
    extraction and is moved like an anchor. Otherwise the script would delete the text a
    promotion is about to write targets against.
  - **It locks the file row for each file's writes**, as a promotion does, so it can't write
    an old target back over a promoted one.
- **Restoring an earlier version** is uploading its bytes again: an ordinary replacement.

### Rejected designs

- **A version as a row of the `file` table**, with what the bytes decide swapped between the
  two rows at promotion. Everything that reads a file then reads a version unchanged. But the
  row is a file in the table and nowhere else, and each place that means "a file" needs a
  rule for it: a slug of its own, renamed with its file's; visibility, owners and deletion
  taken from its file; a clause to leave it out of every listing of files and another to keep
  its notes in every listing of notes; a refusal in every manage operation; a title that is
  never shown. The swap needs `file_page_text`'s rows parked at negative page indexes to get
  past their own key. And a note left behind moves to another file's id.
- **A slug per version** (`book-v1`). It has to be claimed, can be taken by a real file,
  follows a rename only if every version is renamed with it, and outlives a purge only if the
  name is held for good.
- **New bytes in place on the same row, with the outgoing text moved to a side table as a
  `text[]`.** The text would need a second, unindexed home, and the new bytes couldn't be
  opened, measured or searched before they were the file's.
- **Notes on a candidate.** A reader who spots a fault in a new scan could say so on it. But
  abandoning the candidate would then either delete readers' notes or be refused while one
  stands, which lets any reader block it.
- **A candidate only its managers can read.** It needs a read rule of its own at the page,
  the download, the byte route and MCP, and a reader who knows the hash must be kept from the
  bytes. The file's list of versions marks a candidate as one, which is all a reader needs.
- **A copy of the latest version's hash, page count, labels, outline and filename on the
  `file` row**, so that the modules reading them today stay as they are. Seven columns stored
  twice, kept in step by two writers and a check, and a write that skips the rule fails
  silently until the check runs.
- **A candidate as an ordinary PRIVATE file owned by the replacer.** It appears in that
  person's `/files` and search until promotion, and it takes annotations and links like any
  file.
- **No new notes on an earlier version.** It kept every note where a reconciliation would read
  it, but it refused a reader who had chosen an older scan, and left a draft that couldn't be
  placed no way out but discarding it.

### Open

- **Moving notes forward**: carrying a note on an earlier version, left behind or made there,
  to the latest, placed as a reconciliation places an anchor. It is a later feature. Until
  it exists, such a note is drawn only on its own version, and listed on the latest's page.
- **A batch that rewrites the links in bodies its runner may edit**: `page=` to `p=`, a
  stale stamp to the latest version, or a link to a citation. It is not designed here. The
  clock above is what would let it date a link, and nothing in this plan depends on it.
- **A viewer left open across a promotion is not told.** It shows the version it loaded,
  correctly, until it is reloaded (TODO.md, "Replacing a PDF's bytes").
- **Pairing a sheet by hand, or after the promotion.** An unmapped sheet stays unmapped, and
  so does a run of sheets not accepted before the promotion. A map is read whenever a link is,
  so a later pairing would mend the `page=` links to that sheet at once. It is built when a
  file needs it.
- **A new edition rather than a new copy** (§12). Reconciliation could carry anchors into one,
  but whether an edition should replace its predecessor or stand beside it as a file of its own
  is a separate question.

### Building it

Steps 1 to 4 change no behaviour while every file has one version, so they are a pull request
of their own, which the existing suite proves before anything can be replaced. Steps 5 to 11
are a second.

The existing suite can't prove the reads by version, since a missing filter passes every test
while each file has one version. So the first pull request adds a fixture to
`e2e/db-worker.ts` that inserts a second, promoted version beside the first, with a note and a
link part on version 1, and a spec that checks what is drawn and listed at each address, the
titles and the links. The integrity check that every file has a latest version goes in with
step 1, where the column becomes nullable.

**The deploy that carries the first migration takes the PDF surfaces down for the length of
its build**, and that is accepted. `deploy/deploy.sh` migrates before it builds, so until the
new build is swapped in, the running one reads `file` and `file_page_text` by columns the
migration has moved. Its writes to a changed table fail there, on a missing column or on step
4's CHECK, so none lands wrong. A build that fails after the migration leaves those surfaces
down until one succeeds, whatever the script's message says of the live site.

1. **The schema and its migration**:
   - `file_version`, with a row numbered 1 for every file, and `file.current_version_id`
     with its foreign key on the pair;
   - the columns the bytes decide moved from `file` to that row, with the file's search
     trigger reading the filename from it;
   - `file_page_text` keyed by version, by renaming its column: a migrated version 1 has its
     file's id (Versions);
   - `file_version_id` on `annotation` and the anchor tables, filled for every row with a PDF
     target, with the foreign key on the pair. Each pair key is `ON DELETE NO ACTION`, written
     out: Prisma's default for an optional relation is `SET NULL`, which on a pair would
     null `file_id` too. A version's row goes only with its file, whose cascade takes the
     anchors;
   - the partial unique index that allows a file one candidate;
   - `file_reconciliation_item`, on the candidate's row: one nullable foreign key per kind of
     row placed, two today, with a CHECK that exactly one is set, the anchor tables' own
     pattern (CLAUDE.md, "One anchor row shape"), the anchor's old target, its outcome and
     the target proposed or placed. An item goes with its row, by cascade: a draft discarded
     after the pass.
2. **Reads by version**: every reader of the moved columns selecting them through the
   latest version, page text's functions, the two lazy writers, search's filter, and the
   count of rows holding a blob.
3. **Addresses by version**: the `/v/<n>` pages with their banner and the `/v<n>` redirect,
   the viewer's `key`, the byte route and the download's `v`, the note loaders' shared query,
   the listings' titles and links, a card's link on the bare address, the `/link/<id>`
   landing, the presence channel, MCP's `read`, and a past slug's redirect keeping the rest
   of the address.
4. **Anchor writes**: each stamps its version and checks it inside its transaction. A second
   migration then repeats step 1's fill and adds the CHECK that `file_version_id` is set
   exactly when the row holds a PDF target, which no row written between step 1 and this one
   would pass.
5. **The upload** (`PUT /api/files/<id>`) and abandoning a candidate.
6. **The page-similarity measure**, fixed against real pairs, and then the reconciliation
   pass, `src/lib/file-reconcile.ts`, rerun on demand and before promotion.
   - **A rerun keeps what a person decided.** An item accepted, placed by hand or left
     behind is changed only when its row's target has changed otherwise than in its text
     version, which the text-version script restamps. An item's row is unique per candidate,
     so two passes at once can't make two. A run of sheets that was accepted stays accepted.
   - **The pass opens each version's document once.** `extractPageItems` opens it on every
     call, so the pass takes a form that reads many pages from one open document.
7. **The review page**, with its runs of sheets.
8. **Promotion**, with its check under the lock.
9. **`v=`**: the writers, the viewer's resolution through the page maps, the cited-page
   route's, the banner, and the integrity check with its dating.
10. **The version list, purge, the page of a version that is gone, and the text-version
    script by version.**
11. **Integrity checks**, beside step 1's (every file has a latest version, which is
    promoted):
    - every version that is neither abandoned nor purged has its bytes on disk;
    - every anchor with a PDF target names a version of its file, and none names a
      candidate or an abandoned version. A live anchor on a purged version is not a fault: a
      note restored after a purge is one;
    - no `tag_anchor` or `comment_quote_anchor` row holds a `PDF_TEXT` selector on a file
      with more than one version;
    - every anchor's quote matches the page text of the version it names, where that
      version is not purged, which `check-pdf-anchors` verifies today against the file's.

**Tests.**

- **Unit**, for the pure parts: the page map (a first page removed, blank pages added, a label
  on two sheets, labels corrected, no labels, a sheet left unmapped, a run of sheets before and
  after it is accepted), the transform fit, the diff mapping of a range,
  and a `page=` link resolved through two promotions, stamped and not, from the bare address
  and from a version's own, stamped with an abandoned version, and with one the file lacks.
- **A fixture with ink and no text.** `scripts/make-test-pdf.ts` writes text operators only,
  so it gains a page that draws a filled rectangle, for rule 5 and for a rectangle selection
  on a page without text items.
- **e2e**: two fixtures from `scripts/make-test-pdf.ts`, with the same text but the second
  having its first page removed, a blank page added and one word changed. On the first, a word
  is annotated, a passage given an anchored link, a rectangle annotated and replied to, and a
  `page=` link and a `p=` link written. Then the second is uploaded as a version, one manual
  item is placed in the review, the rectangle is left behind, and the version is promoted. The
  spec checks:
  - before the promotion, `/pdf/<slug>` and `/pdf/<slug>/v/1` showing the first bytes and
    `/pdf/<slug>/v/2` the second, to a reader who can't manage the file;
  - an annotation refused on the candidate, and a note with no target written there and
    listed on every version's page;
  - a draft part of the open link on version 1, not drawn on the latest after the promotion;
  - a draft left behind, listed in its author's private notes on the latest's page;
  - after it, the highlights on `/pdf/<slug>`, and where both links land;
  - the rectangle and its reply on `/pdf/<slug>/v/1` and not on the latest, and listed in
    `/annotations` as on version 1;
  - a viewer opened before the promotion still reading the first bytes, and its capture
    refused;
  - a note posted on the latest between the review and the promotion, carried with the rest;
  - the banner's link from `/pdf/<slug>/v/1` to the latest, followed without a reload,
    showing the second bytes;
  - the rectangle's card link on the bare address landing on its entry under version 1;
  - a note made on `/pdf/<slug>/v/1` after the promotion, drawn there and not on the latest,
    and listed on the latest's page under version 1;
  - a search hit coming from the latest version's text alone;
  - the addresses following a rename of the file;
  - `/pdf/<slug>/v2` redirecting to `/pdf/<slug>/v/2`, and each version's download saved
    under its own filename;
  - a second candidate abandoned, and the next taking a new number;
  - the purge refused while the rectangle stays on version 1, and going through once it is
    deleted, with `/pdf/<slug>/v/1` then saying the version was purged, its link carrying
    `#page=` to the latest, and a `page=` link stamped `v=1` still landing.
