// pdfjs-dist 6.x calls the TC39 "Map upsert" methods — Map.prototype.getOrInsert
// and .getOrInsertComputed — pervasively, on the main thread and inside its own
// worker script alike. Those methods shipped in V8/Node before they did in
// every WebKit release, so an iPad on an older iPadOS throws
// `this.something.getOrInsertComputed is not a function` the moment pdfjs
// touches either realm's Map.prototype for the first time.
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
export const MAP_UPSERT_POLYFILL_SOURCE = `
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
// source string the worker gets, so there is exactly one place this patch is
// written rather than two copies that can drift.
new Function(MAP_UPSERT_POLYFILL_SOURCE)();
