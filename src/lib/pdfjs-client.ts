"use client";

import * as pdfjs from "pdfjs-dist";
import * as pdfjsViewer from "pdfjs-dist/web/pdf_viewer.mjs";

// PLAN.md §19 / docs/PDF.md §10 — the browser's single entry point to pdfjs.
//
// Everything that imports pdfjs in the client goes through here, so the worker
// is wired exactly once and every internal we depend on is named in one place
// (which is what e2e/pdfjs-internals.spec.ts asserts against).
//
// **`pdfjs-dist/web/pdf_viewer.mjs`, not `PDFViewerApplication`.** docs/PDF.md
// §10 names the latter, and it isn't importable: it is the bundled
// `web/viewer.html` *application*, not a library entry. `PDFViewer` +
// `EventBus` + `PDFLinkService` is the library-level equivalent and exposes
// every internal §5 and §8 rely on. The version-pinning discipline §10 asks for
// applies unchanged — these are still internals with no stability promise.

export { pdfjs, pdfjsViewer };

/** The pinned pdfjs version, for the `textVersion` stamp (src/lib/pdf-text.ts). */
export const PDFJS_VERSION = pdfjs.version;

let workerReady = false;

/**
 * Points pdfjs at its worker. Idempotent, and called before the first
 * `getDocument`.
 *
 * **`workerSrc` (a URL), not `workerPort` (a live Worker) — and the difference
 * is a lifetime bug, not a style preference.** A `workerPort` is *shared*:
 * pdfjs wraps whatever port it is given in one PDFWorker, and destroying a
 * `PDFDocumentLoadingTask` marks that PDFWorker destroyed. The next
 * `getDocument` then dies with
 *
 *     PDFWorker.create - the worker is being destroyed.
 *     Please remember to await `PDFDocumentLoadingTask.destroy()`-calls.
 *
 * which reads like a missing `await` in our teardown and isn't. Any second
 * mount triggers it — React StrictMode's double-invoked effects in
 * development, or simply navigating between two PDFs — so the viewer would
 * open exactly once per page load. With `workerSrc`, pdfjs does
 * `new Worker(src, { type: "module" })` per PDFWorker and owns the lifetime
 * itself, which is what makes mount/unmount/remount safe.
 *
 * The URL still comes from `new URL(…, import.meta.url)`, which is the form a
 * bundler rewrites to the emitted asset — so this survives Turbopack with no
 * copy step into `public/` and no guessable path. (Contrast
 * src/lib/pdf-extract.ts, where the *server* must defeat that same static
 * analysis, because there the file is read from node_modules at runtime rather
 * than bundled.)
 *
 * Without a worker at all, pdfjs falls back to parsing on the main thread —
 * a visibly frozen tab on a large PDF rather than an error, hence the warning.
 */
export function ensurePdfWorker(): void {
  if (workerReady) return;
  workerReady = true;
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
  } catch (err) {
    console.warn("[pdfjs-client] couldn't locate the PDF worker; parsing will block the main thread:", err);
  }
}

// Where scripts/copy-pdfjs-assets.ts puts pdfjs's runtime data files. Absolute
// site paths with trailing slashes — pdfjs concatenates a filename directly
// onto each, so a missing slash silently produces `…standard_fontsFoxitSans`.
// An *unset* one concatenates onto `null`, which is how a missing `wasmUrl`
// surfaces: `Failed to resolve module specifier 'nullopenjpeg_nowasm_fallback.js'`.
//
// Not `new URL(…, import.meta.url)` like the worker above: these are fetched by
// URLs pdfjs *builds*, so there is no import for a bundler to see and nothing
// to emit. That is the whole reason the copy step exists.
const STANDARD_FONT_DATA_URL = "/pdfjs/standard_fonts/";
const CMAP_URL = "/pdfjs/cmaps/";
const WASM_URL = "/pdfjs/wasm/";
const ICC_URL = "/pdfjs/iccs/";

/** Options every `getDocument` in the browser shares. */
export function documentOptions(url: string): Parameters<typeof pdfjs.getDocument>[0] {
  return {
    url,
    // All four of pdfjs's runtime asset directories. See
    // scripts/copy-pdfjs-assets.ts for what each one is for; the one that
    // matters most is `wasmUrl`, which carries the JBIG2 and JPEG 2000
    // decoders. **A scanned PDF is images**, so without it every page renders
    // blank — with a working text layer floating over the blankness, which
    // reads as "the PDF isn't loading" rather than as a decoder problem.
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    wasmUrl: WASM_URL,
    iccUrl: ICC_URL,
    // Range requests are why the download route implements them (PLAN.md §19):
    // a large PDF renders its first page without transferring the whole file.
    // `disableAutoFetch` stops pdfjs then quietly fetching the rest in the
    // background, which would give back everything ranges just saved.
    disableAutoFetch: true,
    disableStream: false,
    // Same reasoning as the server side: a PDF is a complex format from outside
    // the trust boundary, and nothing here needs system fonts.
    useSystemFonts: false,
    // Served from the app's own origin so the session cookie rides along; the
    // download route is session-gated.
    withCredentials: true,
  };
}
