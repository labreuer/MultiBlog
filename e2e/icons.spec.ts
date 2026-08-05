// Site icons (docs/FAVICON.md): favicon/manifest links are content-hashed and
// resolve, and the one URL deliberately left un-hashed (/favicon.ico) is
// never what the page's own <link> tags point at — that's the whole
// mechanism that lets a redeploy actually change the icon instead of
// getting stuck behind a browser's favicon cache.
//
// Deliberately does NOT assert on pixel content — scripts/build-icons.ts's
// output is gitignored deployment content (a fresh clone or CI checkout may
// have none at all), so this only asserts on the shape of what Next emits:
// hashed hrefs, correct rel/type/sizes, and that everything referenced
// actually resolves. If build-icons.ts was never run, the icon files won't
// exist and Next won't emit their <link> tags at all — the assertions below
// are written to pass in that state too, same as SITE_BANNER unset (§17b)
// degrading the banner rather than 404ing it.
import { test, expect } from "./fixtures";

test("favicon/manifest links, when present, are content-hashed and resolve", async ({ page }) => {
  await page.goto("/");

  const iconLinks = page.locator('link[rel="icon"], link[rel="apple-touch-icon"]');
  const count = await iconLinks.count();

  for (let i = 0; i < count; i++) {
    const link = iconLinks.nth(i);
    const href = await link.getAttribute("href");
    expect(href).toBeTruthy();

    // Next's metadata-image loader appends the content hash as a query
    // string (`?name.<hash>.<ext>`) — verified against next@16.2.11's
    // next-metadata-image-loader.js. No hash means this <link> is pointing
    // at an unhashed URL, which is exactly the staleness bug docs/FAVICON.md
    // exists to avoid.
    expect(href, `${href} should carry Next's content-hash query`).toMatch(/\?/);

    const res = await page.request.get(href!);
    expect(res.status(), href!).toBe(200);
  }

  // The bare, un-hashed path must never be what the page's own <link> tags
  // point at — see build-icons.ts's header comment for why this is
  // deliberately public/favicon.ico rather than src/app/favicon.ico
  // (resolve-metadata.js would unshift the latter to the front of the icon
  // list).
  for (let i = 0; i < count; i++) {
    const href = await iconLinks.nth(i).getAttribute("href");
    expect(href).not.toMatch(/\/favicon\.ico(\?|$)/);
  }
});

test("manifest link, when present, resolves and its icon URLs are hashed and resolve", async ({ page }) => {
  await page.goto("/");

  const manifestLink = page.locator('link[rel="manifest"]');
  if ((await manifestLink.count()) === 0) {
    return; // app/manifest.ts is always present in this repo, but guard for a future rename
  }

  const href = await manifestLink.getAttribute("href");
  expect(href).toBeTruthy();

  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  const manifest = await res.json();

  expect(manifest.name).toBeTruthy();
  expect(Array.isArray(manifest.icons)).toBe(true);

  for (const icon of manifest.icons) {
    // manifest.ts computes this hash itself (public/ files get none of
    // Next's automatic hashing) — see that file's header comment.
    expect(icon.src, `${icon.src} should carry manifest.ts's own ?v= hash`).toMatch(/\?v=/);
    const iconRes = await page.request.get(icon.src);
    expect(iconRes.status(), icon.src).toBe(200);
  }

  // At least one maskable icon is expected once build-icons.ts has run —
  // Android's squircle crop needs it. Only assert this when icons exist at
  // all, so a from-scratch clone with no icon set doesn't fail the suite.
  if (manifest.icons.length > 0) {
    expect(manifest.icons.some((icon: { purpose?: string }) => icon.purpose === "maskable")).toBe(true);
  }
});

test("/favicon.ico resolves for clients that bypass the page's own <link> tags", async ({ page }) => {
  const res = await page.request.get("/favicon.ico");
  // 200 once build-icons.ts has run; a from-scratch clone with no icon set
  // falls through to Next's own scaffold response. Either way this must not
  // 500 — it's the fallback path, and a broken fallback is worse than a
  // missing icon.
  expect(res.status(), "GET /favicon.ico").toBeLessThan(500);
});
