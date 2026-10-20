import type { Locator, Page } from "@playwright/test";
import { test, expect, QUOTED_TEXT, QUOTE_FROM, QUOTE_TO } from "./fixtures";
import { ADMIN_EMAIL, createTestAnnotation } from "./db";

// docs/ANNOTATIONS.md, "Collapsing a card" — a per-card toggle, remembered in
// this browser's localStorage and nowhere else. The cases are chosen around
// the parts that are not visible from one page load: that the state survives
// a reload, that it is this browser's and not the account's, that a
// permalink opens what it names without forgetting it was closed, and that
// a collapsed card still says what arrived under it since.
//
// "Collapsed" is asserted by what disappears — the card's Reply button and
// its replies — never by the body's text, which the one-line excerpt repeats.

function card(page: Page, annotationId: string) {
  return page.locator(`[data-comment-id="${annotationId}"]`);
}

/** The collapsed card's "N new" pill, by the name it carries for a screen reader. */
function newPill(target: Locator, count: number) {
  return target.getByRole("button", { name: `Show ${count} new ${count === 1 ? "reply" : "replies"}` });
}

/**
 * Clicks a card's toggle until it reports the other state. A click that lands
 * before hydration does nothing, and nothing on this page changes when
 * hydration finishes to wait for instead.
 */
