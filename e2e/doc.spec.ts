// Docs and annotations (PLAN.md §12) — the ydoc-stack's second real
// consumer after /ydoc-debug. Three things worth covering that nothing else
// in the suite touches: the doc-cache debounce actually reaches
// Doc.title/proseJson, a reader's already-open tab updates with no reload
// (the reading view's whole reason for existing, §12g), and an annotation's
// full anchoring lifecycle — anchored at the selected range, degrading the
// instant its text is gone, and never reachable from the blog's own
// /comments.
//
// The anchoring tests below cover *both* mechanisms (PLAN.md §13o), because
// which one is used is a property of the surface: annotating from a reading
// view stores offsets and leaves the document untouched, annotating from the
// doc editor writes a mark. "The reading view writes no mark" is asserted
// directly rather than left implied — it is the security property the split
// exists for, and nothing else in the suite would notice if it regressed.
import {
  test,
  expect,
  bodyEditor,
  titleEditor,
  annotationEditor,
  deleteTextInBody,
  selectTextInBody,
  waitForDocCollabReady,
  statusLine,
  visibleText,
  QUOTED_BODY,
  QUOTED_TEXT,
} from "./fixtures";
import { countDocYdocUpdates, getDocState, getAnnotationStates, addTestDocAuthor } from "./db";
import { ADMIN_EMAIL } from "./naming";
import { uniqueTitle } from "./naming";

