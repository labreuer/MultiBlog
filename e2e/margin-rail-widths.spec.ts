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
  titleEditor,
  statusLine,
  annotationEditor,
  selectTextInBody,
  waitForDocCollabReady,
  QUOTED_TEXT,
  QUOTED_BODY,
  QUOTE_FROM,
  QUOTE_TO,
} from "./fixtures";
import { createTestAnnotation, createTestDoc, deleteTestDoc, getAnnotationStates } from "./db";
import { EDITOR_SCROLL_ATTRIBUTE } from "../src/components/editor-scroll";
import { ADMIN_EMAIL } from "./naming";
import type { Page } from "@playwright/test";

// The measured iPad-landscape viewport. NARROW is deliberately not 1179: an
// off-by-one probe would fail for the right reason and for a dozen wrong ones
// too (a scrollbar's width, a rounded rem), and what this file is for is the
// behaviour on either side of the threshold rather than its exact pixel.
const IPAD_LANDSCAPE = { width: 1194, height: 834 };
const NARROW = { width: 1024, height: 768 };
// An iPhone 13 Pro held sideways. Short enough to satisfy the focus mode's
// `max-height: 500px` and, at 844px, comfortably under the 1180px width the
// rail otherwise demands — which is the whole point of the mode having a
// query of its own rather than a lower number in the shared one.
const PHONE_LANDSCAPE = { width: 844, height: 390 };

// Geometry rather than class names, for the reason admin-table.spec.ts asserts
// its row borders by computed colour: `.anchored` is toggled from JS and the
// grid comes from CSS (CLAUDE.md's margin-notes invariant), so either half
// could regress alone and only the resulting position says whether a reader
// can actually see the note beside its passage.
async function boxes(page: Page) {
  const article = await bodyEditor(page).boundingBox();
  const card = await page.locator("[data-margin-note-id]").first().boundingBox();
  return article && card ? { article, card } : null;
}

/**
 * Gap from the article's right edge to the card's left edge — non-negative
 * exactly when the card is beside the text rather than over or below it.
 * Returned as a number rather than a boolean so a failure reports how far off
 * it landed, which is the difference between "the breakpoint didn't fire" and
 * "the rail is overlapping the prose".
 *
 * NaN, not a throw, when either box is missing. Crossing the breakpoint moves
 * a card between the rail's portal and the section below, and for a tick
 * neither is laid out — `boundingBox()` answers null. A throw inside
 * `expect.poll` aborts the whole test instead of being retried, so this
 * returns a value that simply fails the comparison and polls again. It failed
 * exactly this way against the prod target while passing on dev, which is the
 * timing difference the suite targets prod for in the first place.
 */
async function besideBy(page: Page): Promise<number> {
  const measured = await boxes(page);
  if (!measured) return Number.NaN;
  const { article, card } = measured;
  return Math.round(card.x - (article.x + article.width));
}

