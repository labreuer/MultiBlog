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
  every anchor is keyed on one edition's `sha256` by construction (§4). §13 plans versions of
  a file, with notes moved forward from one to the next; whether a different edition should
  be a version of its predecessor's file stays open.
- **The Contents pane's expansion default, and remembering what a reader opened** — TODO.md,
  "The PDF Contents pane forgets its expansion state". An item with enough design in it to
  act on, so it lives there rather than here.

---

## 13. Versions of a file — plan

**Built so far: steps 1 to 4 of "Building it".** The `file_version` table exists, every
file has its version 1, what the bytes decide is read through the latest version, and page
text is keyed by version. Every version has its own address, and what is drawn, listed,
titled and linked goes by version. Every anchor into a PDF names its version, and a capture's
write checks the version its viewer loaded. No file can gain a second version yet, so
nothing a reader sees has changed: `e2e/pdf-versions.spec.ts` gives a fixture file a second
version, and a candidate, to exercise it. The rest is a plan, and the one exception to this file's "every statement is
current". When it lands, it is rewritten as an account of what exists. §2a, §3, §4 and CLAUDE.md's "A PDF anchor
cannot drift" are then amended where they say the bytes cannot change, and so is
PDF_FRAGMENT_LINKS.md §1. CLAUDE.md's "One anchor row shape" gains the version column,
PDF_FRAGMENT_LINKS.md §2 gains `sheet=` and `v=`, and docs/PERMISSIONS.md gains rows for
uploading a version, promoting or abandoning one, building a page map, answering a run of
sheets, running the bulk carry, moving a note or marking it as staying, and showing or hiding
a move. docs/MCP.md gains the upload of a version (§5, §8). docs/DATABASE.md's data-only load
gains two lines. A file's row loaded before its versions gets a search vector without its
filename, which `check-search-index.ts --repair` refills. And `file` and `file_version` name
each other, a second pair of tables whose keys form a cycle, beside `post` and
`post_publication_event`.

Whoever may manage a file (`canUserManageFile`) may give it new bytes, which become its next
**version**. Versions are numbered from 1 and kept for good. Each stays readable, at an address
of its own, by whoever may read the file. One of them is the **latest**: the one `/pdf/<slug>`
shows, search ranks and a citation resolves on. A new note goes on whichever version its writer
is reading, the latest or an earlier one. New bytes are not writing into a PDF, so §0's
invariant 1 holds.

**Two words for a page.** A **sheet** is one of a version's pages, counted from 1. A **page**
is the one printed on it, its label. A link names a sheet with `sheet=` and a page with `p=`
(Links into the file). "Page text" and "page map" keep their names, and each is by sheet.

**Two kinds of new version.**

- **A better copy** of the same text: a new scan, or the same scan with a corrected text layer.
  The new bytes may have a different number of sheets and put the same words in different
  places. Whether a note carries is a mechanical question. Where its words are found, it
  applies.
- **A revised text**: a later draft of a paper. A sentence that survives doesn't mean a note on
  it still applies, since the author may have answered it elsewhere. Moving the note asserts
  that it does, so nothing moves without a person's judgement, and a note that no longer
  applies stays on the version it was made on.

**One operation serves both: moving a note forward.** An anchor on an earlier version is given
a target on the latest, and the latest becomes its version (Moving a note forward). A better
copy runs that in bulk, for everything that places itself. A revised text runs nothing, and
each note is moved, or not, one at a time and at any later date.

**A new version has two stages.** Moving notes is apart from both, though a promotion may
run the bulk carry:

1. **Upload**: the new bytes become the file's next version, a *candidate*, readable at once
   at its own address. Until it is promoted `/pdf/<slug>` shows what it always did.
2. **Promote**: one transaction makes the candidate the latest. Nothing holds it up. An anchor
   nobody moved stays on the version it is on, where it is still drawn, and the latest's page
   lists it under that version.

Three rules hold throughout:

- **The uploader's choice decides only what runs, and nothing stores it as a mode.** No reader
  branches on it. A reader looks at data: which version an anchor is on, and whether a page map
  has a counterpart for a sheet. Otherwise every read path gains a second behaviour that can
  fail with nothing to show it.
- **A selective move is as available after a better copy** as after a revised text, for the
  notes the bulk carry couldn't place.
- **Only decisions are stored**: the moves, the "stays here" marks, and the answers about a
  page map's runs of sheets. Where a note would go is worked out when it is asked for. So there
  is no stored proposal per anchor, nothing to rerun when an anchor or the text version
  changes, and nothing for a promotion to check under its lock.

### Versions

- **`file_version`** has one row per version of a file. It holds:
  - `file_id` and `number`;
  - what the bytes decide: `sha256`, `byte_size`, `content_type`, `page_count`,
    `page_labels`, `outline` and `filename`;
  - who uploaded it and who promoted it, with when;
  - `base_version_id`, the version that was the latest when it was uploaded, and the page
    map from that version, once one is built (Matching the pages). The base is stored, since
    it can't be worked out from the numbers once a version between two others has been
    abandoned;
  - `uploaded_at_update_id` and `promoted_at_update_id`, the highest `ydoc_update.id` when
    the row was made and when it was promoted: a clock for dating links (Links into the
    file);
  - `abandoned_at`.

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
  - **The promoted versions are a line.** A file has one candidate at a time, so a promoted
    version's base is the promoted version before it. An abandoned version hangs off the
    line at its base.
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
    is, so the latest is one of the file's own versions. Prisma takes a pair as a one-to-one
    relation only where the pair is unique on the side that holds it, so `file` gains
    `@@unique([currentVersionId, id])` (validated on 7.9, with one column of the pair
    nullable and the other not).
- **What the bytes decide leaves the `file` row.** `sha256`, `byte_size`, `content_type`,
  `page_count`, `page_labels`, `outline` and `filename` are a version's alone, and a reader
  that means the latest selects them through `current_version_id`. About forty modules read
  them from the file row today, and the compiler finds each once the columns go. It does not
  find raw SQL, which breaks only when run:
  - `scripts/integrity/check-search-index.ts` builds `file_search_vector(title, filename)`
    over `file` and keys `file_page_text` on `file_id`, for its check and its `--repair`;
  - search's two queries over `file_page_text` join on `file_id` (`src/lib/search/pdfs.ts`);
  - `fill` writes `UPDATE file SET page_labels …` (`src/lib/pdf-metadata.ts`).
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
  that file's. It is the version whose sheets the quads were measured on.
  - The column is part of the row shape the anchor tables share (`src/lib/anchors/`), beside
    the selector and outside it: a `PdfTarget` stays what the viewer measured. It is not in
    the target arc either, since a tag's target is a file and no version of it.
  - A reply has no target and so no version. It is on its root's version, is shown with its
    root, and travels with it when the root is moved. Replies nest, and `/annotations`,
    search, a reference's cited-by, mentions and a link's groups each list single rows. So
    one helper answers which version a note is on, its own or its root's at any depth, and
    every such listing goes through it.
  - **A root with no target is the file's, and has no version.** The panel's "Write an
    annotation..." makes one, and so does MCP's `add_note` without a quote. It is listed on
    every version's page, a candidate's included, and may be written from any of them, since
    no sheet of it was measured. No move touches it. A stored target that no longer parses
    is listed the same way.
  - A tag is on the whole file and has none.
  - A reference has none. It names the work, and a citation's page is resolved on the
    latest version's labels and text at every click (Links into the file).
- **A number is never reused.** An abandoned version keeps its row, without its bytes or its
  page text. The next number is one more than the file's rows. So version 3 of a file never
  comes to mean other bytes. An address is only as lasting as its slug: a deleted file's slug
  is free, and whatever takes it answers at `/pdf/<slug>/v/1` too.
- **One candidate per file**, held by a partial unique index on `file_id` where the row is
  neither promoted nor abandoned. An upload while one stands is refused, naming it, until it
  is promoted or abandoned. A soft-deleted file takes none, and neither does a file that is
  not a PDF.
- **Whoever may read the file may read every version of it**: the candidate, the latest and
  the earlier ones. A version has no visibility, owners or deletion of its own, so there is
  no second read rule to keep in step with the file's. Uploading a version, promoting or
  abandoning it, building its page map, answering a run of sheets and running the bulk carry
  take `canUserManageFile`. Uploading a version is also open to a bot whose person manages
  the file (The upload). Moving one note is its author's alone (Moving a note forward).
- **A new note or link part goes on the version it was made on**: the latest, or an earlier
  version from its own address.
  - **A candidate takes none**, since abandoning it removes the sheets the anchor was
    measured on. Nothing is kept against a candidate but its page map.
  - **A note on an earlier version stays there until it is moved.** It is drawn at its
    version's address and listed wherever a note is (Addresses), and every other version's
    page lists it under its version.
  - **A capture names the version its viewer loaded and the address it loaded it from**, and
    the write checks them inside the transaction that inserts, with the file row locked: a
    posted note, a draft opened on a selection, a part added to a link, and MCP's
    `anchorPdfQuote`.
    - **From `/pdf/<slug>`, the version must still be `current_version_id`.** A viewer left
      open there across a promotion still shows the old bytes and isn't told, and its writer
      means the latest. Its capture is refused with a reload message, as the schema gate
      refuses a stale tab, rather than landing on an earlier version unseen.
    - **From `/pdf/<slug>/v/<n>`, the version must be promoted.** Its page names its version
      in its title, whatever the version's state (Addresses). A candidate isn't promoted,
      and neither is an abandoned one, so a tab left open on a candidate across its
      abandoning is refused too. Its page text is gone, and the capture would otherwise keep
      the quads and drop the quote.
    - **A target given to a note being moved is not a capture.** It takes the checks of a
      move (Moving a note forward, "Writing a move").

