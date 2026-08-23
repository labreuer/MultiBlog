# PDF.js External Annotations — Architecture & Implementation Rules

Reference for work on the in-browser PDF viewer: annotations stored **outside** the PDF,
plus multi-client viewport synchronisation.

**Status of this document.** The anchor model, coordinate rules, layer structure, and sync
wire format below were *recommendations* worked out in design discussion. **They are now
built** — PLAN.md §19, `src/lib/pdf-anchor*.ts`, `src/components/pdf/`. Where the
implementation departs from what is written here, §13 at the end says so and why; treat any
un-annotated statement below as still current. The renderer choice (PDF.js) and the "annotations live
outside the file" constraint are settled. Treat everything else as a strong default —
if you find a concrete reason it's wrong, say so rather than silently working around it.

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

---

## 3. Text normalisation

Anchoring correctness depends entirely on this being **deterministic and versioned**.

Pipeline, applied per page to `page.getTextContent()`:

1. Join `items` in order. PDF.js frequently omits inter-item spaces — insert a space when
   the gap between item bounding boxes exceeds a fraction of the font size, and a newline
   when `item.hasEOL` is set.
2. Unicode NFKC.
3. Decompose ligatures (ﬁ, ﬂ, ﬀ, ﬃ, ﬄ, ﬅ, ﬆ).
4. Strip soft hyphens (U+00AD) and zero-width characters.
5. Normalise dashes and quote characters to ASCII.
6. Collapse runs of whitespace to a single space; trim.

While joining, build an **offset map**: normalised char index → `{ itemIndex, charOffset }`.
This is what makes `position` → `quads` recoverable without a rendered text layer, and it is
the reason normalisation must be a pure function of `getTextContent()` output.

Cache normalised page text + offset map per `(docId, pageIndex, textVersion)`. It is
expensive and completely stable for a given version.

When `textVersion` changes, re-anchor **lazily** on next open and rewrite the stored
`quote`/`position` if resolution succeeds. Do not batch-migrate.

---

## 4. Anchoring algorithm

Resolve order, per annotation:

1. **Exact quote match** in normalised page text, searching outward from `position.start`.
   Cheap, and correct in the overwhelming majority of cases.
2. **Fuzzy quote match** — bounded edit distance, within a window around `position.start`.
   Only if step 1 misses.
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
viewport.convertToPdfPoint(x, y);              // page-relative CSS px -> PDF user space
viewport.convertToViewportRectangle(rect);     // PDF user space -> page-relative CSS px
```

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
  chosen value rather than a unit error — see §13.

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
interface ViewportState {
  pageIndex: number;
  pdfPoint: [left: number, top: number];   // PDF user space, top-left of visible region
  zoomMode: 'page-fit' | 'page-width' | number;
  clientId: string;
  t: number;                                // monotonic, for staleness
}
```

Never broadcast `scrollTop`, `scrollLeft`, pixel offsets, or a raw scale — they are meaningless
on a different window size, zoom level, or DPR.

This maps 1:1 onto a PDF destination array, which is also what PDF.js consumes:

```ts
pdfViewer.scrollPageIntoView({
  pageNumber: pageIndex + 1,
  destArray: [pageIndex, { name: 'XYZ' }, left, top, null],
});
```

Passing `null` for zoom preserves the local user's zoom, which is almost always what you want —
followers should see the same *content*, not be forced into the leader's zoom level.

### Transport

- **Annotations → ydoc.** `Y.Map<string, Annotation>` keyed by annotation id. Gets CRDT merge,
  offline, and the existing Hocuspocus persistence path for free.
- **Viewport → awareness.** Ephemeral and unpersisted by design. Putting viewport updates in
  the ydoc would bloat the update log badly, which matters given the `gc: false` work.

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

