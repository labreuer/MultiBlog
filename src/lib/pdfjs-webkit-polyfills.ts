// The built-ins pdfjs-dist needs that WebKit does not have.
//
// **Baseline: Safari 26 / iPadOS 18.4+.** Two patches live here, and they fail
// for opposite reasons — one permanent, one a version lag that has not aged
// out yet:
//
//   - `ReadableStream.prototype[Symbol.asyncIterator]` — WebKit has *never*
//     implemented it, in either realm, and Safari 26.6.1 still does not.
//   - `Map.prototype.getOrInsert` / `.getOrInsertComputed` — these land in
//     **Safari 26.2**, which is *inside* the baseline's own range, so every
//     supported engine below that lacks them.
//
// A third patch, for the `Iterator` global, was deleted correctly: it really
// did ship in Safari 18.4, the baseline's floor.
//
// **The Map patch was deleted once, in error, and restoring it is the reason
// to read this comment.** The deletion followed the rule below — it was made
// on a measurement, not an assumption — but the measurement was taken on
// Safari 26.6.1, the *newest* engine in the baseline, and generalized to a
// range whose floor is iPadOS 18.4. Confirmed on a real iPhone 13 Pro running
// iOS 18.6.2, which is squarely inside the supported range: both methods are
// `undefined` in both realms, pdfjs calls `getOrInsertComputed` 68 times
// without a guard, and the viewer renders its toolbar and then nothing at all
// —
//     this.#methodPromises.getOrInsertComputed is not a function
// MDN's compatibility data is what settles the version, against release notes
// that were read as 18.4: Safari 26.2, Safari on iOS mirroring it, Chrome 145,
// Firefox 144, Node 26 — "newly available" only since February 2026.
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map/getOrInsert#browser_compatibility
//
// So the rule that governs this file needs its missing half: add a patch on a
// failure, remove one on a measurement — **and take that measurement on the
// oldest engine the baseline claims to support, not the newest one to hand.**
// A single desktop Safari is blind to this class in exactly the way §10 says a
// chromium-only suite is. `scripts/probe-engine.ts` answers for whatever
// browser is on this machine; `scripts/remote-console.ts` is what reaches a
// real phone, and is how the numbers above were taken. docs/PDF.md §10 records
// both columns.
//
// Exported as a source *string*, not just executed here, because the worker
// realm can't be patched by importing this module the normal way: pdfjs is
// only ever handed a `workerSrc` URL, and a bundler has no reason to treat an
// arbitrary local `new URL("./something", import.meta.url)` target as a
// module entry point the way it treats a real `new Worker(new URL(...))`
// call — it just copies whatever the literal names as a static asset,
// unparsed. That's harmless for the vendor file (already-built, dependency-
// free JS), but a wrapper `.ts` module with its own `import` doesn't survive
// being copied verbatim. ensurePdfWorker (pdfjs-client.ts) works around that
// by building the worker's script as a Blob at runtime instead: a module that
// imports this source (itself a Blob) and then the vendor worker's own
// resolved absolute URL — both of which a module worker can load with no
// bundler involved at all. Those two imports are static and in that order
// because static imports are hoisted; see the note in ensurePdfWorker for why
// that ordering is kept even though nothing here now depends on it.
//
// Being a source string, this is plain JS and cannot use TypeScript syntax.
export const WEBKIT_POLYFILL_SOURCE = `
// --- ReadableStream async iteration (WHATWG Streams) ----------------------
// WebKit has never implemented ReadableStream.prototype[Symbol.asyncIterator]
// (nor its .values alias). pdfjs needs it in *both* realms:
//
//   - main thread: PDFPageProxy.getTextContent does
//     \`for await (const value of readableStream)\` over streamTextContent,
//     so **every text extraction throws** — which on the PDF surface means a
//     selection is captured and then dies before it can be published or
//     turned into an annotation (src/components/pdf/PdfAnnotationSurface.tsx).
//   - worker: it iterates a DecompressionStream's readable side the same way.
//
// The failure names the loop variable rather than the missing method
// (\`undefined is not a function (near '...value of readableStream...')\`),
// which is why it reads as a pdfjs bug rather than an engine gap.
//
// Defined per the Streams spec's own async-iterator semantics: \`return()\`
// cancels the stream unless preventCancel was asked for, and the reader's
// lock is released on every exit path so the stream stays usable.
if (typeof ReadableStream.prototype[Symbol.asyncIterator] !== "function") {
  ReadableStream.prototype.values = function (options) {
    var preventCancel = Boolean(options && options.preventCancel);
    var reader = this.getReader();
    return {
      next: function () {
        return reader.read().then(function (result) {
          if (result.done) reader.releaseLock();
          return result;
        });
      },
      return: function (value) {
        if (preventCancel) {
          reader.releaseLock();
          return Promise.resolve({ done: true, value: value });
        }
        var cancelled = reader.cancel(value);
        reader.releaseLock();
        return cancelled.then(function () {
          return { done: true, value: value };
        });
      },
      [Symbol.asyncIterator]: function () {
        return this;
      },
    };
  };
  ReadableStream.prototype[Symbol.asyncIterator] = ReadableStream.prototype.values;
}

// --- Map upsert (TC39 "Map.prototype.getOrInsert") ------------------------
// pdfjs-dist 6.x calls these pervasively and never guards them: 68 calls to
// .getOrInsertComputed and 2 to .getOrInsert across pdf.mjs, pdf.worker.mjs
// and pdf.sandbox.mjs. So the *first* Map either realm touches throws, which
// is why the symptom is a viewer that mounts its toolbar and renders no
// document rather than a page that fails halfway.
//
// Needed in both realms for the ordinary reason — a worker inherits nothing
// from the main thread's prototypes — and measured absent in both on iOS
// 18.6.2. Shipping in Safari 26.2 (see the header) means this one *will*
// eventually age out, unlike the stream patch above it; delete it when the
// baseline's floor rises past 26.2, and delete it on a probe of a device at
// that floor rather than on this comment.
//
// Semantics follow the proposal: insert only when the key is genuinely
// absent, so a stored \`undefined\` is not overwritten — \`has\` rather than a
// \`get(key) === undefined\` test, which is the one way to get this wrong. The
// computed form calls its callback only on a miss, which is the whole point
// of the method, and passes the key through as the proposal specifies.
if (typeof Map.prototype.getOrInsert !== "function") {
  Map.prototype.getOrInsert = function (key, value) {
    if (!this.has(key)) this.set(key, value);
    return this.get(key);
  };
}
if (typeof Map.prototype.getOrInsertComputed !== "function") {
  Map.prototype.getOrInsertComputed = function (key, callback) {
    if (!this.has(key)) this.set(key, callback(key));
    return this.get(key);
  };
}
`;

// The main thread's own copy: executed immediately on import, from the same
// source string the worker gets, so there is exactly one place these patches
// are written rather than two copies that can drift.
new Function(WEBKIT_POLYFILL_SOURCE)();
