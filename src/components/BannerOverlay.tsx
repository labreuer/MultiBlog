import { readFile } from "node:fs/promises";
import type { ReactNode } from "react";
import { resolveOneOfs } from "@/lib/banner-overlay";
import { SITE_BANNER_OVERLAY, SITE_BANNER_OVERLAY_CSS } from "@/lib/site-banner";

// The banner overlay (docs/BLOG.md, "The banner overlay"), read on each
// render. Both files reach the browser as written: only someone with a shell
// on the box writes them, the same trust as .env. Either unreadable and there
// is no overlay, with the reason logged: words without their placing would
// land anywhere on the image.
export async function loadBannerOverlay(): Promise<ReactNode> {
  if (!SITE_BANNER_OVERLAY) return null;
  try {
    const [html, css] = await Promise.all([
      readFile(SITE_BANNER_OVERLAY, "utf8"),
      SITE_BANNER_OVERLAY_CSS ? readFile(SITE_BANNER_OVERLAY_CSS, "utf8") : null,
    ]);
    const picked = resolveOneOfs(html, (count) => Math.floor(Math.random() * count));
    return (
      <>
        {css !== null && <style dangerouslySetInnerHTML={{ __html: css }} />}
        {/* A plain class, not a CSS Module's: the deployment's stylesheet names it. */}
        <div className="banner-overlay" dangerouslySetInnerHTML={{ __html: picked }} />
      </>
    );
  } catch (error) {
    console.error(`[banner-overlay] ${error instanceof Error ? error.message : error} — no overlay is shown.`);
    return null;
  }
}
