import type { MetadataRoute } from "next";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SITE_TITLE } from "@/lib/site-config";

// Replaces the static site.webmanifest a favicon generator would normally
// hand you, for one reason: public/ files get none of Next's automatic
// content-hashing (only src/app/icon.png and its siblings do — see
// scripts/build-icons.ts's header comment and docs/FAVICON.md). Hashing
// these URLs ourselves means a changed icon set gets a new manifest icon URL
// instead of getting stuck behind whatever a browser or OS icon cache
// already has for today's bytes — the same staleness problem
// docs/FAVICON.md's whole design exists to avoid, just for the PWA/
// home-screen icons rather than the tab favicon.
async function hashedIconUrl(relPath: string): Promise<string | null> {
  try {
    const bytes = await readFile(path.join(process.cwd(), "public", relPath));
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
    return `/${relPath}?v=${hash}`;
  } catch {
    // No icon installed (a fresh clone, or scripts/build-icons.ts never
    // run) — degrade to a manifest with no icons, same as SITE_BANNER
    // unset rendering nothing (§17b), rather than a broken image reference.
    return null;
  }
}

// Matches WHITE_BACKGROUND in scripts/build-icons.ts — the opaque
// background the maskable icons are composited onto (icon.png and friends
// stay transparent; maskable can't, see that script's header comment).
// Kept as a literal rather than imported: the build script isn't something
// manifest.ts (which runs in the request/build path) should depend on.
const BACKGROUND_COLOR = "#ffffff";

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const [any192, any512, maskable192, maskable512] = await Promise.all(
    ["icons/icon-192.png", "icons/icon-512.png", "icons/maskable-192.png", "icons/maskable-512.png"].map(
      hashedIconUrl,
    ),
  );

  const icons: MetadataRoute.Manifest["icons"] = [];
  if (any192) icons.push({ src: any192, sizes: "192x192", type: "image/png", purpose: "any" });
  if (any512) icons.push({ src: any512, sizes: "512x512", type: "image/png", purpose: "any" });
  if (maskable192) icons.push({ src: maskable192, sizes: "192x192", type: "image/png", purpose: "maskable" });
  if (maskable512) icons.push({ src: maskable512, sizes: "512x512", type: "image/png", purpose: "maskable" });

  return {
    name: SITE_TITLE,
    short_name: SITE_TITLE,
    icons,
    theme_color: BACKGROUND_COLOR,
    background_color: BACKGROUND_COLOR,
    display: "standalone",
  };
}
