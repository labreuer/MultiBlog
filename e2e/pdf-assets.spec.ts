import { test, expect } from "@playwright/test";

// PLAN.md §19 — pdfjs's runtime asset directories are actually served.
//
// **This spec exists because of a bug the rest of the suite structurally
// cannot catch.** Every PDF fixture is generated (scripts/make-test-pdf.ts) and
// therefore text-only, so none of them exercises an image decoder. The first
// cut of scripts/copy-pdfjs-assets.ts copied two of pdfjs's four asset
// directories; every test passed, and the first real *scanned* PDF rendered as
// blank pages with a working text layer floating over them — which reads as
// "the viewer is broken", not as "a decoder is missing".
//
// Asserting the assets are reachable is the cheap, deterministic guard. It also
// covers the deploy-time failure mode: a build that skipped npm lifecycle
// scripts never runs the copy at all.
//
// Unauthenticated on purpose — these are static files under public/, and if one
// ever starts needing a session that is itself worth failing on.

const REQUIRED_ASSETS = [
  // The base-14 fonts. Missing → substituted glyphs in any PDF that doesn't
  // embed its own.
  { path: "/pdfjs/standard_fonts/LiberationSans-Regular.ttf", why: "base-14 font substitution" },
  // CJK character maps. Missing → a Japanese or Chinese PDF renders as boxes.
  { path: "/pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap", why: "CJK text" },
  // The JPEG 2000 decoder. Missing → "JpxError: OpenJPEG failed to initialize"
  // and every image on a scanned page fails.
  { path: "/pdfjs/wasm/openjpeg.wasm", why: "JPEG 2000 images (scanned PDFs)" },
  // The JBIG2 decoder — the other standard scan encoding.
  { path: "/pdfjs/wasm/jbig2.wasm", why: "JBIG2 images (scanned PDFs)" },
  // Colour management, used alongside the decoders above.
  { path: "/pdfjs/wasm/qcms_bg.wasm", why: "colour management" },
  // ICC profiles, for documents that embed one.
  { path: "/pdfjs/iccs/CGATS001Compat-v2-micro.icc", why: "embedded ICC colour profiles" },
];

test.describe("pdfjs runtime assets", () => {
  for (const asset of REQUIRED_ASSETS) {
    test(`serves ${asset.path} (${asset.why})`, async ({ request }) => {
      const response = await request.get(asset.path);
      expect(response.status(), `${asset.path} is missing — run scripts/copy-pdfjs-assets.ts`).toBe(200);
      // A non-empty body, not just a 200: a directory that exists but is empty
      // would otherwise pass while still breaking every decode.
      expect((await response.body()).byteLength).toBeGreaterThan(0);
    });
  }
});
