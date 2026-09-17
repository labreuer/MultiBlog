import type { Page } from "@playwright/test";
import { test, expect, freshGoto, selectTextInBody } from "./fixtures";
import {
  ADMIN_EMAIL,
  createComment,
  createCommentWithQuotes,
  createTestPost,
  deleteTestPost,
  getCommentFacts,
  getCommentQuoteFacts,
  uniqueEmail,
} from "./db";

// PLAN.md §23n / §23f / §23h — a comment quoting what is on the page.
//
// The matcher's own table is a unit suite (src/lib/comment-quote-match.test.ts);
// what this asserts is the shape that reaches the reader and the database:
// a `>` block that matches the post becomes an anchored blockquote with a
// citation naming the post, a typo in a hand-typed quote of another comment
// is corrected to the comment's own words, a block that matches nothing
// stays a plain quote, and the two gestures — "Quote in comment instead" in
// the article's popover and "Quote in reply" over a selection in a card —
// land where they should.
//
// Most comments here are seeded through `createCommentWithQuotes`, which runs
// the real parse-match-rewrite path without the form; only the two gesture
// tests post through the form, which the per-IP rate limit (5 per 10 minutes,
// shared with moderation.spec.ts and comment-markdown.spec.ts) allows for.

const POST_BODY = "The quick brown fox jumps over the lazy dog.";

function card(page: Page, commentId: string) {
  return page.locator(`[data-comment-id="${commentId}"]`);
}

