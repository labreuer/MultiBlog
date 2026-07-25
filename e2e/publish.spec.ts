import { test, expect, bodyEditor, gotoOk, visibleText, waitForCollabReady } from "./fixtures";

// "Publish" without `exact` also matches the Unpublish button.
const PUBLISH = { name: "Publish", exact: true } as const;

test.describe("publish / unpublish", () => {
  test("publishing a draft makes it readable at its public slug", async ({ page, draftPost }) => {
    await page.goto(`/posts/${draftPost.id}/edit`);
    await waitForCollabReady(page);
    await expect(page.getByText("Unpublished")).toBeVisible();

    await page.getByRole("button", PUBLISH).click();
    await expect(page.getByRole("link", { name: /Published revision #\d+/ })).toBeVisible();

    await gotoOk(page, `/${draftPost.slug}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(draftPost.title);
    await expect(visibleText(page, draftPost.bodyText)).toBeVisible();
  });

  test("edits made after publishing only reach the public page on republish", async ({ page, draftPost }) => {
    await page.goto(`/posts/${draftPost.id}/edit`);
    await waitForCollabReady(page);
    await page.getByRole("button", PUBLISH).click();
    await expect(page.getByRole("link", { name: /Published revision #\d+/ })).toBeVisible();

    const addition = "A sentence added after the first publish.";
    await bodyEditor(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(` ${addition}`);
    // Asserted before EDITED so a failure distinguishes "the keystrokes never
    // landed" from "the debounced diff never reported them" — this test has
    // flaked here under full-suite load.
    await expect(bodyEditor(page)).toContainText(addition);
    // The status line's diff counter is debounced (see REVISION_DIFF_DEBOUNCE_MS);
    // waiting on it confirms the edit actually landed in the doc.
    await expect(page.getByText("EDITED")).toBeVisible();

    await gotoOk(page, `/${draftPost.slug}`);
    await expect(page.getByText(addition)).toHaveCount(0);

    await page.goto(`/posts/${draftPost.id}/edit`);
    await waitForCollabReady(page);
    await page.getByRole("button", PUBLISH).click();
    await expect(page.getByRole("link", { name: /Published revision #2/ })).toBeVisible();

    await gotoOk(page, `/${draftPost.slug}`);
    await expect(visibleText(page, addition)).toBeVisible();
  });

  test("unpublishing takes the post back to a 404", async ({ page, publishedPost }) => {
    await page.goto(`/posts/${publishedPost.id}/edit`);
    await waitForCollabReady(page);

    await page.getByRole("button", { name: "Unpublish" }).click();
    await expect(page.getByText("Unpublished")).toBeVisible();

    const response = await page.goto(`/${publishedPost.slug}`);
    expect(response?.status()).toBe(404);
  });
});
