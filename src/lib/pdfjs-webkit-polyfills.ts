// The one built-in pdfjs-dist needs that WebKit does not have.
//
// **Baseline: Safari 26 / iPadOS 18.4+.** Two more patches used to live here —
// the `Iterator` global and `Map.prototype.getOrInsert`/`.getOrInsertComputed`
// — and both were deleted when that baseline was set, because Safari has
// shipped both since 18.4. `scripts/probe-engine.ts` is what established that,
// by feature-probing a real Safari in both realms rather than reading release
// notes; docs/PDF.md §10 records the measurement. Re-run it on a `pdfjs-dist`
// bump instead of adding a patch on suspicion — and delete a patch the same
// way, on a measurement rather than an assumption that everyone has updated.
//
// What is left is not a version lag and will not age out the way those two
// did: WebKit has *never* implemented
// `ReadableStream.prototype[Symbol.asyncIterator]`, and Safari 26.6.1 still
// lacks it on the main thread and in workers alike.
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
`;

// The main thread's own copy: executed immediately on import, from the same
// source string the worker gets, so there is exactly one place these patches
// are written rather than two copies that can drift.
new Function(WEBKIT_POLYFILL_SOURCE)();
