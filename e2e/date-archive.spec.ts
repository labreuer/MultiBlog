// The date archives — PLAN.md §21h. `/yyyy`, `/yyyy/mm` and `/yyyy/mm/dd`
// list what was published in that UTC range; the byline's date on every
// listing and on the post page links to the day's archive and carries the
// full UTC timestamp as its tooltip; a malformed prefix 404s before any
// query; a trailing slash lands on the bare URL.
//
// The fixture post is dated 2001-02-03 — far enough in the past that no
// other spec's "published now" post can land in the same year, so the year
// page's contents are exactly this file's. Fixture rows bypass the server
// actions' revalidatePath, so every archive visit goes through freshGoto
// (fixtures.ts) rather than a plain goto.
import { test, expect, freshGoto, gotoOk } from "./fixtures";
import { ADMIN_EMAIL, createTestPost, deleteTestPost, type TestPost } from "./db";

const PUBLISHED_AT = "2001-02-03T04:05:06.000Z";
const DAY_PATH = "/2001/02/03";

test.describe("date archives", () => {
  let post: TestPost;

  test.beforeAll(async () => {
    post = await createTestPost({
      authorEmail: ADMIN_EMAIL,
      publish: true,
      publishedAt: PUBLISHED_AT,
      bodyText: "An archived post about the Anglo-Saxon shore forts.",
    });
    expect(post.path).toBe(`${DAY_PATH}/${post.slug}`);
  });

  test.afterAll(async () => {
    if (post) await deleteTestPost(post.id);
  });

  for (const path of ["/2001", "/2001/02", DAY_PATH]) {
    test(`${path} lists the post with a byline date linking to its day`, async ({ page }) => {
      await freshGoto(page, path);
      const article = page.locator("article").filter({ hasText: post.title });
      await expect(article).toHaveCount(1);
      await expect(article.getByRole("link", { name: post.title })).toHaveAttribute("href", post.path!);
      await expect(article).toContainText("shore forts");

      const date = article.getByRole("link", { name: "2001-02-03" });
      await expect(date).toHaveAttribute("href", DAY_PATH);
      await expect(date).toHaveAttribute("title", "2001-02-03 04:05:06 UTC");
    });
  }

  test("breadcrumbs climb from the day to the month, the year and the front page", async ({ page }) => {
    await freshGoto(page, DAY_PATH);
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs.getByRole("link", { name: "All posts" })).toHaveAttribute("href", "/");
    await expect(crumbs.getByRole("link", { name: "2001", exact: true })).toHaveAttribute("href", "/2001");
    await expect(crumbs.getByRole("link", { name: "02", exact: true })).toHaveAttribute("href", "/2001/02");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("2001-02-03");

    await freshGoto(page, "/2001");
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("2001");
  });

  test("a day that exists but has no posts is a page, not a 404", async ({ page }) => {
    await freshGoto(page, "/2001/02/04");
    await expect(page.getByText("No posts published in 2001-02-04.")).toBeVisible();
    await expect(page.locator("article")).toHaveCount(0);
  });

  test("a trailing slash lands on the bare URL", async ({ page }) => {
    for (const path of ["/2001/", "/2001/02/", `${DAY_PATH}/`, `${post.path}/`]) {
      await gotoOk(page, path);
      expect(new URL(page.url()).pathname).toBe(path.slice(0, -1));
    }
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(post.title);
  });

  test("a malformed prefix 404s", async ({ page }) => {
    for (const path of ["/2001/13", "/2001/2/3", "/2001/02/30", "/20011", "/0050", "/tag", "/2001/feb"]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
    }
  });

  test("the post page and a search result link their date to the day's archive", async ({ page }) => {
    await gotoOk(page, post.path!);
    const date = page.getByRole("link", { name: "2001-02-03" });
    await expect(date).toHaveAttribute("href", DAY_PATH);
    await expect(date).toHaveAttribute("title", "2001-02-03 04:05:06 UTC");
    await date.click();
    await expect(page).toHaveURL(DAY_PATH);
    await expect(page.locator("article").filter({ hasText: post.title })).toHaveCount(1);

    await page.goto(`/search?q=${encodeURIComponent(post.title)}`);
    const result = page.locator("article").filter({ hasText: post.title });
    await expect(result.getByRole("link", { name: "2001-02-03" })).toHaveAttribute("href", DAY_PATH);
  });
});
