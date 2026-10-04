import type { Browser, Page } from "@playwright/test";
import { test, expect, gotoOk } from "./fixtures";
import {
  ADMIN_EMAIL,
  createComment,
  createTestAnnotation,
  createTestDoc,
  createTestFile,
  createTestPost,
  deleteTestDoc,
  deleteTestFile,
  deleteTestPost,
  editCommentAt,
  uniqueEmail,
  uniqueTitle,
} from "./db";

// docs/FULLTEXT.md — /search, end to end. Each test plants a word nothing
// else in the database contains and searches for it, so a hit or a miss can
// only be about the row the test made.
//
// What is worth a browser here is the read rules: each kind's hits come from
// its own `where` helper (§2), and a leak would look exactly like the feature
// working. So most tests are one row searched by several people — the one
// who may see it and the ones who may not.

/** A token the stemmer leaves alone and no other row contains. */
function plantedWord(): string {
  return `zq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** One kind's section on /search, found by its heading ("Docs (2)"). */
function section(page: Page, heading: "Docs" | "Posts" | "PDFs" | "Annotations" | "Comments") {
  return page.getByRole("region", { name: new RegExp(`^${heading} \\(`) });
}

async function searchAs(page: Page, query: string): Promise<void> {
  await gotoOk(page, `/search?${query}`);
}

async function signedOutPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  return context.newPage();
}

test.describe("/search", () => {
  test("a PRIVATE doc is found by its author and nobody else", async ({ page, browser, secondUser }) => {
    const word = plantedWord();
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: `A private note mentioning ${word}.` });
    try {
      await searchAs(page, `q=${word}`);
      await expect(section(page, "Docs").getByRole("link", { name: doc.title })).toBeVisible();
      // The snippet marks the match as typed.
      await expect(section(page, "Docs").locator("mark", { hasText: word })).toBeVisible();

      // Another AUTHOR, an AUTHORIZED reader and a signed-out visitor: no
      // PRIVATE doc is anybody's but its byline's, ADMIN and EDITOR included.
      for (const role of ["AUTHOR", "AUTHORIZED", "EDITOR"] as const) {
        const other = await secondUser({ role });
        await searchAs(other.page, `q=${word}`);
        await expect(other.page.getByText(`Nothing you can read matches “${word}”.`)).toBeVisible();
      }
      const anon = await signedOutPage(browser);
      await searchAs(anon, `q=${word}&kinds=docs`);
      await expect(anon.getByText("None of the kinds selected is one you can search.")).toBeVisible();
      await anon.context().close();
    } finally {
      await deleteTestDoc(doc.id);
    }
  });

  test("drafts and scheduled posts are found by the people who may edit them", async ({ page, browser, secondUser }) => {
    const author = await secondUser({ role: "AUTHOR" });
    const draftWord = plantedWord();
    const scheduledWord = plantedWord();
    // A draft has no text of its own until it is published, so it is found by its title.
    const draft = await createTestPost({ authorEmail: author.user.email, title: uniqueTitle(`draft ${draftWord}`) });
    const scheduled = await createTestPost({
      authorEmail: author.user.email,
      bodyText: `Not live until next week: ${scheduledWord}.`,
      scheduledFor: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    try {
      const query = `q=${draftWord} or ${scheduledWord}&kinds=posts`;

      // The byline author, and an EDITOR (who may edit every post), see both,
      // marked, linking into the editor rather than to a public URL that
      // doesn't answer yet.
      for (const viewer of [author.page, (await secondUser({ role: "EDITOR" })).page]) {
        await searchAs(viewer, query);
        const posts = section(viewer, "Posts");
        await expect(posts.getByRole("link", { name: draft.title })).toHaveAttribute("href", `/post/${draft.id}/edit`);
        await expect(posts.getByRole("link", { name: scheduled.title })).toHaveAttribute(
          "href",
          `/post/${scheduled.id}/edit`,
        );
        await expect(posts.getByText("draft", { exact: true })).toBeVisible();
        await expect(posts.getByText("scheduled", { exact: true })).toBeVisible();
      }

      // Another AUTHOR, not on the byline, and a signed-out reader see neither.
      const otherAuthor = await secondUser({ role: "AUTHOR" });
      await searchAs(otherAuthor.page, query);
      await expect(section(otherAuthor.page, "Posts")).toHaveCount(0);
      const anon = await signedOutPage(browser);
      await searchAs(anon, query);
      await expect(section(anon, "Posts")).toHaveCount(0);
      await anon.context().close();

      // The shared admin, an ADMIN, may edit every post too. (List items, not
      // links: a byline's names are links as well.)
      await searchAs(page, query);
      await expect(section(page, "Posts").getByRole("listitem")).toHaveCount(2);
    } finally {
      await deleteTestPost(draft.id);
      await deleteTestPost(scheduled.id);
    }
  });

  test("a DRAFT annotation and a PENDING comment are found by nobody", async ({ page, sharedDoc, publishedPost }) => {
    const word = plantedWord();
    await createTestAnnotation({ docId: sharedDoc.id, authorEmail: ADMIN_EMAIL, bodyText: `kept private ${word}`, draft: true });
    await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: uniqueEmail("pending"),
      displayName: "Pending Reader",
      body: `awaiting moderation ${word}`,
      status: "PENDING",
    });
    // And their posted, approved twins, which are.
    const liveWord = plantedWord();
    await createTestAnnotation({ docId: sharedDoc.id, authorEmail: ADMIN_EMAIL, bodyText: `posted ${liveWord}` });
    await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email: uniqueEmail("approved"),
      displayName: "Approved Reader",
      body: `already public ${liveWord}`,
      status: "APPROVED",
    });

    // The DRAFT is the searcher's own, and the post is the searcher's to
    // moderate: neither is a reason to list them (§2, §10 item 2).
    await searchAs(page, `q=${word}`);
    await expect(page.getByText(`Nothing you can read matches “${word}”.`)).toBeVisible();

    await searchAs(page, `q=${liveWord}`);
    await expect(section(page, "Annotations").getByRole("listitem")).toHaveCount(1);
    await expect(section(page, "Comments").getByRole("link", { name: /^Approved Reader on / })).toBeVisible();
  });

  test("filters: kind, author and created date", async ({ page, secondUser }) => {
    const word = plantedWord();
    const other = await secondUser({ role: "AUTHOR" });
    const mine = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: `ours ${word}` });
    const theirs = await createTestDoc({ authorEmail: other.user.email, visibility: "SHARED", bodyText: `theirs ${word}` });
    const old = await createTestPost({
      authorEmail: ADMIN_EMAIL,
      bodyText: `an old post ${word}`,
      publish: true,
      publishedAt: "2001-02-03T12:00:00.000Z",
    });
    try {
      // By name rather than by count: the post's own backing doc carries the
      // word too, as every fixture post's does.
      await searchAs(page, `q=${word}`);
      await expect(section(page, "Docs").getByRole("link", { name: mine.title })).toBeVisible();
      await expect(section(page, "Docs").getByRole("link", { name: theirs.title })).toBeVisible();
      await expect(section(page, "Posts").getByRole("listitem")).toHaveCount(1);

      // Kind.
      await searchAs(page, `q=${word}&kinds=posts`);
      await expect(section(page, "Docs")).toHaveCount(0);
      await expect(section(page, "Posts").getByRole("listitem")).toHaveCount(1);

      // Author, chosen through the picker, which offers names only — and an
      // author filter says it leaves PDFs and comments out.
      await searchAs(page, `q=${word}`);
      await page.getByText("Filters").click();
      await page.getByRole("checkbox", { name: other.user.name }).check();
      await page.getByRole("button", { name: "Search" }).click();
      await expect(page).toHaveURL(new RegExp(`authors=${other.user.slug}`));
      await expect(section(page, "Docs").getByRole("link", { name: theirs.title })).toBeVisible();
      await expect(section(page, "Docs").getByRole("link", { name: mine.title })).toHaveCount(0);
      await expect(section(page, "Posts")).toHaveCount(0);
      await expect(page.getByText(/^Filtering by author leaves out PDFs and comments/)).toBeVisible();

      // Created: a post's go-live date, a day in the URL's zone.
      await searchAs(page, `q=${word}&created_from=2001-02-03&created_to=2001-02-03`);
      await expect(section(page, "Posts").getByRole("listitem")).toHaveCount(1);
      await expect(section(page, "Docs")).toHaveCount(0);
      // 12:00 UTC on the 3rd is already the 4th at UTC+14.
      await searchAs(page, `q=${word}&created_from=2001-02-03&created_to=2001-02-03&tz=Pacific/Kiritimati`);
      await expect(section(page, "Posts")).toHaveCount(0);
    } finally {
      await deleteTestDoc(mine.id);
      await deleteTestDoc(theirs.id);
      await deleteTestPost(old.id);
    }
  });

  test("an edit readers weren't told about can't be found by its date", async ({ page, publishedPost }) => {
    const word = plantedWord();
    const email = uniqueEmail("silent");
    // Posted a minute before midnight and fixed two minutes later: inside the
    // grace window, so the card shows no edit — and an "updated" range over
    // the day of the edit must not find it either (§6). The edit is on the
    // 2nd; the comment, as far as any reader knows, is from the 1st.
    const silent = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email,
      displayName: "Silent Editor",
      body: `a typo ${word}`,
      status: "APPROVED",
      createdAt: "2026-01-01T23:59:00.000Z",
    });
    await editCommentAt({ commentId: silent.id, body: `a fixed typo ${word}`, at: "2026-01-02T00:01:00.000Z" });

    await searchAs(page, `q=${word}&updated_from=2026-01-02&updated_to=2026-01-02`);
    await expect(section(page, "Comments")).toHaveCount(0);
    await searchAs(page, `q=${word}&updated_from=2026-01-01&updated_to=2026-01-01`);
    await expect(section(page, "Comments").getByRole("listitem")).toHaveCount(1);
    await expect(section(page, "Comments")).not.toContainText("edited");

    // An edit after the window is one readers are told about, and is.
    const visibleWord = plantedWord();
    const visible = await createComment({
      postId: publishedPost.id,
      anchoredEventId: publishedPost.eventId!,
      email,
      displayName: "Silent Editor",
      body: `first draft ${visibleWord}`,
      status: "APPROVED",
      createdAt: "2026-01-01T10:00:00.000Z",
    });
    await editCommentAt({ commentId: visible.id, body: `second thoughts ${visibleWord}`, at: "2026-01-03T10:00:00.000Z" });
    await searchAs(page, `q=${visibleWord}&updated_from=2026-01-03&updated_to=2026-01-03`);
    await expect(section(page, "Comments").getByRole("listitem")).toHaveCount(1);
    await expect(section(page, "Comments")).toContainText("edited");
  });

  test("accents fold: Godel finds Gödel", async ({ page }) => {
    const word = plantedWord();
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: `Kurt Gödel's incompleteness, ${word}.` });
    try {
      await searchAs(page, `q=Godel ${word}`);
      // Marked as written, accent and all.
      await expect(section(page, "Docs").locator("mark", { hasText: "Gödel" })).toBeVisible();
    } finally {
      await deleteTestDoc(doc.id);
    }
  });

  test("a typo is corrected, says so, and can be undone", async ({ page }) => {
    const word = plantedWord();
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: `Alasdair MacIntyre on the virtues, ${word}.` });
    try {
      // Nothing matches "macintire" as typed; its nearest lexeme with hits
      // this reader can see is `macintyr` (§5).
      await searchAs(page, `q=macintire ${word}`);
      await expect(page.getByText(/as typed, so these are close matches\./)).toBeVisible();
      await expect(section(page, "Docs").getByRole("link", { name: doc.title })).toBeVisible();
      await expect(section(page, "Docs").locator("mark", { hasText: "MacIntyre" })).toBeVisible();

      await page.getByRole("link", { name: "Search exactly as typed" }).click();
      await expect(page).toHaveURL(/exact=1/);
      await expect(page.getByText(/^Nothing you can read matches/)).toBeVisible();
    } finally {
      await deleteTestDoc(doc.id);
    }
  });

  test("a stop-word-only query says so rather than finding nothing", async ({ page }) => {
    await searchAs(page, "q=the and of");
    await expect(page.getByText(/is made only of words too common to search for/)).toBeVisible();
  });

  test("a PDF page hit opens the viewer on that page", async ({ page }) => {
    const word = plantedWord();
    const file = await createTestFile({
      ownerEmail: ADMIN_EMAIL,
      visibility: "SHARED",
      pages: [["The first page says nothing much."], ["Neither does the second."], [`The third page has ${word}.`]],
    });
    try {
      await searchAs(page, `q=${word}`);
      const pdfs = section(page, "PDFs");
      await expect(pdfs.getByRole("link", { name: file.title })).toBeVisible();
      await pdfs.getByRole("link", { name: "p. 3" }).click();
      await expect(page).toHaveURL(new RegExp(`/pdf/${file.slug}#page=3$`));
      await expect(page.getByLabel("Page number")).toHaveValue("3", { timeout: 30_000 });
    } finally {
      await deleteTestFile(file.id);
    }
  });
});