### Addresses

- **`/pdf/<slug>` shows the latest version. `/pdf/<slug>/v/<n>` shows version n, whatever
  its state**: a candidate, the latest or an earlier one. It never redirects to the bare
  address, so a link to version 2 still shows version 2 after version 3 is promoted.
  `/pdf/<slug>/v<n>` redirects to it.
- **The page of a version that is not the latest says so in a banner**: which version it is,
  when it and the latest were uploaded, and the time between them in the largest unit that
  fits (years, months, days, hours, minutes or seconds), rounded to the nearest, with a link
  to the latest. On an earlier version it adds that a note made there is on that version
  until it is moved forward, by its author or by a bulk carry, and that its author may mark it
  as staying. A candidate's banner says it is not yet the latest.
- **`/files/<slug>/v/<n>`** is a version's download page, and `…/download` its download. A
  download is saved under the version's own `filename`, so two versions uploaded as
  `book.pdf` both save as `book.pdf`. The download redirects to the byte URL with `&v=<n>`,
  and the route takes the filename from that version once it has checked that the version
  holds the hash. Without `v`, the newest version holding the hash names the download. So
  the same bytes uploaded twice under two names each save under their own.
- **The byte route serves the hash its URL names** (`/api/files/<id>/<sha256>`) when a
  version of the file that is not abandoned holds those bytes, `immutable`. Any other hash
  answers 404, where today it gets the current bytes. So a viewer open on one version reads
  that version's bytes for as long as it is open, never splicing another's in by range.
- **A version has no slug.** A renamed file's old slug redirects as it does today, and the
  redirect keeps the rest of the address: `/pdf/book/v/1` goes to `/pdf/barfield/v/1`. A file
  restored as `book-2` has `/pdf/book-2/v/1`.
- **An abandoned version's address answers with a page that says so**, to whoever may read
  the file: which version it was, that it was abandoned and when, and a link to the latest. A
  number the file never had answers 404.
  - **The link carries the fragment over.** `/pdf/book/v/2#sheet=49` offers
    `/pdf/book#sheet=49&v=2`, which the latest's viewer resolves as it does any link that
    names an abandoned version (Links into the file). The server never sees a fragment, so a
    client component completes the link.
  - MCP's `read` of such an address answers the same: the version is gone, and where the
    latest is.
- **The viewer is mounted per version.** `PdfSurfaceClient`'s `key` is the version's id, where
  it is the file's today. A client navigation between two versions of one file (the banner's
  link to the latest, the version list, a link's parts on two versions, a link sent to the
  version it names) then mounts a new surface. Keyed on the file, the old surface would stay,
  with one version's viewer, ready flag and once-only jump on the other's page.
- **A version that is not the latest is called `<title>, version <n>`**, on its page and
  wherever a note on it is listed: `/annotations`, search, a reference's cited-by, mentions,
  MCP's threads and a link's groups. Each links the note at `/pdf/<slug>/v/<n>`, and so does
  the email sent when a note is raised. About twenty-five places build such a link from a
  template string today, and the compiler finds none of them, so they move to one helper that
  takes the version. One that is missed lands on the note's entry and not its card (below).
- **A version's own address always names its version**, the latest's included. The page at
  `/pdf/<slug>/v/<n>` is titled `<title>, version <n>` whatever the version's state, and
  says "the latest" beside it while it is. A tab left open there across a promotion writes
  its notes on the version it shows (Versions), and its title has said which. The bare
  address names none, which is why a capture from it is refused instead.
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
- **An anchor nobody moved is never drawn over the wrong ink.** It keeps its target and its
  version, and is drawn on that version's sheets, where its quads are still right. That
  matters most for a rectangle selection, which the viewer can never report as orphaned (§4:
  it has no quote to check).
- **What is listed is the file's.** Every version's page lists the file's notes that are on
  other versions, under the version each is on. Each entry links the note at its own version
  (`/pdf/<slug>/v/<n>#<card>`), and carries its card's fragment id and its replies'.
  - **A card's link finds its note from any address of the file.** `/pdf/<slug>#<card>` is
    what `/annotations`, MCP's answers and every body written before a second version hold,
    and `/pdf/<slug>/v/<n>#<card>` what an email sent before a note was moved holds. Either
    lands on the card where the note is on the version shown, and on its entry otherwise.
    MCP's `read` of a card's URL answers the thread on whichever version holds it, and names
    that version.
  - **The viewer's own drafts** ("Your private notes") are listed on every version's page,
    each naming the version it is on and linking there, so a draft on an earlier version is
    on the page its author opens.
  - **The viewer's own notes on earlier versions are their worklist**, with what moves them
    (Moving a note forward).
  - **MCP's threads on the bare address** answer the latest version's and then those on other
    versions, each naming its version, as the page does. Filtered to the latest alone, a
    RAISED note on version 1 would leave the reply queue. On a version's own address they
    answer that version's.
- **`PdfMetadataPanel` lists the versions**, each with its state, who uploaded it and when,
  who promoted it and when, a download link and a link to its page. To whoever may manage the
  file it also gives the upload, a candidate's promotion and abandoning, a link to each
  version's map page, and the bulk carry, with the number of posted notes still on each
  earlier version. Versions are in no listing of files, since they are not files.
- **MCP's `read` takes `/pdf/<slug>/v/<n>`**, and the latest without it. Its byte route
  (`/api/mcp/files/<id>`) takes no hash. It serves the latest version's bytes, and with
  `?v=<n>` that version's.
  - **A fragment in the URL is read by the viewer's rules** (Links into the file): an
    unstamped `#sheet=50` on the bare address is the first version's sheet, carried to the
    latest. The tool's own `sheet` argument is a sheet of the version read. The two can be
    the same number and different sheets, so the answer names what it read in its stamped
    form. A fragment that can't be carried is answered on the version it names, and the
    answer says so.
  - **`add_note`, `create_link` and search's `within` take a version's address** as `read`
    does. A note or a part on a candidate is refused, as from the viewer.
- **The presence channel is per version** (`ydocIdForFile` gains the version), so a reader
  following a presenter is never led to a sheet of other bytes.

### The upload

`PUT /api/files/<id>?filename=…`, a Route Handler for the upload's reasons (§2a), sent through
`FileUploader`'s streaming with its 413 and severed-connection messages. It runs
`stageUpload`, extracts as any upload does, and makes the version row with its page text. It
refuses anything but a PDF. `stageUpload` checks only the uploader's role today, so the file's
own checks come before the body is read: `canUserManageFile`, the file not deleted, and no
candidate standing.

**MCP uploads a version through its own byte route**, `POST
/api/mcp/files?versionOf=<file id>&filename=…`. The `upload` tool answers that URL when it is
given the file's address. Both routes are wrappers around one function in
`src/lib/file-ingest.ts` that takes an `Actor` (CLAUDE.md, "A write the UI and the MCP server
share"), so the checks are the same ones.

- **A bot may upload a version of a file the person it works for manages**, as well as of one
  it manages itself. `canUserManageFile` is asked a second time with the person's id and the
  bot's own role (`user.works_for_user_id`, PERMISSIONS.md "Bots"). So the bot borrows its
  person's place among the file's owners and not their role, and a bot's token still acts
  with the bot's role: `stageUpload`'s role check is the bot's own, and a bot never outranks
  its person. Otherwise a file its person uploaded in the browser would refuse the bot that
  corrected its text. The rule is this upload's alone, and nothing else a manager does
  passes to a bot by it.
- **It answers the candidate's address and number**, or "unchanged".
- **`title`, `issuerOnly` and `duplicate` are a new file's**, and are refused beside
  `versionOf`.
- **A repeat is keyed as any upload's is**, on the bytes' hash and the parameters
  (MCP.md §5). A retry answers the candidate the first request made, where it would otherwise
  be refused for the candidate standing.
- **It makes a candidate and nothing more.** It builds no map and promotes nothing. Saying
  that two versions hold the same text, and making one the latest, stay a person's acts on
  the candidate's page (Open).

What follows holds through either route, but for the first, which is the uploader's page
alone: MCP's upload is asked for no kind and asks for no map.

- **The uploader says which kind of new version it is.** For a better copy the uploader's
  page asks for the page map as soon as the upload has answered (Matching the pages), so the
  candidate's page can show what would carry. For a revised text nothing more runs. The
  answer itself is not stored. What is there afterwards is a candidate with a page map or one
  without, and a manager may ask for the map later, on the version's map page. The map is a
  request of its own either way, since building one can take longer than an upload should
  wait.
- **Bytes identical to the latest version's** answer "unchanged" and write nothing.
- **Bytes identical to an earlier version's, or to another file's,** make a version as any
  others do, sharing the blob on disk. Going back to an earlier scan is therefore an ordinary
  new version.
- **MCP's upload of bytes a readable file already holds** (`recordUpload`'s `reuseReadable`)
  answers with that file only where its latest version holds them. Bytes that only an earlier
  version holds make a new file, since the file found would show other bytes.
