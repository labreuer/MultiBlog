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

---

## 5. Coordinates

The only conversion API to use:

```ts
const viewport = page.getViewport({ scale, rotation });
viewport.convertToPdfPoint(x, y);              // page-relative CSS px -> PDF user space
viewport.convertToViewportRectangle(rect);     // PDF user space -> page-relative CSS px
```

Rules:

- `x`/`y` passed to `convertToPdfPoint` must be **relative to the page element's top-left**.
  Subtract `pageView.div.getBoundingClientRect()` from client coordinates first.
- Use CSS pixels from `getBoundingClientRect()`, never canvas backing-store pixels. The
  canvas is scaled by `devicePixelRatio`; the viewport transform is not.
- Always pass the page's **current** `rotation` into `getViewport`. Rotation changes invalidate
  every cached viewport rect.
- `range.getClientRects()` returns one rect per rendered line fragment, not per selection.
  Store all of them as separate quads — that is what makes a multi-line highlight render
  correctly.

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

---

## 10. Version coupling

`PDFViewerApplication`, `PDFViewer`, `pageView.div`, and the `eventBus` event names are all
internals. Pin `pdfjs-dist` exactly and add a smoke test asserting the specific internals we
touch still exist, so an upgrade fails loudly in CI rather than silently at runtime.

Hypothesis — who have done exactly this integration for over a decade — ship a standing warning
that new PDF.js releases may be incompatible with their client. Budget for upgrade work; do not
float the version.

### Engine coupling — the built-ins pdfjs assumes

Pinning `pdfjs-dist` fixes the API you call. It does nothing about the second coupling, which
is to the *JavaScript runtime* pdfjs assumes underneath it — and pdfjs tracks new built-ins
closely, while WebKit ships them late or not at all. **Baseline: Safari 26 / iPadOS 18.4+.**

Three gaps have broken the viewer in Safari over time. Only one is still patched, and the
split between them is the useful part:

- **`ReadableStream.prototype[Symbol.asyncIterator]`** — the standing one, patched in
  `src/lib/pdfjs-webkit-polyfills.ts`. WebKit has *never* implemented it, in either realm, and
  Safari 26.6.1 still does not. `getTextContent` iterates its stream with
  `for await (const value of readableStream)`, so **every text extraction throws** — which on
  this surface means a selection is captured and then dies before it can be published or
  become an annotation.
- **The `Iterator` global** and **`Map.prototype.getOrInsert` / `.getOrInsertComputed`** —
  both were *version lag*, both shipped in Safari 18.4, and both patches were **deleted** when
  the baseline was set. The `Iterator` one is worth remembering anyway for its shape: pdfjs
  polyfills `Iterator.prototype.join` itself, guarded by
  `typeof Iterator.prototype.join !== "function"` — and that guard dereferences the *global*.
  So on an engine without it, the failure was a `ReferenceError` thrown out of pdfjs's
  top-level module body before a line of its own logic ran: the viewer never mounted, and the
  stack pointed at our `import * as pdfjs`. A `typeof` guard protects the property, not the
  object it hangs off.

**Measured baseline — Safari 26.6.1 (2026-08-22), both realms.** `npx tsx scripts/probe-engine.ts`
serves one page that runs the checks on the main thread *and* inside a module worker, opens it
in a browser, and prints both columns. Re-run it on a `pdfjs-dist` bump rather than re-deriving
this from memory — and **delete** a patch the same way, on a measurement rather than an
assumption that everyone has updated.

Only the **Safari 26.6.1** column is measured. The *shipped in* column is from release notes
and is orientation, not evidence.

| built-in | Safari 26.6.1 | shipped in |
| --- | --- | --- |
| `ReadableStream.prototype[Symbol.asyncIterator]` (and `.values`) | **absent** | never |
| `Iterator` global | present | 18.4 |
| `Map.prototype.getOrInsert` / `.getOrInsertComputed` | present | 18.4 |
| `URL.parse` / `URL.canParse` | present | 18.0 / 17.0 |
| `Response.prototype.bytes`, `Uint8Array.fromBase64` / `.toBase64` / `.toHex` | present | 18.0 / 26 |
| `Float16Array`, `Promise.withResolvers`, `AbortSignal.any`, `Set.prototype.intersection` | present | 26 / 17.4 |

`Iterator.prototype.join` is *itself* still absent on 26.6.1 — pdfjs's own polyfill for it
fires and works, now that the global its guard dereferences exists. The guard was the bug,
never the method. `Float16Array` and `Uint8Array.fromBase64` are worth a glance in that table
too: pdfjs feature-detects the first (`FeatureTest.isFloat16ArraySupported`, falling back to
`Float32Array`) and does **not** guard the second, which it uses for XFA images and signature
decompression — a narrow path, but the one to suspect if the baseline ever moves backwards.

Four things generalise beyond the specific patches:

1. **A patch has to reach both realms, and may need to land before pdfjs's module body rather
   than merely before its first call.** pdfjs runs a worker, which is its own realm and
   inherits nothing from the main thread's prototypes — and the surviving gap is used on both
   sides (the worker iterates a `DecompressionStream`'s readable side the same way). There is
   no hook to run code before the vendor worker's own top-level body, so `ensurePdfWorker`
   builds the worker script as a Blob, which is why the polyfill is exported as a *source
   string* and not merely executed. **The obvious spelling of that Blob is wrong.**
   `<polyfill source>` followed by `import "<vendor>"` puts the patches in the module's *own
   body*, and static imports are hoisted, so the vendor worker script runs before them. The
   surviving patch tolerates that (it is needed before pdfjs's first call, and lands in the
   gap); the deleted `Iterator` one did not, because it was dereferenced during evaluation.
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

The same asymmetry applies to input. Text selection on iPadOS emits no `pointerup` — a
long-press hands the touch to WebKit's selection gesture recognizer, which fires
`pointercancel`, and the selection handles are native views above the page that emit no
pointer events at all. Anything reading `window.getSelection()` must settle on
`selectionchange` (debounced) as well, or it will work on every desktop and silently do
nothing on a tablet. See `PdfAnnotationSurface`'s trigger comment.

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

**§3's NFKC is applied per character, not to the joined string.** Whole-string NFKC can merge
or reorder across characters, which is incompatible with the exact offset map §3 also
requires. Per-character keeps the map exact and the function deterministic — which is what §3
actually rests on — and both sides that matter (upload extraction and selection capture) call
the same function, so they agree by construction. See `src/lib/pdf-text.ts`.