async function setCollapsed(target: Locator, collapsed: boolean) {
  const from = collapsed ? "Collapse annotation" : "Expand annotation";
  const to = collapsed ? "Expand annotation" : "Collapse annotation";
  await expect(async () => {
    const button = target.getByRole("button", { name: from, exact: true });
    if ((await button.count()) > 0) await button.click({ timeout: 2_000 });
    await expect(target.getByRole("button", { name: to, exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass();
}

async function thread(docId: string) {
  const stamp = Date.now();
  const root = await createTestAnnotation({
    docId,
    authorEmail: ADMIN_EMAIL,
    bodyText: `E2E collapsible annotation ${stamp}`,
    anchor: { from: QUOTE_FROM, to: QUOTE_TO, quotedText: QUOTED_TEXT },
  });
  const reply = await createTestAnnotation({
    docId,
    authorEmail: ADMIN_EMAIL,
    bodyText: `E2E reply under it ${stamp}`,
    parentAnnotationId: root.id,
  });
  return { root, reply };
}

test.describe("collapsing an annotation card", () => {
  test("stays collapsed across a reload, in this browser only", async ({ page, sharedDoc, secondUser }) => {
    const { root, reply } = await thread(sharedDoc.id);

    await page.goto(`/doc/${sharedDoc.slug}`);
    await expect(card(page, reply.id)).toBeVisible();
    await setCollapsed(card(page, root.id), true);
    await expect(card(page, reply.id)).toHaveCount(0);
    await expect(card(page, root.id).getByRole("button", { name: "Reply" })).toHaveCount(0);
    await expect(card(page, root.id)).toContainText("1 reply");

    // The server renders every card open; the browser's answer arrives with
    // hydration, so these poll through it rather than reading the HTML.
    await page.reload();
    await expect(card(page, root.id).getByRole("button", { name: "Expand annotation" })).toBeVisible();
    await expect(card(page, reply.id)).toHaveCount(0);

    const { page: other } = await secondUser();
    await other.goto(`/doc/${sharedDoc.slug}`);
    await expect(card(other, reply.id)).toBeVisible();
    await expect(card(other, root.id).getByRole("button", { name: "Collapse annotation" })).toBeVisible();
  });

  test("counts a reply posted after the collapse as new until the card is opened", async ({ page, sharedDoc }) => {
    const { root } = await thread(sharedDoc.id);

    await page.goto(`/doc/${sharedDoc.slug}`);
    await setCollapsed(card(page, root.id), true);
    await expect(card(page, root.id)).toContainText("1 reply");

    await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: `E2E reply that came later ${Date.now()}`,
      parentAnnotationId: root.id,
    });
    await page.reload();
    await expect(card(page, root.id)).toContainText("2 replies");
    await expect(newPill(card(page, root.id), 1)).toBeVisible();

    // Opening and closing it again is having seen it.
    await setCollapsed(card(page, root.id), false);
    await setCollapsed(card(page, root.id), true);
    await expect(card(page, root.id)).toContainText("2 replies");
    await expect(newPill(card(page, root.id), 1)).toHaveCount(0);
  });

  test("a reply begun before the collapse and posted after it is new", async ({ page, sharedDoc }) => {
    const { root } = await thread(sharedDoc.id);

    await page.goto(`/doc/${sharedDoc.slug}`);
    await setCollapsed(card(page, root.id), true);

    // Its composer opened a minute ago, before the collapse; posted now, after
    // it. Judged by `createdAt` it would look older than what was seen.
    await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: `E2E reply that took a while to write ${Date.now()}`,
      parentAnnotationId: root.id,
      draftOpenedMsAgo: 60_000,
    });
    await page.reload();
    await expect(card(page, root.id)).toContainText("2 replies");
    await expect(newPill(card(page, root.id), 1)).toBeVisible();
  });

  test("the new pill opens the card onto its new reply, through a reply collapsed on its own", async ({
    page,
    sharedDoc,
  }) => {
    const { root, reply } = await thread(sharedDoc.id);

    await page.goto(`/doc/${sharedDoc.slug}`);
    await setCollapsed(card(page, reply.id), true);
    await setCollapsed(card(page, root.id), true);

    const later = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: `E2E reply under the reply ${Date.now()}`,
      parentAnnotationId: reply.id,
    });
    await page.reload();
    // The pill exists only in the browser's answer, never in the server's
    // HTML, so seeing it is also seeing hydration done.
    const pill = newPill(card(page, root.id), 1);
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(card(page, later.id).getByRole("button", { name: "Reply" })).toBeVisible();
    await expect(card(page, root.id).getByRole("button", { name: "Collapse annotation" })).toBeVisible();
    await expect(card(page, reply.id).getByRole("button", { name: "Collapse annotation" })).toBeVisible();

    // Opening the thread was written; opening the reply on the way was not.
    await page.reload();
    await expect(card(page, root.id).getByRole("button", { name: "Collapse annotation" })).toBeVisible();
    await expect(card(page, reply.id).getByRole("button", { name: "Expand annotation" })).toBeVisible();
    await expect(card(page, later.id)).toHaveCount(0);
  });

  test("a permalink into a collapsed thread opens the way to it, for that visit only", async ({
    page,
    sharedDoc,
  }) => {
    const { root, reply } = await thread(sharedDoc.id);

    await page.goto(`/doc/${sharedDoc.slug}`);
    const fragment = await card(page, reply.id).locator("a[id]").first().getAttribute("id");
    expect(fragment).toBeTruthy();
    await setCollapsed(card(page, root.id), true);

    // A fresh load, as a shared link would be.
    await page.goto("about:blank");
    await page.goto(`/doc/${sharedDoc.slug}#${fragment}`);
    await expect(card(page, reply.id)).toBeVisible();
    await expect(card(page, root.id).getByRole("button", { name: "Collapse annotation" })).toBeVisible();

    await page.goto("about:blank");
    await page.goto(`/doc/${sharedDoc.slug}`);
    await expect(card(page, root.id).getByRole("button", { name: "Expand annotation" })).toBeVisible();
    await expect(card(page, reply.id)).toHaveCount(0);
  });

  test("Collapse all closes every thread; Expand all opens every card in them", async ({ page, sharedDoc }) => {
    const first = await thread(sharedDoc.id);
    const second = await thread(sharedDoc.id);

    await page.goto(`/doc/${sharedDoc.slug}`);
    // A reply closed on its own, so Expand all has something below the top
    // level to open.
    await setCollapsed(card(page, second.reply.id), true);

    await page.getByRole("button", { name: "Collapse all" }).click();
    for (const { root, reply } of [first, second]) {
      await expect(card(page, root.id).getByRole("button", { name: "Expand annotation" })).toBeVisible();
      await expect(card(page, reply.id)).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: "Collapse all" })).toBeDisabled();

    await page.getByRole("button", { name: "Expand all" }).click();
    for (const { root, reply } of [first, second]) {
      await expect(card(page, root.id).getByRole("button", { name: "Collapse annotation" })).toBeVisible();
      await expect(card(page, reply.id).getByRole("button", { name: "Reply" })).toBeVisible();
    }
    await expect(page.getByRole("button", { name: "Expand all" })).toBeDisabled();
  });
});