- **Whether bytes are still referenced** is counted over `file_version` rows that hold them,
  where `discardStagedUpload` and `deleteBytesIfUnreferenced`'s other callers count `file`
  rows today.
- **The candidate's page shows its managers what a promotion would do**, beside the banner
  every reader gets:
  - **the page map**, where it has one, in numbers: sheets paired, removed and unmapped, and
    the runs of sheets with a question open, with a link to where they are answered
    (Matching the pages);
  - **what would carry**, where it has a map, worked out when it is asked for and not
    stored: how many posted notes and link parts place themselves, from which versions, and
    which would stay. Without a map the page offers to build one;
  - **a warning when the candidate has no usable labels**: every citation of the file takes
    its page as a sheet number of the latest version (Links into the file). A scan from a
    pipeline that can write `/PageLabels` is better given them before it is uploaded;
  - **a warning when either version has no usable labels and citations already name a page
    of the file.** A version that moves the sheets misdirects them. It counts the citations
    in bodies the manager may read;
  - **Promote** and **Abandon**, and **Promote with the carry** where the candidate has a
    page map. Without one the carry is not offered: whoever said "a revised text" at the
    upload is then two deliberate acts from moving everyone's notes, not one click.
- **Abandoning** a candidate marks its row, and deletes its page text and its bytes, unless
  another row holds them. The row keeps its labels and its page map, so a link written
  against it can still find its sheet (Links into the file), and its address says where the
  latest is (Addresses).
  - **The delete and an upload take one lock on the hash**, an advisory lock held to the end
    of its transaction, as a slug's claim is (`lockFileSlug`). An upload that finds its bytes
    on disk keeps them and stores nothing (`storeUploadStream`'s `deduped`). So the same file
    uploaded again beside the abandoning, which is how a wrong choice at the upload is put
    right, could otherwise make a row whose bytes the abandoning has just removed.
    - **An upload takes it in the transaction that inserts its row**, a file's first version
      or a later one, and checks there that the blob is on disk. `storeUploadStream` decides
      `deduped` with no database, seconds before the row is written, so the lock can't be
      held from that decision. An upload whose blob is gone by then is refused, to be sent
      again.
    - **The abandoning counts the other rows holding the hash and removes the blob before it
      commits**, still holding the lock. Removed after the commit, the blob could go from
      under a row an upload has just written. A commit that fails after the removal leaves a
      candidate without bytes, which the integrity check reports (Building it) and a second
      abandoning clears.
    - **`discardStagedUpload` counts and removes under the same lock**, where it does both
      unlocked today.
  - **Promoting and abandoning name the version**, and check under the file row's lock that
    it is still the candidate. Otherwise a manager's click lands on a candidate another
    manager uploaded since, which they never saw.
- **A candidate waits with its file.** Deleting the file leaves the candidate as it is.
  Promoting and abandoning are refused while the file is deleted.

### Matching the pages

A **page map** is between a version and its base. It gives each sheet of the base a sheet of
the version, or none. One sheet pairs with one sheet: no two sheets of the base share a
counterpart. The map is one JSON value on the version's row, and is read in both directions.
It records who stored it and when, and the carry that did, where one did.

**A map is stored by a deliberate act, and once**:

- the upload of a better copy;
- a manager's asking for it, on a candidate's page or on the map page of any version that
  has none (`/pdf/<slug>/v/<n>/map`, open to whoever may manage the file);
- a bulk carry that is run, for each version on its way that has none (Moving a note
  forward).

A version uploaded as a revised text has no map until one of the last two happens. A look at
what a carry would do stores none: it works on maps it builds and throws away.

- **Storing a map says the two versions hold the same text.** It moves no note. What it
  changes at once is where links land: a link that names one of the two versions is carried
  to the other from then on, and no longer opens the version it names (Links into the file).
  The page that offers to build one says so.
- **It is written only where the version has none**, with the file row locked, so two
  requests can't each store one. A later carry reads the map as it stands, with the answers
  its runs have been given. Nothing rebuilds one or takes one away (Open).

It is built from each version's stored page text, at the current text version where the
version has it and at the greatest it has otherwise, as the fragment check reads (a skeleton
barely depends on the text version). Only a sheet without text has its document opened, for
rules 4 and 5. It is built in order of trust:

1. **By label**, where both versions have usable labels (`usablePageLabels`). Each sheet maps
   to the sheet with the same label, each version's own labels read as a `p=` reads them
   (`sheetsLabelled`). A label on several sheets maps the k-th sheet carrying it in the base
   to the k-th in the version, when both have the same number of sheets with that label.
   **A sheet the labels give no one counterpart goes on to rules 3 to 5**: one whose own
   label is empty, which has none to match by, as for `p=` (PDF_FRAGMENT_LINKS.md §2, "Which
   sheet"); one whose label no sheet of the version carries; and one whose label the two
   versions carry on different numbers of sheets. The labels say nothing there, so the text's
   answer is taken without a question.
2. **Checked by text.** Where both sheets have text, a label's answer stands only if the two
   sheets' skeletons (PDF_FRAGMENT_LINKS.md §4) largely agree. Where they disagree neither
   answer is taken, since the new version may exist to correct the labels: the sheet is left
   unmapped, and rule 3's alignment proposes its counterpart for a person to accept (A run of
   sheets, below).
   - **A sheet without text is checked by its neighbours.** It keeps its label's answer where
     the nearest sheets with text before it and after it both kept theirs. Where either lost
     it, the sheet joins that run, and the alignment proposes its place by rule 5. Otherwise
     one plate in a stretch of shifted labels would keep a wrong answer and split the run in
     two.
3. **By text**, where labels can't decide: a version without them, with them on one side
   only, or a sheet rule 1 passes on. The two sequences of sheets are aligned as a diff
   aligns lines, on the similarity of their skeletons. A sheet takes the alignment's
   counterpart unless a label has already given that sheet to another.
4. **Blank sheets** have no text and draw nothing, so a blank sheet added is a known insertion
   and a blank sheet removed a known deletion. "Draws nothing" is read from pdfjs's operator
   list, which holds no painting operator for such a sheet. Nothing on the server asks for one
   today, so `src/lib/pdf-extract.ts` gains that read. A blank sheet in a scan usually still
   paints the scan's image, so it is a sheet with ink and no text, under rule 5.
   - **The read opens the document with `wasmUrl`**, which the server's `openPdf` doesn't pass
     today. Without it JBIG2 and JPEG 2000 images fail to decode on the server ("JBig2 failed
     to initialize", measured on two scans). pdfjs adds an image *mask*'s operator only once
     the mask has decoded, and drops one that fails with a warning. So a sheet whose only ink
     is a JBIG2 mask would read as drawing nothing, and be taken for a blank one.
   - **A sheet with an image that failed to decode counts as ink**, whatever its operator
     list holds, and the measurement below includes a scan whose sheets are JBIG2 masks.
5. **Sheets with ink but no text**, such as plates, figures and image-only scans, are placed
   between their aligned neighbours when the run between them has the same length in both
   versions. Otherwise they are left unmapped.
6. **By position, for a person to accept.** A sheet with text that no rule above pairs is
   proposed the sheet at its place, where rule 5 would put a sheet without text: between its
   aligned neighbours, the run between them the same length in both versions. Its text is too
   unlike that sheet's for the map to pair them unasked: a sheet whose text layer was rebuilt
   from nothing in a corrected scan, or a page rewritten in a draft that kept its pagination.
   The proposal is a question (A run of sheets, below), and without it such a sheet could
   never be mapped.

**A sheet without a counterpart is removed or unmapped**, and the map records which.

- **Removed** is what the alignment decides when nothing stands in the sheet's place: the
  nearest paired sheets before and after it have counterparts that are neighbours in the
  version. At either end of the base, the paired sheet on its one side has its counterpart
  at that end of the version. A blank sheet with no counterpart is removed wherever it stood
  (rule 4).
- **Unmapped** is every other sheet no rule could place, and every sheet with a proposal
  nobody has accepted: sheets of the version stand where it stood, and none of them is known
  to be it. A sheet of a revised text whose words now run over two
  sheets is unmapped, since neither is its counterpart (Open).
- **Only the map's page and a candidate's numbers say which a sheet is.** A reader whose link
  couldn't be carried is not told.
- **Either costs the same two things**, and holds up nothing. A link to the sheet is not
  carried, unless it has words that are found elsewhere (Links into the file). And no anchor
  on it is placed by its sheet (Placing each anchor).

Nothing pairs such a sheet by hand (Open).

**A run of sheets** is what a person is asked about, never one sheet. There are two
questions, and consecutive sheets with the same one are one run:

- **whether to pair the sheets as the text does, where the labels pair them otherwise**
  (rule 2). Whenever rule 2 finds a disagreement, rule 3's alignment is made over the whole
  of both versions, and it gives each sheet of the run the counterpart proposed for it;
- **whether to pair the sheets by their place, where their text is too unlike to say**
  (rule 6). The page shows each sheet's text beside the one proposed, and says where a label
  agrees with the place.

What follows holds for both:

- **For example**, a scan whose labels start one sheet late has printed page 1 on sheet 11
  and the label `1` on sheet 12. Its better copy is the same 311 sheets with the labels
  corrected. By label, sheet 12 goes to sheet 11 and every numbered sheet after it goes back
  one, and each pair's text disagrees. The alignment pairs every sheet with itself. Sheets 12
  to 311 are one run, accepted in one act where sheet by sheet would take three hundred.
- **The question is asked of whoever may manage the file.** It is on the version's map page,
  which shows the run once: for the first question, the sheets the labels give beside those
  the alignment gives. The version list links there and counts the questions open.
- **Any manager may answer at any time**: while the version is a candidate, and after its
  promotion, which closes nothing.
- **Until one accepts, the run's sheets are unmapped.** The proposal is kept in the map beside
  each sheet, marked as not accepted, and the map's readers treat such a sheet as unmapped.
  Declining leaves them so and takes the question off the list of open ones. A declined run
  may still be accepted later.
- **Accepting writes the proposed sheets into the map**, and stays: an accepted run is not
  declined afterwards, since notes and links have gone through it. A sheet inside a stretch
  of shifted labels that the alignment gives no counterpart is asked about by its place, as
  a run of the second kind, or stays unmapped where rule 6 proposes nothing.
- **An answer is written with the file row locked**, onto the map as it then reads. The map
  is one value, so two managers answering two runs would otherwise each write the whole of
  it, and one answer would be lost.
- **Accepting moves no note.** Where the version is promoted and page maps join it to the
  latest, the page then shows which notes on those sheets would now place themselves, and
  the manager approves that carry or leaves it. Approved, it is written as any bulk carry
  is. On a candidate there is nothing to carry yet, and its promotion's carry reads the map
  as answered.

**How alike two sheets must be** is one measure, which rules 2 and 3 share. It and its
threshold are settled by measurement before a map is built.

- **Two sheets are alike when each holds the other's words**, not when one holds the other's
  among more. So a sheet of a reflowed draft is not paired with the sheet that took most of
  its words.
- **It is measured on three pairs**: a scan before and after its text layer is corrected,
  where every sheet should pair with itself; two scans of one book; and two drafts of a paper,
  where a sheet that reflowed should come out unmapped and one that didn't should pair.

A map stays on its version's row for good, an abandoned version's included: links are resolved
through it (Links into the file). The answers given about an abandoned candidate's runs are
that map's own, and the next candidate's map asks again (Open).

### Placing each anchor

Two kinds of row point into a file with a `PdfTarget` today:

- an annotation's `pdfTarget`, with its `quotedText`;
- an `anchored_link_anchor`'s `PDF_TEXT` selector, with its `quoted_text`.

`tag_anchor` and `comment_quote_anchor` have the same row shape and no such row. A tag is on a
whole file (TAGS.md), by the file's id, and needs nothing. A comment's quotation of a file is
refused (`canQuoteTargetInto`). Each joins the two above when it gains a writer. Until then a
`PDF_TEXT` row in either would stay on its version with nothing to move it, and the integrity
check reports one (Building it). `scripts/upgrade-pdf-text-version.ts` already reads all four
tables.

**The placing rules answer one question**: where an anchor on one version would go on a later
one. They start from where the anchor is now, its version and the target it has there, so a
note placed by hand on one version is looked for on the next by the quote and the sheet it
was given. The *mapped sheet* is its sheet's counterpart through every page map between the
two versions. It has none where a map on the way is missing, or leaves the sheet removed or
unmapped. The answer is one of three, and it is used twice: the bulk carry acts on the first
alone, and a suggestion shows whichever came out (Moving a note forward).

**It places itself** by the first of these that holds, tried in this order:

- **the quote is found once on the mapped sheet**, by skeleton.
  - **A tie is broken by its `prefix` and `suffix`.** An occurrence *agrees* with them when
    the text before it ends in the prefix's skeleton and the text after it begins with the
    suffix's, an empty one agreeing with anything. One occurrence on the sheet is found once,
    whatever stands around it. Of several, the one that agrees is the quote, where exactly one
    does. No occurrence agreeing, or more than one, is "found more than once".
- **the quote is found exactly once in the whole version, and that occurrence agrees** with
  its `prefix` and `suffix`. This holds on whatever sheet, mapped or not, and so for an
  anchor on a removed or unmapped sheet. An anchor whose `prefix` and `suffix` are both
  empty, a quote that was the whole of its sheet's text, has nothing to agree with here, and
  gets a proposal.
- **its words were corrected on the mapped sheet.** The quote is not there, and its old range is
  carried through a diff of the two sheets' text (`diffText` over `tokenizeFine`'s tokens,
  `src/lib/diff.ts`). The earlier sheet is read at the text version the anchor names, which its
  offsets are into and which the text-version script keeps for it. It places itself where both
  ends of the range come through at a word boundary: each end in text the two sheets share, or
  in a run the diff replaces word for word. The quote is then derived anew from the later
  version's text, so "modem" becomes "modern". How much of a range may change is settled with
  the measure above.
- **it has no words, and the ink has not moved.** A rectangle selection is a target whose
  `position` is null. A text selection whose quote the capture dropped
  (`capturePdfTextAnchor`, on a mismatch) has a position and an empty quote, and is carried as
  a rectangle is, written with its `position` null: its offsets were into the earlier
  version's page text. Either places itself, its quads unchanged, when the mapped sheet has
  the same page box and rotation and a transform fitted to the text items the two sheets
  share is the identity, within a tolerance settled with the measure above. A text layer
  that was corrected moves its items a little and the ink not at all.

The new target is measured on the later version's sheet as MCP measures one (MCP.md §8,
`anchorPdfQuote`'s pipeline):

- quads from `quadsForRange` over that sheet's text items;
- `position` and quote derived by `capturePdfTextAnchor`;
- `textVersion` the current one.

Where the server can't measure it, the anchor has no place: the sheet's text items don't
reproduce its stored page text, or the range covers no glyph, which is where `anchorPdfQuote`
refuses today.

**It has a proposal**, which only a person's acceptance makes a move:

- the quote found once in the version, where its `prefix` and `suffix` don't agree or are
  both empty;
- the quote found several times in the version, where exactly one occurrence agrees with
  them;
- the quote's words changed, and the diff carries the range less cleanly than above. The
  suggestion shows the old quote beside the new;
- a rectangle selection whose sheet moved: its quads are carried by the fitted transform,
  when the fit is close;
- a rectangle selection on a sheet with no text items, a plate or an image-only scan: its
  quads unchanged, when the page box and rotation agree. Nothing on such a sheet says whether
  the ink sits where it did.

**It has no place**: the quote isn't found, is found more than once, or now crosses a break
between sheets, which one target can't hold; or a rectangle has no mapped sheet, its transform
doesn't fit, or its sheet has no text and a different box. A person places such a note by
hand, or leaves it.

**In a revised text these answers are suggestions and nothing more.** No rule above is
switched off for one, since no reader branches on the kind of version. What differs is that
no bulk carry is run, so each answer goes to the note's author, and a match of the words is
never more than a suggestion to them. Without a page map there is no mapped sheet either, so
a suggestion there comes from the quote being found in the whole version.

### Moving a note forward

A move gives an anchor on an earlier version a target on a later one and makes that version
its own. "Note" below stands for both kinds of row that hold a PDF target: an annotation, and a
part of an anchored link, whose author is the link's creator. A reply has no target and
travels with its root.

| Act | Who may |
|---|---|
| Run the bulk carry, and show or hide a carry's moves together | Whoever may manage the file |
| Move one note, mark it as staying or take the mark off, and show or hide any move of it | The note's author. For a note a bot wrote, also the person the bot works for (`user.works_for_user_id`; a bot works for exactly one person, PERMISSIONS.md "Bots") |

A bot given to another person takes its notes to them. A manager of the file who is neither
moves nobody's note one at a time, and neither does an ADMIN: no role curates other people's
notes (Open). Whoever moves a note must be able to read the file. So a note whose author is
gone, or can no longer read the file, is moved by a carry or not at all, and so is a bot's
note once the person it worked for is deleted.

**Forward only, and to the latest version only.** Nothing moves a note to an earlier version,
and nothing offers a destination but the latest.

**The bulk carry** moves forward everything that places itself.

- **It is an action.** A candidate with a page map offers it, and its promotion runs it when
  asked to (Promotion). It stays available afterwards in the version list, for what is still
  on an earlier version.
- **Whoever may manage the file runs it**, and it moves everyone's posted notes and the parts
  of everyone's minted links. Otherwise a corrected scan would leave every other author's
  notes behind until each of them acted.
- **It moves nothing else.** Each of these stays on its version, and its author moves it as
  any other note, a deleted one once it is restored:
  - a DRAFT, its runner's own included;
  - a soft-deleted note, and a part of a deleted link. A deleted root with a reply that is
    not deleted counts as posted and is moved, since its thread is still listed and nobody
    else could move the replies;
  - a part of a link that is open in its creator's tray, not yet minted or reopened for
    editing, since the tray holds its parts as it loaded them;
  - a note its author has marked "stays here".
- **It takes the notes on every earlier version that page maps join to the latest without a
  break.** A version followed by one without a map ends the chain: a revised text followed
  it, and what is on it or before it waits for its authors.
  - **At a promotion** it is offered only where the candidate has a map, and builds none.
  - **From the version list** a manager starts it on one earlier version, and it first builds
    the map of every version from there forward that has none. Starting it on a version that
    a revised text followed is that manager's judgement that the two hold the same text after
    all. It shows what would carry before it stores a map or moves a note, as a candidate's
    page does, since nothing in the app undoes either (The history of moves, below).
- **What it moves is what places itself** (Placing each anchor), each to the place those
  rules give. Everything else stays where it is, for its author's worklist.
- **Its moves are hidden by default** (The history of moves, below).
- **Run again, it moves what places itself by then**: a note posted on an earlier version
  since, one that a run of sheets accepted since now reaches, one whose author took the mark
  off, and one an earlier carry skipped. It answers with what it did: how many it moved, how
  many stayed on each version, and how many it skipped.
- **It changes nothing else on a row**: not a note's `editedAt`, and not a link's.

**A selective move** is one note, moved by a person who judges that it still applies.

- **Where a note would go is worked out when it is asked for.** The placing rules run for the
  viewer's notes against the latest version when their worklist is opened, each starting from
  where the note is now. Their answer is a suggestion, whether the rules say the note places
  itself or has a proposal. It shows the passage on the note's version beside the one on the
  latest, and how it was found: on the matching sheet, once elsewhere, with its words changed.
- **The author does one of three things**:
  - **accepts** the suggestion;
  - **places** the note by selecting text or drawing a rectangle on the latest, as an
    annotation is captured, where there is no suggestion or it is wrong;
  - **marks the note as staying.**
- **Its move is shown by default.**
- **The page then loads its notes again**, through `loadPdfAnnotationEntries` or a full
  reload, as it does after a carry from the version list or from an accepted run of sheets.
  A `router.refresh()` alone is lost behind the viewer's `ssr: false` (CLAUDE.md).
- **A moved part of the open link reloads the tray's store too.** The store holds its parts
  as it loaded them, each with its version, and the surface draws a part by that version.
  Left as it was, the store would keep the part off the latest's sheets until a reload.

**The worklist** is "my notes on earlier versions": the viewer's notes and link parts, and
those of the bots that work for them, on any version but the latest, less the ones marked as
staying. Drafts and the parts of an open link are in it, and replies are not, since each
travels with its root. It is on the latest version's page, as the viewer's own part of the
list of notes on other versions (Addresses), and it is a filter in `/annotations`. Nothing is
emailed.

**"Stays here" is the author's mark on their own note**: it has been looked at, and it belongs
on its version. Without the mark, a note kept on a first draft on purpose looks the same as
one nobody has looked at, and no worklist ever empties.

- **It is offered only on a note that has a later version to go to**: in the worklist, and
  on the author's own card on an earlier version's page, so a note posted from an earlier
  version's address can be marked as soon as it is posted. A note on the latest has nothing
  to stay behind from, and takes no mark in advance.
- **The mark holds when a later version arrives**, so the note is not asked about again, and
  no bulk carry moves it.
- **Its author may take it off**, which puts the note back in their worklist and in a carry's
  reach. Moving the note takes it off too.
- **It is written with the file row locked**, on the version the note is then on, and
  refused where that is the latest. A carry's write refuses a marked row (below), so a mark
  made while a carry was working out its placements holds.

**Writing a move** is one transaction with the file row locked, for one note or for a carry's
hundreds. Working out where each note goes comes first and outside it, since that reads a
version's sheets and takes seconds: each version's document is opened once and each sheet read
once.

- **Three checks are the file's, and are made once**: the destination is a promoted version
  later than every version the notes are on; the mover may make the move; and the destination
  has page text at the text version the new targets name.
- **The fourth is each note's, and is the write's own condition.** One `UPDATE` for each anchor
  table takes the whole batch as one parameter. It sets a row's target, quote and version where
  the row is still on the version, and at the target, its placement was worked out from, and it
  returns the rows it changed. A carry's condition adds that the row has no "stays here"
  mark. A difference in text version alone passes, since the text-version script restamps
  only a sheet that reads the same. One `INSERT` then writes the history of the rows
  returned, and for a selective move one `DELETE` takes their "stays here" marks. All are raw
  SQL: Prisma has no update that sets different values on different rows. A carry of any size
  is a handful of statements, and one of several thousand notes splits its parameter inside
  the one transaction.
- **The quote is derived on the server**, from the destination's page text, for a note placed
  by hand as for any other (§4).
- **A row not returned was skipped**: moved from another tab, or by a carry that got there
  first. A bulk carry counts it, and the next carry takes it. A selective move shows a fresh
  suggestion.
- **The destination need not still be the latest.** A person's decision made against a version
  that was the latest when they made it is written to that version, where a refusal would
  discard their work. The note is then on an earlier version again, and its next suggestion
  starts from where they put it. So a target given by hand is checked as a move is, and not
  as a capture from `/pdf/<slug>` is (Versions).
- **Nothing is staged.** Each decision is written as it is made, and a placement the app worked
  out and couldn't write is worked out again. So nothing is decided against a candidate
  (Open).

**The history of moves.** A note has one location, the newest version it was moved to. Each
move is a row of `file_anchor_move`:

- the row moved: one nullable foreign key per kind, two today, with a CHECK that exactly one
  is set, the anchor tables' own pattern (CLAUDE.md, "One anchor row shape"). The row goes
  with its anchor, by cascade;
- the version it left and the target it had there, with its quote;
- the version it reached. The target it reached is not kept: the note holds it, and a later
  move's row records it as the one left;
- who moved it, and when. A deleted user's id is set to NULL, and the row stays;
- the carry it was part of, an id its rows share, or none for a selective move;
- whether the note was marked "stays here" when it was moved, which only a selective move
  can find;
- whether the move is hidden.

A row's id is from a sequence, and "an anchor's newest move" is by that id, never by time.

**A "stays here" mark is a row of the same table that reaches no version**: the anchor, the
version it stays on, who marked it and when. It is there while the mark holds, and a partial
unique index allows an anchor one. So no anchor table gains a column for it, and a new kind
of anchor costs this table one column.

**A shown move appears in two places**: on the note's card, which says which version it was
moved from, and who moved it where that is not its author; and on the note's entry on the page
of the version it left, as "moved to version n". A hidden move appears in neither, and the
note is listed there as any note on another version is. That suits a corrected scan, where the
move tells a reader nothing.

- **The flag is on each move**, so a carry that turns out to be mistaken can be shown.
  Whoever may manage the file shows or hides the moves of one carry together, by its id. A
  note's author shows or hides any move of their own note, a carry's included.

**The table holds what an undo needs.** Nothing in this plan undoes a move (Open), and a
mistaken carry has to be undoable from the database all the same. A move changes three things
on its anchor, the target, the quote and the version, and its row keeps all three as they
were.

- **To undo a move**: where the row is its anchor's newest and the anchor is on the version
  the row reached, write the three back and delete the row. Where the row says the note was
  marked, write the mark back. A carry is undone by its id.
- **Newest first.** A move that is not its anchor's newest can't be undone until the ones
  after it are. The target a move reached is not needed for that check, since on a version
  only a move changes where an anchor is.
- **The kept target is true as it stands**: its sheet, its quads and its quote, since a
  version's bytes never change. Its offsets and its text version may name an extraction the
  text-version script has deleted since. The undo finds them again from the quote, on that
  sheet at the current text version, or the integrity check would report the anchor.
- **A page map records how it came to be stored**: who stored it and when, and the carry
  that did, where one did. So undoing a carry can also take away the maps it stored, and the
  links that were carried through them open the version they name again. A map with an
  accepted run loses that answer with it.
- **Step 11's tests replay a carry backwards in SQL**, and compare every anchor's row with
  what it was before the carry.

### Promotion

`promoteFileVersion(actor, versionId, { carry })` in `src/lib/file-manage.ts`, so an MCP front
door, if one is wanted, is a wrapper (CLAUDE.md, "A write the UI and the MCP server share"). The
carry and the move are functions of that kind too. It is refused where the version is no longer
the file's candidate or the file is deleted, and by nothing else: no note, no unmapped sheet and
no run of sheets left unanswered holds it up.

The carry is taken only where the candidate has a page map, and asking for it without one is
refused. With it, the placements are worked out before the transaction. Then one transaction,
the file row locked:

1. **`current_version_id` becomes the candidate.**
2. **The candidate's row records who promoted it and when**, and `promoted_at_update_id`, the
   highest `ydoc_update.id` at that moment.
3. **With the carry, its moves are written** (Moving a note forward, "Writing a move"). The
   switch and the moves are one transaction, so the latest is never shown without its notes.
4. `updatedAt`, and `updatedByUserId` set to the promoter.

A note captured on the outgoing version after the placements were worked out stays there. Its
own check passed, since its version was still the latest. The version list counts it among
the notes still on that version, and the next carry moves it.

Nothing else changes. The file's id, slug, title, visibility, owners, tags, references and
slug history are as they were, every version's address answers as it did, and only
`/pdf/<slug>` shows other bytes.

**After it:**

- **The promoter's page reloads in full.** `router.refresh()` is not enough, since the viewer is
  behind `ssr: false` (CLAUDE.md).
- **A viewer left open keeps the version it loaded.** Its bytes come by hash and its note list
  by version, so it shows what stayed on that version, and the notes that were moved leave
  its view. Nothing tells it to reload, and a capture from it is refused with a message that
  does.

### Links into the file

Links are href text in other people's bodies. A promotion rewrites none of them, and neither
does a move.

**A link names a sheet or a page, and a version.**

- **A sheet is written `sheet=`.** `page=` is read as the same thing for good, so every link
  already written keeps working, and the app writes it no more. Beside `p=`, "page" is the
  word a reader takes for the printed page.
  - **MCP's tools use the two words that way.** A sheet is `sheet`, a range of them `sheets`,
    and the printed page is `page`, where they are `page`, `pages` and `label` today. An
    answer says "sheet" and "page" in the same senses, and names both. A prompt written for
    today's tools that passes `page` for a sheet then asks for a printed page, and nothing
    refuses it. That is accepted: the prompts and skills that call the tools are few, and are
    changed with the rename.
  - **A tab whose bundle predates `sheet=`** ignores it: it opens such a link at the first
    sheet and draws nothing, as one that predates `p=` does with that
    (PDF_FRAGMENT_LINKS.md §6).
  - **The rename is a pull request of its own**, ahead of `v=` (Building it). It is deployed
    to every instance together: between two builds `page` is a sheet on one instance and a
    printed page on the other, and a skill written for either misreads the other with
    nothing refused.
- **`v=<n>` is the version a link was written against**: the number in that version's
  address, which a person can read, type and check.
  - **A `v=` belongs to the `sheet=` or the `p=` before it**, and is written straight after
    it: `#sheet=50&v=2&text=…`. Parameters are read left to right (PDF_FRAGMENT_LINKS.md §2,
    "Pairing"), so a `v=` before any of them is ignored.
  - **A link with several passages stamps each of its own.** The app writes one version on
    all of them. A hand-written link whose stamps differ has each passage read by its own
    stamp.
  - **A tab whose bundle predates `v=`** ignores it, and reads the sheet on whichever version
    it shows, with nothing to say so. That takes a tab open since before the deploy and a
    file that has gained a version since.
- **A link without `v=` names the file's first version, always**, by sheet or by page. That
  holds for every link that exists before a file's second version does, and while a file has
  one version it changes nothing.
  - **On a version's own address, a link without `v=` names that version**: the address has
    already said which. `/pdf/book/v/2#sheet=49` is sheet 49 of version 2. This is the one
    place an unstamped link is not read as the first version.
- **A `p=` names a version as a `sheet=` does.** Its label is read on the labels of the
  version it names (PDF_FRAGMENT_LINKS.md §2, "Which sheet"), and on a version without usable
  labels `p=<n>` is that version's sheet n. Nothing in an unstamped `p=5` says which draft's
  page 5 was meant, and a set of drafts has a page 5 each.
- **The address says which version is shown, and `v=` whose sheets the link counts.**
  `/pdf/book#sheet=50&v=1` shows the latest version, at the sheet that version 1's sheet 50
  became. `/pdf/book/v/1#sheet=50&v=1` shows version 1 itself.

**A link is carried from the version it names to the version shown**, through the page map of
each version between them.

- **In either direction**: forwards to a later version, and backwards to an earlier one or off
  an abandoned one. A link stamped `v=4`, where version 4 was abandoned over version 3, is
  carried from 4 back to 3 and on to the latest.
- **A `p=` is carried as a `sheet=` is.** The sheets carrying its label on the version it
  names each go through the maps, and its words are looked for on the sheets they reach, the
  first that holds them (§2 there, rule 3).
- **The map comes first, then the words.** The passage is looked for on the sheet the maps
  give, and the miss (PDF_FRAGMENT_LINKS.md §6, step 3) still finds one that isn't there,
  where it occurs exactly once in the version shown. The miss alone already carries such a
  passage. The map is what carries a link without words, and a passage that an unmapped sheet
  also holds, which would be drawn there with nothing to say it is the wrong one.
- **A sheet with no counterpart is carried only by its words.** The sheet may be removed or
  unmapped on the way, or be one the version shown lacks when a link is carried backwards.
  A link to it with words is looked for in the whole version shown, and drawn where they
  occur exactly once. One without words, or whose words are missing there or found on
  several sheets, is not carried.
- **No link is carried where a map on the way is missing**, with words or without. The map is
  missing because a revised text stands between the two versions, and there a match of the
  words doesn't say the passage is the one the link's writer meant.
- **One function carries a sheet**, for the viewer, the cited-page route, MCP and the checks
  (`src/lib/pdf-page-map.ts`, which is safe in a browser; the builder is a server module of its
  own, `src/lib/pdf-page-map-build.ts`). The viewer holds what it reads among its props, each
  version's number, state, labels and page map, since `PdfViewer` applies `#sheet=` on its own,
  before any passage is found (`pageFromHash`).

**A link that can't be carried opens the version it names**, where its sheet and its words are
what its writer saw.

- **From the bare address, the viewer goes to that version's own address** with the link as
  written, `/pdf/<slug>/v/<n>#…`, replacing the history entry. Its banner says which version
  the reader is on and links the latest. So in a file whose versions are drafts, every link
  written against a draft opens that draft.
- **On a version's own address the viewer stays**, since the address chose the version. Its
  banner says the link names another version and couldn't be brought to this one, and offers
  it at that version's address.
- **A link that names an abandoned version has no version to open.** Where that version kept
  a map, it is carried off it. Where it didn't, the viewer stays, says the version was
  abandoned and its sheets were never matched, and sends a link without words nowhere.
- **A `v=` that names no version of the file** opens the sheet as written, with a banner
  saying the file has no such version. This is what `v=2` gets on another file that has taken
  a deleted file's slug.
- **In those two cases alone, a passage is looked for by its words with no map behind it**,
  since there is no version to open instead. It is drawn where the words occur exactly once
  in the version shown, and the banner says it was found by its words alone.

**A link that was carried says so in the viewer's banner, where that changed what it
opens.**

- **It says how the link was read** ("read as version 1: its sheet 50 is sheet 49 here") and
  offers the current form to copy. A link carried to a sheet of the same number, its words
  found there, opens as it always did and says nothing: after a corrected scan that is nearly
  every link into the file.
- **Words not found where the link was carried** are reported as today, "Not found on page
  n". The miss's answer also says whether the version the link names holds them, and the row
  then offers the passage there. A link whose words a better copy corrected, and one whose
  passage a later draft cut, both end here.
- **A hand-typed link without `v=`, to the bare address of a file with several versions,** is
  the case the reading gets wrong: its writer meant the latest. Where it was carried to a sheet
  of another number, the banner offers the other reading. Where it wasn't, the reader is on the
  first version, whose banner links the latest.

**Once a file has a second version, every link into it that the app writes carries `v=`**, by
sheet or by page, and a link to version 1 included. A second version is a second
`file_version` row, a candidate or an abandoned one as much as a promoted one, so a file
that has begun to stamp its links never stops. Each names the version its writer read: the
latest, or the version whose own address it was written from.

Each is written by `formatPageName` (`src/lib/pdf-open-params.ts`), which takes a type of its
own: a page's name with its stamp, a version or "the file has one". `PageName` stays what a
parser returns, where a missing stamp is a reading, the first version, and not an omission.
So every writer must fill the stamp, and the compiler names each of them. That includes a
writer that sends out a name it read, as the cited-page route's redirect and the corrected
hrefs do: with one type for both, an unstamped name would pass from the parser to the writer
unseen. The writers:

- search's page links (`src/lib/search/pdfs.ts`) and the cited-page links (`pdfPageHref`),
  whichever form `pageNameForSheet` or `pageNameForLabel` answers (PDF_FRAGMENT_LINKS.md §8,
  "Which page form a writer takes");
- every passage written through `formatFragmentPassages`: the cited-page route's redirect
  (`placedFragment`), the one-quote CLI's, and the corrected hrefs the check and MCP's
  refusals give (below);
- the page MCP's `read` names in its answer, and the current form the viewer's banner offers.

**A citation's page is a printed page, never a sheet, and names no version.** Its link is the
cited-page route's, `/references/<key>/p/<page>?…` (CITATIONS.md, "A passage in a citation").
The route reads the latest version's labels and page text at every click, for a post's frozen
href as for a doc's. A work is one fixed text, so its file takes better copies and no
revisions, and its printed pages are the same in each.

- **A `quote:*` passage is found by its words**, on the sheets carrying the cited page
  (`placeCitedQuotation`), and by the viewer's miss when it isn't there.
- **A `/pdf/` referent is a link into the work's file, read as one.** Its pages ride in the
  route's query as the referent wrote them, by sheet or by page, each with its `v=`. So `v=`
  is kept from a referent (`fragmentPairs`, whose filter drops every parameter but `page`,
  `p` and `text` today) and in the query (`parseCitedQuery`).
  - **The route carries each on the server**, as the viewer carries a link on the bare
    address, and redirects to the latest with what it found, stamped. One it can't carry
    redirects to the version it names.
  - **A referent on a version's own address**, `/pdf/<slug>/v/<n>#…`, names version n's
    sheets and pages. They ride with `v=<n>`.
  - **The conversion of the hand-written citations** keeps the version each link names. An
    old link has no stamp, so it names the first version: its sheet is turned into a page on
    that version's labels, where they are usable, and the referent is stamped `v=1` where
    the file has a second version by then. The latest's labels would give another page with
    nothing to say so.
- **A file without usable labels** takes a citation's page as a sheet number of the latest
  version (`sheetsLabelled`). So a version that moves its sheets misdirects the citations of
  it that name a page and no passage, and the candidate's page warns of that (The upload).
  They are not carried through the page maps as an unstamped link is. A `sheet=` is a sheet by
  definition, and the maps carry it exactly. A locator is a printed page, read as a sheet only
  for want of labels, so the maps would carry a guess forward. Labels on the new version are
  what fix it.

**The checks read a link as the viewer does**: on the version it names, by that version's
labels and page text, and then wherever the viewer would take it. The integrity check and
MCP's write check share one reading (PDF_FRAGMENT_LINKS.md §8).

- **A link the viewer carries is checked where it lands.** Where page maps join the version
  a link names to the version its address shows, a reader is shown the link there, so its
  words are looked for there.
  - **Words that the version named holds and the landing doesn't are a fault**: a better
    copy corrected them, and every reader of the link is told "Not found on page n". The
    integrity check warns, naming the sheet the link lands on, and MCP's write check
    refuses, as each does today for words that aren't found.
  - **This is decided by the maps**, and by no kind of version. A file whose versions are
    drafts has no map for the link to be carried through.
- **A link the viewer can't carry is checked on the version it names**, which is the one it
  opens. Words that are gone from the latest version are no fault in it: a revised text
  stands between, and the link opens the draft it was written against.
- **A link that names an abandoned version** is carried off it by its map and checked where
  it lands. Where the version kept no map the check warns, since nothing can confirm the
  link.
- **A link to a version's own address is a link into that version**:
  `/pdf/<slug>/v/<n>#sheet=…&text=…`, which is what a reader on an earlier version copies from
  the address bar. Three parsers take only `/pdf/<slug>` today and would pass over it
  unchecked: the integrity check's `parseFragmentLinkHref`, MCP's `parseRef`, and a
  citation's `referentKind`, which calls it a link elsewhere.
- **A link that names a version other than the latest, and lands with its words found, is
  no fault**, and every link written before a file's second version is one. The integrity
  check lists such a link only under `--verbose`, with its form for the latest where it can
  be carried there.
- **Both cover a link without words too**, `#sheet=5` with no `text`, which the check already
  reads (PDF_FRAGMENT_LINKS.md §8).

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

**The check warns of a link without `v=` written after its file's second version was
uploaded**, by sheet or by page, which only a hand can have typed. The viewer has only the
URL, so it reads by the rules above. A link pasted from an older body is dated at its paste.

**MCP refuses a link without `v=` into a file with several versions**, and gives its stamped
forms. Its `read` of a sheet of such a file names it in its stamped form, so a model has it
before it writes.

- **A link with `text` is placed by its words**, on the latest version and failing that on
  the first, and the corrected form names where they were found.
- **A link without words has nothing to say which reading was meant**: the first version's,
  by the rule, or the latest's, which a model that has just read the file means. The refusal
  gives both, each with the sheet it would open.

**A version's number and an update id are one instance's own.** A doc copied to another
instance carries links whose `v=`, and whose dating, mean nothing there. That is left for the
work that makes docs portable between instances, which update ids need as well.

Rejected, with reasons:

- **Rewriting the sheet numbers in other people's bodies at promotion.** Nothing edits a
  body's text but its own writers: a renamed slug redirects rather than rewriting hrefs, and a
  chip's refreshed label is a cache beside the text. Docs, comments, annotation bodies and
  posts each have their own write path and history. And links from outside the site can't be
  rewritten at all. A batch a person runs over the bodies they may edit is a different thing
  (Open).
- **Reading a link without `v=` as the latest version.** A link typed by hand would then be
  right, and every older link nobody rewrote would land on the wrong sheet with nothing to say
  so: the viewer can't tell when a URL was written. Which bytes a link means matters most
  when a new version exists to correct them.
- **A `p=` that names no version**, read on the latest's labels. For a better copy it needs
  no stamp, since the printed pages are the same in each. In a set of drafts it sends every
  earlier link to the latest draft's page of that number, and nothing in the link says which
  draft was meant.
- **A hash for `v=`**, the first digits of the bytes' `sha256`. It can't be read, typed or
  compared by eye, it is a second name beside the number in the address, and the same bytes
  uploaded twice give two versions one stamp. What it adds is noticing bytes other than the
  ones a link was written against, which matters only between instances (above).

### Earlier versions

- **An earlier version stays readable** at its address, with its bytes, its page text at
  every version it was extracted at, and the anchors on it.
- **No version is purged.** A version goes only as its file does, by the soft deletion that
  exists. `FILE_STORAGE_DIR` grows by a whole copy per version, and nothing shrinks it
  (Open).
- **`scripts/upgrade-pdf-text-version.ts` works version by version**, over every version that
  has its bytes, where it works file by file today: it extracts, restamps anchors and deletes
  older extractions within one version. An abandoned version has no bytes to extract from and
  is skipped.
  - **It locks the file row for each file's writes**, as a move does, so it can't write an
    old target back over a moved one.
  - **It doesn't read `file_anchor_move`.** A kept target's sheet, quads and quote stay true,
    since a version's bytes never change. Its offsets and its text version may name an
    extraction the script has since deleted, and an undo would find them again from the
    quote.
- **Restoring an earlier version** is uploading its bytes again: an ordinary new version.

### Rejected designs

- **A promotion that waits for every anchor.** Each anchor on the latest version has a stored
  item, which a pass or a reviewer places on the candidate or a reviewer leaves behind, and
  the promotion is refused while any is undecided. It fits a better copy and nothing else: in
  a revised text many notes have no place, and whether one applies is its author's to say,
  not a reviewer's. It also needs the pass rerun whenever an anchor or the text version
  changes, and a check of every anchor against its item under the promotion's lock.
- **A kind stored on the version**, better copy or revised text. Every reader of a note or a
  link then has two behaviours, and the one less used fails with nothing to show it. What a
  reader needs is already data: the version an anchor is on, and whether a map exists.
- **Moving a note on a match of its words alone, whatever the kind of version.** In a revised
  text the sentence can survive and the note not apply.
- **A version as a row of the `file` table**, with what the bytes decide swapped between the
  two rows at promotion. Everything that reads a file then reads a version unchanged. But the
  row is a file in the table and nowhere else, and each place that means "a file" needs a
  rule for it: a slug of its own, renamed with its file's; visibility, owners and deletion
  taken from its file; a clause to leave it out of every listing of files and another to keep
  its notes in every listing of notes; a refusal in every manage operation; a title that is
  never shown. The swap needs `file_page_text`'s rows parked at negative page indexes to get
  past their own key. And a note that isn't moved ends up on another file's id.
- **A slug per version** (`book-v1`). It has to be claimed, can be taken by a real file, and
  follows a rename only if every version is renamed with it.
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
- **A candidate as an ordinary PRIVATE file owned by its uploader.** It appears in that
  person's `/files` and search until promotion, and it takes annotations and links like any
  file.
- **No new notes on an earlier version.** It refuses a reader who has chosen an older scan,
  and leaves a draft that can't be moved no way out but discarding it.

### Open

- **A batch that rewrites the links in bodies its runner may edit**: `page=` to `sheet=` or
  `p=`, a stamp for an earlier version to the latest, or a link to a citation. It is not
  designed here. The clock above is what would let it date a link, and nothing in this plan
  depends on it.
- **A viewer left open across a promotion is not told.** It shows the version it loaded,
  correctly, until it is reloaded (TODO.md, "PDF versions").
- **Pairing a sheet by hand, and building a map again.** An unmapped sheet stays unmapped. A
  map is read whenever a link is, so a later pairing would mend the links to that sheet at
  once. It is built when a file needs it.
- **A map for sheets that reflow.** A map pairs one sheet with one, so a page whose words now
  run over two sheets has no counterpart. Pairing a sheet with a part of another would carry
  the links to it.
- **Search and citations across a set of drafts.** Both stay on the latest version. A search
  that reaches an earlier draft, and a citation that names one, are not designed.
- **A curator who moves other people's notes.** Only a note's author moves it one at a time,
  so a note whose author is gone stays where it is unless a carry takes it.
- **Moving a note back, or undoing a move from the app.** The history keeps what an undo
  needs, and a carry can be undone from the database (Moving a note forward).
- **A nudge by email** to an author with notes on earlier versions.
- **A tool for MCP that moves a note.** A bot's notes are in the worklist of the person it
  works for. The move takes an `Actor`, so the tool is a wrapper when it is wanted.
- **Tools for MCP that build a page map, promote a candidate or abandon one.** MCP uploads a
  candidate and a person does the rest on its page. Each of the three takes an `Actor`, so a
  tool is a wrapper when it is wanted.
- **Purging a version**, to free its bytes. It needs a rule for the notes still on it and for
  the links that name it.
- **Decisions made against a candidate before its promotion**, and written with it. They need
  a table of pending moves and a rule for an abandoned candidate.
- **The answers given about the runs of an abandoned candidate's map**, which the next
  candidate's map asks again.
- **A new edition** (§12). It can be uploaded as a revised text. Whether an edition should be
  a version of its predecessor's file or a file of its own, with a reference and citations of
  its own, is a separate question.

### Building it

Four pull requests, each merged before the next is opened.

1. **Steps 1 to 4** change no behaviour while every file has one version, so the existing
   suite proves them before any file can have a second.
2. **Step 5** is the `sheet=` rename.
3. **Steps 6 to 9** let a file take a new version. Every version then behaves as a revised
   text whose notes can't be moved yet: a note stays where it is, and a link opens the
   version it names. Nothing is lost by stopping here, since a carry can be run on any
   earlier version later.
4. **Steps 10 to 13** add the page maps and the moves.

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
     with its foreign key on the pair and the unique index Prisma needs for it;
   - the columns the bytes decide moved from `file` to that row, with the file's search
     trigger reading the filename from it;
   - `file_page_text` keyed by version, by renaming its column: a migrated version 1 has its
     file's id (Versions);
   - `file_version_id` on `annotation` and the anchor tables, filled for every row with a PDF
     target, with the foreign key on the pair. Each pair key is `ON DELETE NO ACTION`, written
     out: Prisma's default for an optional relation is `SET NULL`, which on a pair would
     null `file_id` too. A version's row goes only with its file, whose cascade takes the
     anchors;
   - the partial unique index that allows a file one candidate.
2. **Reads by version**: every reader of the moved columns selecting them through the
   latest version, page text's functions, the two lazy writers, search's filter, and the
   count of rows holding a blob.
3. **Addresses by version**: the `/v/<n>` pages with their banner and the `/v<n>` redirect, the
   viewer's `key`, the byte route and the download's `v`, the note loaders' shared query, the
   listings' titles and their links through one helper, the list of notes on other versions and
   a card's link from any address, the `/link/<id>` landing, the presence channel, MCP's `read`,
   and a past slug's redirect keeping the rest of the address.
4. **Anchor writes**: each stamps its version and checks it inside its transaction. A second
   migration then repeats step 1's fill and adds the CHECK that `file_version_id` is set
   exactly when the row holds a PDF target, which no row written between step 1 and this one
   would pass.
5. **`sheet=`**: `formatPageName` writes it and every reader takes it beside `page=`: the
   fragment's parser, `pageFromHash`, the check's and MCP's href parsers, and the two
   patterns that are written out by hand, `fragmentPairs`' filter (`citation.ts`) and
   `PAGE_PARAM` (`src/lib/cited-passage-query.ts`). A referent written with `sheet=` that
   either one misses loses its sheet, and its words are then read as a quotation with no
   error. MCP's parameters and answers take the two words. PDF_FRAGMENT_LINKS.md,
   CITATIONS.md and MCP.md are rewritten to it.
6. **`v=`**: the stamped type `formatPageName` takes and its writers, the three parsers that
   read a version's own address, the viewer's reading of the version a link names and its
   going there, the cited-page route's, the banners, MCP's refusal, and the integrity check
   with its dating. No map exists yet, so no link is carried.
7. **The upload**, through `PUT /api/files/<id>` and through MCP's route with `versionOf`,
   the lock on the hash, the candidate's page, promotion without the carry, abandoning, and
   the page of an abandoned version.
8. **The version list's management half, and the text-version script by version.**
9. **Integrity checks**, beside step 1's (every file has a latest version, which is
   promoted):
   - every version that is not abandoned has its bytes on disk;
   - every anchor with a PDF target names a version of its file, and none names a
     candidate or an abandoned version;
   - no `tag_anchor` or `comment_quote_anchor` row holds a `PDF_TEXT` selector on a file
     with more than one version;
   - every anchor's quote matches the page text of the version it names, which
     `check-pdf-anchors` verifies today against the file's.
