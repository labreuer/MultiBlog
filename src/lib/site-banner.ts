// Landing-page banner config (PLAN.md §17b). Deliberately its own module,
// not folded into site-config.ts: SiteHeader.tsx imports that module and is
// a "use client" component, which is exactly why SITE_TITLE there is
// NEXT_PUBLIC_-prefixed — only those vars are inlined into the browser
// bundle. A bare process.env read added to that file would silently resolve
// to undefined in the browser. Keeping server-only values in their own
// module makes "never readable from the client" a property of the file
// rather than a comment on a line.
//
// Bare (not NEXT_PUBLIC_) is also the better operational fit: DEPLOY.md §4
// warns every NEXT_PUBLIC_ var is baked in at `npm run build`, so changing
// one needs a rebuild. These are read server-side only, so changing them
// needs a service restart and nothing more — and swapping the image file
// itself needs neither, since public/ is served from the project directory
// at runtime.
export const SITE_BANNER = process.env.SITE_BANNER?.trim() || null;
export const SITE_BANNER_ASPECT = process.env.SITE_BANNER_ASPECT?.trim() || "3 / 1";
export const SITE_BANNER_ALT = process.env.SITE_BANNER_ALT?.trim() || "";
