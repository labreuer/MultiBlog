// Exercises the standalone ydoc persistence stack (PLAN.md §11) through
// /ydoc-debug — invariant 1 (row #1 is always a full state), that read-only
// viewing never writes, that clientID attribution only happens on an actual
// edit, that a replay of the log reproduces the editor's text with no
// duplication, and that a snapshot's high-water mark is correct. The old
// "editing a post never writes to any ydoc-stack table" isolation check is
// gone with PostEditor — posts no longer have any editable content of their
// own to isolate from (PLAN.md §15), so there's no second stack left to
// stay isolated from.
import type { Page } from "@playwright/test";
import { test, expect, bodyEditor, gotoOk } from "./fixtures";
import {
  ADMIN_EMAIL,
  createTestYdoc,
  deleteTestYdoc,
  countYdocUpdates,
  getMaxYdocUpdateId,
  getYdocSnapshots,
  getYdocClients,
  replayYdocText,
  getUserIdByEmail,
} from "./db";

// /ydoc-debug pulls in the same TipTap+Yjs+collab bundle as the post editor,
// and (unlike /posts/[id]/edit) isn't warmed up by auth.setup.ts — so the
// first test to hit it in a cold `next dev` can take a while to compile.
const LIVE_TIMEOUT = 90_000;

test("creating a document writes exactly one full-state update row", async () => {
  const doc = await createTestYdoc();
  try {
    expect(await countYdocUpdates(doc.id)).toBe(1);
  } finally {
    await deleteTestYdoc(doc.id);
  }
});

test("read-only viewing writes nothing; editing attributes exactly the typing user; replay has no duplication", async ({
  page,
}) => {
  const doc = await createTestYdoc();
  try {
    await gotoOk(page, "/ydoc-debug");
    await page.getByLabel("Document").selectOption(doc.id);

    // Merely viewing an unedited document must not write anything, and its
    // clients map must be empty.
    await expect(page.getByText("No one has edited this document yet.")).toBeVisible();
    expect(await countYdocUpdates(doc.id)).toBe(1);

    await page.getByRole("button", { name: "Switch to editing" }).click();
    await expect(page.getByText("🟢 Live")).toBeVisible({ timeout: LIVE_TIMEOUT });

    const marker = `ydoc-debug marker ${Date.now()}`;
    await bodyEditor(page).click();
    await page.keyboard.type(marker);

    // Give Hocuspocus's onChange a moment to persist the keystrokes.
    await expect.poll(() => countYdocUpdates(doc.id)).toBeGreaterThan(1);

    await page.getByRole("button", { name: "Switch to read-only" }).click();
    await page.getByRole("button", { name: "Refresh" }).click();

    const adminId = await getUserIdByEmail(ADMIN_EMAIL);
    const clients = await getYdocClients(doc.id);
    const entries = Object.entries(clients);
    expect(entries).toHaveLength(1);
    expect(entries[0][1]).toBe(adminId);

    // The duplication check: replaying row #1 plus every delta must
    // reproduce exactly what was typed, once — not doubled the way a
    // mis-seeded post document can be (CLAUDE.md's restart-doubling gotcha).
    expect(await replayYdocText(doc.id)).toBe(marker);
  } finally {
    await page.goto("about:blank").catch(() => {});
    await deleteTestYdoc(doc.id);
  }
});

test("a snapshot captures the document's actual high-water mark", async ({ page }) => {
  const doc = await createTestYdoc();
  try {
    await gotoOk(page, "/ydoc-debug");
    await page.getByLabel("Document").selectOption(doc.id);
    await page.getByRole("button", { name: "Switch to editing" }).click();
    await expect(page.getByText("🟢 Live")).toBeVisible({ timeout: LIVE_TIMEOUT });

    await bodyEditor(page).click();
    await page.keyboard.type("snapshot this");
    await expect.poll(() => countYdocUpdates(doc.id)).toBeGreaterThan(1);

    const maxIdBeforeSnapshot = await getMaxYdocUpdateId(doc.id);

    await page.getByRole("button", { name: "Switch to read-only" }).click();
    await page.getByRole("button", { name: "Snapshot" }).click();

    await expect.poll(() => getYdocSnapshots(doc.id)).toHaveLength(1);
    const [snapshot] = await getYdocSnapshots(doc.id);

    // last_ydoc_update_id is read *before* the live document is encoded
    // (PLAN.md §11d), so it can only be at or after what had already landed
    // when we asked — never before it.
    expect(Number(snapshot.lastYdocUpdateId)).toBeGreaterThanOrEqual(Number(maxIdBeforeSnapshot));
  } finally {
    await page.goto("about:blank").catch(() => {});
    await deleteTestYdoc(doc.id);
  }
});