10. **The page map**: the similarity measure, fixed against real pairs, the blank-sheet read,
    the builder (`src/lib/pdf-page-map-build.ts`), the map's page with its runs of sheets, and
    the carrying of links through maps (`src/lib/pdf-page-map.ts`), in the viewer, the
    cited-page route, MCP and the check.
11. **The move**: the placing rules, `file_anchor_move`, the write, and the bulk carry at a
    promotion, from the version list and after a run of sheets is accepted, each with what
    would carry shown first.
    - **The working-out opens each version's document once.** `extractPageItems` opens it on
      every call, so it takes a form that reads many sheets from one open document.
12. **The selective move**: the worklist on the latest's page and in `/annotations`, the
    suggestions, placing by hand, "stays here", and a shown move on its card and in the
    earlier version's list.
13. **Integrity checks** for the two:
    - every page map pairs sheets that exist, and no two with one counterpart;
    - every move's destination is a promoted version later than the one it left, and an
      anchor is on the version its newest move reached, the marks left out of both;
    - every "stays here" mark names the version its anchor is on, which is not the latest,
      and no anchor has two.

**Tests.**

- **Unit**, for the pure parts:
  - the page map: a first sheet removed, a last sheet removed, blank sheets added, a label on
    two sheets, a label on two sheets of one version and three of the other, a label the version
    lacks, labels corrected, a sheet without text inside the corrected stretch, a sheet whose
    text was rebuilt and is proposed by its place, no labels, a sheet left unmapped, a
    reflowed pair left unmapped, and a run of sheets of each kind before and after it is
    accepted;
  - the placing rules: a tie broken by `prefix` and `suffix` and one that isn't, a quote found
    once in the version with and without them agreeing, a range carried through the diff
    cleanly and not, and the transform fit;
  - a link's reading: stamped and not, by sheet and by page, from the bare address and from a
    version's own, carried through two maps, with a map missing on the way, onto a sheet with
    no counterpart with and without words, stamped with an abandoned version that kept a map
    and one that didn't, and with a version the file lacks;
  - the check's reading: a link carried to a sheet that holds its words, one carried to a
    sheet where they were corrected, and one that can't be carried and whose words the
    latest lacks.