/** The same, vertically: how far the card's top sits below the article's bottom. */
async function belowBy(page: Page): Promise<number> {
  const measured = await boxes(page);
  if (!measured) return Number.NaN;
  const { article, card } = measured;
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

// PLAN.md §18f's surface, in the one orientation where the page is nothing but
// the document: a phone held sideways has width to spare and almost no height,
// so the editor trades every piece of stacked chrome — the site header, the
// title, the connection badge, the "View and Annotate" link, the settings
// panel — for room to write, and keeps the annotation rail as a peek that
// scrolls sideways.
//
// Every assertion here is invisible to the rest of the suite twice over: at
// desktop widths the mode never engages, and at phone widths without the
// mode there is no rail at all.
test.describe("the doc editor's phone-landscape focus mode", () => {
  // The annotation is made at a desktop size first. It has to be: the editor's
  // annotate marker has a 900px floor of its own (ANNOTATION_WIDGET_MEDIA_QUERY
  // — measured, not picked, see its comment), so nothing can be annotated *in*
  // this mode on an 844px phone. That is also the honest case, a doc arriving
  // on a phone with annotations already on it.
  async function annotateThenTurnSideways(page: Page, docId: string): Promise<string> {
    await page.setViewportSize(IPAD_LANDSCAPE);
    await page.goto(`/doc/${docId}/edit`);
    await waitForDocCollabReady(page);
    await selectTextInBody(page, QUOTED_TEXT);
    await page.locator("[data-testid='annotate-marker']").click();
    const popup = page.getByTestId("annotation-popup");
    await annotationEditor(page).click();
    await page.keyboard.type("Still readable sideways?");
    await popup.getByRole("button", { name: "Post annotation" }).click();

    // Returns the id of what it just wrote, read from the DB rather than the
    // DOM: the widget's annotation is the *marked* one, which identifies it
    // even on a doc a test has already put other annotations on.
    let id = "";
    await expect
      .poll(
        async () => {
          id = (await getAnnotationStates(docId)).find((state) => state.marked)?.id ?? "";
          return id;
        },
        { timeout: 15_000 },
      )
      .not.toBe("");
    await page.setViewportSize(PHONE_LANDSCAPE);
    return id;
  }

  test("keeps the document and the rail, and drops every other piece of chrome", async ({ page, sharedDoc }) => {
    await annotateThenTurnSideways(page, sharedDoc.id);

    await expect(bodyEditor(page)).toBeVisible();
    // The site header is the largest of these and the only one hidden from
    // globals.css — it belongs to the root layout, not to this page.
    await expect(page.locator("body > header")).toBeHidden();
    await expect(titleEditor(page)).toBeHidden();
    await expect(statusLine(page)).toBeHidden();
    await expect(page.getByRole("link", { name: "View and Annotate" })).toBeHidden();
    await expect(page.locator("[data-doc-settings]")).toBeHidden();

    // Hidden, not unmounted: turning the phone back restores all of it with no
    // state to rebuild, which is why none of the above is a conditional render.
    await page.setViewportSize(IPAD_LANDSCAPE);
    await expect(page.locator("body > header")).toBeVisible();
    await expect(titleEditor(page)).toBeVisible();
    await expect(page.getByRole("link", { name: "View and Annotate" })).toBeVisible();
  });

  test("scrolls the whole row sideways to the rest of the card", async ({ page, sharedDoc }) => {
    await annotateThenTurnSideways(page, sharedDoc.id);

    // The rail engages at 844px wide, which the shared 1180px threshold would
    // refuse outright — this is the assertion that the editor's query is
    // genuinely its own and not the reading views'.
    await expect(page.locator("[data-margin-note-id]")).toHaveCount(1);
    await expect.poll(() => besideBy(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(0);

    // The row is wider than the phone and scrolls as one piece. The scroller
    // is this box and not the page: globals.css clips page-level horizontal
    // overflow unreachably, so a regression that moved the overflow up to the
    // body would strand the card rather than merely look different.
    const scroller = page.locator("[data-doc-editor-scroller]");
    const before = await scroller.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    expect(before.client).toBeLessThan(before.scroll);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

    // Only part of the card is readable at rest…
    const railBox = await page.locator("[data-editor-rail]").boundingBox();
    if (!railBox) throw new Error("Expected the rail to be laid out.");
    expect(railBox.x).toBeLessThan(before.client);
    expect(railBox.x + railBox.width).toBeGreaterThan(before.client);

    // …and scrolling the row brings the whole of it into the viewport, which
    // is the point of the row scrolling rather than the rail.
    await scroller.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    const scrolled = await page.locator("[data-editor-rail]").boundingBox();
    if (!scrolled) throw new Error("Expected the rail to be laid out after scrolling.");
    expect(scrolled.x).toBeGreaterThanOrEqual(0);
    expect(Math.round(scrolled.x + scrolled.width)).toBeLessThanOrEqual(PHONE_LANDSCAPE.width);
  });

  test("still offers the annotate marker, in the gutter it reserves for it", async ({ page, sharedDoc }) => {
    await annotateThenTurnSideways(page, sharedDoc.id);

    // "Annotations can be made", not merely read. The marker's own gate is a
    // 900px width floor (ANNOTATION_WIDGET_MEDIA_QUERY) that an 844px phone
    // fails — focus mode passes it on the second clause instead, because the
    // room is reserved as a 44px gutter rather than inferred from the window.
    await selectTextInBody(page, "lazy dog");
    const marker = page.locator("[data-testid='annotate-marker']");
    await expect(marker).toBeVisible();

    // In the gutter: clear of the text it belongs to, and clear of the rail.
    // Unclamped is the property worth holding — the placement falls back to
    // pinning against the viewport edge when there is no true gutter, and
    // that fallback would put it on top of the card.
    const markerBox = await marker.boundingBox();
    const editorBox = await bodyEditor(page).boundingBox();
    const railBox = await page.locator("[data-editor-rail]").boundingBox();
    if (!markerBox || !editorBox || !railBox) throw new Error("Expected marker, editor and rail to be laid out.");
    expect(markerBox.x).toBeGreaterThanOrEqual(editorBox.x + editorBox.width);
    expect(markerBox.x + markerBox.width).toBeLessThanOrEqual(railBox.x);

    // And it opens into a composer rather than merely appearing.
    await marker.click();
    await expect(page.getByTestId("annotation-popup")).toBeVisible();
  });

  test("lists every annotation, including one the aligned rail drops for having no anchor", async ({
    page,
    sharedDoc,
  }) => {
    await annotateThenTurnSideways(page, sharedDoc.id);

    // An annotation with no anchor at all — no stored offsets, no mark
    // (PLAN.md §12h). The aligned rail is a *window* onto the visible text, so
    // it has nowhere to put one and does not draw it; the queue is a list, so
    // it does. That difference is the point of the mode changing presentation
    // and not merely geometry.
    await createTestAnnotation({ docId: sharedDoc.id, authorEmail: ADMIN_EMAIL, bodyText: "Nothing to attach to." });
    await page.setViewportSize(IPAD_LANDSCAPE);
    await page.reload();
    await waitForDocCollabReady(page);

    // Counted as visible rather than located by its text: a fixture-made
    // annotation has no body ydoc, so its card renders empty (see
    // createTestAnnotation). And counted *visible* rather than present,
    // because the layout hook hides an out-of-band card rather than
    // unmounting it — both cards are in the DOM either way.
    const present = page.locator("[data-margin-note-id]");
    const drawn = page.locator("[data-margin-note-id]:visible");
    await expect(present).toHaveCount(2);
    await expect(drawn).toHaveCount(1);

    await page.setViewportSize(PHONE_LANDSCAPE);
    await expect(drawn).toHaveCount(2);
  });

  test("orders the queue by the document, not by when each note was written", async ({ page, sharedDoc }) => {
    // QUOTED_BODY is "The quick brown fox jumps over the lazy dog near the
    // river bank.", so "lazy dog" sits *after* "brown fox jumps" in the text
    // while being written first here. `entries` arrive ordered by createdAt
    // (annotation-data.ts), so a queue that rendered them as they came would
    // show these in exactly the wrong order — and one that happened to agree
    // with the document would prove nothing.
    //
    // Column-anchored rows rather than annotations authored through the widget:
    // two round trips through the composer is a slow and flaky way to arrange a
    // fact about sorting, and both mechanisms resolve in this editor (PLAN.md
    // §13o — as of the `synced` re-push, without which this test could not be
    // written at all).
    const dogAt = QUOTED_BODY.indexOf("lazy dog") + 1;
    const dog = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: "About the dog.",
      anchor: { from: dogAt, to: dogAt + "lazy dog".length, quotedText: "lazy dog" },
    });
    const fox = await createTestAnnotation({
      docId: sharedDoc.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: "About the fox.",
      anchor: { from: QUOTE_FROM, to: QUOTE_TO, quotedText: QUOTED_TEXT },
    });

    await page.setViewportSize(IPAD_LANDSCAPE);
    await page.goto(`/doc/${sharedDoc.id}/edit`);
    await waitForDocCollabReady(page);
    await page.setViewportSize(PHONE_LANDSCAPE);

    const cards = page.locator("[data-margin-note-id]");
    await expect(cards).toHaveCount(2);
    // By thread id: a fixture-made card has no body ydoc and so no text to
    // read (see createTestAnnotation).
    await expect
      .poll(() => cards.evaluateAll((els) => els.map((el) => el.getAttribute("data-thread-id"))), { timeout: 10_000 })
      .toEqual([fox.id, dog.id]);

    // The cards are in flow here, where the wide layout places them
    // absolutely — asserted because it is the mechanism the ordering rests on:
    // DOM order is the visual order only once nothing is positioning them.
    expect(await cards.first().evaluate((el) => getComputedStyle(el).position)).toBe("static");
    await page.setViewportSize(IPAD_LANDSCAPE);
    await expect
      .poll(() => cards.first().evaluate((el) => getComputedStyle(el).position), { timeout: 10_000 })
      .toBe("absolute");
  });

  test("marks the cards whose passage is on screen, and moves nothing when the document scrolls", async ({
    page,
  }) => {
    // A document tall enough to scroll inside the editor's own frame, with a
    // distinct word at each end to anchor against. The fixture doc's body is a
    // single sentence, which can never have an off-screen passage.
    const body = `ALPHA ${"filler ".repeat(700)}OMEGA`;
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: body });
    try {
      const alpha = await createTestAnnotation({
        docId: doc.id,
        authorEmail: ADMIN_EMAIL,
        bodyText: "At the top.",
        anchor: { from: 1, to: 6, quotedText: "ALPHA" },
      });
      const omegaAt = body.indexOf("OMEGA") + 1;
      const omega = await createTestAnnotation({
        docId: doc.id,
        authorEmail: ADMIN_EMAIL,
        bodyText: "At the bottom.",
        anchor: { from: omegaAt, to: omegaAt + "OMEGA".length, quotedText: "OMEGA" },
      });

      await page.setViewportSize(IPAD_LANDSCAPE);
      await page.goto(`/doc/${doc.id}/edit`);
      await waitForDocCollabReady(page);
      await page.setViewportSize(PHONE_LANDSCAPE);
      await expect(page.locator("[data-margin-note-id]")).toHaveCount(2);

      const frame = page.locator(`[${EDITOR_SCROLL_ATTRIBUTE}]`);
      const markedIds = () =>
        page
          .locator("[data-margin-note-id][data-on-screen]")
          .evaluateAll((els) => els.map((el) => el.getAttribute("data-thread-id")));

      // Both cards are listed either way — that is the queue. What the marker
      // adds is which of them is about the text in front of you.
      await frame.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect.poll(markedIds, { timeout: 10_000 }).toEqual([alpha.id]);

      // "Move nothing" is the property, so it gets an assertion rather than a
      // comment: the cards sit exactly where they did before the document
      // scrolled underneath them.
      const before = await page.locator("[data-margin-note-id]").first().boundingBox();
      await frame.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect.poll(markedIds, { timeout: 10_000 }).toEqual([omega.id]);
      const after = await page.locator("[data-margin-note-id]").first().boundingBox();
      expect(Math.round(after!.y)).toBe(Math.round(before!.y));
      expect(Math.round(after!.x)).toBe(Math.round(before!.x));

      // The marker is a colour change on a border that is always there, so it
      // cannot shift the text it sits beside.
      const widths = await page
        .locator("[data-margin-note-id]")
        .evaluateAll((els) => els.map((el) => getComputedStyle(el).borderLeftWidth));
      expect(widths).toEqual(["2px", "2px"]);

      // And nothing is marked in the aligned layout, where an out-of-band card
      // is hidden instead and the marker would have nothing to say.
      await page.setViewportSize(IPAD_LANDSCAPE);
      await expect.poll(markedIds, { timeout: 10_000 }).toEqual([]);
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(doc.id);
    }
  });

  test("fits the viewport rather than spilling into a page scroll", async ({ page, sharedDoc }) => {
    await annotateThenTurnSideways(page, sharedDoc.id);

    // .editorContent's 300px floor plus a wrapping toolbar does not fit in
    // 390px, and EditorChrome.module.css's header explains where the excess
    // goes when it doesn't: a page scroll beneath the editor. In a mode whose
    // premise is that the viewport *is* the document, that is the one thing
    // that must not happen. One pixel of slack for sub-pixel rounding.
    const spill = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    expect(spill).toBeLessThanOrEqual(1);
  });
});