test.describe("quoting into a comment", () => {
  test("a Markdown quote of the post becomes an anchored blockquote with a citation", async ({ page, publishedPost }) => {
    const { id } = await createCommentWithQuotes({
      postId: publishedPost.id,
      email: uniqueEmail("quoter"),
      displayName: "Quoter",
      markdown: `> ${POST_BODY}\n\nIndeed it does.`,
    });
    await freshGoto(page, publishedPost.path);
    const quote = card(page, id).locator("blockquote[data-anchor-id]");
    await expect(quote).toContainText(POST_BODY);
    await expect(quote.locator("footer")).toContainText(publishedPost.title);
    await expect(quote.locator("footer a")).toHaveAttribute("href", publishedPost.path);

    const facts = await getCommentQuoteFacts(id);
    expect(facts).toHaveLength(1);
    expect(facts[0].targetKind).toBe("post");
    expect(facts[0].targetId).toBe(publishedPost.id);
    expect(facts[0].quotedText).toBe(POST_BODY);
    expect(facts[0].anchoredEventId).toBe(publishedPost.eventId);
    expect(facts[0].quotedRevisionId).toBeNull();
  });

  test("a hand-typed quote of another comment is corrected to that comment's own words", async ({
    page,
    publishedPost,
  }) => {
    // Long enough for the fuzzy tier (END_CHARS on each end, intact), with
    // the typos in the middle third — a misquote in the last 32 characters
    // is deliberately not caught.
    const original = "Precision matters more than speed in this argument, every single time, without any exception at all.";
    const { id: quotedId } = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: uniqueEmail("author"),
      displayName: "Careful Author",
      body: original,
      status: "APPROVED",
    });
    const { id } = await createCommentWithQuotes({
      postId: publishedPost.id,
      email: uniqueEmail("quoter"),
      displayName: "Quoter",
      // Two typos and straight quotes; the ends tier finds it and the rewrite
      // stores the source's words (§23f), so the reader sees them corrected.
      markdown: `> Precision matters more than speed in this argumnet, evrey single time, without any exception at all.\n\nAgreed.`,
    });
    await freshGoto(page, publishedPost.path);
    const quote = card(page, id).locator("blockquote[data-anchor-id]");
    await expect(quote).toContainText(original);
    await expect(quote).not.toContainText("argumnet");
    await expect(quote.locator("footer")).toContainText("Careful Author's comment");
    await expect(quote.locator("footer a")).toHaveAttribute("href", /#careful-author-/);

    const facts = await getCommentQuoteFacts(id);
    expect(facts[0].targetKind).toBe("comment");
    expect(facts[0].targetId).toBe(quotedId);
    expect(facts[0].quotedText).toBe(original);
    expect(facts[0].quotedRevisionId).not.toBeNull();
  });

  test("a quote that matches nothing on the page stays an ordinary blockquote", async ({ page, publishedPost }) => {
    const { id } = await createCommentWithQuotes({
      postId: publishedPost.id,
      email: uniqueEmail("quoter"),
      displayName: "Quoter",
      markdown: `> Something nobody on this page has written, from a book.\n\nA thought.`,
    });
    await freshGoto(page, publishedPost.path);
    const quote = card(page, id).locator("blockquote");
    await expect(quote).toContainText("from a book");
    await expect(quote).not.toHaveAttribute("data-anchor-id", /.+/);
    await expect(quote.locator("footer")).toHaveCount(0);
    expect(await getCommentQuoteFacts(id)).toHaveLength(0);
  });

  test("an inline quote in prose becomes a <q> with the citation as its title", async ({ page, publishedPost }) => {
    const { id } = await createCommentWithQuotes({
      postId: publishedPost.id,
      email: uniqueEmail("quoter"),
      displayName: "Quoter",
      markdown: `The line "jumps over the lazy dog" is the whole point.`,
    });
    await freshGoto(page, publishedPost.path);
    const q = card(page, id).locator("q[data-anchor-id]");
    await expect(q).toHaveText("jumps over the lazy dog");
    await expect(q).toHaveAttribute("title", publishedPost.title);
    const facts = await getCommentQuoteFacts(id);
    expect(facts[0].quotedText).toBe("jumps over the lazy dog");
  });

  test("quoting a comment makes its version visible when it is edited, and the citation says so", async ({
    page,
    publishedPost,
    secondUser,
  }) => {
    const { page: authorPage, user: author } = await secondUser({ role: "ADMIN" });
    const original = "A claim the author will later change entirely.";
    const { id: quotedId } = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: author.email,
      displayName: "Second Admin",
      body: original,
      status: "APPROVED",
    });
    const { id: quotingId } = await createCommentWithQuotes({
      postId: publishedPost.id,
      email: uniqueEmail("quoter"),
      displayName: "Quoter",
      markdown: `> ${original}\n\nReally?`,
    });

    // The author edits the quoted words away, well inside the three-minute
    // window — which would be silent (§22b) if nothing quoted the version.
    await authorPage.goto(publishedPost.path);
    const own = card(authorPage, quotedId);
    await own.getByRole("button", { name: "Edit" }).click();
    const box = own.getByRole("textbox", { name: "Edit comment" });
    await expect(box).toHaveValue(original);
    await box.fill("A claim the author has now retracted.");
    await own.getByRole("button", { name: "Save" }).click();
    await expect(box).toHaveCount(0);

    await freshGoto(page, publishedPost.path);
    // The quoted comment shows its history despite the edit being inside the window.
    await expect(card(page, quotedId).getByRole("button", { name: /earlier versions/ })).toBeVisible();
    // The quoting comment keeps the words it quoted and says the source moved on.
    const quote = card(page, quotingId).locator("blockquote[data-anchor-id]");
    await expect(quote).toContainText(original);
    await expect(quote.locator("footer")).toContainText("quoted an earlier version");

    const facts = await getCommentFacts(quotedId);
    expect(facts?.revisions).toHaveLength(2);
  });

  test("'Quote in comment instead' drops the article selection into the general form as Markdown", async ({
    page,
    publishedPost,
  }) => {
    await page.goto(publishedPost.path);
    await selectTextInBody(page, "brown fox jumps");
    await page.getByTestId("quote-in-comment").click();
    const box = page.getByRole("textbox", { name: "Comment body" });
    await expect(box).toHaveValue(/^> brown fox jumps\n\n$/);
    // The popover is gone; the selection became text in the box, which the
    // matcher then handles exactly as the seeded Markdown tests above prove.
    // Not posted: the per-IP rate limit shared with the other comment specs
    // leaves room for one gesture post per run, and the reply one carries the
    // hint round trip that this one has nothing to add to.
    await expect(page.getByTestId("comment-popup")).toHaveCount(0);
  });

  test("'Quote in reply' over a selection in a card opens the reply with the quote, in rich mode with the hint", async ({
    publishedPost,
    secondUser,
  }) => {
    const { page } = await secondUser({ role: "ADMIN" });
    const parentText = "Selecting inside this comment should offer to quote it in a reply.";
    const { id: parentId } = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: ADMIN_EMAIL,
      displayName: "Admin Commenter",
      body: parentText,
      status: "APPROVED",
    });
    await page.goto(publishedPost.path);
    // Rich mode, remembered for this context, so the reply form opens rich
    // and the gesture inserts an anchored blockquote with a pending hint.
    await page.getByRole("button", { name: "Rich text" }).click();

    // A synthetic selection plus the two events the popover settles on —
    // `selectionchange` (debounced) and `pointerup` (immediate). Retried:
    // once, in the full suite under load, the affordance did not appear for a
    // first synthetic selection while it appears every time in isolation
    // (30/30 at --repeat-each=4); a second selection is what a person would
    // do, and it costs nothing when the first one lands.
    const quoteButton = page.getByTestId("quote-in-reply");
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.evaluate((needle) => {
        const body = document.querySelector("[data-comment-body]");
        if (!body) throw new Error("no comment body");
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const index = node.textContent?.indexOf(needle) ?? -1;
          if (index === -1) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + needle.length);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new Event("selectionchange"));
          document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
          return;
        }
        throw new Error("needle not found");
      }, "offer to quote it");
      if (await quoteButton.isVisible({ timeout: 2_000 }).catch(() => false)) break;
      await page.waitForTimeout(500);
    }
    await expect(quoteButton).toBeVisible();
    await quoteButton.click();

    const reply = page.locator(`[data-reply-form="${parentId}"] form`);
    const editor = reply.getByRole("textbox", { name: "Comment body" });
    await expect(editor).toBeVisible();
    await expect(editor.locator("blockquote")).toContainText("offer to quote it");
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type("Well put.");
    await reply.getByRole("button", { name: "Post comment" }).click();
    await expect(reply).toHaveCount(0);

    await freshGoto(page, publishedPost.path);
    const quote = page.locator("blockquote[data-anchor-id]", { hasText: "offer to quote it" });
    await expect(quote).toBeVisible();
    // The shared admin's existing commenter row keeps its own display name
    // (createComment upserts), so the citation is checked by target rather
    // than by the name passed above.
    await expect(quote.locator("footer")).toContainText("'s comment");
    const quotingId = await quote.locator("xpath=ancestor::*[@data-comment-id][1]").getAttribute("data-comment-id");
    const facts = await getCommentQuoteFacts(quotingId!);
    expect(facts).toHaveLength(1);
    expect(facts[0].targetKind).toBe("comment");
    expect(facts[0].targetId).toBe(parentId);
    expect(facts[0].quotedText).toBe("offer to quote it");
  });
});

