import type { Locator, Page } from "@playwright/test";
import { test, expect, freshGotoComment, QUOTED_TEXT, QUOTE_FROM, QUOTE_TO } from "./fixtures";
import { ADMIN_EMAIL, createComment, createTestAnnotation } from "./db";

// docs/ANNOTATIONS.md, "Clamping a long body", and docs/COMMENTS.md, "A long
// body is clamped" — a body past 16 lines shows 12 until the reader opens it,
// for this visit only. The cases are the ones a glance at the page wouldn't
// settle: that a short body is left alone, that opening isn't remembered,
// that a scroll of the box (find in page's way in) opens it, and that a
// comment card has the same thing.

/** About 4,000 characters in one paragraph: far past 16 lines at any card's width. */
const LONG_TEXT = "E2E long body. " + "A note this long is an essay beside its passage, and the card should say so. ".repeat(50).trim();
const WORDS = LONG_TEXT.split(/\s+/).length;
const SHOW_ALL = `Show all ${WORDS.toLocaleString("en-US")} words`;

function card(page: Page, id: string) {
  return page.locator(`[data-comment-id="${id}"]`);
}

function box(target: Locator) {
  return target.locator("[data-clamp]").first();
}

test.describe("clamping a long body", () => {
  test("a long annotation is cut until opened, a short one is left whole, and opening isn't remembered", async ({
    page,
    sharedDoc,
  }) => {
    const anchor = { from: QUOTE_FROM, to: QUOTE_TO, quotedText: QUOTED_TEXT };
    const long = await createTestAnnotation({ docId: sharedDoc.id, authorEmail: ADMIN_EMAIL, bodyText: LONG_TEXT, anchor });
    const short = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: "E2E short note, a line long.",
      anchor,
    });
    await page.goto(`/doc/${sharedDoc.slug}`);

    const longCard = card(page, long.id);
    const showAll = longCard.getByRole("button", { name: SHOW_ALL });
    await expect(showAll).toBeVisible({ timeout: 15_000 });
    await expect(showAll).toHaveAttribute("aria-expanded", "false");
    await expect(box(longCard)).toHaveAttribute("data-clamp", "clamped");
    // Cut, not removed: the box is shorter than what it holds.
    expect(await box(longCard).evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);

    const shortCard = card(page, short.id);
    await expect(shortCard.getByText("E2E short note, a line long.").filter({ visible: true })).toBeVisible();
    await expect(box(shortCard)).toHaveAttribute("data-clamp", "open");
    await expect(shortCard.getByRole("button", { name: /^Show all/ })).toHaveCount(0);

    await showAll.click();
    const showLess = longCard.getByRole("button", { name: "Show less" });
    await expect(showLess).toHaveAttribute("aria-expanded", "true");
    await expect(box(longCard)).toHaveAttribute("data-clamp", "open");
    expect(await box(longCard).evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(false);

    await page.reload();
    await expect(card(page, long.id).getByRole("button", { name: SHOW_ALL })).toBeVisible({ timeout: 15_000 });
  });

  test("a scroll inside a clamped box, the way find in page brings hidden text into view, opens it", async ({
    page,
    sharedDoc,
  }) => {
    const long = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: LONG_TEXT,
      anchor: { from: QUOTE_FROM, to: QUOTE_TO, quotedText: QUOTED_TEXT },
    });
    await page.goto(`/doc/${sharedDoc.slug}`);
    const longCard = card(page, long.id);
    await expect(longCard.getByRole("button", { name: SHOW_ALL })).toBeVisible({ timeout: 15_000 });

    await box(longCard).evaluate((el) => {
      el.scrollTop = 100;
    });
    await expect(box(longCard)).toHaveAttribute("data-clamp", "open");
    await expect(longCard.getByRole("button", { name: "Show less" })).toBeVisible();
  });

  test("a long comment is cut until opened", async ({ page, publishedPost }) => {
    const { id } = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: ADMIN_EMAIL,
      displayName: "Admin Commenter",
      body: LONG_TEXT,
      status: "APPROVED",
    });
    await freshGotoComment(page, publishedPost.path, id);

    const comment = card(page, id);
    const showAll = comment.getByRole("button", { name: SHOW_ALL });
    await expect(showAll).toBeVisible({ timeout: 15_000 });
    await expect(box(comment)).toHaveAttribute("data-clamp", "clamped");
    await showAll.click();
    await expect(box(comment)).toHaveAttribute("data-clamp", "open");
    await expect(comment.getByRole("button", { name: "Show less" })).toBeVisible();
  });
});
