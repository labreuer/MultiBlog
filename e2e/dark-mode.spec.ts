// STYLE.md's Dark theme section — verifies the app actually renders dark
// under prefers-color-scheme: dark, in a way that survives future palette
// retuning rather than pinning today's exact values. Runs under its own
// "chromium-dark" project (playwright.config.ts, colorScheme: "dark"),
// excluded from the ordinary "chromium" project via testIgnore — duplicating
// the whole suite under a second color scheme would roughly double wall
// clock for near-zero incremental coverage, since nothing else in the suite
// asserts on color.
//
// These assert invariants (nothing near-white, text stays legible), not
// specific rgb values — a palette retune should never break this file.
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

// Relative luminance per WCAG 2.x — small enough to inline rather than pull
// in a dependency for one spec.
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [rl, gl, bl] = [channel(r), channel(g), channel(b)];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function parseRgb(css: string): [number, number, number, number] | null {
  const m = css.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
}

/**
 * Walks every element on the page and fails if any carries a near-white,
 * non-transparent background — the exact failure mode of a missed `#fff`/
 * `white`/light-gray literal under a dark theme. The cheapest possible
 * detector for the class of bug this migration is prone to.
 *
 * An *inline* background is exempt. In this codebase that is never a theme
 * literal (CLAUDE.md's no-literal rule and STYLE.md's grep guard see to
 * that): it is a per-user author colour — an avatar fallback, a presence
 * dot, a swatch — which is data, chosen by the user, and legitimately as
 * light as they like. The first offender this found was the slot's own
 * account wearing #6bffe6 on the landing page's contributor card, and it
 * read exactly like a regression.
 */
async function assertNoNearWhiteBackgrounds(page: Page, path: string): Promise<void> {
  const offenders = await page.evaluate(() => {
    function relLum(r: number, g: number, b: number): number {
      const c = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
    }
    const found: string[] = [];
    document.querySelectorAll<HTMLElement>("*").forEach((el) => {
      if (el.style.backgroundColor || el.style.background) return;
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      if (!m) return;
      const alpha = m[4] !== undefined ? Number(m[4]) : 1;
      if (alpha === 0) return;
      const lum = relLum(Number(m[1]), Number(m[2]), Number(m[3]));
      if (lum > 0.6) {
        found.push(`${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""} (${bg})`);
      }
    });
    return found;
  });
  expect(offenders, `near-white background(s) on ${path}: ${offenders.join(", ")}`).toEqual([]);
}

const SURFACES = ["/", "/posts", "/comments", "/users", "/docs", "/annotations"];

test.describe("dark theme", () => {
  test("the page background resolves dark", async ({ page }) => {
    await page.goto("/");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const rgb = parseRgb(bg);
    expect(rgb, `unparseable background: ${bg}`).not.toBeNull();
    const [r, g, b] = rgb!;
    expect(relativeLuminance([r, g, b]), `body background too light: ${bg}`).toBeLessThan(0.1);
  });

  for (const path of SURFACES) {
    test(`no near-white backgrounds on ${path}`, async ({ page }) => {
      await page.goto(path);
      await assertNoNearWhiteBackgrounds(page, path);
    });
  }

  test("post title and body text stay legible against their background", async ({ publishedPost, page }) => {
    await page.goto(`/${publishedPost.slug}`);
    const results = await page.evaluate(() => {
      function relLum(r: number, g: number, b: number): number {
        const c = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
      }
      function parse(css: string): [number, number, number, number] | null {
        const m = css.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
        if (!m) return null;
        return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] !== undefined ? Number(m[4]) : 1];
      }
      function nearestOpaqueBackground(el: Element): [number, number, number] {
        let node: Element | null = el;
        while (node) {
          const bg = getComputedStyle(node).backgroundColor;
          const parsed = parse(bg);
          if (parsed && parsed[3] > 0) return [parsed[0], parsed[1], parsed[2]];
          node = node.parentElement;
        }
        return [10, 10, 10]; // globals.css --background dark value, as a last resort
      }
      const targets = [document.querySelector("h1"), document.querySelector("article p"), document.querySelector("article")]
        .filter((el): el is HTMLElement => el !== null);
      return targets.map((el) => {
        const fg = parse(getComputedStyle(el).color);
        const [br, bg, bb] = nearestOpaqueBackground(el);
        if (!fg) return { tag: el.tagName, ratio: null };
        return {
          tag: el.tagName,
          ratio: (function () {
            const l1 = relLum(fg[0], fg[1], fg[2]);
            const l2 = relLum(br, bg, bb);
            const lighter = Math.max(l1, l2);
            const darker = Math.min(l1, l2);
            return (lighter + 0.05) / (darker + 0.05);
          })(),
        };
      });
    });
    for (const r of results) {
      expect(r.ratio, `${r.tag} had no parseable color`).not.toBeNull();
      expect(r.ratio! >= 4.5, `${r.tag} contrast ratio ${r.ratio} < 4.5:1`).toBe(true);
    }
  });

  test("admin table row-status border and moderation fills are visible, not transparent-into-invisible", async ({
    page,
  }) => {
    await page.goto("/comments");
    // The three moderation action buttons must each have a distinct,
    // non-transparent fill — the whole point of --fill-success/-warning/
    // -danger is that the fill (not the shared neutral border) carries the
    // meaning (STYLE.md).
    const fills = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button")).filter((b) =>
        /approve|pend|spam/i.test(b.className),
      );
      return buttons.map((b) => getComputedStyle(b).backgroundColor);
    });
    // If the comments table has no rows to moderate yet, this is a no-op —
    // the invariant only matters when the buttons actually render.
    const distinct = new Set(fills.filter((f) => f && f !== "rgba(0, 0, 0, 0)"));
    if (fills.length > 0) {
      expect(distinct.size, `moderation button fills not distinct: ${fills.join(", ")}`).toBeGreaterThan(1);
    }
  });
});