// PLAN.md §23h, Phase 4 — quoting what is *not* on the page. The picker
// searches published posts and public comments, shows the chosen body for a
// passage selection, and hands the composer a quote with the target named;
// the server loads that target as a match candidate because the hint says
// to, and nothing else on the page would have found it.
test.describe("quoting from elsewhere", () => {
  const OTHER_BODY = "An entirely separate article about migratory birds and their long journeys south.";

  test("a seeded quote of another post resolves through its hint and cites that post", async ({
    page,
    publishedPost,
  }) => {
    const other = await createTestPost({ authorEmail: ADMIN_EMAIL, bodyText: OTHER_BODY, publish: true });
    try {
      const { id } = await createCommentWithQuotes({
        postId: publishedPost.id,
        email: uniqueEmail("quoter"),
        displayName: "Quoter",
        markdown: `> migratory birds and their long journeys south\n\nFrom the other piece.`,
        pending: [{ target: { kind: "post", id: other.id }, text: "migratory birds and their long journeys south" }],
      });
      await freshGoto(page, publishedPost.path);
      const quote = card(page, id).locator("blockquote[data-anchor-id]");
      await expect(quote).toContainText("migratory birds");
      await expect(quote.locator("footer a")).toHaveAttribute("href", other.path!);
      await expect(quote.locator("footer")).toContainText(other.title);
      const facts = await getCommentQuoteFacts(id);
      expect(facts[0].targetKind).toBe("post");
      expect(facts[0].targetId).toBe(other.id);
    } finally {
      await deleteTestPost(other.id);
    }
  });

  test("without the hint, the same quote matches nothing on the page", async ({ page, publishedPost }) => {
    const other = await createTestPost({ authorEmail: ADMIN_EMAIL, bodyText: OTHER_BODY, publish: true });
    try {
      const { id } = await createCommentWithQuotes({
        postId: publishedPost.id,
        email: uniqueEmail("quoter"),
        displayName: "Quoter",
        markdown: `> migratory birds and their long journeys south\n\nFrom the other piece.`,
      });
      await freshGoto(page, publishedPost.path);
      await expect(card(page, id).locator("blockquote")).toContainText("migratory birds");
      expect(await getCommentQuoteFacts(id)).toHaveLength(0);
    } finally {
      await deleteTestPost(other.id);
    }
  });

  test("the picker finds another post, and a selection in it lands in the box with the target named", async ({
    page,
    publishedPost,
  }) => {
    const other = await createTestPost({ authorEmail: ADMIN_EMAIL, bodyText: OTHER_BODY, publish: true });
    try {
      await page.goto(publishedPost.path);
      await page.getByRole("button", { name: "Quote from elsewhere…" }).click();
      const picker = page.getByTestId("quote-picker");
      await picker.getByRole("searchbox", { name: "Search for something to quote" }).fill("migratory birds");
      await picker.getByRole("button", { name: other.title }).click();
      const body = page.getByTestId("quote-picker-body");
      await expect(body).toContainText("migratory birds");

      await page.evaluate((needle) => {
        const root = document.querySelector('[data-testid="quote-picker-body"]');
        if (!root) throw new Error("no picker body");
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const index = node.textContent?.indexOf(needle) ?? -1;
          if (index === -1) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + needle.length);
          const selection = window.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          document.dispatchEvent(new Event("selectionchange"));
          document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
          return;
        }
        throw new Error("needle not found");
      }, "long journeys south");
      const quoteButton = picker.getByRole("button", { name: "Quote selection" });
      await expect(quoteButton).toBeEnabled();
      await quoteButton.click();

      await expect(picker).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "Comment body" })).toHaveValue(/^> long journeys south\n\n$/);
      const pending = await page.locator('input[name="pendingQuotes"]').inputValue();
      expect(JSON.parse(pending)).toEqual([{ id: null, target: { kind: "post", id: other.id }, text: "long journeys south" }]);
    } finally {
      await deleteTestPost(other.id);
    }
  });
});
