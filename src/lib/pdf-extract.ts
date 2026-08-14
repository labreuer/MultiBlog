import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { normalisePageText, textVersionFor, type PdfTextItemLike } from "./pdf-text";

// PLAN.md §19 — the server-side half of PDF text extraction: run once per file
// at upload, its output stored in `file_page_text`.
//
// Server-only (see src/lib/file-storage.ts for the convention). It pulls in
// pdfjs's **legacy** build, which is the one built for a non-DOM environment;
// the browser viewer imports `pdfjs-dist` proper instead. Both resolve to the
// same pinned version, and both feed the same normalisePageText, so the text
// this produces and the text the browser computes at selection time are the
// same string by construction rather than by convention.
//
// Why extract here at all, rather than letting the client report page text:
// `quotedText` has to be derived server-side to keep §12i's "the selected text
// is a request field only, never a column" true (PLAN.md §19, Phase 3). Doing
// that per annotation would mean re-parsing the PDF on every post; doing it
// once at upload makes it a string slice.

// Resolving pdfjs's own files (its worker, its standard fonts) by path, in a
// way that survives Next's bundler.
//
// **Two things here are deliberate and both are load-bearing.**
//
// 1. `createRequire` is anchored at the *project root*, not at `import.meta.url`.
//    Under Turbopack this module's own URL is a bundler-internal id, so
//    resolution relative to it doesn't reach node_modules at all.
// 2. The specifier is built from a variable rather than written as a literal.
//    Turbopack statically analyses `require.resolve("pdfjs-dist/…")` and
//    rewrites it to a *virtual module id* — even with pdfjs-dist listed in
//    `serverExternalPackages`. The symptom is worth recognising, because it
//    doesn't look like a resolution problem: pdfjs receives
//    `"[externals]/pdfjs-dist/package.json [external] (…)"` and fails with
//    `Invalid factory url: … must include trailing slash`, which reads like a
//    malformed URL of ours. A non-literal specifier isn't analysable, so it is
//    left as a real runtime call.
//
// Verified against Next 16.2.11 + Turbopack: with either half written the
// obvious way, every upload fails to parse *only when served through Next* —
// the same code path run under `npx tsx` works fine, which is exactly the kind
// of gap that reaches production.
const PDFJS_PACKAGE = "pdfjs-dist";
const nodeRequire = createRequire(pathToFileURL(join(process.cwd(), "package.json")).href);

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjsPromise: Promise<PdfJsModule> | null = null;

// Lazy, and cached as the *promise* rather than the module: the import is
// expensive (a few MB of parser), most requests never need it, and two
// concurrent uploads should share one load rather than race two.
async function loadPdfjs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      // Point pdfjs at its own worker file by resolved path. Without this it
      // falls back to a "fake worker" on the main thread, which works but
      // parses a large PDF synchronously enough to block the event loop —
      // unacceptable in a request handler that another upload may be sharing.
      // Wrapped because the resolve depends on bundler behaviour: if it fails,
      // the fake worker is still correct, just slower, so this degrades rather
      // than breaking uploads outright.
      //
      // **A `file://` URL, not the bare path `resolve` returns.** pdfjs loads
      // this through a dynamic `import()`, and Node's ESM loader rejects a
      // Windows absolute path outright: *"Only URLs with a scheme in: file,
      // data, and node are supported … Received protocol 'c:'"*. On Linux the
      // bare path happens to work, so this is a Windows-only failure that would
      // otherwise surface for the first time on a developer's machine and never
      // in production — or vice versa, depending on who ran it first.
      try {
        pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
          nodeRequire.resolve(`${PDFJS_PACKAGE}/legacy/build/pdf.worker.mjs`),
        ).href;
      } catch (err) {
        console.warn("[pdf-extract] couldn't resolve the pdfjs worker; falling back to in-process parsing:", err);
      }
      return pdfjs;
    })();
  }
  return pdfjsPromise;
}

