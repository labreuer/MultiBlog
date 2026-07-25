import { test, expect } from "./fixtures";
import { createComment, getCommentStatus, uniqueEmail } from "./db";

test.describe("comment moderation", () => {
  test("a pending comment is hidden until an admin approves it", async ({ page, publishedPost }) => {
    const body = "Pending comment awaiting a moderator.";
    const { id: commentId } = await createComment({
      postId: publishedPost.id,
      anchoredRevisionId: publishedPost.revisionId,
      email: uniqueEmail("commenter"),
      displayName: "Pending Person",
      body,
      status: "PENDING",
    });

    await page.goto(`/${publishedPost.slug}`);
    await expect(page.getByText(body)).toHaveCount(0);

    // The deep-link filter (?post=) narrows the queue to this post, so parallel
    // workers' comments can't make the row ambiguous.
    await page.goto(`/comments?post=${publishedPost.id}`);
    const row = page.getByRole("row").filter({ hasText: body });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Approve" }).click();

    await expect.poll(() => getCommentStatus(commentId)).toBe("APPROVED");

    await page.goto(`/${publishedPost.slug}`);
    await expect(page.getByText(body)).toBeVisible();
  });

  test("marking a comment as spam hides it again", async ({ page, publishedPost }) => {
    const body = "Approved comment that later gets flagged.";
    const { id: commentId } = await createComment({
      postId: publishedPost.id,
      anchoredRevisionId: publishedPost.revisionId,
      email: uniqueEmail("commenter"),
      displayName: "Flagged Person",
      body,
      status: "APPROVED",
    });

    await page.goto(`/${publishedPost.slug}`);
    await expect(page.getByText(body)).toBeVisible();

    await page.goto(`/comments?post=${publishedPost.id}`);
    await page.getByRole("row").filter({ hasText: body }).getByRole("button", { name: "Spam" }).click();
    await expect.poll(() => getCommentStatus(commentId)).toBe("SPAM");

    await page.goto(`/${publishedPost.slug}`);
    await expect(page.getByText(body)).toHaveCount(0);
  });
});

test.describe("comment submission (signed out)", () => {
  // The one place the real form gets exercised. Everything else inserts
  // comments directly, because src/lib/rate-limit.ts caps submissions at 5 per
  // IP per 10 minutes and every worker shares 127.0.0.1.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("an untrusted visitor's comment lands in moderation", async ({ page, publishedModeratedPost }) => {
    await page.goto(`/${publishedModeratedPost.slug}`);

    // No links in the body — src/lib/spam-check.ts would score it as SPAM
    // rather than PENDING, which is a different assertion than this test's.
    await page.getByPlaceholder("Name").fill("Passing Visitor");
    await page.getByPlaceholder("Email").fill(uniqueEmail("visitor"));
    await page.getByPlaceholder("Write a comment...").fill("A perfectly ordinary first comment.");
    await page.getByRole("button", { name: "Post comment" }).click();

    await expect(page.getByText("Your comment is awaiting moderation.")).toBeVisible();
  });
});
