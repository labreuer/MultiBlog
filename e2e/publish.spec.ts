// PLAN.md §15 — /posts/[id]/edit no longer edits a post's own content; it
// publishes a point in its backing doc's history. Editing happens at
// /doc/[id]/edit, same as any doc.
import { test, expect, bodyEditor, gotoOk, visibleText, waitForDocCollabReady } from "./fixtures";
import { addTestDocAuthor } from "./db";

// "Publish" without `exact` also matches "Publish as blog post" elsewhere.
const PUBLISH = { name: "Publish", exact: true } as const;

async function waitForPublishReady(page: import("@playwright/test").Page): Promise<void> {
  // The scrub bar loads the doc's history asynchronously (PostSnapshotScrubBar)
  // before Publish/Schedule can do anything meaningful — see PostPublisher.tsx.
  await expect(page.getByRole("button", PUBLISH)).toBeEnabled({ timeout: 15_000 });
}

/**
 * The scrub bar opens on the *presently published* position, not the doc's
 * head (so viewing the page shows what's actually live) — so republishing the
 * latest edit means explicitly scrubbing to the end first. A no-op for a
 * post's first-ever publish, since with nothing published yet the bar already
 * defaults to the head.
 */
async function scrubToLatest(page: import("@playwright/test").Page): Promise<void> {
  const slider = page.getByLabel("Scrub through the doc's edit history");
  const max = await slider.getAttribute("max");
  await slider.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, max);
}

test.describe("publish / unpublish", () => {
  test("publishing a draft makes it readable at its public slug", async ({ page, draftPost }) => {
    await page.goto(`/posts/${draftPost.id}/edit`);
    await expect(page.getByText("Not published yet.")).toBeVisible();
    await waitForPublishReady(page);

    await page.getByRole("button", PUBLISH).click();
    await expect(page.getByText("Published.")).toBeVisible();

    await gotoOk(page, `/${draftPost.slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(draftPost.title);
    await expect(visibleText(page, draftPost.bodyText)).toBeVisible();
  });

  test("edits made after publishing only reach the public page on republish", async ({ page, draftPost }) => {
    await page.goto(`/posts/${draftPost.id}/edit`);
    await waitForPublishReady(page);
    await page.getByRole("button", PUBLISH).click();
    await expect(page.getByText("Published.")).toBeVisible();

    const addition = "A sentence added after the first publish.";
    await page.goto(`/doc/${draftPost.docId}/edit`);
    await waitForDocCollabReady(page);
    await bodyEditor(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(` ${addition}`);
    await expect(bodyEditor(page)).toContainText(addition);

    await gotoOk(page, `/${draftPost.slug}`);
    await expect(page.getByText(addition)).toHaveCount(0);

    await page.goto(`/posts/${draftPost.id}/edit`);
    await waitForPublishReady(page);
    await scrubToLatest(page);
    // The doc moved on since the last publish, so a fresh snapshot is due.
    await expect(page.getByText(/Publishing will create a new snapshot/)).toBeVisible();
    await page.getByRole("button", PUBLISH).click();
    await expect(page.getByText("Published.")).toBeVisible();

    await gotoOk(page, `/${draftPost.slug}`);
    await expect(visibleText(page, addition)).toBeVisible();
  });

  test("publishing again with no doc edits in between reuses the same snapshot", async ({ page, draftPost }) => {
    await page.goto(`/posts/${draftPost.id}/edit`);
    await waitForPublishReady(page);
    await page.getByRole("button", PUBLISH).click();
    await expect(page.getByText("Published.")).toBeVisible();

    await page.goto(`/posts/${draftPost.id}/edit`);
    await waitForPublishReady(page);
    await expect(page.getByText(/Publishing will reuse the snapshot/)).toBeVisible();
  });

  // PLAN.md §15b — a doc's ydoc decodes with docContentExtensions, which
  // carries authorHighlight (and annotation) marks no post-side reader knows
  // about. postContentFromYdoc has to strip both before Post.proseJson is
  // ever written, or the public page's plain contentExtensions/pmSchema 500s
  // trying to render a mark type it has no definition for. Two distinct
  // authors is what actually produces an authorHighlight mark in the first
  // place — AuthorHighlight only tags an edit once a second author has shown
  // up in the doc (src/lib/author-highlight-extension.ts).
  test("publishing a doc with author-highlight marks doesn't 500 the public page", async ({
    page,
    draftPost,
    secondUser,
  }) => {
    const { user: other, page: otherPage } = await secondUser();
    // The doc backing draftPost is PRIVATE and bylined to the shared admin
    // alone, and a PRIVATE doc's editor admits its listed authors only
    // (docs/PERMISSIONS.md), so the second identity needs a byline of its own.
    await addTestDocAuthor(draftPost.docId, other.email);

    await page.goto(`/doc/${draftPost.docId}/edit`);
    await otherPage.goto(`/doc/${draftPost.docId}/edit`);
    await waitForDocCollabReady(page);
    await waitForDocCollabReady(otherPage);

    await bodyEditor(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" First author's sentence.");
    await bodyEditor(otherPage).click();
    await otherPage.keyboard.press("End");
    await otherPage.keyboard.type(" Second author's sentence.");
    await expect(bodyEditor(page)).toContainText("Second author's sentence.");

    await page.goto(`/posts/${draftPost.id}/edit`);
    await waitForPublishReady(page);
    await page.getByRole("button", PUBLISH).click();
    await expect(page.getByText("Published.")).toBeVisible();

    await gotoOk(page, `/${draftPost.slug}`);
    await expect(visibleText(page, "Second author's sentence.")).toBeVisible();
  });

  test("unpublishing takes the post back to a 404", async ({ page, publishedPost }) => {
    await page.goto(`/posts/${publishedPost.id}/edit`);
    await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible();

    await page.getByRole("button", { name: "Unpublish" }).click();
    await expect(page.getByText("Unpublished.")).toBeVisible();
    await expect(page.getByText("Not published yet.")).toBeVisible();

    const response = await page.goto(`/${publishedPost.slug}`);
    expect(response?.status()).toBe(404);
  });
});
