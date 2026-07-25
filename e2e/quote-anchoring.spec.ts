// Quote anchoring across revisions — PLAN.md §5, and §1's "one genuinely hard
// part". On publish, `remapThreadsToRevision` diffs the thread's anchored
// revision against the newly published one and maps each anchor through the
// resulting Mapping; a range that collapses, or whose text no longer matches
// the stored quotedText, flips the thread to DETACHED and freezes its anchor
// at the last revision it was valid against.
//
// Worth knowing before adding cases here: **deleting the quoted text is not
// enough to collapse the range.** `recreateTransform` produces a character-
// level diff, so removing exactly "brown fox jumps " still leaves the mapped
// end one character past the start — it lands on the "o" that the diff matched
// against "over". That case detaches on the quotedText comparison, same branch
// as an edit *inside* the quote. Genuinely collapsing the range (mappedTo ==
// mappedFrom) takes deleting past the quote's boundary, which the last test
// does. Verified by running the mapping directly against these exact strings.
//
// The survival case comes first, since without it these specs would only prove
// that anchors break.
import {
  test,
  expect,
  bodyEditor,
  deleteTextInBody,
  visibleText,
  waitForCollabReady,
  QUOTED_BODY,
  QUOTED_TEXT,
  QUOTE_FROM,
  QUOTE_TO,
} from "./fixtures";
import { getLatestRevisionId, getThread } from "./db";

const PUBLISH = { name: "Publish", exact: true } as const;
const DETACHED_NOTICE = "This quote was edited or removed in a later revision of the article.";

