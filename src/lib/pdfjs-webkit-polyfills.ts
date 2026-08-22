// Patches for built-ins pdfjs-dist uses that WebKit ships late or not at all.
// Both of the ones here were found on a real iPad and are invisible to every
// local check, because a chromium-only e2e suite runs the one engine that has
// them. e2e/pdf-webkit-gaps.spec.ts is what covers them now: it deletes each
// built-in in chromium and asserts the viewer still works.
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
// by building the worker's script as a Blob at runtime instead: this source,
// followed by an `import` of the vendor worker's own resolved absolute URL —
// which a module worker can load with no bundler involved at all.
//
// Being a source string, this is plain JS and cannot use TypeScript syntax.
export const WEBKIT_POLYFILL_SOURCE = `
// --- Map upsert (TC39) ---------------------------------------------------
// pdfjs-dist 6.x calls Map.prototype.getOrInsert and .getOrInsertComputed
// pervasively, on the main thread and inside its own worker script alike.
// Those methods shipped in V8/Node before they did in every WebKit release,
// so an iPad on an older iPadOS throws
// \`this.something.getOrInsertComputed is not a function\` the moment pdfjs
// touches either realm's Map.prototype for the first time.
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
