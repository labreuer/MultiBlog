import type { Page, Route } from "@playwright/test";
import {
  test,
  expect,
  annotationEditor,
  selectTextInAnnotation,
  selectTextInBody,
  QUOTED_TEXT,
  QUOTE_FROM,
  QUOTE_TO,
} from "./fixtures";
import { ADMIN_EMAIL, createTestAnnotation, getAnnotationStates } from "./db";

// A composer is bound to exactly one DRAFT, and the words typed into it are
// that draft's.
//
// The two can come apart without anything looking wrong: AnnotationBody's
// editor binds its ydoc once, at construction, so a LiveAnnotationComposer
// handed a different draft id in place keeps showing — and taking — the
// typing, while the draft it posts is the new one, which is empty. The author
// sees their words in the box and "Annotation can't be empty." under it. Each
// test below drives one of the two ways a parent can swap the draft under an
// open composer, and asserts on the *posted* body: the text is always in the
// box, so an assertion on visible text passes either way.

// AnnotationNode's SELECTION_SETTLE_MS is 300; this is long enough that a
// second settle timer, if anything started one, has fired.
const PAST_SELECTION_SETTLE_MS = 1_000;

/**
 * Holds every server action `page` sends to `path` until released, in the
 * order sent, so a test can count them and let them answer one at a time.
 */
async function holdServerActions(page: Page, path: string) {
  const held: Array<() => void> = [];
  const forwarded: Array<Promise<void>> = [];
  const matches = (url: URL) => url.pathname === path;
  const handler = (route: Route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) return route.fallback();
    const sent = new Promise<void>((resolve) => held.push(resolve)).then(() => route.continue());
    forwarded.push(sent);
    return sent;
  };
  await page.route(matches, handler);
  return {
    sent: () => forwarded.length,
    releaseNext: () => held.shift()?.(),
    async releaseAllAndStop() {
      while (held.length > 0) held.shift()!();
      // Unrouting while a handler is still forwarding hands its request on
      // without it, and the handler's own continue() then throws.
      await Promise.all(forwarded);
      await page.unroute(matches, handler);
    },
  };
}

test.describe("an annotation composer posts the draft it is typing into", () => {
  // PLAN.md §13p — selecting inside a posted body opens a reply, once the
  // selection has settled. The window that matters is after the settle timer
  // has fired and before createDraftAnnotation answers: a selection that
  // changes then (a drag held still past the settle time, then carried on) is
  // a refinement of what the reply quotes, not a second reply. On a 1-vCPU
  // box that window is ~400ms; here the action is held open so the second
  // selection lands inside it every time.
  test("a selection that moves while its reply is opening re-points that reply rather than opening another", async ({
    page,
    sharedDoc,
  }) => {
    const { id: parentId } = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: "E2E parent annotation naming a zebrafish and a narwhal.",
      anchor: { from: QUOTE_FROM, to: QUOTE_TO, quotedText: QUOTED_TEXT },
    });

    await page.goto(`/doc/${sharedDoc.slug}`);
    await expect(page.locator(`[data-comment-id="${parentId}"]`).filter({ visible: true })).toContainText(
      "narwhal",
    );

    const actions = await holdServerActions(page, `/doc/${sharedDoc.slug}`);
    await selectTextInAnnotation(page, "zebrafish");
    // The settle timer has fired and the draft is on its way.
    await expect.poll(() => actions.sent()).toBe(1);
    await selectTextInAnnotation(page, "narwhal");
    // A fixed wait, because what it gives a chance to happen is a request
    // that should never be sent.
    await page.waitForTimeout(PAST_SELECTION_SETTLE_MS);

    // The first draft answers and its composer connects before anything else
    // does — the order in which a second draft, if there is one, lands as a
    // swap under a composer that is already open.
    actions.releaseNext();
    const composer = annotationEditor(page);
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await actions.releaseAllAndStop();

    await composer.click();
    await page.keyboard.type("E2E reply about the narwhal");
    await page.getByRole("button", { name: "Post annotation" }).click();
    // A posted reply closes its composer; a refused one keeps it open with
    // the error under it.
    await expect(composer).toHaveCount(0);

    const replies = (await getAnnotationStates(sharedDoc.id)).filter((a) => a.parentAnnotationId === parentId);
    expect(replies.map((r) => r.bodyText)).toEqual(["E2E reply about the narwhal"]);
    // The second selection is what the reply quotes.
    expect(replies[0].quotedText).toBe("narwhal");
  });

  // PLAN.md §13g — "Move to bottom" hands the bottom slot a draft created in
  // the popover. A slot that already has a draft open posts that one first,
  // then opens the incoming one in its place: the same composer, a different
  // draft.
  test("moving a draft into a bottom composer that already holds one gives the moved draft its own editor", async ({
    page,
    sharedDoc,
  }) => {
    await page.goto(`/doc/${sharedDoc.slug}`);
    // The live tap's first sync pushes its own setContent through the body,
    // which would collapse a selection made before it lands.
    await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });

    await page.getByRole("button", { name: "Write an annotation..." }).click();
    const composer = annotationEditor(page);
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.click();
    await page.keyboard.type("E2E first bottom draft");

    await selectTextInBody(page, QUOTED_TEXT);
    await page.getByTestId("annotation-popup").getByRole("button", { name: "Move to bottom" }).click();

    // The slot's first draft has been posted and the moved one opened, empty.
    await expect(composer).toHaveText("", { timeout: 15_000 });
    await composer.click();
    await page.keyboard.type("E2E moved draft");
    await page.getByRole("button", { name: "Post annotation" }).click();
    await expect(page.getByRole("button", { name: "Write an annotation..." })).toBeVisible();

    const posted = (await getAnnotationStates(sharedDoc.id)).filter((a) => a.bodyText !== "");
    expect(posted.map((a) => a.bodyText).sort()).toEqual(["E2E first bottom draft", "E2E moved draft"]);
    expect(posted.find((a) => a.bodyText === "E2E moved draft")?.quotedText).toBe(QUOTED_TEXT);
  });
});