// A range input ignores fill()/click-based interaction in a way that doesn't
// dispatch what React listens for, so set the value through the native setter
// and fire the events by hand — the same recipe CLAUDE.md documents for
// driving React-controlled inputs from javascript_tool.
async function seekSlider(page: Page, value: number): Promise<void> {
  await page.getByLabel("Scrub through ydoc update history").evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

function replayStatus(page: Page) {
  return page.getByTestId("replay-status");
}

test("the replay slider scrubs the log, marks snapshots, and rebuilds from the nearest one", async ({ page }) => {
  const doc = await createTestYdoc();
  try {
    await gotoOk(page, "/ydoc-debug");
    await page.getByLabel("Document").selectOption(doc.id);

    // Two runs of typing either side of a snapshot, so the log has updates
    // both before and after the mark — which is what makes the base-resolution
    // branch below meaningful rather than degenerate.
    await page.getByRole("button", { name: "Switch to editing" }).click();
    await expect(page.getByText("🟢 Live")).toBeVisible({ timeout: LIVE_TIMEOUT });
    await bodyEditor(page).click();
    await page.keyboard.type("before snapshot ");
    await expect.poll(() => countYdocUpdates(doc.id)).toBeGreaterThan(1);

    await page.getByRole("button", { name: "Switch to read-only" }).click();
    await page.getByRole("button", { name: "Snapshot" }).click();
    await expect.poll(() => getYdocSnapshots(doc.id)).toHaveLength(1);
    const [snapshot] = await getYdocSnapshots(doc.id);

    const countAtSnapshot = await countYdocUpdates(doc.id);
    await page.getByRole("button", { name: "Switch to editing" }).click();
    await expect(page.getByText("🟢 Live")).toBeVisible({ timeout: LIVE_TIMEOUT });
    await bodyEditor(page).click();
    await page.keyboard.type("after snapshot ");
    await expect.poll(() => countYdocUpdates(doc.id)).toBeGreaterThan(countAtSnapshot);

    await page.getByRole("button", { name: "Switch to read-only" }).click();
    await page.getByRole("button", { name: "Refresh" }).click();

    // The slider spans the whole log, one position per ydoc_update row.
    const total = await countYdocUpdates(doc.id);
    const slider = page.getByLabel("Scrub through ydoc update history");
    await expect(slider).toHaveAttribute("max", String(total - 1));

    // One dot per snapshot, labelled with the high-water mark it replays from.
    const dots = page.getByRole("button", { name: /^Jump to snapshot through update / });
    await expect(dots).toHaveCount(1);
    await expect(dots.first()).toHaveAttribute(
      "aria-label",
      `Jump to snapshot through update ${snapshot.lastYdocUpdateId}`,
    );

    // Scrubbing genuinely replays: the earliest position can't already hold
    // text that was typed later.
    const body = page.getByTestId("replay-body");
    await seekSlider(page, total - 1);
    const atEnd = (await body.innerText()).trim();
    await seekSlider(page, 0);
    const atStart = (await body.innerText()).trim();
    expect(atEnd).toContain("after snapshot");
    expect(atStart).not.toEqual(atEnd);

    // Clicking the dot lands exactly on the snapshot's mark, where the base
    // already covers everything and nothing has to be applied on top of it.
    await dots.first().click();
    await expect(replayStatus(page)).toHaveText(/^rebuild · snapshot \d+ B \([+−]\d+\) · 0 since snapshot \(0\) · [\d.]+ms$/);

    // One step forward reuses the doc already in hand — the whole point of the
    // asymmetry this view exists to show.
    const dotIndex = Number(await slider.inputValue());
    await seekSlider(page, dotIndex + 1);
    await expect(replayStatus(page)).toHaveText(/^forward · snapshot \d+ B \([+−]\d+\) · 1 since snapshot \(1\) · [\d.]+ms$/);

    // Going backward can't reuse it — Yjs has no un-apply — so it rebuilds,
    // and from row #1 rather than the snapshot, since the target predates it.
    await seekSlider(page, 0);
    await expect(replayStatus(page)).toHaveText(/^rebuild · base row #1 \d+ B \([+−]\d+\) · 1 since row #1 \(1\) · [\d.]+ms$/);
  } finally {
    await page.goto("about:blank").catch(() => {});
    await deleteTestYdoc(doc.id);
  }
});