/** Publishes whatever is currently in the editor as the next revision. */
async function republish(page: import("@playwright/test").Page, postId: string) {
  await page.getByRole("button", PUBLISH).click();
  await expect(page.getByRole("link", { name: /Published revision #2/ })).toBeVisible();
  const revisionId = await getLatestRevisionId(postId);
  expect(revisionId).not.toBeNull();
  return revisionId!;
}

test.describe("quote anchoring across revisions", () => {
  test("an edit outside the quote moves the anchor and keeps the thread active", async ({ page, quotedPost }) => {
    await page.goto(`/posts/${quotedPost.id}/edit`);
    await waitForCollabReady(page);

    // Inserted at the very start, i.e. entirely before the quote — the anchor
    // should slide forward by exactly the inserted length and stay valid.
    const prefix = "Yesterday, ";
    await bodyEditor(page).click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.type(prefix);
    // Asserted before EDITED so a failure distinguishes "the keystrokes never
    // landed" from "the debounced diff never reported them" — this test has
    // flaked here under full-suite load.
    await expect(bodyEditor(page)).toContainText(`${prefix}${QUOTED_BODY}`);
    await expect(page.getByText("EDITED")).toBeVisible();

    const newRevisionId = await republish(page, quotedPost.id);

    await expect
      .poll(async () => (await getThread(quotedPost.threadId))?.anchoredRevisionId)
      .toBe(newRevisionId);
    const thread = await getThread(quotedPost.threadId);
    expect(thread).toMatchObject({
      status: "ACTIVE",
      anchorFrom: QUOTE_FROM + prefix.length,
      anchorTo: QUOTE_TO + prefix.length,
    });

    // Still highlighted inline, at its new home.
    await page.goto(`/${quotedPost.slug}`);
    await expect(page.locator(`[data-thread-ids~="${quotedPost.threadId}"]`).first()).toBeVisible();
    await expect(page.getByText(DETACHED_NOTICE)).toHaveCount(0);
  });

  test("deleting a word inside the quote detaches it — the range survives but the text no longer matches", async ({
    page,
    quotedPost,
  }) => {
    await page.goto(`/posts/${quotedPost.id}/edit`);
    await waitForCollabReady(page);

    // "brown fox jumps" → "brown jumps": the mapped range shrinks but stays
    // non-empty (11..22), so this detaches on the quotedText comparison.
    await deleteTextInBody(page, "fox ");
    await expect(bodyEditor(page)).toContainText("The quick brown jumps over");
    await expect(page.getByText("EDITED")).toBeVisible();

    await republish(page, quotedPost.id);

    await expect.poll(async () => (await getThread(quotedPost.threadId))?.status).toBe("DETACHED");
    const thread = await getThread(quotedPost.threadId);
    // The anchor is frozen at the revision it was last valid against, not
    // advanced to the one just published — that frozen revision is what the
    // "show where it used to appear" context is read from.
    expect(thread).toMatchObject({
      anchoredRevisionId: quotedPost.revisionId,
      anchorFrom: QUOTE_FROM,
      anchorTo: QUOTE_TO,
    });

    await page.goto(`/${quotedPost.slug}`);
    // No inline highlight any more, but the thread is still listed, showing
    // the quote as it was written.
    await expect(page.locator(`[data-thread-ids~="${quotedPost.threadId}"]`)).toHaveCount(0);
    await expect(visibleText(page, DETACHED_NOTICE)).toBeVisible();
    await expect(page.getByText(QUOTED_TEXT, { exact: true })).toBeVisible();

    // The context snippet comes from the frozen revision, so it still contains
    // the word that was just deleted from the live article.
    await page.getByRole("button", { name: "Show where it used to appear" }).click();
    await expect(page.getByText(QUOTED_BODY, { exact: false })).toBeVisible();
  });

  test("deleting the whole quote detaches it, even though the range doesn't collapse", async ({
    page,
    quotedPost,
  }) => {
    await page.goto(`/posts/${quotedPost.id}/edit`);
    await waitForCollabReady(page);

    // Every character the anchor covered is gone from the article, but the
    // mapped range is 11..12 rather than empty — the diff pairs the quote's
    // final character with the "o" of the following "over". So this still
    // detaches on the text comparison; see the header note.
    await deleteTextInBody(page, `${QUOTED_TEXT} `);
    await expect(bodyEditor(page)).toContainText("The quick over the lazy dog");
    await expect(bodyEditor(page)).not.toContainText(QUOTED_TEXT);
    await expect(page.getByText("EDITED")).toBeVisible();

    await republish(page, quotedPost.id);

    await expect.poll(async () => (await getThread(quotedPost.threadId))?.status).toBe("DETACHED");
    const thread = await getThread(quotedPost.threadId);
    expect(thread).toMatchObject({
      anchoredRevisionId: quotedPost.revisionId,
      anchorFrom: QUOTE_FROM,
      anchorTo: QUOTE_TO,
    });

    await page.goto(`/${quotedPost.slug}`);
    // The quoted words are gone from the article body entirely, yet the thread
    // still renders its quote and notice.
    await expect(page.locator(`[data-thread-ids~="${quotedPost.threadId}"]`)).toHaveCount(0);
    await expect(visibleText(page, DETACHED_NOTICE)).toBeVisible();
    await expect(page.getByText(QUOTED_TEXT, { exact: true })).toBeVisible();
  });

  // The only case that reaches DETACHED through the `mappedTo > mappedFrom`
  // guard rather than the quotedText comparison. Deleting past the quote's
  // trailing boundary removes the character the diff would otherwise have
  // paired with, leaving nothing between the two mapped ends.
  test("deleting past the quote's boundary collapses the range to nothing", async ({ page, quotedPost }) => {
    await page.goto(`/posts/${quotedPost.id}/edit`);
    await waitForCollabReady(page);

    await deleteTextInBody(page, `${QUOTED_TEXT} over `);
    await expect(bodyEditor(page)).toContainText("The quick the lazy dog");
    await expect(page.getByText("EDITED")).toBeVisible();

    await republish(page, quotedPost.id);

    await expect.poll(async () => (await getThread(quotedPost.threadId))?.status).toBe("DETACHED");
    expect(await getThread(quotedPost.threadId)).toMatchObject({
      anchoredRevisionId: quotedPost.revisionId,
      anchorFrom: QUOTE_FROM,
      anchorTo: QUOTE_TO,
    });

    await page.goto(`/${quotedPost.slug}`);
    await expect(page.locator(`[data-thread-ids~="${quotedPost.threadId}"]`)).toHaveCount(0);
    await expect(visibleText(page, DETACHED_NOTICE)).toBeVisible();
  });
});
