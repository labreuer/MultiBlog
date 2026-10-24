// The blog's pages and a post's neighbours — docs/BLOG.md. `/` is page 1 of
// one listing that `/page/N` continues, and a post links to the published
// posts just older and newer than it, in the same order: newest first by
// publishedAt, ties broken by id.
//
// The other specs publish posts "now" and delete them as they go, so how many
// pages there are, and what is on each, moves under this file while it runs.
// So its own posts are dated 1999, older than anything else the suite makes
// (date-archive.spec.ts and search.spec.ts use 2001). That pins them to the
// end of the listing, where they are always the last twelve posts whatever
// is above them. The page checks retry, since a post published elsewhere
// between two reads can move a page boundary.
//
// Fixture rows bypass the server actions' revalidatePath, so every visit goes
// through freshGoto (fixtures.ts) rather than a plain goto.
import type { Page } from "@playwright/test";
import { test, expect, freshGoto } from "./fixtures";
import { ADMIN_EMAIL, createTestPost, deleteTestPost, type TestPost } from "./db";

const HOUR = 3_600_000;
const BASE = Date.parse("1999-01-01T00:00:00.000Z");
// Hours after BASE, one post each. Two share hour 5, so the tie break decides
// their order.
const OFFSETS = [0, 1, 2, 3, 4, 5, 5, 6, 7, 8, 9, 10];

type Fixture = TestPost & { path: string; publishedAt: number };

/** The listing's order: newest first, ties broken by id, descending. */
function listingOrder(posts: Fixture[]): Fixture[] {
  return [...posts].sort((a, b) => b.publishedAt - a.publishedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

function pager(page: Page) {
  return page.getByRole("navigation", { name: "Pages of posts" }).first();
}

function neighbours(page: Page) {
  return page.getByRole("navigation", { name: "Older and newer posts" });
}

/** The titles of the posts listed on the page, in order. */
async function listedTitles(page: Page): Promise<string[]> {
  return page.locator("article h2").allTextContents();
}

test.describe("pages of posts, and a post's neighbours", () => {
  let fixtures: Fixture[] = [];
  let ordered: Fixture[] = [];

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    fixtures = await Promise.all(
      OFFSETS.map(async (hours) => {
        const publishedAt = BASE + hours * HOUR;
        const post = await createTestPost({
          authorEmail: ADMIN_EMAIL,
          publish: true,
          publishedAt: new Date(publishedAt).toISOString(),
          bodyText: "A paginated post about the Antonine Wall.",
        });
        return { ...post, path: post.path!, publishedAt };
      }),
    );
    ordered = listingOrder(fixtures);
  });

  test.afterAll(async () => {
    await Promise.all(fixtures.map((post) => deleteTestPost(post.id)));
  });

  test("the landing page links to page 2", async ({ page }) => {
    await freshGoto(page, "/");
    await expect(pager(page).getByRole("link", { name: "← Older posts" })).toHaveAttribute("href", "/page/2");
    await expect(pager(page)).toContainText(/Page 1 of \d+/);
    await expect(pager(page).getByRole("link", { name: "Newer posts →" })).toHaveCount(0);
  });

  test("the last page ends the listing with the oldest posts, in order", async ({ page }) => {
    await expect(async () => {
      await freshGoto(page, "/page/2");
      const position = (await pager(page).locator("span", { hasText: /^Page \d+ of \d+$/ }).textContent()) ?? "";
      const last = Number(/of (\d+)$/.exec(position)?.[1]);
      expect(last).toBeGreaterThanOrEqual(2);

      await freshGoto(page, `/page/${last}`);
      await expect(pager(page)).toContainText(`Page ${last} of ${last}`, { timeout: 2_000 });
      await expect(pager(page).getByRole("link", { name: "← Older posts" })).toHaveCount(0);
      await expect(pager(page).getByRole("link", { name: "Newer posts →" })).toHaveAttribute(
        "href",
        last === 2 ? "/" : `/page/${last - 1}`,
      );
      // At most ten posts here, all of them this file's: the oldest twelve.
      const onLast = await listedTitles(page);
      expect(onLast.length).toBeGreaterThan(0);
      expect(onLast).toEqual(ordered.slice(ordered.length - onLast.length).map((post) => post.title));

      // The rest of the twelve end the page before, with nothing repeated or
      // skipped at the boundary, wherever the tied pair fell.
      const remaining = ordered.length - onLast.length;
      await freshGoto(page, last === 2 ? "/" : `/page/${last - 1}`);
      const before = await listedTitles(page);
      const tail = ordered.slice(Math.max(0, remaining - before.length), remaining).map((post) => post.title);
      expect(before.slice(before.length - tail.length)).toEqual(tail);
    }).toPass({ timeout: 45_000 });
  });

  test("each post links to the posts on either side of it, ties included", async ({ page }) => {
    // The tied pair, which only the id tells apart, and the oldest post of
    // all, which has nothing older.
    const tied = fixtures.filter((post) => post.publishedAt === BASE + 5 * HOUR);
    const oldest = ordered[ordered.length - 1];
    for (const post of [...tied, oldest]) {
      const at = ordered.indexOf(post);
      const older = ordered[at + 1];
      const newer = ordered[at - 1];
      await freshGoto(page, post.path);
      const nav = neighbours(page);
      if (older) {
        await expect(nav.getByRole("link", { name: `← Older ${older.title}` })).toHaveAttribute("href", older.path);
      } else {
        await expect(nav.getByRole("link", { name: /^← Older/ })).toHaveCount(0);
      }
      await expect(nav.getByRole("link", { name: `Newer → ${newer.title}` })).toHaveAttribute("href", newer.path);
    }
  });

  test("following Older and then Newer comes back to the same post", async ({ page }) => {
    const start = ordered[3];
    await freshGoto(page, start.path);
    await neighbours(page).getByRole("link", { name: /^← Older/ }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(ordered[4].path);
    await neighbours(page).getByRole("link", { name: /^Newer →/ }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(start.path);
  });

  test("a page number that isn't one, or is past the end, 404s, and page 1 is the landing page", async ({ page }) => {
    const first = await page.request.get("/page/1", { maxRedirects: 0 });
    expect(first.status()).toBe(308);
    expect(new URL(first.headers()["location"], "http://x").pathname).toBe("/");

    for (const path of ["/page", "/page/0", "/page/01", "/page/-2", "/page/2.5", "/page/abc", "/page/99999"]) {
      const response = await page.request.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(404);
    }
  });
});
