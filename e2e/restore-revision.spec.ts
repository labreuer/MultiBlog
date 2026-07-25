// Restoring an old revision (`restoreRevision` in src/app/actions/posts.ts,
// driven by RestoreRevisionButton on /posts/[id]/history/[revisionNumber]).
//
// The steps are split deliberately so a failure says *which half* broke: the
// DB write (a new revision carrying the old content) and what the author then
// sees when the button drops them back in the editor are separate mechanisms,
// and the editor's content comes from the collab Y.Doc, not from the revision
// table.
import { test, expect, bodyEditor, waitForCollabReady } from "./fixtures";
import { getRevisions, hasCollabDoc } from "./db";

const ADDITION = "Second version, added after the first revision.";

test.describe("restoring an old revision", () => {
  test("writes a new revision carrying the old content", async ({ page, draftPost }) => {
    await page.goto(`/posts/${draftPost.id}/edit`);
    await waitForCollabReady(page);

    await bodyEditor(page).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(` ${ADDITION}`);
    await expect(page.getByText("EDITED")).toBeVisible();
    await page.getByRole("button", { name: "Save draft" }).click();

    await expect.poll(async () => (await getRevisions(draftPost.id)).length).toBe(2);
    expect((await getRevisions(draftPost.id))[1].text).toContain(ADDITION);

    // RestoreRevisionButton guards on window.confirm; Playwright dismisses
    // dialogs by default, which would silently cancel the restore.
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`/posts/${draftPost.id}/history/1`);
    await page.getByRole("button", { name: "Restore revision #1" }).click();
    await page.waitForURL(`**/posts/${draftPost.id}/edit`);

    const revisions = await getRevisions(draftPost.id);
    expect(revisions).toHaveLength(3);
    expect(revisions[2]).toMatchObject({
      revisionNumber: 3,
      changelog: "Restored from revision 1",
    });
    expect(revisions[2].text).toBe(revisions[0].text);
    expect(revisions[2].text).not.toContain(ADDITION);
  });

  test("brings the restored content back into the editor", async ({ page, draftPost }) => {
    await page.goto(`/posts/${draftPost.id}/edit`);
    await waitForCollabReady(page);

    await bodyEditor(page).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(` ${ADDITION}`);
    await expect(page.getByText("EDITED")).toBeVisible();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect.poll(async () => (await getRevisions(draftPost.id)).length).toBe(2);

    // Typing in the editor is what creates the PostCollab row — the live doc
    // now exists independently of the revision table, which is the condition
    // this test is really about. Polled rather than read straight away:
    // onStoreDocument is debounced, so the row appears a couple of seconds
    // after the edit, not synchronously with it.
    await expect.poll(() => hasCollabDoc(draftPost.id), { timeout: 20_000 }).toBe(true);

    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`/posts/${draftPost.id}/history/1`);
    await page.getByRole("button", { name: "Restore revision #1" }).click();
    await page.waitForURL(`**/posts/${draftPost.id}/edit`);
    await waitForCollabReady(page);

    // The author was just sent here by the Restore button, so this is what
    // "restored" has to mean for them: the old text is back, and the text the
    // restore was meant to undo is gone.
    await expect(bodyEditor(page)).toContainText(draftPost.bodyText);
    await expect(bodyEditor(page)).not.toContainText(ADDITION);
  });

  test("a restore that is then published puts the old content on the public page", async ({
    page,
    publishedPost,
  }) => {
    await page.goto(`/posts/${publishedPost.id}/edit`);
    await waitForCollabReady(page);

    await bodyEditor(page).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(` ${ADDITION}`);
    await expect(page.getByText("EDITED")).toBeVisible();
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("link", { name: /Published revision #2/ })).toBeVisible();

    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(`/posts/${publishedPost.id}/history/1`);
    await page.getByRole("button", { name: "Restore revision #1" }).click();
    await page.waitForURL(`**/posts/${publishedPost.id}/edit`);
    await waitForCollabReady(page);

    // Restore only ever creates a draft revision (PLAN.md §10), so publishing
    // is a required second step — but it must publish the *restored* content.
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByRole("link", { name: /Published revision #\d+/ })).toBeVisible();

    await page.goto(`/${publishedPost.slug}`);
    await expect(page.getByText(ADDITION)).toHaveCount(0);
  });
});
