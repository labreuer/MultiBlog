// Exercises the standalone ydoc persistence stack (PLAN.md §11) through
// /ydoc-debug — invariant 1 (row #1 is always a full state), that read-only
// viewing never writes, that clientID attribution only happens on an actual
// edit, that a replay of the log reproduces the editor's text with no
// duplication, that a snapshot's high-water mark is correct, and — the one
// that matters most, since nothing existing may touch these tables — that
// ordinary post editing leaves every ydoc-stack table untouched.
import { test, expect, waitForCollabReady, bodyEditor, gotoOk } from "./fixtures";
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
  countAllYdocs,
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

test("editing a post never writes to any ydoc-stack table", async ({ page, draftPost }) => {
  const before = await countAllYdocs();

  await gotoOk(page, `/posts/${draftPost.id}/edit`);
  await waitForCollabReady(page);
  await bodyEditor(page).click();
  await page.keyboard.type(" More text for the isolation check.");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText(/No changes since revision|Currently viewing/)).toBeVisible();

  expect(await countAllYdocs()).toBe(before);
});
