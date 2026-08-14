// Copies pdfjs's runtime data files into public/ (PLAN.md §19).
//
// pdfjs ships two directories it fetches over HTTP at render time rather than
// bundling:
//
//   standard_fonts/  the 14 base Type1 fonts. A PDF that uses Helvetica or
//                    Times without embedding it — which is most older and most
//                    machine-generated documents — renders with substituted
//                    glyphs otherwise, and logs
//                    "Ensure that the `standardFontDataUrl` API parameter is
//                    provided." once per document.
//   cmaps/           character maps for CJK encodings. Without them a
//                    Japanese or Chinese PDF renders as blank boxes.
//
// Neither can come through the bundler: they are fetched by URL at runtime,
// from paths pdfjs builds by concatenation, so there is no import for a
// bundler to see. Copying them into public/ is pdfjs's own documented
// deployment step.
//
// **The copies are gitignored**, the same treatment scripts/build-icons.ts's
// output gets and for the same reason: they are a build product of a pinned
// dependency, not repository content. That makes this a *required* build step
// rather than a convenience — hence `prebuild` and `predev` in package.json,
// so it is impossible to run the app without having run it.
//
// Re-running is cheap and idempotent: it clears the destination first, so a
// pdfjs upgrade can't leave a stale font behind.

import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const nodeRequire = createRequire(join(process.cwd(), "package.json"));

async function main(): Promise<void> {
  // Resolved through the package's own manifest so this follows the installed
  // copy rather than assuming a node_modules layout.
  const pdfjsRoot = dirname(nodeRequire.resolve("pdfjs-dist/package.json"));
  const target = join(process.cwd(), "public", "pdfjs");

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  for (const dir of ["standard_fonts", "cmaps"]) {
    await cp(join(pdfjsRoot, dir), join(target, dir), { recursive: true });
  }

  console.log(`Copied pdfjs standard_fonts and cmaps to ${target}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
