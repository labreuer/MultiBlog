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
  selectTextInAnnotation,
  waitForDocCollabReady,
  statusLine,
  visibleText,
  QUOTED_BODY,
  QUOTED_TEXT,
  QUOTE_FROM,
  QUOTE_TO,
} from "./fixtures";
import {
  countDocYdocUpdates,
  getDocState,
  getDocAuthorEmails,
  getAnnotationStates,
  markPresentAtStamp,
  addTestDocAuthor,
  createTestAnnotation,
} from "./db";
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

  // PLAN.md §13q — the same flush stamps what it wrote. All three have to
  // agree: Doc.prose_json_update_id (which update this cache is the content
  // of), Ydoc.last_update_id (the rolling checkpoint the anchor resolver
  // walks from), and the log's own tail.
  //
  // Asserting agreement rather than any single value is the point. The stamp
  // is read from an in-memory map that the *append* fills asynchronously, so
  // a version of this that didn't drain the append queue at the debounce
  // would still write a plausible-looking id — just an older one than the
  // content it describes, silently, and only under load.
  const stamped = await getDocState(draftDoc.id);
  expect(stamped?.proseJsonUpdateId).not.toBeNull();
  expect({
    prose: stamped?.proseJsonUpdateId,
    ydoc: stamped?.ydocLastUpdateId,
    tail: stamped?.ydocMaxUpdateId,
  }).toEqual({
    prose: stamped?.ydocMaxUpdateId,
    ydoc: stamped?.ydocMaxUpdateId,
    tail: stamped?.ydocMaxUpdateId,
  });
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