test("+ New doc creates titleless and drops straight into the editor, no title-collecting page in between", async ({
  page,
  trackCreatedDoc,
}) => {
  await page.goto("/docs");
  await page.getByRole("button", { name: "+ New doc" }).click();
  await page.waitForURL(/\/doc\/[^/]+\/edit$/);

  const docId = page.url().match(/\/doc\/([^/]+)\/edit$/)?.[1];
  if (!docId) throw new Error(`Couldn't extract doc id from ${page.url()}`);
  trackCreatedDoc(docId);

  await waitForDocCollabReady(page);

  // Titleless (PLAN.md §12n) — the title editor is empty, and its wrapper
  // carries the placeholder attributes CollabTitleField sets, not literal
  // "Untitled" text (::before content isn't in the accessibility tree, so
  // this is asserted on the attributes rather than getByText).
  await expect(titleEditor(page)).toHaveText("");
  const titleWrapper = page.locator("[data-empty]");
  await expect(titleWrapper).toHaveAttribute("data-placeholder", "Untitled");

  // doc.title starts empty too — not the literal word "Untitled" (that only
  // ever appears as a render-time fallback, never stored, PLAN.md §12n).
  expect((await getDocState(docId))?.title).toBe("");

  // Typing clears the placeholder and reaches doc.title on the store
  // debounce; clearing the title again is the regression case for
  // doc-cache.ts no longer skipping an empty write.
  const title = uniqueTitle("doc");
  await titleEditor(page).click();
  await page.keyboard.type(title);
  await expect(titleWrapper).toHaveCount(0);
  await expect.poll(async () => (await getDocState(docId))?.title, { timeout: 15_000 }).toBe(title);

  await titleEditor(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await expect(titleWrapper).toHaveAttribute("data-placeholder", "Untitled");
  await expect.poll(async () => (await getDocState(docId))?.title, { timeout: 15_000 }).toBe("");
});

test("creating a doc writes exactly one full-state update row", async ({ draftDoc }) => {
  expect(await countDocYdocUpdates(draftDoc.id)).toBe(1);
});

test("editing a doc updates its title/prose_json cache on the store debounce", async ({ page, draftDoc }) => {
  await page.goto(`/doc/${draftDoc.id}/edit`);
  await waitForDocCollabReady(page);

  // Clear before typing: createTestDoc seeds the title *fragment*, not just
  // the column, so a fixture doc opens with its title already in the editor
  // and typing would append to it. That seeding is the point — a doc's title
  // fragment is canonical (§3d), and a fixture that set only the column had a
  // title that vanished the first time the store debounce ran.
  await titleEditor(page).click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("Retitled live");
  await bodyEditor(page).click();
  await page.keyboard.type("Cached by the collab server, not saved by hand.");

  // doc-cache.ts writes on ydocOnStoreDocument's debounce, not per keystroke
  // — poll rather than assert once.
  await expect
    .poll(async () => (await getDocState(draftDoc.id))?.proseText, { timeout: 15_000 })
    .toBe("Cached by the collab server, not saved by hand.");
  expect((await getDocState(draftDoc.id))?.title).toBe("Retitled live");

  // The same flush attributes the edit: Doc.updatedBy comes from the
  // Hocuspocus connection's own verified context (ydocOnStoreDocument's
  // lastContext), not from anything the client asserts. Deliberately a
  // last-writer-wins value under concurrent editing — see schema.prisma — so
  // this asserts it only where a single identity did all the typing.
  expect((await getDocState(draftDoc.id))?.updatedByEmail).toBe(ADMIN_EMAIL);
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

  // No readerPage.reload() anywhere above or below — DocReadingBody's read-only
  // Hocuspocus tap is what has to deliver this.
  await expect(readerPage.getByText(addition.trim())).toBeVisible({ timeout: 15_000 });
});

test.describe("annotations", () => {
  test("a reading-view selection anchors an annotation to it — as stored offsets, with no mark written to the doc", async ({
    page,
    sharedDoc,
    secondUser,
  }) => {
    const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });

    await readerPage.goto(`/doc/${sharedDoc.slug}`);
    await expect(bodyEditor(readerPage)).toBeVisible();
    // The live tap's initial sync pushes its own setContent through the
    // editor, which would silently collapse a selection made before it
    // lands (DocReadingBody's own comment on `synced`) — wait it out first.
    await expect(readerPage.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    await selectTextInBody(readerPage, QUOTED_TEXT);

    // PLAN.md §13j Phase 3 — the popup opens on a selection but doesn't
    // create anything until "Annotate" is clicked (avoids spinning up a
    // draft row on every micro-adjustment of a selection still being
    // dragged); that's what turns it into the live editor this fills in.
    const popup = readerPage.getByTestId("annotation-popup");
    await popup.getByRole("button", { name: "Annotate" }).click();
    await annotationEditor(readerPage).click();
    await readerPage.keyboard.type("Why this bit specifically?");
    await popup.getByRole("button", { name: "Post annotation" }).click();

    await expect(readerPage.getByText("Why this bit specifically?")).toBeVisible();
    // "Annotate" already created the row as a DRAFT (PLAN.md §13j Phase 2) —
    // a row existing isn't "posted" any more, so this polls for the fully-
    // posted state directly rather than a length check that would pass the
    // instant the draft appeared, well before Post's own flush/anchor-capture
    // round trip (postAnnotation) has actually completed.
    //
    // PLAN.md §13o — the three things that make this the *reading view's*
    // anchor and not the editor's: it is anchored, the quote the server
    // derived at those offsets is exactly what was selected, and the doc's
    // ydoc was never written to. The last one is the point of the whole
    // split: a reader who may not edit this doc did not just edit it.
    await expect
      .poll(async () => (await getAnnotationStates(sharedDoc.id))[0], { timeout: 15_000 })
      .toMatchObject({
        anchored: true,
        marked: false,
        quotedText: QUOTED_TEXT,
        bodyText: "Why this bit specifically?",
      });

    // The stored offsets are real positions, not a placeholder pair.
    const [stored] = await getAnnotationStates(sharedDoc.id);
    expect(stored.anchorTo).toBeGreaterThan(stored.anchorFrom!);

    // QuoteThreadHeader's blockquote shows the exact selected text (scoped to
    // <blockquote>, since QUOTED_TEXT is also a plain substring of the body).
    await expect(readerPage.locator("blockquote", { hasText: QUOTED_TEXT })).toBeVisible();

    // And the passage itself is highlighted — by a decoration here rather
    // than the mark's own span, which is why data-annotation-ids is plural
    // (annotation-highlight-extension.ts).
    await expect(readerPage.locator(`[data-annotation-ids~="${stored.id}"]`).first()).toBeVisible();

    // Never reachable from the blog's own moderation surface — a completely
    // separate table (§12i).
    await page.goto("/comments");
    await expect(page.getByText("Why this bit specifically?")).toHaveCount(0);
  });

  test("deleting the annotated text unanchors the annotation but leaves it able to say what it quoted", async ({
    page,
    sharedDoc,
    secondUser,
  }) => {
    const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });

    await readerPage.goto(`/doc/${sharedDoc.slug}`);
    await expect(bodyEditor(readerPage)).toBeVisible();
    // The live tap's initial sync pushes its own setContent through the
    // editor, which would silently collapse a selection made before it
    // lands (DocReadingBody's own comment on `synced`) — wait it out first.
    await expect(readerPage.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    await selectTextInBody(readerPage, QUOTED_TEXT);
    const popup = readerPage.getByTestId("annotation-popup");
    await popup.getByRole("button", { name: "Annotate" }).click();
    await annotationEditor(readerPage).click();
    await readerPage.keyboard.type("This quote is about to disappear.");
    await popup.getByRole("button", { name: "Post annotation" }).click();
    await expect
      .poll(async () => (await getAnnotationStates(sharedDoc.id))[0]?.anchored)
      .toBe(true);

    await page.goto(`/doc/${sharedDoc.id}/edit`);
    await waitForDocCollabReady(page);
    await deleteTextInBody(page, QUOTED_TEXT);
    await expect(bodyEditor(page)).not.toContainText(QUOTED_TEXT);

    // PLAN.md §13o — the two mechanisms degrade differently, and this is
    // where that shows. A mark would have gone with the text it decorated;
    // stored offsets survive the deletion as *columns* and stop resolving
    // instead, which is a decision made against the live document at read
    // time rather than a state written to the row. So the row still says
    // "anchored" and the rendering is what has to change.
    await readerPage.goto(`/doc/${sharedDoc.slug}`);
    await expect(readerPage.getByText("This quote is about to disappear.")).toBeVisible();

    // No highlight left in the article: the quoted text is gone, so neither
    // the stored offsets nor a search for it resolves.
    const [annotation] = await getAnnotationStates(sharedDoc.id);
    await expect(readerPage.locator(`[data-annotation-ids~="${annotation.id}"]`)).toHaveCount(0);

    // The blockquote *stays*, unlike a lost mark — the quote was derived
    // server-side against a state that is still reconstructible, so the card
    // can still say what it was about. That is the DETACHED affordance a
    // post comment has always had and a doc annotation never could.
    await expect(readerPage.locator("blockquote", { hasText: QUOTED_TEXT })).toBeVisible();
  });

  // The other side of PLAN.md §13o's split. e2e/text-selection.spec.ts already
  // covers where the editor's marker sits; this covers what posting from it
  // actually writes, which is the thing that must not follow the reading view.
  test("the doc editor's own widget still anchors with a mark, and stores no offsets", async ({
    page,
    sharedDoc,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/doc/${sharedDoc.id}/edit`);
    await waitForDocCollabReady(page);
    await selectTextInBody(page, QUOTED_TEXT);

    // Stage one is a marker beside the document; clicking it opens the
    // composer directly (PLAN.md §18f's `autoOpen`).
    await page.locator("[data-testid='annotate-marker']").click();
    const popup = page.getByTestId("annotation-popup");
    await annotationEditor(page).click();
    await page.keyboard.type("Annotated while editing.");
    await popup.getByRole("button", { name: "Post annotation" }).click();

    await expect
      .poll(async () => (await getAnnotationStates(sharedDoc.id))[0], { timeout: 15_000 })
      .toMatchObject({
        anchored: true,
        marked: true,
        // The columns stay empty: this annotation's anchor is content, and a
        // second copy of it in a column would be a second source of truth to
        // reconcile (§12i).
        anchorFrom: null,
        quotedText: "",
        bodyText: "Annotated while editing.",
      });
  });
});

// Ported from the old e2e/collab.spec.ts (deleted with PostEditor, PLAN.md
// §15) — two signed-in users editing one *doc* at once. CollabEditorBody/
// CollabTitleField are unchanged from the post-editing days (same aria-labels
// bodyEditor()/titleEditor() key off), so these work verbatim against
// /doc/[id]/edit. The old suite's third test ("a save by one author is
// visible as a new revision to the other") has no equivalent here — a doc has
// no save step at all (PLAN.md §12k); its content just is the live Yjs state.
test.describe("real-time collaboration", () => {
  test("body edits from one author appear in the other's editor", async ({ page, draftDoc, secondUser }) => {
    const { user: other, page: otherPage } = await secondUser();
    // draftDoc is PRIVATE and bylined to the shared admin alone, and a
    // PRIVATE doc's editor admits its listed authors only (docs/PERMISSIONS.md), so
    // the second identity needs a byline of its own to get in.
    await addTestDocAuthor(draftDoc.id, other.email);

    await page.goto(`/doc/${draftDoc.id}/edit`);
    await otherPage.goto(`/doc/${draftDoc.id}/edit`);
    await waitForDocCollabReady(page);
    await waitForDocCollabReady(otherPage);

    const typed = "Text typed by the first author.";
    await bodyEditor(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(` ${typed}`);

    await expect(bodyEditor(otherPage)).toContainText(typed);

    // …and back the other way, which also proves the second context is really
    // a second identity rather than the first one's session reused.
    const reply = "And a line from the second author.";
    await bodyEditor(otherPage).click();
    await otherPage.keyboard.press("End");
    await otherPage.keyboard.type(` ${reply}`);

    await expect(bodyEditor(page)).toContainText(reply);
    // Scoped to the status line's connected-authors list: the same name also
    // appears on a caret label and in the settings panel's author picker.
    await expect(statusLine(page)).toContainText(other.name);
  });

  test("the title is collaborative too, and its own Yjs fragment", async ({ page, draftDoc, secondUser }) => {
    const { user: other, page: otherPage } = await secondUser();
    await addTestDocAuthor(draftDoc.id, other.email);

    await page.goto(`/doc/${draftDoc.id}/edit`);
    await otherPage.goto(`/doc/${draftDoc.id}/edit`);
    await waitForDocCollabReady(page);
    await waitForDocCollabReady(otherPage);

    const suffix = " (retitled live)";
    await titleEditor(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(suffix);

    await expect(titleEditor(otherPage)).toContainText(suffix);
    // The body must be untouched — the two fragments share a Y.Doc, and a
    // title edit leaking into the body would be the failure mode worth
    // catching here.
    await expect(bodyEditor(otherPage)).not.toContainText(suffix);
  });
});
