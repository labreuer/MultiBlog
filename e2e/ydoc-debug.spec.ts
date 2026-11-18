// Exercises the ydoc persistence stack (PLAN.md §11) through /ydoc-debug, the
// ADMIN's inspector — invariant 1 (row #1 is always a full state), that
// viewing never writes, that clientID attribution only happens on an actual
// edit, that a replay of the log reproduces the editor's text with no
// duplication, and that a snapshot's high-water mark is correct.
//
// The page has no editor (docs/YDOC.md, "/ydoc-debug reads any ydoc, and
// writes none"), so each test types in the doc editor on a throwaway doc,
// the path docs really write through, and inspects that doc's ydoc here.
import type { Page } from "@playwright/test";
import { test, expect, bodyEditor, titleEditor, gotoOk, waitForDocCollabReady } from "./fixtures";
import {
  ADMIN_EMAIL,
  createTestDoc,
  deleteTestDoc,
  createTestYdoc,
  deleteTestYdoc,
  countYdocUpdates,
  getDocState,
  getMaxYdocUpdateId,
  getYdocSnapshots,
  getYdocClients,
  replayYdocText,
  getUserIdByEmail,
  type TestDoc,
} from "./db";
import { ydocIdForDoc } from "@/lib/ydoc-names";

/** The inspector, opened on one document by `?id=`, since its list holds only the ten most recently updated. */
async function inspect(page: Page, ydocId: string): Promise<void> {
  await gotoOk(page, `/ydoc-debug?id=${encodeURIComponent(ydocId)}`);
  await expect(page.getByLabel("Document")).toHaveValue(ydocId);
}

/** The doc editor, synced. */
async function edit(page: Page, doc: TestDoc): Promise<void> {
  await gotoOk(page, `/doc/${doc.slug}/edit`);
  await waitForDocCollabReady(page);
}

/** A PRIVATE throwaway doc whose byline is the suite's signed-in ADMIN, so its editor opens for them. */
const adminDoc = () => createTestDoc({ authorEmail: ADMIN_EMAIL });

test("creating a document writes exactly one full-state update row", async () => {
  const doc = await createTestYdoc();
  try {
    expect(await countYdocUpdates(doc.id)).toBe(1);
  } finally {
    await deleteTestYdoc(doc.id);
  }
});

test("viewing writes nothing; editing attributes exactly the typing user; replay has no duplication", async ({
  page,
}) => {
  const doc = await adminDoc();
  const ydocId = ydocIdForDoc(doc.id);
  try {
    // Merely viewing an unedited document must not write anything, and its
    // clients map must be empty.
    await inspect(page, ydocId);
    await expect(page.getByText("No one has edited this document yet.")).toBeVisible();
    expect(await countYdocUpdates(ydocId)).toBe(1);

    await edit(page, doc);
    const marker = `ydoc-debug marker ${Date.now()}`;
    await bodyEditor(page).click();
    await page.keyboard.type(marker);
    await expect.poll(() => countYdocUpdates(ydocId)).toBeGreaterThan(1);

    // The clients map lives in the stored blob, which the store debounce
    // writes, so it is polled for rather than read once the editor closes.
    await inspect(page, ydocId);
    const adminId = await getUserIdByEmail(ADMIN_EMAIL);
    await expect.poll(async () => Object.values(await getYdocClients(ydocId)), { timeout: 20_000 }).toEqual([adminId]);

    // The duplication check: replaying row #1 plus every delta must
    // reproduce exactly what was typed, once — not doubled the way a
    // mis-seeded document can be (docs/YDOC.md's restart-doubling gotcha).
    expect(await replayYdocText(ydocId)).toBe(marker);
  } finally {
    await page.goto("about:blank").catch(() => {});
    await deleteTestDoc(doc.id);
  }
});

test("a snapshot captures the document's actual high-water mark", async ({ page }) => {
  const doc = await adminDoc();
  const ydocId = ydocIdForDoc(doc.id);
  try {
    await edit(page, doc);
    await bodyEditor(page).click();
    await page.keyboard.type("snapshot this");
    await expect.poll(() => countYdocUpdates(ydocId)).toBeGreaterThan(1);

    const maxIdBeforeSnapshot = await getMaxYdocUpdateId(ydocId);

    await inspect(page, ydocId);
    await page.getByRole("button", { name: "Snapshot" }).click();

    await expect.poll(() => getYdocSnapshots(ydocId)).toHaveLength(1);
    const [snapshot] = await getYdocSnapshots(ydocId);

    // last_ydoc_update_id is read *before* the live document is encoded
    // (PLAN.md §11d), so it can only be at or after what had already landed
    // when we asked — never before it.
    expect(Number(snapshot.lastYdocUpdateId)).toBeGreaterThanOrEqual(Number(maxIdBeforeSnapshot));
  } finally {
    await page.goto("about:blank").catch(() => {});
    await deleteTestDoc(doc.id);
  }
});

