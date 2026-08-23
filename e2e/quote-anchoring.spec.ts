// Quote anchoring across publishes — PLAN.md §5/§15, and §1's "one genuinely
// hard part". On publish, `remapThreadsToEvent` diffs the thread's anchored
// event against the newly published one and maps each anchor through the
// resulting Mapping; a range that collapses, or whose text no longer matches
// the stored quotedText, flips the thread to DETACHED and freezes its anchor
// at the last event it was valid against.
//
// Editing happens on the *doc* now, not the post (PLAN.md §15) — a case here
// is always "edit the backing doc, then publish that doc's new head from
// /posts/[id]/edit".
//
// Worth knowing before adding cases here: **deleting the quoted text is not
// enough to collapse the range.** `recreateTransform` produces a character-
// level diff, so removing exactly "brown fox jumps " still leaves the mapped
// end one character past the start — it lands on the "o" that the diff matched
// against "over". That case detaches on the quotedText comparison, same branch
// as an edit *inside* the quote. Genuinely collapsing the range (mappedTo ==
// mappedFrom) takes deleting past the quote's boundary, which one of the
// tests below does. Verified by running the mapping directly against these
// exact strings.
//
// The survival case comes first, since without it these specs would only prove
// that anchors break.
import type { Page } from "@playwright/test";
import {
  test,
  expect,
  bodyEditor,
  collapseToBodyStart,
  deleteTextInBody,
  visibleText,
  waitForDocCollabReady,
  QUOTED_BODY,
  QUOTED_TEXT,
  QUOTE_FROM,
  QUOTE_TO,
} from "./fixtures";
import { getThread, getPublicationEvents, getPostContentText } from "./db";

const PUBLISH = { name: "Publish", exact: true } as const;
const DETACHED_NOTICE = "This quote was edited or removed in a later revision of the article.";

async function editDoc(page: Page, docId: string): Promise<void> {
  await page.goto(`/doc/${docId}/edit`);
  await waitForDocCollabReady(page);
}

/**
 * Publishes whatever the doc's current head is, and returns the new event's
 * id. The scrub bar opens on the *presently published* position, not the
 * head (so viewing /posts/[id]/edit shows what's actually live) — so
 * publishing the latest edit means explicitly scrubbing to the end first,
 * every time, not just when a case cares about an earlier point on purpose.
 */
async function republish(page: Page, postId: string): Promise<string> {
  await page.goto(`/posts/${postId}/edit`);
  await expect(page.getByLabel("Scrub through the doc's edit history")).toBeVisible({ timeout: 15_000 });
  await scrubToLatest(page);
  await expect(page.getByRole("button", PUBLISH)).toBeEnabled();
  await page.getByRole("button", PUBLISH).click();
  await expect(page.getByText("Published.")).toBeVisible();
  const events = await getPublicationEvents(postId);
  return events[events.length - 1].id;
}