// Regression coverage for a layout bug that shipped with no test at all:
// opening DocSettingsPanel's <details> (a native, JS-untouched toggle) grows
// content below the editor, and .editorFrame is supposed to shrink to make
// room (DocEditor.module.css's flex-grow chain, STYLE.md's flex-grow trap).
// On Safari specifically, the outer border resized but the scrollable
// [data-editor-scroll] child didn't — the caret and click hit-testing stayed
// at the old, taller size, spilling over the now-shorter border into the
// Authors checkboxes below. sharedDoc rather than draftDoc: the admin
// unchecking themself as author (below) must not cost them edit access
// mid-test, and only a SHARED doc's "any ADMIN/EDITOR" bypass guarantees
// that (docs/PERMISSIONS.md — a PRIVATE doc has no such bypass).
test("opening Settings shrinks the editor without stealing clicks from it or the author checkboxes", async ({
  page,
  sharedDoc,
  secondUser,
}) => {
  // Guarantees a second eligible-but-not-yet-author row exists regardless of
  // whatever else is in this database. Identified by name below rather than
  // assumed to land at checkbox index 1 — eligibleUsers (the edit page's own
  // query) is every ADMIN/EDITOR/AUTHOR in the whole database sorted by
  // name, so on a shared dev DB a real account could easily sort ahead of
  // this one. Clicking whatever's actually at index 1 would risk making a
  // real person a co-author of a doc this test then deletes.
  const { user: coAuthorCandidate } = await secondUser({ role: "AUTHOR" });

  // Tall enough that .editorContent's own 300px floor (EditorChrome.module.css)
  // is never the constraint — that floor is a *documented*, cross-browser
  // "the page scrolls instead of shrinking further" overflow, not the bug
  // under test, and at a short viewport it looks identical from the outside.
  // This test is about whether the shrink that *should* fit actually reaches
  // the editor's own hit-testing, not about what happens once there's
  // genuinely no room.
  await page.setViewportSize({ width: 1280, height: 1400 });

  await page.goto(`/doc/${sharedDoc.id}/edit`);
  await waitForDocCollabReady(page);

  const scrollFrame = page.locator("[data-editor-scroll]");
  const beforeBox = await scrollFrame.boundingBox();
  expect(beforeBox).not.toBeNull();

  await page.getByText("Settings", { exact: true }).click();
  const authors = page.getByRole("group", { name: "Authors" });
  await expect(authors).toBeVisible();

  const afterBox = await scrollFrame.boundingBox();
  expect(afterBox).not.toBeNull();
  // The bug's exact shape: the box report itself (not just the pixel value)
  // has to have actually shrunk...
  expect(afterBox!.height).toBeLessThan(beforeBox!.height);
  // ...and not merely on paper — its bottom edge must not still reach past
  // where the Authors panel now starts, which is what let the editor's
  // caret/hit-testing intercept clicks meant for the checkboxes below it.
  const authorsBox = await authors.boundingBox();
  expect(authorsBox).not.toBeNull();
  expect(afterBox!.y + afterBox!.height).toBeLessThanOrEqual(authorsBox!.y + 1);

  // The editor itself is still genuinely interactive at its new bounds, not
  // just correctly sized on paper — a click has to land where it visually
  // is, and typing has to actually reach the document.
  const addition = "Typed after Settings opened.";
  await bodyEditor(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(addition);
  await expect(bodyEditor(page)).toContainText(addition);

  // The first author checkbox (admin, the doc's sole author so far — always
  // the first row, since DocSettingsPanel puts current authors ahead of the
  // rest) and a second one, reachable and functional — exactly the region
  // the stale hit-testing intercepted.
  const checkboxes = authors.getByRole("checkbox");
  const first = checkboxes.nth(0);
  const second = authors.locator("label", { hasText: coAuthorCandidate.name! }).getByRole("checkbox");
  await expect(first).toBeChecked(); // the doc's sole author, admin, so far
  await expect(second).not.toBeChecked();

  await second.click();
  await expect(second).toBeChecked();

  // Safe only because sharedDoc is SHARED — admin keeps edit access after
  // unchecking themself, per the fixture comment above.
  await first.click();
  await expect(first).not.toBeChecked();
  await first.click();
  await expect(first).toBeChecked();
  // Settle on server truth: toBeChecked passes on the checkbox's *optimistic*
  // flip (handleAuthorToggle sets state before its action runs), so the
  // admin's re-add can still be in flight — or silently rejected by the
  // "Author list changed — please retry" concurrency guard — when this test
  // ends. That once left teardown holding a doc with zero authors: the
  // unlanded re-add plus secondUser's earlier teardown cascading the
  // co-author's row away, which deleteTestDoc's safety guard rightly refused
  // (docs/playwright-flakiness.html, class 5). Polling the DB proves both
  // authors really landed — and turns a rejected re-add into a failure *here*,
  // where the cause is legible, instead of a cryptic one in teardown.
  await expect
    .poll(() => getDocAuthorEmails(sharedDoc.id))
    .toEqual(expect.arrayContaining([ADMIN_EMAIL, coAuthorCandidate.email]));

  // Closing it back up (the same native toggle, the other direction) hands
  // the space back to the editor, and the editor keeps working through that
  // too — this is what "you can click it to close it" actually depends on.
  await page.getByText("Settings", { exact: true }).click();
  await expect(authors).not.toBeVisible();

  const closedBox = await scrollFrame.boundingBox();
  expect(closedBox).not.toBeNull();
  expect(closedBox!.height).toBeGreaterThan(afterBox!.height);

  await bodyEditor(page).click();
  await page.keyboard.type(" And after closing it again.");
  await expect(bodyEditor(page)).toContainText("And after closing it again.");
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
    // Unique per run: the `quotedPost` fixture's comment body is this same
    // sentence, and /comments lists every worker's rows — at 12 workers the
    // "no comment row" check below found another test's comment instead.
    const annotationText = `Why this bit specifically? ${Date.now()}`;
    await readerPage.keyboard.type(annotationText);
    await popup.getByRole("button", { name: "Post annotation" }).click();

    await expect(readerPage.getByText(annotationText)).toBeVisible();
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
        bodyText: annotationText,
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
    await expect(page.getByText(annotationText)).toHaveCount(0);
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
    // visibleText, not `.first()`: an annotation's body is in the DOM twice
    // since PLAN.md §13p — the SSR static copy and the editor's own,
    // display-toggled once AnnotationBodyReader mounts. `.first()` pins
    // whichever copy is DOM-first regardless of visibility, and under load
    // that was the hidden one — this exact line failed 4 of the flakiness
    // matrix's 30 runs, always at 3 workers, because mount timing decided
    // which copy it landed on (docs/playwright-flakiness.html, class 5). The
    // 2026-08-23 audit of every other `.first()` in the suite found this the
    // only dual-copy-hazardous one: the highlight locators are decoration
    // attributes only the live copy carries (`data-thread-ids` /
    // `data-annotation-ids` — the static render's mark uses the singular
    // `data-annotation-id`), and the rest pick among same-visibility
    // siblings (rows, columns, split highlight segments).
    await expect(visibleText(readerPage, "This quote is about to disappear.")).toBeVisible();

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

  // PLAN.md §13q — the stamp is *the version the annotator was looking at*,
  // not the log's tail at the moment they clicked Post. Those are the same
  // number unless somebody edits in between, so the test makes somebody edit
  // in between: a second author types into the doc while the reader holds a
  // selection, which advances the tail past what the reader can see (the
  // reading view freezes its render on a selection, §12).
  //
  // Before this, the annotation would have been stamped with the tail —
  // pointing at a state containing text the annotator never saw.
  test("an annotation is stamped with the version its author was looking at, not the tail", async ({
    page,
    sharedDoc,
    secondUser,
  }) => {
    const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });

    await readerPage.goto(`/doc/${sharedDoc.slug}`);
    await expect(bodyEditor(readerPage)).toBeVisible();
    await expect(readerPage.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });

    // Hold a selection: from here the reader's render is frozen.
    await selectTextInBody(readerPage, QUOTED_TEXT);
    const popup = readerPage.getByTestId("annotation-popup");
    await popup.getByRole("button", { name: "Annotate" }).click();

    // Meanwhile the author types, advancing the log well past the reader's view.
    await page.goto(`/doc/${sharedDoc.id}/edit`);
    await waitForDocCollabReady(page);
    await bodyEditor(page).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Appended while the reader was mid-annotation.");
    await expect
      .poll(async () => (await getDocState(sharedDoc.id))?.proseText ?? "", { timeout: 15_000 })
      .toContain("mid-annotation");

    await annotationEditor(readerPage).click();
    await readerPage.keyboard.type("Stamped against what I could see.");
    await popup.getByRole("button", { name: "Post annotation" }).click();

    await expect
      .poll(async () => (await getAnnotationStates(sharedDoc.id))[0]?.quotedText, { timeout: 15_000 })
      .toBe(QUOTED_TEXT);

    // The stamp names a state *older* than the tail — i.e. the reader's, not
    // the server's. Asserted as a strict inequality rather than an exact id
    // because how many update rows the author's typing produced is a Yjs
    // batching detail, but that it produced some is not.
    const [annotation] = await getAnnotationStates(sharedDoc.id);
    const doc = await getDocState(sharedDoc.id);
    expect(annotation.ydocUpdateId).not.toBeNull();
    expect(BigInt(annotation.ydocUpdateId!)).toBeLessThan(BigInt(doc!.ydocMaxUpdateId!));

    // And the invariant still holds at that older stamp: replaying to it and
    // reading the stored offsets gives back the stored quote. That is what
    // scripts/integrity/check-annotation-anchors.ts checks in bulk.
    expect(annotation.quoteMatchesAtStamp).toBe(true);
  });

  // PLAN.md §13p — an annotation's own body is a surface you can annotate,
  // and the same gesture means the same thing there: selecting text is the
  // request to reply about *that* passage. The anchor targets the parent
  // annotation, never the doc, which is what the assertions below pin down.
  test("selecting inside an annotation opens a reply anchored to that passage, and re-selecting re-points it", async ({
    sharedDoc,
    secondUser,
  }) => {
    const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });

    // A root annotation to reply to, made the ordinary way.
    await readerPage.goto(`/doc/${sharedDoc.slug}`);
    await expect(bodyEditor(readerPage)).toBeVisible();
    await expect(readerPage.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    await selectTextInBody(readerPage, QUOTED_TEXT);
    const popup = readerPage.getByTestId("annotation-popup");
    await popup.getByRole("button", { name: "Annotate" }).click();
    await annotationEditor(readerPage).click();
    await readerPage.keyboard.type("The middle clause here is doing a lot of work.");
    await popup.getByRole("button", { name: "Post annotation" }).click();
    // Polls the *posted* state, not the row count: "Annotate" already created
    // the row as a DRAFT, so a length check would pass before Post's own
    // round trip had done anything.
    await expect
      .poll(async () => (await getAnnotationStates(sharedDoc.id))[0]?.quotedText, { timeout: 15_000 })
      .toBe(QUOTED_TEXT);

    // Reload so the posted annotation renders through AnnotationBodyReader
    // rather than through whatever the composer left on screen.
    await readerPage.goto(`/doc/${sharedDoc.slug}`);
    await expect(readerPage.getByRole("textbox", { name: "Annotation" }).first()).toBeVisible();

    // The gesture: no Reply click anywhere in this test.
    await selectTextInAnnotation(readerPage, "middle clause");
    await expect(annotationEditor(readerPage)).toBeVisible({ timeout: 15_000 });

    // The selected passage is *visibly* marked, not merely decorated in the
    // abstract. Asserted as a computed style rather than as the span's
    // existence, because the decoration being dispatched and the decoration
    // being painted are two different things: `.pending-annotation` is styled
    // by a rule scoped under `.prose` (prose.module.css), so a surface that
    // renders the span without that class produces exactly this feature
    // silently doing nothing. That is the bug this assertion exists for.
    const pendingMark = readerPage.locator('[aria-label="Annotation"] .pending-annotation').first();
    await expect(pendingMark).toBeVisible();
    expect(
      await pendingMark.evaluate((el) => getComputedStyle(el).borderBottomStyle),
    ).toBe("dashed");

    // Re-pointing: a second selection while the composer sits open must move
    // the anchor rather than open a second reply.
    await selectTextInAnnotation(readerPage, "doing a lot of work");
    await expect(annotationEditor(readerPage)).toHaveCount(1);
    await expect(readerPage.locator('[aria-label="Annotation"] .pending-annotation').first()).toContainText(
      "doing a lot of work",
    );

    await annotationEditor(readerPage).click();
    await readerPage.keyboard.type("Agreed, that's the crux.");
    await readerPage.getByRole("button", { name: "Post annotation" }).click();

    await expect
      .poll(async () => (await getAnnotationStates(sharedDoc.id)).find((a) => a.parentAnnotationId !== null), {
        timeout: 15_000,
      })
      .toMatchObject({
        // The *second* selection is what it quotes — the first was replaced.
        quotedText: "doing a lot of work",
        bodyText: "Agreed, that's the crux.",
      });

    // And the anchor points into the parent annotation, not the doc: those
    // offsets are small (an annotation body is short) and the quoted text
    // appears nowhere in the doc at all.
    const reply = (await getAnnotationStates(sharedDoc.id)).find((a) => a.parentAnnotationId !== null)!;
    expect(reply.anchorTo).toBeGreaterThan(reply.anchorFrom!);
    await expect(bodyEditor(readerPage)).not.toContainText("doing a lot of work");

    // Once posted, the quote is highlighted inside the parent's body — the
    // same paint check as above, for the durable decoration rather than the
    // in-progress one.
    await readerPage.reload();
    const replyMark = readerPage.locator(`[data-annotation-ids~="${reply.id}"]`).first();
    await expect(replyMark).toBeVisible();
    await expect(replyMark).toContainText("doing a lot of work");
    expect(await replyMark.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  });

  // The other side of PLAN.md §13o's split. e2e/text-selection.spec.ts already
  // covers where the editor's marker sits; this covers what posting from it
  // actually writes, which is the thing that must not follow the reading view.
  test("an annotation written from a reading view is visible in the editor's rail too", async ({
    page,
    sharedDoc,
  }) => {
    // PLAN.md §13o's claim in the direction nothing covered: the editor is
    // supposed to answer for *both* mechanisms, and EditorAnnotationRail's own
    // header says a reader's column-anchored annotation "is precisely what the
    // author needs to see while editing the passage it is about".
    //
    // It wasn't. A column anchor resolves by finding its quotedText in the
    // document, and this editor's document starts empty and fills from Yjs, so
    // the one anchor push happened against an empty doc, failed, and was never
    // retried (annotation-highlight-extension.ts's tier 3 leaves a failed scan
    // detached until the next push, and there was no next push). Every
    // annotation written from a reading view was invisible here. The fix is a
    // second push once `synced` says the document has arrived; this is what
    // fails without it.
    const annotation = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: "Written against stored offsets.",
      anchor: { from: QUOTE_FROM, to: QUOTE_TO, quotedText: QUOTED_TEXT },
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/doc/${sharedDoc.id}/edit`);
    await waitForDocCollabReady(page);

    // The anchor resolved against the live document: the highlight decoration
    // exists, which is the thing that was missing outright.
    await expect(page.locator(`[data-annotation-ids~="${annotation.id}"]`).first()).toBeVisible({ timeout: 15_000 });

    // And the card is *drawn*, not merely present — the bounded rail hides a
    // card it cannot place, which is exactly how this failure looked.
    await expect(page.locator(`[data-thread-id="${annotation.id}"]`)).toBeVisible();
  });

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

    // PLAN.md §13n — the stamp names a revision the annotation is actually
    // *locatable* at. A mark is applied as an update strictly after the state
    // its author was looking at, so stamping that earlier state pointed "at
    // this revision" at a document with no such mark, and the card fell out
    // of the margin rail the moment you clicked it. Asserted by replaying to
    // the stamp and looking, which is what makes this about the property
    // rather than about which id happens to be current.
    const [marked] = await getAnnotationStates(sharedDoc.id);
    expect(marked.ydocUpdateId).not.toBeNull();
    expect(await markPresentAtStamp(sharedDoc.id, marked.id)).toBe(true);
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
