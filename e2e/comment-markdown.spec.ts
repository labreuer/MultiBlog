import type { Page } from "@playwright/test";
import { test, expect, freshGoto } from "./fixtures";
import { createComment, getCommentFacts } from "./db";

// PLAN.md §23m — the two front doors of the comment form, and what the
// Markdown one does with syntax the schema does not allow. The parse itself
// is a unit table (src/lib/markdown-comment.test.ts); what this asserts is
// the shape that reaches the page: a heading typed in a comment renders as
// bold rather than as a heading, a fence renders as code rather than as
// nothing, and a rich-mode body arrives through the same write path.
//
// **Every real submission here is made by a second ADMIN, not the shared
// one.** The rate limit is per IP *and* per commenter (src/lib/rate-limit.ts,
// 5 per 10 minutes each), and fixture comments inserted for the shared admin
// by comment-editing.spec.ts — which runs in a parallel worker — count
// against the shared admin's commenter total even though they never touched
// the form. A fresh admin has a fresh commenter row; the IP half is shared
// with moderation.spec.ts's one real post and stays well under five.
//
// The post page is ISR against the prod target; a submission revalidates it,
// and `freshGoto` is what fetches the result (comment-editing.spec.ts).

/** A comment card, by text it must contain. */
function cardContaining(page: Page, text: string) {
  return page.locator("[data-comment-id]").filter({ hasText: text }).first();
}

/**
 * Submits the open form and waits for it to *finish* — the button reads
 * "Posting..." while pending, so asserting on its absence would pass during
 * the request; the body textbox is what leaves when the action returns.
 */
async function post(page: Page) {
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByRole("textbox", { name: "Comment body" })).toHaveCount(0);
  await expect(page.locator("form").getByText(/too quickly|too long|can't be empty|Malformed/)).toHaveCount(0);
}

test.describe("comment bodies", () => {
  test("Markdown renders as schema nodes, and out-of-schema syntax degrades rather than vanishing", async ({
    publishedPost,
    secondUser,
  }) => {
    const { page } = await secondUser({ role: "ADMIN" });
    await page.goto(publishedPost.path);
    await page.getByRole("textbox", { name: "Comment body" }).fill(
      [
        "# E2E markdown heading",
        "",
        "Some **bold** words and a [link](https://example.invalid/x).",
        "",
        "> a quoted line",
        "",
        "- first item",
        "- second item",
        "",
        "```",
        "let fence = 1;",
        "```",
        "",
        "<script>alert(1)</script> stays literal",
      ].join("\n"),
    );
    await post(page);

    await freshGoto(page, publishedPost.path);
    const card = cardContaining(page, "E2E markdown heading");
    await expect(card).toBeVisible();
    // The heading became a bold paragraph, not an <h1>.
    await expect(card.locator("h1, h2, h3")).toHaveCount(0);
    await expect(card.locator("strong", { hasText: "E2E markdown heading" })).toBeVisible();
    await expect(card.locator("strong", { hasText: "bold" })).toBeVisible();
    await expect(card.locator("blockquote")).toContainText("a quoted line");
    await expect(card.locator("ul li")).toHaveCount(2);
    // The fence survived as code, and the raw HTML is text, not a script.
    await expect(card.locator("code", { hasText: "let fence = 1;" })).toBeVisible();
    await expect(card.locator("script")).toHaveCount(0);
    await expect(card).toContainText("<script>alert(1)</script> stays literal");
    // Every link is hardened, whatever was typed.
    const link = card.locator("a", { hasText: "link" });
    await expect(link).toHaveAttribute("rel", "nofollow noopener");
    await expect(link).toHaveAttribute("target", "_blank");
  });

  test("rich mode posts through the same write path, and the mode is remembered", async ({
    publishedPost,
    secondUser,
  }) => {
    const { page } = await secondUser({ role: "ADMIN" });
    await page.goto(publishedPost.path);
    await page.getByRole("button", { name: "Rich text" }).click();
    const editor = page.getByRole("textbox", { name: "Comment body" });
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.type("E2E rich comment with ");
    // The shortcut, not the toolbar button: the button's focus() is deferred
    // a frame (CLAUDE.md's requestAnimationFrame note), and a keystroke typed
    // inside that frame goes nowhere.
    await page.keyboard.press("Control+b");
    await page.keyboard.type("emphasis");
    await expect(editor.locator("strong", { hasText: "emphasis" })).toBeVisible();
    await post(page);

    await freshGoto(page, publishedPost.path);
    const card = cardContaining(page, "E2E rich comment");
    await expect(card).toBeVisible();
    await expect(card.locator("strong", { hasText: "emphasis" })).toBeVisible();

    // The choice persists per browser: the next form opens in rich mode.
    await expect(page.getByRole("button", { name: "Rich text" })).toHaveAttribute("aria-pressed", "true");
  });

  test("an unsent comment survives a reload as a restorable draft", async ({ page, publishedPost }) => {
    await page.goto(publishedPost.path);
    const box = page.getByRole("textbox", { name: "Comment body" });
    await box.fill("E2E draft that was never posted");
    // The save is debounced; a reload before it lands would lose the draft
    // by design, so wait for it rather than racing it.
    await page.waitForTimeout(800);

    await page.reload();
    await expect(page.getByRole("textbox", { name: "Comment body" })).toHaveValue("E2E draft that was never posted");
    await expect(page.getByText("Draft restored")).toBeVisible();

    await page.getByRole("button", { name: "discard" }).click();
    await expect(page.getByRole("textbox", { name: "Comment body" })).toHaveValue("");
    // The delete is an IndexedDB request a reload can cut short; give it the
    // same grace the save got.
    await page.waitForTimeout(800);
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Comment body" })).toHaveValue("");
  });

  test("editing serializes the stored body to Markdown and back", async ({ publishedPost, secondUser }) => {
    const { page, user } = await secondUser({ role: "ADMIN" });
    const { id: commentId } = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: user.email,
      displayName: "Second Admin",
      body: "E2E comment to be edited into shape.",
      status: "APPROVED",
    });
    await page.goto(publishedPost.path);
    const card = page.locator(`[data-comment-id="${commentId}"]`);
    await card.getByRole("button", { name: "Edit" }).click();
    const box = card.getByRole("textbox", { name: "Edit comment" });
    await expect(box).toHaveValue("E2E comment to be edited into shape.");
    await box.fill("E2E comment, now with *italics* and\n\n> a quote");
    await card.getByRole("button", { name: "Save" }).click();
    await expect(box).toHaveCount(0);

    await expect(card.locator("em", { hasText: "italics" })).toBeVisible();
    await expect(card.locator("blockquote")).toContainText("a quote");
    const facts = await getCommentFacts(commentId);
    expect(facts?.bodyText).toBe("E2E comment, now with italics and\na quote");
    expect(facts?.revisions).toHaveLength(2);
  });
});