- **A fixture with ink and no text.** `scripts/make-test-pdf.ts` writes text operators only,
  so it gains a sheet that draws a filled rectangle, for rule 5 and for a rectangle selection
  on a sheet without text items.
- **e2e, the third pull request**: a fixture and a second with other text. On the first, a
  word is annotated and a `sheet=` link and a `p=` link are written. The second is uploaded
  and promoted. The spec checks:
  - before the promotion, `/pdf/<slug>` and `/pdf/<slug>/v/1` showing the first bytes and
    `/pdf/<slug>/v/2` the second, to a reader who can't manage the file;
  - an annotation refused on the candidate, and a note with no target written there and
    listed on every version's page;
  - after it, the note drawn on `/pdf/<slug>/v/1` alone and listed on the latest's page under
    version 1, with its card's link on the bare address landing on that entry;
  - both links, unstamped, opening version 1, and a link the app writes afterwards carrying
    `v=2`;
  - a viewer opened before the promotion still reading the first bytes, and its capture
    refused;
  - the banner's link from `/pdf/<slug>/v/1` to the latest, followed without a reload,
    showing the second bytes;
  - `/pdf/<slug>/v/2` naming its version in its title while it is the latest;
  - a version uploaded through MCP's route by a bot, of a file that only the person it works
    for owns, a retry answering the same candidate, and the upload refused for a token whose
    user neither manages the file nor works for someone who does;
  - a note made on `/pdf/<slug>/v/1` after the promotion, drawn there and not on the latest;
  - a search hit coming from the latest version's text alone;
  - the addresses following a rename of the file;
  - `/pdf/<slug>/v2` redirecting to `/pdf/<slug>/v/2`, and each version's download saved
    under its own filename;
  - a second candidate abandoned, its address saying so, and the next taking a new number.
