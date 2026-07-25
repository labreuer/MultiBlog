// Two signed-in users editing one post at once. This is the flow that's
// genuinely awkward to drive by hand — the browser pane's tabs share a cookie
// jar, so "sign in as a second user" quietly re-authenticates the first tab
// too. Separate browser contexts make it a non-issue.
import { test, expect, bodyEditor, titleEditor, statusLine, waitForCollabReady } from "./fixtures";

test.describe("real-time collaboration", () => {
  test("body edits from one author appear in the other's editor", async ({ page, draftPost, secondUser }) => {
    const { user: other, page: otherPage } = await secondUser();

    await page.goto(`/posts/${draftPost.id}/edit`);
    await otherPage.goto(`/posts/${draftPost.id}/edit`);
    await waitForCollabReady(page);
    await waitForCollabReady(otherPage);

    const typed = "Text typed by the first author.";
    await bodyEditor(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(` ${typed}`);

    await expect(bodyEditor(otherPage)).toContainText(typed);

    // …and back the other way, which also proves the second context is really
    // a second identity rather than the first one's session reused.
    const reply = "And a line from the second author.";
    await bodyEditor(otherPage).click();
    await otherPage.keyboard.press("End");
    await otherPage.keyboard.type(` ${reply}`);

    await expect(bodyEditor(page)).toContainText(reply);
    // Scoped to the status line's connected-authors list: the same name also
    // appears on a caret label and in the settings panel's author picker.
    await expect(statusLine(page)).toContainText(other.name);
  });

  test("the title is collaborative too, and its own Yjs fragment", async ({ page, draftPost, secondUser }) => {
    const { page: otherPage } = await secondUser();

    await page.goto(`/posts/${draftPost.id}/edit`);
    await otherPage.goto(`/posts/${draftPost.id}/edit`);
    await waitForCollabReady(page);
    await waitForCollabReady(otherPage);

    const suffix = " (retitled live)";
    await titleEditor(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(suffix);

    await expect(titleEditor(otherPage)).toContainText(suffix);
    // The body must be untouched — the two fragments share a Y.Doc, and a
    // title edit leaking into the body would be the failure mode worth
    // catching here.
    await expect(bodyEditor(otherPage)).toContainText(draftPost.bodyText);
    await expect(bodyEditor(otherPage)).not.toContainText(suffix);
  });

  test("a save by one author is visible as a new revision to the other", async ({ page, draftPost, secondUser }) => {
    const { page: otherPage } = await secondUser();

    await page.goto(`/posts/${draftPost.id}/edit`);
    await otherPage.goto(`/posts/${draftPost.id}/edit`);
    await waitForCollabReady(page);
    await waitForCollabReady(otherPage);

    await bodyEditor(otherPage).click();
    await otherPage.keyboard.press("End");
    await otherPage.keyboard.type(" An edit worth saving.");
    await expect(bodyEditor(page)).toContainText("An edit worth saving.");

    await page.getByRole("button", { name: "Save draft" }).click();
    // Saving clears the author-highlight marks in the shared doc, which is a
    // synced transaction — so the *other* client's EDITED badge clears too.
    await expect(otherPage.getByText("EDITED")).toHaveCount(0);
  });
});