// Directory pdfjs loads the 14 standard font files from, with a trailing slash.
// Resolved off the package's own package.json so it follows the installed copy
// rather than assuming a node_modules layout.
//
// **A plain filesystem path, NOT a file:// URL — the exact opposite of
// `workerSrc` above.** Both are "where is this file", both are set on the same
// library, and they want different spellings: `workerSrc` goes through Node's
// ESM loader, which rejects a bare Windows path; this goes through pdfjs's own
// Node data factory, which does a filesystem read and cannot handle a URL. Get
// it wrong and the only symptom is a per-document
// `Unable to load font data at: file:///…` warning — text extraction still
// works, so it reads as harmless noise rather than as a misconfiguration.
// Verified both ways against 6.2.108.
let standardFontDir: string | null = null;

function standardFontDataUrl(): string {
  if (standardFontDir === null) {
    const packageJson = nodeRequire.resolve(`${PDFJS_PACKAGE}/package.json`);
    standardFontDir = packageJson.replace(/package\.json$/, "standard_fonts/");
  }
  return standardFontDir;
}

export type ExtractedPdf = {
  pageCount: number;
  textVersion: string;
  /** Normalised text per page, index 0 = page 1. Always `pageCount` entries; a page with no text is "". */
  pages: string[];
};

/**
 * Parses a PDF's structure and text. Throws on a file pdfjs can't open at all,
 * which the upload route turns into a 415 — a file that passed the `%PDF-`
 * magic check but is truncated or corrupt gets caught here rather than being
 * stored and failing later in someone's browser.
 */
export async function extractPdf(bytes: Uint8Array): Promise<ExtractedPdf> {
  const pdfjs = await loadPdfjs();

  const task = pdfjs.getDocument({
    // A copy, because pdfjs transfers ownership of the buffer it is given and
    // the caller may still be holding the original (the upload route hashes it
    // and writes it to disk).
    data: new Uint8Array(bytes),
    // The untrusted-input posture. The uploader is an authenticated AUTHOR+,
    // but a PDF is still a complex format from outside the trust boundary and
    // this parse runs on the server.
    //
    // `isEvalSupported: false` used to belong here and is **gone in pdfjs 6** —
    // not ignored, removed from DocumentInitParameters, because the eval-based
    // font path it disabled no longer exists. Setting it is now a type error
    // rather than a silent no-op, which is the good version of docs/PDF.md
    // §10's version coupling.
    useSystemFonts: false,
    disableAutoFetch: true,
    // Required even though nothing is rendered: pdfjs resolves the 14 standard
    // Type1 fonts through this to build a glyph map, and without it every
    // document using Helvetica logs *"Ensure that the `standardFontDataUrl` API
    // parameter is provided."* and falls back to a guess. A `file://` URL with
    // a trailing slash — pdfjs concatenates a filename onto it directly.
    standardFontDataUrl: standardFontDataUrl(),
  });

  const pdf = await task.promise;
  try {
    const pageCount = pdf.numPages;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        // getTextContent returns (TextItem | TextMarkedContent)[]; only the
        // former carries text. Narrowed by structure rather than by pdfjs's
        // exported type names, and copied field by field into our own shape —
        // which doubles as the explicit statement of exactly what the
        // normaliser depends on, so a pdfjs field rename shows up here rather
        // than as subtly different text.
        const items: PdfTextItemLike[] = [];
        for (const item of content.items) {
          if (!("str" in item)) continue;
          items.push({
            str: item.str,
            transform: item.transform,
            width: item.width,
            height: item.height,
            hasEOL: item.hasEOL,
          });
        }
        pages.push(normalisePageText(items).text);
      } finally {
        page.cleanup();
      }
    }
    return { pageCount, textVersion: textVersionFor(pdfjs.version), pages };
  } finally {
    // Releases the worker's copy of the document. Skipping this leaks a worker
    // per upload, which on a long-lived server is the difference between
    // steady memory and a slow climb.
    //
    // **On the loading task, not the document proxy.** `PDFDocumentProxy` had a
    // `destroy()` in older pdfjs and does not in 6.x — it has `cleanup()`,
    // which only drops cached fonts and leaves the worker alive. Calling the
    // wrong one throws `pdf.destroy is not a function` at runtime with nothing
    // at build time to catch it, which is docs/PDF.md §10's version-coupling
    // warning arriving in the least dramatic possible way.
    await task.destroy();
  }
}
