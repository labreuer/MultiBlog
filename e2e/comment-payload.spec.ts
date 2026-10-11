// What the public post page puts in its source about its comments. The page is
// statically generated and its comment list is a client component, so every
// field the loader (src/lib/comment-data.ts) hands that list is in the HTML and
// its inlined RSC payload for anyone who views source — not only what the
// cards draw. These assert on the source itself, since a field the cards never
// render passes every DOM assertion.
//
// Every post-page navigation is a `freshGoto`, for the reason
// comment-editing.spec.ts gives: the fixtures write comments straight to the
// database, which revalidates nothing.
import { test, expect, visibleText, freshGotoComment } from "./fixtures";
import { ADMIN_EMAIL, createComment, softDeleteComment, uniqueEmail } from "./db";

test.describe("the post page's comment payload", () => {
  test("a deleted comment reaches the page as a tombstone, its words and name nowhere in the source", async ({
    page,
    publishedPost,
  }) => {
    const takenBack = "E2E words the commenter took back.";
    const takenBackName = "E2E Retracting Commenter";
    const reply = "E2E a reply that outlives its parent.";
    const { id: deletedId } = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: uniqueEmail("retracting"),
      displayName: takenBackName,
      body: takenBack,
      status: "APPROVED",
    });
    // A live reply is what keeps the deleted comment on the page at all: one
    // with nothing live below it renders nothing.
    await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: uniqueEmail("replying"),
      displayName: "E2E Replying Commenter",
      body: reply,
      status: "APPROVED",
      parentCommentId: deletedId,
    });
    await softDeleteComment(deletedId, ADMIN_EMAIL);

    await freshGotoComment(page, publishedPost.path, deletedId);
    await expect(page.locator(`[data-comment-id="${deletedId}"]`)).toHaveText("[deleted]");
    await expect(visibleText(page, reply)).toBeVisible();

    const source = await (await page.request.get(publishedPost.path)).text();
    // Booleans rather than toContain, whose failure prints the whole page. The
    // tombstone is there, so the absences below are about its contents, not
    // about a page that never mentioned it.
    expect(source.includes(deletedId), "the tombstone's id is in the source").toBe(true);
    expect(source.includes(reply), "the reply is in the source").toBe(true);
    expect(source.includes(takenBack), "the deleted comment's words are in the source").toBe(false);
    expect(source.includes(takenBackName), "the deleted comment's display name is in the source").toBe(false);
  });

  // Ownership is the one viewer-shaped thing a card needs, and the page can't
  // know the viewer. Comparing each comment's commenter user id with the
  // session's would put every signed-in commenter's id beside their display
  // name in the source, so the browser asks the server which ids are its own.
  // A COMMENTER, because for an ADMIN or EDITOR the controls appear on every
  // card and ownership would decide nothing visible.
  test("a commenter's own card offers Edit and Delete, though no commenter's user id is in the source", async ({
    publishedPost,
    secondUser,
  }) => {
    const { user, page } = await secondUser({ role: "COMMENTER" });
    const ownText = "E2E a comment of the viewer's own.";
    const otherText = "E2E a comment by somebody else.";
    const { id: ownId } = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: user.email,
      displayName: "E2E Own Commenter",
      body: ownText,
      status: "APPROVED",
    });
    const { id: otherId } = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: uniqueEmail("other-commenter"),
      displayName: "E2E Other Commenter",
      body: otherText,
      status: "APPROVED",
    });

    await freshGotoComment(page, publishedPost.path, otherId);
    const own = page.locator(`[data-comment-id="${ownId}"]`);
    const other = page.locator(`[data-comment-id="${otherId}"]`);
    await expect(own.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(own.getByRole("button", { name: "Delete" })).toBeVisible();
    // Only meaningful once the answer is in, which the own card's controls
    // appearing above has just shown.
    await expect(other).toContainText(otherText);
    await expect(other.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(other.getByRole("button", { name: "Delete" })).toHaveCount(0);

    const source = await (await page.request.get(publishedPost.path)).text();
    expect(source.includes(ownText), "the viewer's comment is in the source").toBe(true);
    expect(source.includes(user.id), "the commenter's user id is in the source").toBe(false);
  });
});
