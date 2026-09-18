import { test, expect, freshGoto, visibleText } from "./fixtures";
import { ADMIN_EMAIL, backdateComment, createComment, getCommentFacts, uniqueEmail } from "./db";
import { EDIT_GRACE_MS } from "../src/lib/edit-grace";

// PLAN.md §22c — editing a posted comment, and §22b's three-minute window.
//
// **The window is not tested with `page.clock`**, and that is the one thing
// worth knowing before adding a case here. The silence rule compares two
// stored timestamps — when a version was superseded, against when the comment
// was posted — and never reads a clock at all, so moving the browser's time
// forward changes nothing. What decides the outcome is the interval between
// posting and editing, which `backdateComment` produces directly.
//
// Every test asserts on both halves: what the reader is shown, and what was
// actually stored. They are deliberately different questions here — a silent
// edit still writes a revision row, so "no marker appeared" alone would pass
// just as well against an implementation that had thrown the old version away.

const PAST_THE_WINDOW = EDIT_GRACE_MS + 60_000;

/** The comment's own card, scoped by the data attribute CommentNode sets. */
function card(page: import("@playwright/test").Page, commentId: string) {
  return page.locator(`[data-comment-id="${commentId}"]`);
}

async function editTo(page: import("@playwright/test").Page, commentId: string, text: string) {
  const own = card(page, commentId);
  await own.getByRole("button", { name: "Edit" }).click();
  const textarea = own.getByRole("textbox", { name: "Edit comment" });
  await expect(textarea).toBeVisible();
  await textarea.fill(text);
  await own.getByRole("button", { name: "Save" }).click();
  await expect(textarea).toHaveCount(0);
}

test.describe("editing a comment", () => {
  test("an edit inside the grace window shows nothing, and still stores the old version", async ({
    page,
    publishedPost,
  }) => {
    const original = "E2E original wording, posted moments ago.";
    const corrected = "E2E corrected wording, fixed immediately.";
    const { id: commentId } = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      // The signed-in admin's own address, so `commenter.userId` is set and
      // this is the viewer's own comment — the ordinary case for editing.
      email: ADMIN_EMAIL,
      displayName: "Admin Commenter",
      body: original,
      status: "APPROVED",
    });

    await page.goto(publishedPost.path);
    await expect(visibleText(page, original)).toBeVisible();

    await editTo(page, commentId, corrected);

    // What the reader sees: the new text, and no sign that anything changed.
    await expect(card(page, commentId)).toContainText(corrected);
    await expect(card(page, commentId).getByRole("button", { name: /earlier versions/ })).toHaveCount(0);

    // What was stored: both versions, and the edit stamp — §22b's "a display
    // rule, not a storage rule", asserted rather than described.
    const facts = await getCommentFacts(commentId);
    expect(facts?.bodyText).toBe(corrected);
    expect(facts?.editedAt).not.toBeNull();
    expect(facts?.revisions.map((r) => r.bodyText)).toEqual([original, corrected]);
    expect(facts?.revisions.map((r) => r.revisionNo)).toEqual([1, 2]);
  });

  test("an edit after the window shows the marker and the earlier version", async ({ page, publishedPost }) => {
    const original = "E2E wording as first published, three minutes ago.";
    const corrected = "E2E wording as revised, well after the window closed.";
    const { id: commentId } = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: ADMIN_EMAIL,
      displayName: "Admin Commenter",
      body: original,
      status: "APPROVED",
    });
    await backdateComment(commentId, PAST_THE_WINDOW);

    await page.goto(publishedPost.path);
    await editTo(page, commentId, corrected);

    // The marker only renders from a fresh server render — `visiblyEdited` is
    // resolved by the loader, not in the browser. freshGoto rather than
    // reload() because the post page is ISR against the prod target, and the
    // action's own revalidatePath is not the thing under test here.
    await freshGoto(page, publishedPost.path);
    const marker = card(page, commentId).getByRole("button", { name: /earlier versions/ });
    await expect(marker).toBeVisible();

    await marker.click();
    const history = page.locator('[data-edit-history="comment"]');
    await expect(history).toContainText(original);
    await expect(history).toContainText(corrected);
    await expect(history).toContainText("Earlier version");
    await expect(history).toContainText("Current version");
  });

  test("a moderator's edit is attributed to the moderator", async ({ page, publishedPost }) => {
    const original = "E2E comment by someone else entirely.";
    const corrected = "E2E comment, tidied up by a moderator.";
    const { id: commentId } = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      // No user has this address, so the commenter is anonymous: the admin
      // driving the page is editing *someone else's* comment, under §22f's
      // moderation gate rather than as its author.
      email: uniqueEmail("commenter"),
      displayName: "Anonymous Person",
      body: original,
      status: "APPROVED",
    });
    await backdateComment(commentId, PAST_THE_WINDOW);

    await page.goto(publishedPost.path);
    await editTo(page, commentId, corrected);

    const facts = await getCommentFacts(commentId);
    expect(facts?.revisions.at(-1)?.authorEmail).toBe(ADMIN_EMAIL);
    // Revision 1 has nobody to name — the original was posted anonymously.
    expect(facts?.revisions[0].authorEmail).toBeNull();
  });

  test("a signed-out reader gets no Edit control and no marker for a silent edit", async ({ page, publishedPost }) => {
    const original = "E2E anonymous comment nobody may edit.";
    const { id: commentId } = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: uniqueEmail("commenter"),
      displayName: "Anonymous Person",
      body: original,
      status: "APPROVED",
    });

    const anonymous = await page.context().browser()!.newContext();
    const anonymousPage = await anonymous.newPage();
    try {
      await anonymousPage.goto(publishedPost.path);
      await expect(visibleText(anonymousPage, original)).toBeVisible();
      await expect(card(anonymousPage, commentId).getByRole("button", { name: "Edit" })).toHaveCount(0);
      await expect(card(anonymousPage, commentId).getByRole("button", { name: "Reply" })).toBeVisible();
    } finally {
      await anonymous.close();
    }
  });

  test("saving an unchanged comment writes no revision and leaves the window open", async ({
    page,
    publishedPost,
  }) => {
    const original = "E2E comment saved again with no change at all.";
    const { id: commentId } = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: ADMIN_EMAIL,
      displayName: "Admin Commenter",
      body: original,
      status: "APPROVED",
    });
    await backdateComment(commentId, PAST_THE_WINDOW);

    await page.goto(publishedPost.path);
    await editTo(page, commentId, original);

    // The point of the no-op branch: a Save with nothing changed must not
    // supersede anything, or it would silently spend the author's window.
    const facts = await getCommentFacts(commentId);
    expect(facts?.revisions).toHaveLength(1);
    expect(facts?.editedAt).toBeNull();
    await freshGoto(page, publishedPost.path);
    await expect(card(page, commentId).getByRole("button", { name: /earlier versions/ })).toHaveCount(0);
  });
});
