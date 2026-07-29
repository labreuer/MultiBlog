// Docs and annotations (PLAN.md §12) — the ydoc-stack's second real
// consumer after /ydoc-debug. Three things worth covering that nothing else
// in the suite touches: the doc-cache debounce actually reaches
// Doc.title/proseJson, a reader's already-open tab updates with no reload
// (the reading view's whole reason for existing, §12g), and the annotation
// mark's full lifecycle — applied at the selected range, degrading to the
// doc's general discussion the instant its text is gone, and never
// reachable from the blog's own /comments.
import {
  test,
  expect,
  bodyEditor,
  titleEditor,
  deleteTextInBody,
  selectTextInBody,
  waitForDocCollabReady,
  visibleText,
  QUOTED_BODY,
  QUOTED_TEXT,
} from "./fixtures";
import { countDocYdocUpdates, getDocState, getAnnotationStates, countPostCollabRows } from "./db";

test("creating a doc writes exactly one full-state update row", async ({ draftDoc }) => {
  expect(await countDocYdocUpdates(draftDoc.id)).toBe(1);
});

test("editing a doc updates its title/prose_json cache on the store debounce, and never touches post_collab", async ({
  page,
  draftDoc,
}) => {
  const before = await countPostCollabRows();

  await page.goto(`/doc/${draftDoc.id}/edit`);
  await waitForDocCollabReady(page);

  await titleEditor(page).click();
  await page.keyboard.type("Retitled live");
  await bodyEditor(page).click();
  await page.keyboard.type("Cached by the collab server, not saved by hand.");

  // doc-cache.ts writes on ydocOnStoreDocument's debounce, not per keystroke
  // — poll rather than assert once.
  await expect
    .poll(async () => (await getDocState(draftDoc.id))?.proseText, { timeout: 15_000 })
    .toBe("Cached by the collab server, not saved by hand.");
  expect((await getDocState(draftDoc.id))?.title).toBe("Retitled live");

  // The isolation constraint's other direction (see doc.spec.ts's sibling
  // check in ydoc-debug.spec.ts, "editing a post never writes to any
  // ydoc-stack table") — a doc must never touch the post-side tables either.
  expect(await countPostCollabRows()).toEqual(before);
});

test("a reader's already-open tab sees an author's edit with no reload", async ({ page, sharedDoc, secondUser }) => {
  const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });

  await page.goto(`/doc/${sharedDoc.id}/edit`);
  await waitForDocCollabReady(page);
  await readerPage.goto(`/doc/${sharedDoc.slug}`);
  await expect(visibleText(readerPage, QUOTED_BODY)).toBeVisible();

  const addition = " Freshly typed by the author.";
  await bodyEditor(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(addition);

  // No readerPage.reload() anywhere above or below — LiveDocBody's read-only
  // Hocuspocus tap is what has to deliver this.
  await expect(readerPage.getByText(addition.trim())).toBeVisible({ timeout: 15_000 });
});

test.describe("annotations", () => {
  test("a selection submits an annotation whose mark lands exactly at the selected range", async ({
    page,
    sharedDoc,
    secondUser,
  }) => {
    const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });

    await readerPage.goto(`/doc/${sharedDoc.slug}`);
    await expect(bodyEditor(readerPage)).toBeVisible();
    // The live tap's initial sync pushes its own setContent through the
    // editor, which would silently collapse a selection made before it
    // lands (LiveDocBody's own comment on `synced`) — wait it out first.
    await expect(readerPage.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    await selectTextInBody(readerPage, QUOTED_TEXT);

    const popup = readerPage.getByTestId("annotation-popup");
    await popup.getByPlaceholder(/Commenting as/).fill("Why this bit specifically?");
    await popup.getByRole("button", { name: "Post comment" }).click();

    await expect(readerPage.getByText("Why this bit specifically?")).toBeVisible();
    await expect
      .poll(async () => (await getAnnotationStates(sharedDoc.id)).length)
      .toBe(1);
    const [annotation] = await getAnnotationStates(sharedDoc.id);
    expect(annotation).toMatchObject({ anchored: true, bodyText: "Why this bit specifically?" });

    // Renders through the mark, not a stored column — QuoteThreadHeader's
    // blockquote shows the exact selected text (scoped to <blockquote>,
    // since QUOTED_TEXT is also a plain substring of the body itself).
    await expect(readerPage.locator("blockquote", { hasText: QUOTED_TEXT })).toBeVisible();

    // Never reachable from the blog's own moderation surface — a completely
    // separate table (§12i).
    await page.goto("/comments");
    await expect(page.getByText("Why this bit specifically?")).toHaveCount(0);
  });

  test("deleting the annotated text degrades the annotation to the doc's general discussion", async ({
    page,
    sharedDoc,
    secondUser,
  }) => {
    const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });

    await readerPage.goto(`/doc/${sharedDoc.slug}`);
    await expect(bodyEditor(readerPage)).toBeVisible();
    // The live tap's initial sync pushes its own setContent through the
    // editor, which would silently collapse a selection made before it
    // lands (LiveDocBody's own comment on `synced`) — wait it out first.
    await expect(readerPage.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    await selectTextInBody(readerPage, QUOTED_TEXT);
    const popup = readerPage.getByTestId("annotation-popup");
    await popup.getByPlaceholder(/Commenting as/).fill("This quote is about to disappear.");
    await popup.getByRole("button", { name: "Post comment" }).click();
    await expect
      .poll(async () => (await getAnnotationStates(sharedDoc.id))[0]?.anchored)
      .toBe(true);

    await page.goto(`/doc/${sharedDoc.id}/edit`);
    await waitForDocCollabReady(page);
    await deleteTextInBody(page, QUOTED_TEXT);
    await expect(bodyEditor(page)).not.toContainText(QUOTED_TEXT);

    // The mark went with the text it decorated — collectMarkAttrValues over
    // the next prose_json store no longer finds this annotation's id.
    await expect
      .poll(async () => (await getAnnotationStates(sharedDoc.id))[0]?.anchored, { timeout: 15_000 })
      .toBe(false);

    // And the reading view reflects it: no quote header left to click,
    // just the comment sitting in the general discussion.
    await readerPage.goto(`/doc/${sharedDoc.slug}`);
    await expect(readerPage.getByText("This quote is about to disappear.")).toBeVisible();
    await expect(readerPage.locator("blockquote")).toHaveCount(0);
  });
});
