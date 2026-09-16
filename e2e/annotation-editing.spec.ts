import { test, expect, annotationEditor, selectTextInAnnotation, visibleText, QUOTED_TEXT, QUOTE_FROM, QUOTE_TO } from "./fixtures";
import {
  ADMIN_EMAIL,
  backdateAnnotationPosting,
  createTestAnnotation,
  getAnnotationEditFacts,
  setAnnotationEditingSince,
} from "./db";
import { EDIT_GRACE_MS, STALE_EDIT_SESSION_MS } from "../src/lib/edit-grace";
import type { Page } from "@playwright/test";

// PLAN.md §22e — editing a *posted* annotation's body, which until this
// existed only a DRAFT composer could do.
//
// Three things here are not obvious from the outside and are what the cases
// are chosen around:
//
//  1. **A reader on the same doc does not see the keystrokes.** While a
//     session is open the store debounce skips the cache every reader renders
//     from, so the honest assertion is that another identity still sees the
//     *old* text mid-session and the new one after Done.
//  2. **Cancel is a forward write, not an undo.** Yjs has no un-apply, so the
//     previous version is written back as new updates. What that must produce
//     is the old text in the body and no new version.
//  3. **The grace window is measured between stored timestamps**, so it is
//     tested by backdating revision 1 rather than with `page.clock` — see
//     backdateAnnotationPosting's own comment.

const PAST_THE_WINDOW = EDIT_GRACE_MS + 60_000;

function card(page: Page, annotationId: string) {
  return page.locator(`[data-comment-id="${annotationId}"]`);
}

/** Opens the session, replaces the whole body, and clicks Done. */
async function editBodyTo(page: Page, annotationId: string, text: string) {
  const own = card(page, annotationId);
  await own.getByRole("button", { name: "Edit", exact: true }).click();
  const editor = annotationEditor(page);
  await expect(editor).toBeVisible();
  // Click into the editor before typing: TipTap defers its own focus() into a
  // requestAnimationFrame, and a keystroke that lands before that is the
  // keystroke race docs/playwright-flakiness.html calls class 1.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await own.getByRole("button", { name: "Done" }).click();
  await expect(editor).toHaveCount(0);
}

