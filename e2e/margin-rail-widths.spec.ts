// PLAN.md §18's threshold — the width at which comments and annotations move
// from a list below the article into the margin rail — is the one number in
// STYLE.md's breakpoint table that nothing else in the suite can fail on.
// Every other spec runs at Desktop Chrome's 1280×720 or wider, which has been
// above the threshold at every value it has ever held, so the rail is always
// already engaged by the time a test looks at it.
//
// That gap shipped. The threshold was 1200px over a layout composing to 1180
// (an 800px reading column + 2.5rem + a 340px rail), and an iPad in landscape
// measures 1194 CSS px — six pixels short of a threshold carrying twenty
// pixels of slack, so a device with room for the rail rendered none of it.
// The doc *editor* was the worst of it: EditorAnnotationRail has no stacked
// fallback by design (its header says why), so an author on an iPad saw the
// highlights in the text and the annotations nowhere at all. Measured on a
// real device 2026-08-25 (TODO.md, scripts/remote-console.ts) and fixed by
// making the threshold the composed width itself.
//
// Hence two widths below rather than one: a spec asserting only the wide case
// would pass just as happily against no breakpoint at all.
import {
  test,
  expect,
  bodyEditor,
  annotationEditor,
  selectTextInBody,
  waitForDocCollabReady,
  QUOTED_TEXT,
} from "./fixtures";
import type { Page } from "@playwright/test";

// The measured iPad-landscape viewport. NARROW is deliberately not 1179: an
// off-by-one probe would fail for the right reason and for a dozen wrong ones
// too (a scrollbar's width, a rounded rem), and what this file is for is the
// behaviour on either side of the threshold rather than its exact pixel.
const IPAD_LANDSCAPE = { width: 1194, height: 834 };
const NARROW = { width: 1024, height: 768 };

// Geometry rather than class names, for the reason admin-table.spec.ts asserts
// its row borders by computed colour: `.anchored` is toggled from JS and the
// grid comes from CSS (CLAUDE.md's margin-notes invariant), so either half
// could regress alone and only the resulting position says whether a reader
// can actually see the note beside its passage.
async function boxes(page: Page) {
  const article = await bodyEditor(page).boundingBox();
  const card = await page.locator("[data-margin-note-id]").first().boundingBox();
  if (!article || !card) throw new Error("Expected both the article and one annotation card to be laid out.");
  return { article, card };
}

/**
 * Gap from the article's right edge to the card's left edge — non-negative
 * exactly when the card is beside the text rather than over or below it.
 * Returned as a number rather than a boolean so a failure reports how far off
 * it landed, which is the difference between "the breakpoint didn't fire" and
 * "the rail is overlapping the prose".
 */
async function besideBy(page: Page): Promise<number> {
  const { article, card } = await boxes(page);
  return Math.round(card.x - (article.x + article.width));
}

/** The same, vertically: how far the card's top sits below the article's bottom. */
async function belowBy(page: Page): Promise<number> {
  const { article, card } = await boxes(page);
  return Math.round(card.y - (article.y + article.height));
}

test.describe("the margin rail across the breakpoint", () => {
  test("a doc's annotation sits beside the text at iPad-landscape width, and below it when narrower", async ({
    page,
    sharedDoc,
  }) => {
    await page.setViewportSize(IPAD_LANDSCAPE);
    await page.goto(`/doc/${sharedDoc.slug}`);
    await expect(bodyEditor(page)).toBeVisible();
    // The live tap's initial sync pushes its own setContent through the
    // editor, which would silently collapse a selection made before it lands
    // — the same wait doc.spec.ts's annotation tests take.
    await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    await selectTextInBody(page, QUOTED_TEXT);

    const popup = page.getByTestId("annotation-popup");
    await popup.getByRole("button", { name: "Annotate" }).click();
    await annotationEditor(page).click();
    await page.keyboard.type("Beside the passage, or below the article?");
    await popup.getByRole("button", { name: "Post annotation" }).click();

    await expect(page.locator("[data-margin-note-id]")).toHaveCount(1, { timeout: 15_000 });

    // Polled rather than measured once: the card is portaled into the rail and
    // then positioned from a requestAnimationFrame, so its first painted
    // position is its flow position.
    await expect.poll(() => besideBy(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(0);

    // Narrower, and the same card returns to the section under the article —
    // the reading views' fallback, and what makes this an assertion about the
    // breakpoint rather than about a rail that might be unconditional.
    await page.setViewportSize(NARROW);
    await expect.poll(() => belowBy(page), { timeout: 10_000 }).toBeGreaterThan(0);
  });

  test("the doc editor's rail appears at iPad-landscape width and is absent below it", async ({ page, sharedDoc }) => {
    await page.setViewportSize(IPAD_LANDSCAPE);
    await page.goto(`/doc/${sharedDoc.id}/edit`);
    await waitForDocCollabReady(page);
    await selectTextInBody(page, QUOTED_TEXT);

    // The editor's own widget: a marker beside the document, which opens the
    // composer directly (PLAN.md §18f's `autoOpen`).
    await page.locator("[data-testid='annotate-marker']").click();
    const popup = page.getByTestId("annotation-popup");
    await annotationEditor(page).click();
    await page.keyboard.type("Annotated from an iPad-sized editor.");
    await popup.getByRole("button", { name: "Post annotation" }).click();

    const cards = page.locator("[data-margin-note-id]");
    await expect(cards).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => besideBy(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(0);

    // Nothing at all below the breakpoint — no stacked list to fall back to,
    // which is exactly why the six pixels mattered here more than anywhere
    // else.
    await page.setViewportSize(NARROW);
    await expect(cards).toHaveCount(0);

    // And back, so a failure above can't be read as "posting the annotation
    // removed it" — the width is the only thing that changed.
    await page.setViewportSize(IPAD_LANDSCAPE);
    await expect(cards).toHaveCount(1);
  });
});