`PDFViewerApplication`, `PDFViewer`, `pageView.div`, and the `eventBus` event names are all
internals. Pin `pdfjs-dist` exactly and add a smoke test asserting the specific internals we
touch still exist, so an upgrade fails loudly in CI rather than silently at runtime.

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
  fonts and leaves the worker alive. Destroy the *loading task* instead. §5's
  `convertToViewportRectangle` is gone in 6.x too — §13 has the replacement.
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

- ~~Whether to keep a server-side copy of normalised page text for search, or recompute
  client-side.~~ **Settled: stored.** `file_page_text` holds the normalised text of every
  page, extracted once at upload (PLAN.md §19). It was not the search argument that decided
  it — it is that `quotedText` has to be derived server-side to keep §12i's "the selected
  text is a request field only, never a column" true, and doing that per annotation would
  otherwise mean re-parsing the PDF on every post. Storing it makes the derivation a string
  slice. Search is a free consequence, not the reason.
- ~~Annotation permissions / visibility scoping.~~ **Settled: a file carries docs'
  PRIVATE/SHARED model** (`src/lib/file-authz.ts`, docs/PERMISSIONS.md), and an annotation on
  one is an ordinary `Annotation` row, so it inherits DRAFT privacy, soft delete, and
  `requireOwnOrAdmin` unchanged.
- Behaviour when the same logical document arrives with different bytes (different `docId`)
  — re-anchor across editions, or treat as unrelated. **Still open**, and note that
  content-addressed storage makes the two *share* bytes when they are identical and stay
  wholly separate when they are not; nothing bridges editions.

---

## 13. Where the implementation departs from this document

Recorded here rather than silently, because each of these reads as a bug in our code until
you know it isn't.

**§10 names `PDFViewerApplication`; the viewer is built on `PDFViewer`.** The former is the
bundled `web/viewer.html` *application*, not an importable library entry. `PDFViewer` +
`EventBus` + `PDFLinkService` from `pdfjs-dist/web/pdf_viewer.mjs` is the library-level
equivalent and exposes every internal §5 and §8 rely on. The version-pinning discipline §10
asks for is unchanged, and `e2e/pdf-viewer.spec.ts` is the smoke test it asks for.

**§5 names `convertToViewportRectangle`; it does not exist in pdfjs 6.** Neither the types
nor the shipped `pdf.mjs` have it — only `convertToViewportPoint` and `convertToPdfPoint`.
Converting the two opposite corners as points is exactly equivalent for an axis-aligned box,
which is all a quad's bounding box ever is here. Every *rule* in §5 still holds.

**§9's "annotations → ydoc" is not taken.** Annotations are Postgres rows, for five reasons
set out in PLAN.md §19 — chiefly that Hocuspocus authorizes the connection rather than the
keys, so a `Y.Map` would expose every DRAFT and let anyone delete any entry unattributed, and
that `/annotations` could not see them at all. §9's *viewport* half is taken exactly as
written, including all three echo guards.

**§4 step 2 (fuzzy quote match) is deferred.** It matters only after a `textVersion` bump,
and §4 itself warns against running it synchronously (Hypothesis's ten-second stall). Doing
it properly needs a worker; steps 1, 3 and 4 make the viewer correct without it, because the
quads always resolve. §3's lazy re-anchor on a version change is deferred with it.

**§5 said nothing about `currentScale`, and the omission cost a release cycle.** The rule is
now written into §5 itself. Recorded here because of how it failed rather than that it did:
"scroll a jumped-to passage 25% down the viewport" computed its offset from `currentScale`
and landed the passage at 0.333 instead. Nothing threw, no test could see it, and a third of
the way down looks exactly like a value somebody chose. It was found by measuring the
rendered position against the container, which is the only thing that would have found it.

**§3's NFKC is applied per character, not to the joined string.** Whole-string NFKC can merge
or reorder across characters, which is incompatible with the exact offset map §3 also
requires. Per-character keeps the map exact and the function deterministic — which is what §3
actually rests on — and both sides that matter (upload extraction and selection capture) call
the same function, so they agree by construction. See `src/lib/pdf-text.ts`.