test.describe("editing a posted annotation", () => {
  test("an edit inside the grace window shows nothing, and still stores the old version", async ({
    page,
    sharedDoc,
  }) => {
    const original = `E2E annotation as first posted ${Date.now()}`;
    const corrected = `E2E annotation reworded immediately ${Date.now()}`;
    const { id } = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: original,
      anchor: { from: QUOTE_FROM, to: QUOTE_TO, quotedText: QUOTED_TEXT },
    });

    await page.goto(`/doc/${sharedDoc.slug}`);
    await expect(card(page, id)).toContainText(original);

    await editBodyTo(page, id, corrected);

    await expect.poll(async () => (await getAnnotationEditFacts(id))?.bodyText).toBe(corrected);
    const facts = await getAnnotationEditFacts(id);
    expect(facts?.versions.map((v) => v.bodyText)).toEqual([original, corrected]);
    expect(facts?.editedAt).not.toBeNull();
    expect(facts?.editingSince).toBeNull();
    // Every version is a snapshot at a mark in this body's own update log,
    // which is what makes a reply's "earlier version" reconstructible at all,
    // and the cache is the newest of them.
    expect(facts?.versions.every((v) => v.mark !== "")).toBe(true);
    expect(facts?.versions.at(-1)?.bodyText).toBe(facts?.bodyText);

    await page.reload();
    await expect(card(page, id).getByRole("button", { name: /earlier versions/ })).toHaveCount(0);
  });

  test("an edit after the window shows the marker and the earlier version", async ({ page, sharedDoc }) => {
    const original = `E2E annotation posted long enough ago ${Date.now()}`;
    const corrected = `E2E annotation reworded much later ${Date.now()}`;
    const { id } = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: original,
      anchor: { from: QUOTE_FROM, to: QUOTE_TO, quotedText: QUOTED_TEXT },
    });
    await backdateAnnotationPosting(id, PAST_THE_WINDOW);

    await page.goto(`/doc/${sharedDoc.slug}`);
    await editBodyTo(page, id, corrected);

    await page.reload();
    const marker = card(page, id).getByRole("button", { name: /earlier versions/ });
    await expect(marker).toBeVisible();
    await marker.click();
    const history = page.locator('[data-edit-history="annotation"]');
    await expect(history).toContainText(original);
    await expect(history).toContainText(corrected);
  });

  test("another reader keeps seeing the last settled body until Done", async ({ page, sharedDoc, secondUser }) => {
    const original = `E2E annotation being rewritten ${Date.now()}`;
    const replacement = `E2E annotation half-typed thought ${Date.now()}`;
    const { id } = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: original,
      anchor: { from: QUOTE_FROM, to: QUOTE_TO, quotedText: QUOTED_TEXT },
    });

    await page.goto(`/doc/${sharedDoc.slug}`);
    const own = card(page, id);
    await own.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = annotationEditor(page);
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(replacement);

    // A second identity loading the doc now: the body it renders comes from
    // the cache, which the debounce is deliberately not writing while
    // `editing_since` is set.
    const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });
    await readerPage.goto(`/doc/${sharedDoc.slug}`);
    await expect(card(readerPage, id)).toContainText(original);
    await expect(card(readerPage, id)).not.toContainText(replacement);
    await expect(card(readerPage, id)).toContainText("Being edited since");
    // And no Edit control for them: the session is held, and they could not
    // edit this annotation anyway (§22f).
    await expect(card(readerPage, id).getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);

    await own.getByRole("button", { name: "Done" }).click();
    await expect(editor).toHaveCount(0);

    await readerPage.reload();
    await expect(card(readerPage, id)).toContainText(replacement);
  });

  test("Cancel puts the last settled version back and records no version", async ({ page, sharedDoc }) => {
    const original = `E2E annotation that survives a cancel ${Date.now()}`;
    const { id } = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: original,
      anchor: { from: QUOTE_FROM, to: QUOTE_TO, quotedText: QUOTED_TEXT },
    });
    await backdateAnnotationPosting(id, PAST_THE_WINDOW);

    await page.goto(`/doc/${sharedDoc.slug}`);
    const own = card(page, id);
    await own.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = annotationEditor(page);
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("E2E abandoned rewording nobody should keep");
    await own.getByRole("button", { name: "Cancel" }).click();
    await expect(editor).toHaveCount(0);

    // The body is the old text again — written forward as new updates, which
    // is why this polls rather than reading once.
    await expect.poll(async () => (await getAnnotationEditFacts(id))?.bodyText).toBe(original);
    const facts = await getAnnotationEditFacts(id);
    expect(facts?.versions).toHaveLength(1);
    expect(facts?.editedAt).toBeNull();
    expect(facts?.editingSince).toBeNull();

    await page.reload();
    await expect(card(page, id)).toContainText(original);
    await expect(card(page, id).getByRole("button", { name: /earlier versions/ })).toHaveCount(0);
  });

  test("Done on an emptied body is refused, and readers keep the settled text", async ({
    page,
    sharedDoc,
    secondUser,
  }) => {
    const original = `E2E annotation somebody tries to empty ${Date.now()}`;
    const { id } = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: original,
      anchor: { from: QUOTE_FROM, to: QUOTE_TO, quotedText: QUOTED_TEXT },
    });

    await page.goto(`/doc/${sharedDoc.slug}`);
    const own = card(page, id);
    await own.getByRole("button", { name: "Edit", exact: true }).click();
    const editor = annotationEditor(page);
    await expect(editor).toBeVisible();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    await own.getByRole("button", { name: "Done" }).click();

    // Refused before anything is written: the session stays open with the
    // error beside it, and the cache every reader renders from is untouched —
    // the body is validated at its settled mark, not flushed and then checked.
    await expect(own.getByText("Annotation can't be empty.")).toBeVisible();
    await expect(editor).toBeVisible();
    const facts = await getAnnotationEditFacts(id);
    expect(facts?.bodyText).toBe(original);
    expect(facts?.versions).toHaveLength(1);
    expect(facts?.editingSince).not.toBeNull();

    const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });
    await readerPage.goto(`/doc/${sharedDoc.slug}`);
    await expect(card(readerPage, id)).toContainText(original);
  });

  test("an abandoned session offers Resume and Discard", async ({ page, sharedDoc }) => {
    const original = `E2E annotation with an abandoned session ${Date.now()}`;
    const { id } = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: original,
    });
    // An hour and a bit ago: a closed tab, not someone mid-sentence.
    await setAnnotationEditingSince(id, STALE_EDIT_SESSION_MS + 60_000);

    await page.goto(`/doc/${sharedDoc.slug}`);
    const own = card(page, id);
    await expect(own.getByRole("button", { name: "Resume editing" })).toBeVisible();
    await own.getByRole("button", { name: "Discard unsaved edit" }).click();

    await expect.poll(async () => (await getAnnotationEditFacts(id))?.editingSince).toBeNull();
    const facts = await getAnnotationEditFacts(id);
    // Discarding restores the last settled version, which is what everyone
    // was already reading — so the visible outcome is that nothing changed.
    expect(facts?.bodyText).toBe(original);
    expect(facts?.versions).toHaveLength(1);
  });

  test("a reader who is not the author gets no Edit control", async ({ page, sharedDoc, secondUser }) => {
    const { id } = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: `E2E annotation nobody else may edit ${Date.now()}`,
    });

    const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });
    await readerPage.goto(`/doc/${sharedDoc.slug}`);
    await expect(card(readerPage, id)).toBeVisible();
    await expect(card(readerPage, id).getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
    // Reply stays available — reading and answering are not what narrowed.
    await expect(card(readerPage, id).getByRole("button", { name: "Reply" })).toBeVisible();
    // The admin author, on the same annotation, does get it.
    await page.goto(`/doc/${sharedDoc.slug}`);
    await expect(card(page, id).getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  });

  test("a reply whose quote is edited away offers the version it quoted, and closes the window", async ({
    page,
    sharedDoc,
  }) => {
    const parentBody = "E2E parent annotation containing a distinctive phrase zebrafish.";
    const { id: parentId } = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: parentBody,
      anchor: { from: QUOTE_FROM, to: QUOTE_TO, quotedText: QUOTED_TEXT },
    });

    await page.goto(`/doc/${sharedDoc.slug}`);
    await expect(card(page, parentId)).toContainText("zebrafish");

    // A reply anchored to a passage of the parent's body (PLAN.md §13p):
    // selecting inside the body opens it, and the anchor is what §22e's link
    // later hangs off.
    await selectTextInAnnotation(page, "zebrafish");
    const composer = annotationEditor(page);
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.click();
    await page.keyboard.type("E2E reply about the zebrafish phrase");
    await page.getByRole("button", { name: "Post annotation" }).click();
    await expect(page.getByText("E2E reply about the zebrafish phrase")).toBeVisible();

    // Now edit the quoted words out of the parent — inside the grace window,
    // which the reply's quote closes: silence is only honest while nobody
    // has acted on what was said, so the "edited" marker shows even though
    // the parent was posted seconds ago.
    await page.reload();
    await editBodyTo(page, parentId, "E2E parent annotation with the phrase removed entirely.");

    await page.reload();
    await expect(card(page, parentId).getByRole("button", { name: /earlier versions/ })).toBeVisible();
    const lostLink = page.getByRole("button", { name: "quoted an earlier version" });
    await expect(lostLink).toBeVisible({ timeout: 15_000 });
    await lostLink.click();
    // The materialized parent state at the reply's own stamp — the state the
    // replier was reading, reconstructed from the body's update log.
    await expect(page.getByText("The annotation as it read when this reply quoted it:")).toBeVisible();
    // visibleText, not a bare getByText: the reply's own card is portaled
    // into the margin rail above 1180px and its below-article copy is
    // hidden, so `.first()` on a bare match lands on the hidden one.
    await expect(visibleText(page, "zebrafish").first()).toBeVisible();
  });
});
