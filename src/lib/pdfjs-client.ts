"use client";

// Must be the first import: it patches `ReadableStream`'s async iteration,
// which WebKit has never implemented and pdfjs needs in both realms. The named
// import (rather than a bare side-effect one) is so ensurePdfWorker below can
// reuse the same source string for the worker's own realm. See the polyfill
// file for the full story, including the two patches that used to live beside
// it and left when the baseline moved to Safari 26 / iPadOS 18.4+.
import { WEBKIT_POLYFILL_SOURCE } from "./pdfjs-webkit-polyfills";
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
 * The vendor script's own URL still comes from `new URL(…, import.meta.url)`,
 * which is the form a bundler rewrites to the emitted asset — so this survives
 * Turbopack with no copy step into `public/` and no guessable path. (Contrast
 * src/lib/pdf-extract.ts, where the *server* must defeat that same static
 * analysis, because there the file is read from node_modules at runtime rather
 * than bundled.)
 *
 * Without a worker at all, pdfjs falls back to parsing on the main thread —
 * a visibly frozen tab on a large PDF rather than an error, hence the warning.
 *
 * **`workerSrc` is a Blob URL we build, not the vendor file's URL directly.**
 * The worker is its own JS realm and doesn't inherit the main thread's
 * prototype patches, and there's no hook to run code before the vendor
 * script's own top-level body does — so the polyfill has to already be
 * installed by the time that body runs. A local wrapper module (its only job
 * importing the polyfill, then the vendor script) doesn't survive Turbopack
 * the way the vendor URL above does: `new URL(literal, import.meta.url)` only
 * gets bundler treatment for a package's own pre-built, dependency-free
 * asset, which is what let the original one-liner here work at all. Point it
 * at a local `.ts` file with an `import` of its own and Turbopack just copies
 * it verbatim, unparsed — pdfjs then fails with `Failed to fetch dynamically
 * imported module`, not with anything naming the real cause. Building the
 * script as a Blob sidesteps bundling entirely: a module worker can `import`
 * a full URL with no resolution step, so one import of the polyfill (itself a
 * Blob) followed by one of the vendor script's URL is a complete,
 * self-contained module with nothing left for a bundler to get wrong —
 * **provided that URL is genuinely absolute.** Turbopack's dev-mode rewrite of
 * `new URL(literal, import.meta.url).href` yields a root-relative path
 * (`/_next/static/media/…mjs`), not a scheme-and-host URL, and a relative
 * specifier inside a Blob module's `import` fails with `Failed to resolve
 * module specifier … Invalid relative url or base scheme isn't hierarchical`
 * — a `blob:` URL doesn't count as a hierarchical base for module resolution.
 * Re-resolving against `window.location.href` (itself always absolute) is
 * what forces a real one, whether Turbopack's own rewrite happened to be
 * relative (dev) or already absolute (prod) — resolving an already-absolute
 * URL against another base is a no-op, so this is safe either way.
 */
export function ensurePdfWorker(): void {
  if (workerReady) return;
  workerReady = true;
  try {
    const vendorWorkerUrl = new URL(
      new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href,
      window.location.href,
    ).href;
    // **The polyfill is its own module, imported first — not inlined above the
    // vendor import.** A module's static imports are hoisted and evaluated
    // before its own body, so the obvious spelling
    // (`<polyfill source>` then `import "<vendor>"`) runs the vendor worker
    // script *first* and the patches second — the reverse of what it reads as.
    //
    // Nothing currently depends on getting this right: the one surviving patch
    // is needed before pdfjs's first *call*, not during its module evaluation,
    // so it lands in time either way. It is spelled correctly anyway because
    // the inlined form was wrong-by-luck rather than by design, and a patch
    // that does need evaluation-time ordering is exactly the kind that fails
    // with a ReferenceError out of vendor code naming none of ours. Two static
    // imports in source order cost one extra Blob and remove the trap.
    const polyfillUrl = URL.createObjectURL(new Blob([WEBKIT_POLYFILL_SOURCE], { type: "text/javascript" }));
    const workerSource = `import ${JSON.stringify(polyfillUrl)};\nimport ${JSON.stringify(vendorWorkerUrl)};\n`;
    const blob = new Blob([workerSource], { type: "text/javascript" });
    // Never revoked: ensurePdfWorker only ever runs once (the `workerReady`
    // guard above), and every PDFWorker for the rest of the page's life —
    // one per open document — is created against this same workerSrc.
    // Revoking it after first use would break the second PDF opened.
    pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
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
