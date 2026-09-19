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
4. Strip soft hyphens (U+00AD) and zero-width characters.
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

When `textVersion` changes, the intended recovery is to re-anchor **lazily** on next open and
rewrite the stored `quote`/`position` if resolution succeeds — never a batch migration.
**Not built yet**: it is deferred together with §4's fuzzy match, and the quads carry every
annotation meanwhile.

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

---

## 10b. Page labels

`pdf.getPageLabels()` returns what the document prints on its pages — `["i","ii","iii","1",…]`
— or `null`. Four things about it are worth knowing before touching it:

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

Anchoring, presence and geometry all keep counting **sheets** (1-based indices). A label
never enters a computation — only a rendering. PLAN.md §19c.

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
  every anchor is keyed on one edition's `sha256` by construction (§4).
- **The Contents pane's expansion default, and remembering what a reader opened** — TODO.md,
  "The PDF Contents pane forgets its expansion state". An item with enough design in it to
  act on, so it lives there rather than here.