/** Drives the publish surface's scrub bar — a range input ignores fill()/click, per CLAUDE.md's recipe. */
async function scrubTo(page: Page, value: number): Promise<void> {
  await page.getByLabel("Scrub through the doc's edit history").evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

/** Scrubs to the doc's current head — its own `max` attribute, not a hardcoded index. */
async function scrubToLatest(page: Page): Promise<void> {
  const slider = page.getByLabel("Scrub through the doc's edit history");
  const max = await slider.getAttribute("max");
  await scrubTo(page, Number(max));
}

test.describe("quote anchoring across publishes", () => {
  test("an edit outside the quote moves the anchor and keeps the thread active", async ({ page, quotedPost }) => {
    await editDoc(page, quotedPost.docId);

    // Inserted at the very start, i.e. entirely before the quote — the anchor
    // should slide forward by exactly the inserted length and stay valid.
    const prefix = "Yesterday, ";
    // A DOM Range collapsed at the first text node, not a keyboard chord.
    // There's no portable document-start chord (`Control+Home` is
    // Windows-only; macOS wants `Meta+ArrowUp`), and the previous recipe —
    // `Ctrl+A` then `ArrowLeft` — races ProseMirror's ingestion of the arrow
    // key's native collapse at synthetic keystroke speed: the first typed
    // character could execute against the still-standing select-all state and
    // replace the whole document. Wiped 20 of 30 measured runs at every
    // worker count; the helper's recipe went 12/12 in isolation and 6/6 here
    // (docs/playwright-flakiness.html, class 1; helper comment has the rest).
    await collapseToBodyStart(page);
    await page.keyboard.type(prefix);
    await expect(bodyEditor(page)).toContainText(`${prefix}${QUOTED_BODY}`);

    const newEventId = await republish(page, quotedPost.id);

    await expect.poll(async () => (await getThread(quotedPost.threadId))?.anchoredEventId).toBe(newEventId);
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
    await editDoc(page, quotedPost.docId);

    // "brown fox jumps" → "brown jumps": the mapped range shrinks but stays
    // non-empty (11..22), so this detaches on the quotedText comparison.
    await deleteTextInBody(page, "fox ");
    await expect(bodyEditor(page)).toContainText("The quick brown jumps over");

    await republish(page, quotedPost.id);

    await expect.poll(async () => (await getThread(quotedPost.threadId))?.status).toBe("DETACHED");
    const thread = await getThread(quotedPost.threadId);
    // The anchor is frozen at the event it was last valid against, not
    // advanced to the one just published — that frozen event is what the
    // "show where it used to appear" context is read from.
    expect(thread).toMatchObject({
      anchoredEventId: quotedPost.eventId,
      anchorFrom: QUOTE_FROM,
      anchorTo: QUOTE_TO,
    });

    await page.goto(`/${quotedPost.slug}`);
    // No inline highlight any more, but the thread is still listed, showing
    // the quote as it was written.
    await expect(page.locator(`[data-thread-ids~="${quotedPost.threadId}"]`)).toHaveCount(0);
    await expect(visibleText(page, DETACHED_NOTICE)).toBeVisible();
    await expect(page.getByText(QUOTED_TEXT, { exact: true })).toBeVisible();

    // The context snippet comes from the frozen event's proseJson, so it
    // still contains the word that was just deleted from the live doc.
    await page.getByRole("button", { name: "Show where it used to appear" }).click();
    await expect(page.getByText(QUOTED_BODY, { exact: false })).toBeVisible();
  });

  test("deleting the whole quote detaches it, even though the range doesn't collapse", async ({ page, quotedPost }) => {
    await editDoc(page, quotedPost.docId);

    // Every character the anchor covered is gone from the article, but the
    // mapped range is 11..12 rather than empty — the diff pairs the quote's
    // final character with the "o" of the following "over". So this still
    // detaches on the text comparison; see the header note.
    await deleteTextInBody(page, `${QUOTED_TEXT} `);
    await expect(bodyEditor(page)).toContainText("The quick over the lazy dog");
    await expect(bodyEditor(page)).not.toContainText(QUOTED_TEXT);

    await republish(page, quotedPost.id);

    await expect.poll(async () => (await getThread(quotedPost.threadId))?.status).toBe("DETACHED");
    const thread = await getThread(quotedPost.threadId);
    expect(thread).toMatchObject({
      anchoredEventId: quotedPost.eventId,
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
    await editDoc(page, quotedPost.docId);

    await deleteTextInBody(page, `${QUOTED_TEXT} over `);
    await expect(bodyEditor(page)).toContainText("The quick the lazy dog");

    await republish(page, quotedPost.id);

    await expect.poll(async () => (await getThread(quotedPost.threadId))?.status).toBe("DETACHED");
    expect(await getThread(quotedPost.threadId)).toMatchObject({
      anchoredEventId: quotedPost.eventId,
      anchorFrom: QUOTE_FROM,
      anchorTo: QUOTE_TO,
    });

    await page.goto(`/${quotedPost.slug}`);
    await expect(page.locator(`[data-thread-ids~="${quotedPost.threadId}"]`)).toHaveCount(0);
    await expect(visibleText(page, DETACHED_NOTICE)).toBeVisible();
  });

  // Scrubbing back to the doc's pre-edit position and republishing from there
  // is what "restore a revision" means now (PLAN.md §15) — republishing
  // brings the quoted text verbatim back into the article, and a reader has
  // every reason to expect the highlight and notice to reflect that.
  //
  // remapThreadsToEvent (src/lib/anchor-remap.ts) doesn't do this on its own:
  // its query is `where: { status: "ACTIVE" }`, so a DETACHED thread is
  // excluded from every future publish's remap, permanently — there is no
  // path back to ACTIVE once a thread leaves it, no matter what the article
  // says later. This reproduces that with the exact republish-from-history
  // flow PLAN.md §15 describes. Index 0 on the scrub bar is exactly the
  // state quotedPost was first published from — createTestPost snapshots the
  // doc's single seed row at creation, before this test's own edit adds any
  // further update rows — so scrubbing to the very start recovers it.
  test("scrubbing back to the pre-edit position and republishing reattaches the thread", async ({
    page,
    quotedPost,
  }) => {
    await editDoc(page, quotedPost.docId);
    await deleteTextInBody(page, "fox ");
    await expect(bodyEditor(page)).toContainText("The quick brown jumps over");
    await republish(page, quotedPost.id);
    await expect.poll(async () => (await getThread(quotedPost.threadId))?.status).toBe("DETACHED");

    await page.goto(`/posts/${quotedPost.id}/edit`);
    await expect(page.getByLabel("Scrub through the doc's edit history")).toBeVisible({ timeout: 15_000 });
    await scrubTo(page, 0);
    await expect(page.getByText(/Publishing will reuse the snapshot/)).toBeVisible();
    await expect(page.getByRole("button", PUBLISH)).toBeEnabled();
    await page.getByRole("button", PUBLISH).click();
    await expect(page.getByText("Published.")).toBeVisible();

    await expect.poll(() => getPostContentText(quotedPost.id)).toContain(QUOTED_BODY);

    await expect.poll(async () => (await getThread(quotedPost.threadId))?.status).toBe("ACTIVE");
    expect(await getThread(quotedPost.threadId)).toMatchObject({
      anchorFrom: QUOTE_FROM,
      anchorTo: QUOTE_TO,
    });

    await page.goto(`/${quotedPost.slug}`);
    await expect(page.locator(`[data-thread-ids~="${quotedPost.threadId}"]`).first()).toBeVisible();
    await expect(page.getByText(DETACHED_NOTICE)).toHaveCount(0);
  });
});
