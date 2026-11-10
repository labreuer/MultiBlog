import type { Page } from "@playwright/test";
import { test, expect, freshGoto, freshGotoComment, openDashboardCard } from "./fixtures";
import {
  ADMIN_EMAIL,
  createCommentWithQuotes,
  createTestPost,
  deleteTestPost,
  deleteTestReferences,
  getCitationSources,
  getCommentBody,
  getCommentFacts,
  getCommentQuoteFacts,
  getMentionSources,
  getReferenceId,
  setTestCommentStatus,
} from "./db";
import { createAgent } from "./mcp";
import { uniqueEmail } from "./naming";

// docs/ENTITY_CHIPS.md, "Chips in comments": a comment's mentions and
// citations, from the Markdown box and from the rich editor's menus, labelled
// on the static post page in the comment style, kept in `body_text` and the
// index tables, followed by a rename, and copied by a reply that quotes them.
// The parse, the writer and the rewrite are unit-tested
// (src/lib/comment-body-chips.test.ts); this is what reaches the reader and
// the database.
//
// Only the signed-out commenter's test posts through the form, which the
// per-IP rate limit (shared with moderation.spec.ts, comment-markdown.spec.ts
// and comment-quoting.spec.ts) allows for; the rest seed through
// `createCommentWithQuotes`, which runs the same resolve-parse-match path.

const CHIP = "a.entity-chip, span.entity-chip";

function card(page: Page, commentId: string) {
  return page.locator(`[data-comment-id="${commentId}"]`).filter({ visible: true }).first();
}

/** A fixture's name by its last word, which is the unique part of it. */
function lastName(user: { name: string }) {
  return user.name.split(" ").at(-1)!;
}

/** A work in the library, by a family name no other run uses. */
async function createWork(request: Parameters<typeof createAgent>[0], prefix: string) {
  const agent = await createAgent(request);
  const key = `${prefix}-bhaskar1975`;
  const family = `Bhaskar${prefix}`;
  const made = await agent.call("create_ref", {
    csl: { type: "book", title: `A Realist Theory of Science ${prefix}`, author: [{ family }], issued: { "date-parts": [[1975]] } },
    key,
    short: "RTS",
  });
  expect(made.isError, JSON.stringify(made.error)).toBe(false);
  return { key, family };
}