- **e2e, a better copy**: two fixtures with the same text, the second having its first sheet
  removed, a blank sheet added and one word changed. On the first, by two users: a word
  annotated, the changed word annotated, a passage given an anchored link, a rectangle
  annotated and replied to, a draft, a part of a link not yet minted, and a `sheet=` link
  and a `p=` link written. The second is uploaded as a better
  copy and promoted with the carry. The spec checks:
  - what the candidate's page says would carry, before the promotion;
  - after it, the highlights on `/pdf/<slug>`, both users' among them, the changed word's
    note with its new quote, and no sign of a move on any card;
  - where both links land, and the banner saying how each was read;
  - the draft and the unminted part still on version 1, and the draft listed in its author's
    private notes on the latest's page;
  - a draft part of the open link on version 1, not drawn on the latest;
  - the rectangle and its reply where the fit puts them;
  - two notes posted on version 1 after the promotion and one of them marked "stays here":
    a second carry from the version list shows what it would do, moves the other and leaves
    the marked one;
  - the carry's moves shown once a manager shows them.
- **e2e, a revised text**: a third fixture whose text is reflowed onto more sheets, with one
  passage cut and one rewritten. It is uploaded as a revised text and promoted. The spec
  checks:
  - nothing moved, and every note listed on the latest's page under version 1;
  - the author's worklist, with a suggestion for a passage that survives, accepted, and its
    card and version 1's list saying it was moved;
  - a note on the rewritten passage placed by hand, and one on the cut passage marked as
    staying and gone from the worklist;
  - another user, and a manager who is not the author, offered no move of that author's
    notes, and the action refusing one;
  - a bot's note in the worklist of the person it works for;
  - a link written against version 1 opening version 1, by sheet and by page.
