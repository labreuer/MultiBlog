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
import { test, expect, freshGoto, visibleText } from "./fixtures";
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

    await freshGoto(page, publishedPost.path);
    await expect(page.locator(`[data-comment-id="${deletedId}"]`)).toHaveText("[deleted]");
    await expect(visibleText(page, reply)).toBeVisible();

    const source = await (await page.request.get(publishedPost.path)).text();
    // The tombstone is there — so the absences below are about its contents,
    // not about a page that never mentioned it.
    expect(source).toContain(deletedId);
    expect(source).toContain(reply);
    expect(source).not.toContain(takenBack);
    expect(source).not.toContain(takenBackName);
  });
});
