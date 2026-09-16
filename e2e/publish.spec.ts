// PLAN.md §15 — /post/[id]/edit no longer edits a post's own content; it
// publishes a point in its backing doc's history. Editing happens at
// /doc/[id]/edit, same as any doc.
import { test, expect, bodyEditor, gotoOk, freshGoto, visibleText, waitForDocCollabReady } from "./fixtures";
import { addTestDocAuthor, getPostPath, type TestPost } from "./db";

// "Publish" without `exact` also matches "Publish as blog post" elsewhere.
// The button reads "Publish" on a draft and "Republish" once the post is
// live (PLAN.md §15c), so a second publish in one test clicks the latter.
const PUBLISH = { name: "Publish", exact: true } as const;
const REPUBLISH = { name: "Republish", exact: true } as const;
const NO_OP_TOOLTIP = "Already published at this version with the present title";

// A draft's `path` is null until something publishes it, and here the browser
// does: the date segment is the publish's own `publishedAt` (PLAN.md §21), so
// the spec reads the path back instead of guessing "today" in UTC.
async function publicPath(post: TestPost): Promise<string> {
  const path = await getPostPath(post.id);
  if (!path) throw new Error(`Post ${post.id} is not published.`);
  return path;
}

async function waitForPublishReady(page: import("@playwright/test").Page): Promise<void> {
  // The scrub bar loads the doc's history asynchronously (PostSnapshotScrubBar)
  // before Publish/Schedule can do anything meaningful — see PostPublisher.tsx.
  // Waits on the bar rather than on the button being enabled: on a live
  // post the bar opens at the published position, where Republish is
  // *disabled* as a no-op until something scrubs away from it.
  await expect(page.getByLabel("Scrub through the doc's edit history")).toBeVisible({ timeout: 15_000 });
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
    await page.goto(`/post/${draftPost.id}/edit`);
    await expect(page.getByText("Not published yet")).toBeVisible();
    await waitForPublishReady(page);

    await page.getByRole("button", PUBLISH).click();
    await expect(page.getByText("Published.")).toBeVisible();

    // PLAN.md §21i — the status line links out to the live post and to the
    // history page, and the source line to the doc's editor; no "updated"
    // yet, since this is the first publish.
    const path = await publicPath(draftPost);
    await expect(page.getByRole("link", { name: /^Published / })).toHaveAttribute("href", path);
    await expect(page.getByRole("link", { name: "publication history" })).toHaveAttribute(
      "href",
      `/post/${draftPost.id}/history`,
    );
    await expect(page.getByText("From doc:").getByRole("link")).toHaveAttribute("href", /^\/doc\/.+\/edit$/);
    await expect(page.getByText(/, updated /)).toHaveCount(0);

    await gotoOk(page, path);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(draftPost.title);
    // The byline's "configure post" (PLAN.md §21i), for the admin who is
    // signed in here; the signed-out case is its own test below.
    await expect(page.getByRole("link", { name: "configure post" })).toHaveAttribute(
      "href",
      `/post/${draftPost.id}/edit`,
    );
    await expect(visibleText(page, draftPost.bodyText)).toBeVisible();
  });

  test("edits made after publishing only reach the public page on republish", async ({ page, draftPost }) => {
    await page.goto(`/post/${draftPost.id}/edit`);
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

    await gotoOk(page, await publicPath(draftPost));
    await expect(page.getByText(addition)).toHaveCount(0);

    await page.goto(`/post/${draftPost.id}/edit`);
    await waitForPublishReady(page);
    // PLAN.md §15c — the head is past the live version, and the status
    // line says so before anything is scrubbed.
    await expect(page.getByText(/The doc has changed since this version/)).toBeVisible();
    await scrubToLatest(page);
    // The doc moved on since the last publish, so a fresh snapshot is due.
    await expect(page.getByText(/Publishing will create a new snapshot/)).toBeVisible();
    await expect(page.getByRole("button", REPUBLISH)).toBeEnabled();
    // The "updated" note ignores a republish within a second of the
    // publication date (PostPublisher's tolerance for database-clock skew
    // on older rows), and on a fast machine this whole test has run in
    // under a second — so the republish is held past that threshold on
    // purpose. A deliberate wait on the feature's own constant, not a
    // guess at the app's readiness.
    await page.waitForTimeout(1_100);
    await page.getByRole("button", REPUBLISH).click();
    await expect(page.getByText("Published.")).toBeVisible();
    // PLAN.md §15c — the live version is now a later edit than the
    // publication date (which the republish preserved), and the head is
    // no longer past the live version.
    await expect(page.getByText(/^Published .*, updated /)).toBeVisible();
    await expect(page.getByText(/The doc has changed since this version/)).toHaveCount(0);

    await gotoOk(page, await publicPath(draftPost));
    await expect(visibleText(page, addition)).toBeVisible();
  });

  // PLAN.md §15c — the bar reopens on the published position, where a
  // republish would reuse the snapshot *and* change nothing, so the button
  // is a disabled "Republish" that says why. Retyping the title to what it
  // already is must not re-enable it; a different title must.
  test("publishing again with no doc edits in between reuses the same snapshot", async ({ page, draftPost }) => {
    await page.goto(`/post/${draftPost.id}/edit`);
    await waitForPublishReady(page);
    await page.getByRole("button", PUBLISH).click();
    await expect(page.getByText("Published.")).toBeVisible();

    await page.goto(`/post/${draftPost.id}/edit`);
    await waitForPublishReady(page);
    await expect(page.getByText(/Publishing will reuse the snapshot/)).toBeVisible();
    await expect(page.getByText(/The doc has changed since this version/)).toHaveCount(0);
    const republish = page.getByRole("button", REPUBLISH);
    await expect(republish).toBeDisabled();
    await expect(page.getByTitle(NO_OP_TOOLTIP)).toBeVisible();

    const titleInput = page.getByLabel("Post title");
    await titleInput.fill(draftPost.title);
    await expect(republish).toBeDisabled();
    await titleInput.fill(`${draftPost.title} (retitled)`);
    await expect(republish).toBeEnabled();
    await expect(page.getByTitle(NO_OP_TOOLTIP)).toHaveCount(0);
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

    await page.goto(`/post/${draftPost.id}/edit`);
    await waitForPublishReady(page);
    await page.getByRole("button", PUBLISH).click();
    await expect(page.getByText("Published.")).toBeVisible();

    await gotoOk(page, await publicPath(draftPost));
    await expect(visibleText(page, "Second author's sentence.")).toBeVisible();
  });

  // PLAN.md §21i — the doc byline's post line, through all three entry
  // kinds in one post's life, and §15c's "Publish Now" label on the way.
  test("the doc's byline follows its post from draft to scheduled to published", async ({ page, draftPost }) => {
    const docPage = `/doc/${draftPost.docId}`;
    const configure = () => page.getByRole("link", { name: "configure" });
    const title = draftPost.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // A draft: no button (the row exists), a "Draft" entry pointing at it.
    // createTestPost titles the post and its doc separately, so every entry
    // here carries the "as <post title>" clause.
    await page.goto(docPage);
    await expect(page.getByRole("button", { name: "Publish as blog post" })).toHaveCount(0);
    await expect(page.getByText(`Draft as ${draftPost.title} (configure)`)).toBeVisible();
    await expect(configure()).toHaveAttribute("href", `/post/${draftPost.id}/edit`);

    // Schedule it for a bit over a day out. datetime-local takes the
    // browser's local time, and the browser and this process share a
    // clock and a zone, so the local wall-clock string is built here.
    const when = new Date(Date.now() + 26 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const local =
      `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
      `T${pad(when.getHours())}:${pad(when.getMinutes())}`;
    await page.goto(`/post/${draftPost.id}/edit`);
    await waitForPublishReady(page);
    await page.getByLabel("Schedule for").fill(local);
    await page.getByRole("button", { name: "Schedule", exact: true }).click();
    await expect(page.getByText("Scheduled.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish Now", exact: true })).toBeEnabled();

    // Scheduled: one link carrying the UTC time and the countdown.
    await page.goto(docPage);
    const scheduled = page.getByRole("link", {
      name: new RegExp(`^Scheduled as ${title} for \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} UTC \\(in 1 day, `),
    });
    await expect(scheduled).toHaveAttribute("href", `/post/${draftPost.id}/edit`);
    await expect(page.getByRole("button", { name: "Publish as blog post" })).toHaveCount(0);

    // Publish Now, then: "Published on <date>" to the live page, plus configure.
    await page.goto(`/post/${draftPost.id}/edit`);
    await waitForPublishReady(page);
    await page.getByRole("button", { name: "Publish Now", exact: true }).click();
    await expect(page.getByText("Published.")).toBeVisible();
    const path = await publicPath(draftPost);
    await page.goto(docPage);
    await expect(
      page.getByRole("link", { name: new RegExp(`^Published as ${title} on \\d{4}-\\d{2}-\\d{2}$`) }),
    ).toHaveAttribute("href", path);
    await expect(configure()).toHaveAttribute("href", `/post/${draftPost.id}/edit`);
    await expect(page.getByText(/^Scheduled for/)).toHaveCount(0);
  });

  test("the doc's byline offers \"Publish as blog post\" only while the doc has no post", async ({
    page,
    draftDoc,
  }) => {
    await page.goto(`/doc/${draftDoc.id}`);
    await expect(page.getByRole("button", { name: "Publish as blog post" })).toBeVisible();
    await expect(page.getByRole("link", { name: "configure" })).toHaveCount(0);
  });

  // PLAN.md §21i — the public page is static and reads no session, so the
  // link is a client island that a signed-out reader never sees: not in
  // the HTML, not after hydration.
  test("a signed-out reader sees no \"configure post\" on the public page", async ({ browser, publishedPost }) => {
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const anonPage = await anon.newPage();
    try {
      await freshGoto(anonPage, publishedPost.path);
      await expect(anonPage.getByRole("heading", { level: 1 })).toContainText(publishedPost.title);
      await expect(anonPage.getByRole("link", { name: "Log in" })).toBeVisible();
      await expect(anonPage.getByRole("link", { name: "configure post" })).toHaveCount(0);
    } finally {
      await anon.close();
    }
  });

  test("unpublishing takes the post back to a 404", async ({ page, publishedPost }) => {
    await page.goto(`/post/${publishedPost.id}/edit`);
    await expect(page.getByRole("button", { name: "Unpublish" })).toBeVisible();

    await page.getByRole("button", { name: "Unpublish" }).click();
    await expect(page.getByText("Unpublished.")).toBeVisible();
    await expect(page.getByText("Not published yet")).toBeVisible();

    const response = await page.goto(publishedPost.path);
    expect(response?.status()).toBe(404);
  });
});