test("a Markdown comment's mention and citation are chips, labelled in the comment style and indexed", async ({ page, request, secondUser }) => {
  const prefix = `e2ecc${Date.now().toString(36)}`;
  const { user: author } = await secondUser({ role: "AUTHOR" });
  const post = await createTestPost({ authorEmail: author.email, publish: true });
  try {
    const { key, family } = await createWork(request, prefix);
    await createCommentWithQuotes({
      postId: post.id,
      email: ADMIN_EMAIL,
      displayName: "Admin",
      markdown: `Thanks [@${author.name}](/authors/${author.slug}), see [@${key}, p. 4]. @everyone, this stays plain.`,
    });

    const posted = page.locator("[data-comment-id]").filter({ hasText: "this stays plain" }).filter({ visible: true }).first();
    await expect(async () => {
      await freshGoto(page, post.path!);
      await expect(posted).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    // The comment style: a name, and author-date, never the work's `short` abbreviation.
    const chips = posted.locator(CHIP);
    await expect(chips).toHaveText([`@${author.name}`, `(${family} 1975, p. 4)`]);
    await expect(chips.first()).toHaveAttribute("href", `/authors/${author.slug}`);
    await expect(chips.nth(1)).toHaveAttribute("href", new RegExp(`^/references/${key}`));
    // A bare @word is how one commenter addresses another, not a citation.
    await expect(posted).toContainText("@everyone, this stays plain.");

    const id = await posted.getAttribute("data-comment-id");
    expect(id).toBeTruthy();
    expect((await getCommentFacts(id!))?.bodyText).toBe(`Thanks @${author.name}, see (${family} 1975, p. 4). @everyone, this stays plain.`);
    expect(await getMentionSources(author.id)).toContain(`comment:${id}`);
    expect(await getCitationSources(key)).toContain(`comment:${id}`);
  } finally {
    await page.goto("about:blank");
    await deleteTestPost(post.id);
    await deleteTestReferences(prefix);
  }
});

test("an unknown key refuses the comment, and a mention a stranger may not make stays a link", async ({ publishedPost, secondUser }) => {
  const { user: other } = await secondUser({ role: "AUTHOR" });
  const stranger = uniqueEmail("stranger");
  await expect(
    createCommentWithQuotes({ postId: publishedPost.id, email: stranger, displayName: "Stranger", markdown: "see [@nosuchkey-e2e, p. 4]" }),
  ).rejects.toThrow(/No work in the library has the key @nosuchkey-e2e/);

  // Signed out, a commenter may mention the byline and the contributors; this
  // AUTHOR is neither, so their mention is the link it also is.
  const { id } = await createCommentWithQuotes({
    postId: publishedPost.id,
    email: stranger,
    displayName: "Stranger",
    markdown: `cc [@${other.name}](/authors/${other.slug}) please`,
  });
  const body = JSON.stringify(await getCommentBody(id));
  expect(body).not.toContain("entityChip");
  expect(body).toContain(`"href":"/authors/${other.slug}"`);
  expect(await getMentionSources(other.id)).not.toContain(`comment:${id}`);
});

test("a reply quoting a comment copies its mention as a chip, and a rename relabels both and the page", async ({ page, publishedPost, secondUser }) => {
  const { user: author, page: authorPage } = await secondUser({ role: "AUTHOR" });
  // An AUTHOR or above may mention anyone the doc rule offers them.
  const { id: parentId } = await createCommentWithQuotes({
    postId: publishedPost.id,
    email: ADMIN_EMAIL,
    displayName: "Admin",
    markdown: `I agree with [@${author.name}](/authors/${author.slug}) about the second point entirely.`,
  });
  const { id: replyId } = await createCommentWithQuotes({
    postId: publishedPost.id,
    email: uniqueEmail("quoter"),
    displayName: "Quoter",
    parentCommentId: parentId,
    markdown: `> I agree with @${author.name} about the second point\n\nSo do I.`,
  });

  // The quotation is anchored to the comment, its stored quote holding the chip's anchor text…
  const [quote] = await getCommentQuoteFacts(replyId);
  expect(quote.targetKind).toBe("comment");
  expect(quote.targetId).toBe(parentId);
  expect(quote.quotedText).toBe("I agree with \uFFFC about the second point");
  // …and the reply holds the chip itself, never U+FFFC as text.
  const body = JSON.stringify(await getCommentBody(replyId));
  expect(body).toContain(`"userId":"${author.id}"`);
  expect(body).not.toContain("\uFFFC");

  await freshGotoComment(page, publishedPost.path, replyId);
  await expect(card(page, replyId).locator("blockquote").locator(CHIP)).toHaveText([`@${author.name}`]);
  await expect(card(page, parentId).locator(CHIP)).toHaveText([`@${author.name}`]);

  // The person renames themselves. Nobody edits either comment.
  const renamed = `Renamed ${lastName(author)}`;
  await authorPage.goto("/dashboard");
  await openDashboardCard(authorPage, "Settings");
  await authorPage.getByLabel("Name").fill(renamed);
  await authorPage.getByRole("button", { name: "Save" }).click();
  await expect(authorPage.getByText("Saved.")).toBeVisible();

  await expect.poll(async () => (await getCommentFacts(parentId))?.bodyText, { timeout: 15_000 }).toContain(`@${renamed}`);
  await expect.poll(async () => (await getCommentFacts(replyId))?.bodyText, { timeout: 15_000 }).toContain(`@${renamed}`);
  // The page shows the new name at its next regeneration.
  await expect(async () => {
    await freshGoto(page, publishedPost.path);
    await expect(card(page, parentId).locator(CHIP)).toHaveText([`@${renamed}`], { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(card(page, replyId).locator("blockquote").locator(CHIP)).toHaveText([`@${renamed}`]);
});

test("mentions=me and the dashboard find an approved comment's mention, and not a pending one's until it is approved", async ({
  publishedPost,
  secondUser,
}) => {
  const { user: author, page: authorPage } = await secondUser({ role: "AUTHOR" });
  // A writer of their own, so the name their comments are posted under is this test's.
  const { user: writer } = await secondUser({ role: "ADMIN" });
  const word = `chipword${Date.now()}`;
  const by = `Writer ${word}`;
  const other = await createTestPost({ authorEmail: ADMIN_EMAIL, publish: true });
  try {
    const mention = `[@${author.name}](/authors/${author.slug})`;
    const { id: approved } = await createCommentWithQuotes({
      postId: publishedPost.id,
      email: writer.email,
      displayName: by,
      markdown: `The ${word} goes to ${mention}.`,
    });
    const { id: pending } = await createCommentWithQuotes({
      postId: other.id,
      email: writer.email,
      displayName: by,
      markdown: `Another ${word} for ${mention}.`,
      status: "PENDING",
    });
    const sources = await getMentionSources(author.id);
    expect(sources).toContain(`comment:${approved}`);
    expect(sources).not.toContain(`comment:${pending}`);

    await authorPage.goto(`/search?q=${word}&mentions=me`);
    await expect(authorPage.getByText("Only what mentions you")).toBeVisible();
    await expect(authorPage.getByRole("link", { name: `${by} on ${publishedPost.title}` })).toBeVisible();
    await expect(authorPage.getByRole("link", { name: `${by} on ${other.title}` })).toHaveCount(0);

    await authorPage.goto("/dashboard");
    const cardOf = authorPage.locator("details").filter({ has: authorPage.getByRole("heading", { name: "Mentions of you" }) });
    await expect(cardOf.getByRole("link", { name: publishedPost.title })).toBeVisible();
    await expect(cardOf).toContainText(`a comment by ${by}`);
    await expect(cardOf.getByRole("link", { name: other.title })).toHaveCount(0);

    // Approval is when a comment's mention is first seen.
    await setTestCommentStatus(pending, "APPROVED");
    expect(await getMentionSources(author.id)).toContain(`comment:${pending}`);
  } finally {
    await authorPage.goto("about:blank");
    await deleteTestPost(other.id);
  }
});

// The rich editor's menus, for a commenter who isn't signed in: they ask of
// the post, and offer only what its page already shows, its byline and the
// contributor list, and the works it cites.
test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the menus offer the post's byline and its works, and what they insert is labelled on the page", async ({ page, request, secondUser }) => {
    const prefix = `e2eccm${Date.now().toString(36)}`;
    const { user: author } = await secondUser({ role: "AUTHOR" });
    // On no byline and no contributor list: a member may mention them, a stranger may not.
    const { user: other } = await secondUser({ role: "AUTHOR" });
    const { key, family } = await createWork(request, prefix);
    // The same family name and one letter more: it matches a search for the cited work.
    await createWork(request, `${prefix}x`);
    const refId = await getReferenceId(key);
    const post = await createTestPost({
      authorEmail: author.email,
      publish: true,
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "As argued " },
              { type: "entityChip", attrs: { kind: "citation", iid: "c1", data: { items: [{ refId }] } } },
              { type: "text", text: "." },
            ],
          },
        ],
      },
    });
    try {
      await page.goto(post.path!);
      await page.getByPlaceholder("Name").fill("Passing Reader");
      await page.getByPlaceholder("Email").fill(uniqueEmail("menus"));
      await page.getByRole("button", { name: "Rich text" }).click();
      const editor = page.getByRole("textbox", { name: "Comment body" });
      await editor.click();

      // "@" alone lists the byline first.
      await page.keyboard.type("Thanks @");
      const people = page.getByRole("listbox", { name: "People" });
      await expect(people.getByRole("option").first()).toContainText(author.name);
      await page.keyboard.type(lastName(author));
      await expect(people.getByRole("option", { name: author.name })).toBeVisible();
      await page.keyboard.press("Enter");
      const chips = editor.locator("span.entity-chip");
      await expect(chips).toHaveText([`@${author.name}`]);

      // "[@" alone lists the post's own works.
      await page.keyboard.type("for this [@");
      const works = page.getByRole("listbox", { name: "References" });
      await expect(works.getByText("Cited in this post")).toBeVisible();
      await expect(works.getByRole("option")).toHaveCount(1);
      await page.keyboard.type(`${family} 4`);
      await expect(works.getByRole("option", { name: /— p\. 4/ })).toBeVisible();
      // The other work matches as well, and the library is a member's.
      await expect(works.getByRole("option")).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect(chips).toHaveText([`@${author.name}`, `(${family} 1975, p. 4)`]);

      // A comment's citation has no narrative form, and its popover says so.
      await chips.nth(1).click();
      const popover = page.locator("[data-cite-popover]");
      await expect(popover.getByLabel("In the sentence")).toBeDisabled();
      await expect(popover).toContainText("In a comment, a citation is always in parentheses.");
      await page.keyboard.press("End");
      await expect(popover).toHaveCount(0);

      // Someone off the byline and the list isn't offered: the menu closes when the answer lands.
      await page.keyboard.type(" and @");
      await expect(people).toBeVisible();
      await page.keyboard.type(lastName(other));
      await expect(people).toHaveCount(0);

      await page.getByRole("button", { name: "Post comment" }).click();
      await expect(editor).toHaveCount(0);

      const posted = page.locator("[data-comment-id]").filter({ hasText: "for this" }).filter({ visible: true }).first();
      await expect(async () => {
        await freshGoto(page, post.path!);
        await expect(posted).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      await expect(posted.locator(CHIP)).toHaveText([`@${author.name}`, `(${family} 1975, p. 4)`]);
      await expect(posted.locator(CHIP).first()).toHaveAttribute("href", `/authors/${author.slug}`);
      await expect(posted).toContainText(`@${lastName(other)}`);

      const id = await posted.getAttribute("data-comment-id");
      expect(id).toBeTruthy();
      expect(await getMentionSources(author.id)).toContain(`comment:${id}`);
      expect(await getMentionSources(other.id)).not.toContain(`comment:${id}`);
      expect(await getCitationSources(key)).toContain(`comment:${id}`);
    } finally {
      await page.goto("about:blank");
      await deleteTestPost(post.id);
      await deleteTestReferences(prefix);
    }
  });
});