test("the title-history panel lists only title-changing updates, and tells absent from empty", async ({ page }) => {
  const panel = page.getByTestId("title-history");

  // A bare ydoc is an empty document — no title fragment at all, which is
  // the state this panel distinguishes from an empty-string title. A doc
  // can't show it: its row #1 already carries the title it was made with.
  const bare = await createTestYdoc();
  try {
    await inspect(page, bare.id);
    await expect(page.getByText("No update changes the title")).toBeVisible();
    await expect(panel).toBeHidden();
  } finally {
    await deleteTestYdoc(bare.id);
  }

  const doc = await adminDoc();
  const ydocId = ydocIdForDoc(doc.id);
  const title = `ydoc title ${Date.now()}`;
  try {
    await inspect(page, ydocId);
    await expect(panel.locator("tbody tr")).toHaveCount(1);
    await expect(panel.locator("tbody tr").last()).toContainText(JSON.stringify(doc.title));

    await edit(page, doc);
    await titleEditor(page).click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(title);
    // Doc.title is written on the store debounce, after the update it is
    // derived from was appended, so it says the whole title has landed.
    await expect.poll(async () => (await getDocState(doc.id))?.title, { timeout: 20_000 }).toBe(title);

    // The typed title shows up as a resultant value, JSON-quoted so trailing
    // whitespace would be visible.
    await inspect(page, ydocId);
    await expect(panel.locator("tbody tr").last()).toContainText(JSON.stringify(title));

    // Body typing must not add a row — only title-changing updates qualify,
    // which is the filter this panel is for.
    const rowsAfterTitle = await panel.locator("tbody tr").count();
    await edit(page, doc);
    await bodyEditor(page).click();
    await page.keyboard.type("body text that leaves the title alone");

    // Clearing the title is the third state: the fragment is still there, but
    // it now holds the empty string — which server/doc-cache.ts would write
    // through as Doc.title = "" indistinguishably from never having had one.
    await titleEditor(page).click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Backspace");
    await expect.poll(async () => (await getDocState(doc.id))?.title, { timeout: 20_000 }).toBe("");

    await inspect(page, ydocId);
    await expect(panel.locator("tbody tr").last()).toContainText("present, empty string");
    // Exactly one new row for the clear — the body typing before it added none.
    await expect(panel.locator("tbody tr")).toHaveCount(rowsAfterTitle + 1);
  } finally {
    await page.goto("about:blank").catch(() => {});
    await deleteTestDoc(doc.id);
  }
});

// A range input ignores fill()/click-based interaction in a way that doesn't
// dispatch what React listens for, so set the value through the native setter
// and fire the events by hand — the same recipe docs/BROWSER_PANE.md documents for
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
  const doc = await adminDoc();
  const ydocId = ydocIdForDoc(doc.id);
  try {
    // Two runs of typing either side of a snapshot, so the log has updates
    // both before and after the mark — which is what makes the base-resolution
    // branch below meaningful rather than degenerate.
    await edit(page, doc);
    await bodyEditor(page).click();
    await page.keyboard.type("before snapshot ");
    await expect.poll(() => countYdocUpdates(ydocId)).toBeGreaterThan(1);

    await inspect(page, ydocId);
    await page.getByRole("button", { name: "Snapshot" }).click();
    await expect.poll(() => getYdocSnapshots(ydocId)).toHaveLength(1);
    const [snapshot] = await getYdocSnapshots(ydocId);

    const countAtSnapshot = await countYdocUpdates(ydocId);
    await edit(page, doc);
    await bodyEditor(page).click();
    await page.keyboard.type("after snapshot ");
    await expect.poll(() => countYdocUpdates(ydocId)).toBeGreaterThan(countAtSnapshot);

    await inspect(page, ydocId);

    // The slider spans the whole log, one position per ydoc_update row.
    const total = await countYdocUpdates(ydocId);
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
    await deleteTestDoc(doc.id);
  }
});

// The mark tables after Clients (one per mark type actually present in the
// ydoc, first 10 runs each). Worth covering because the whole point of the
// view is to report what a document *contains* rather than what the schema
// says it may contain — a table that quietly showed nothing would look
// identical to a document that genuinely has no marks.
test("the mark tables list each mark type present, with its own attrs as columns", async ({ page }) => {
  const doc = await adminDoc();
  const ydocId = ydocIdForDoc(doc.id);
  try {
    // Typing is what produces marks here: CollabEditorBody tags every
    // keystroke with an authorHighlight carrying the typist's id (PLAN.md
    // §12k), so a doc that has been edited at all has one to find.
    await edit(page, doc);
    await bodyEditor(page).click();
    await page.keyboard.type("marked up text");
    await expect.poll(() => countYdocUpdates(ydocId)).toBeGreaterThan(1);

    await inspect(page, ydocId);

    const table = page.getByTestId("mark-table-authorHighlight");
    await expect(table).toBeVisible();
    // The attribute is discovered from the mark, not hardcoded in the view —
    // so the column existing is the assertion that that discovery works.
    await expect(table.getByRole("columnheader", { name: "authorId" })).toBeVisible();
    await expect(table.getByRole("columnheader", { name: "Where" })).toBeVisible();

    // Attributed to the signed-in admin, and found in the body fragment.
    const adminId = await getUserIdByEmail(ADMIN_EMAIL);
    expect(adminId).not.toBeNull();
    const firstRow = table.getByRole("row").nth(1);
    await expect(firstRow).toContainText(adminId!);
    await expect(firstRow).toContainText("body");

    // A type with no marks present gets no table at all, rather than an
    // empty one — `annotation` is in the doc editor's schema, but nothing
    // here annotates.
    await expect(page.getByTestId("mark-table-annotation")).toHaveCount(0);
  } finally {
    await page.goto("about:blank").catch(() => {});
    await deleteTestDoc(doc.id);
  }
});
