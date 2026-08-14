import { test, expect, signIn, gotoOk, annotationEditor, visibleText } from "./fixtures";
import { ADMIN_EMAIL, createTestFile, deleteTestFile, getFileAnnotationFacts, type TestFile } from "./db";

// PLAN.md §19 Phase 3 — annotating a PDF.
//
// The load-bearing assertion in here is the round trip: select a phrase, post,
// reload, and find the highlight in the same place with the same quote. That
// is the property the whole anchor model exists to provide, and it is not
// observable from the database alone — `quotedText` could be right while the
// quads point at the wrong line.

const PAGE_ONE = "The quick brown fox jumps over the lazy dog on page one.";
const PAGE_TWO = "A distinctive phrase for page two: xylophone marmalade.";
const PHRASE = "brown fox jumps";

async function makeFile(): Promise<TestFile> {
  return createTestFile({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    pages: [[PAGE_ONE], [PAGE_TWO]],
  });
}

async function waitForViewer(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => document.querySelector(".pdfViewer .page .textLayer") !== null, undefined, {
    timeout: 30_000,
  });
}

/**
 * Selects `needle` inside the rendered text layer of a page.
 *
 * Driving a real `Range` rather than a mouse drag: the capture path reads
 * `window.getSelection()`, so a programmatic selection exercises exactly the
 * same code, and a coordinate drag would be at the mercy of where pdfjs
 * happened to lay out the glyphs. `pointerup` is dispatched afterwards because
 * that — not `selectionchange` — is what the surface listens for.
 */
async function selectPhrase(page: import("@playwright/test").Page, pageNumber: number, needle: string) {
  const found = await page.evaluate(
    ({ pageNumber, needle }) => {
      const layer = document.querySelector(`.pdfViewer .page[data-page-number="${pageNumber}"] .textLayer`);
      if (!layer) return "no text layer";

      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent ?? "";
        const index = text.indexOf(needle);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + needle.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return "ok";
      }
      return "phrase not found in any single text node";
    },
    { pageNumber, needle },
  );
  expect(found, `selecting "${needle}" on page ${pageNumber}`).toBe("ok");

  await page.mouse.up();
  await page.dispatchEvent("body", "pointerup");
}


/**
 * Opens the panel composer against the pending selection, types `body`, and
 * posts. Uses the same locators the doc-side specs do ("Annotation body",
 * "Post annotation") because it is the same composer component — the surface
 * around it differs, the composer does not.
 */
async function composeAnnotation(page: import("@playwright/test").Page, body: string) {
  await page.getByRole("button", { name: "Annotate" }).click();
  await page.getByRole("button", { name: "Write an annotation..." }).click();
  const editor = annotationEditor(page);
  await editor.click();
  await editor.pressSequentially(body);
  await page.getByRole("button", { name: "Post annotation" }).click();

  // Wait for the post to actually land before returning. Clicking is only the
  // *start* of it — postAnnotation flushes the annotation's ydoc, derives the
  // quote and writes the row — and a caller that reloads immediately after the
  // click navigates away mid-action, so the row is never written and the test
  // fails somewhere much later with an empty panel. The composer collapsing
  // back to its placeholder is the signal that the action resolved.
  await expect(page.getByRole("button", { name: "Write an annotation..." })).toBeVisible({ timeout: 15_000 });
  // `visibleText`, not getByText: an annotation body is rendered *twice* on
  // purpose — a static SSR copy plus a read-only TipTap editor that swaps in
  // once it mounts, which is what makes the body selectable (PLAN.md §13p) —
  // and whichever copy is not in use is hidden rather than removed.
  await expect(visibleText(page, body)).toBeVisible({ timeout: 15_000 });
}

test.describe("pdf annotations", () => {
  test("anchors a selection, and the highlight survives a reload", async ({ page }) => {
    const file = await makeFile();
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      await selectPhrase(page, 1, PHRASE);
      await composeAnnotation(page, "Why this phrase specifically?");

      // Reload, so nothing under test is holding client state.
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      // The card, with the server-derived quote.
      await expect(visibleText(page, "Why this phrase specifically?")).toBeVisible();
      await expect(visibleText(page, PHRASE).first()).toBeVisible();

      // The highlight, on page one, overlapping the text it quotes. Asserted
      // geometrically rather than by counting elements: a rect that exists but
      // sits on the wrong line is the failure this whole model guards against,
      // and only its position can tell the two apart.
      const overlap = await page.evaluate((needle) => {
        const rects = Array.from(document.querySelectorAll<HTMLElement>(".pdfViewer .page[data-page-number='1'] .annoRect"));
        if (rects.length === 0) return { rects: 0, overlaps: false };

        const layer = document.querySelector(".pdfViewer .page[data-page-number='1'] .textLayer");
        const walker = layer ? document.createTreeWalker(layer, NodeFilter.SHOW_TEXT) : null;
        let target: DOMRect | null = null;
        let node: Node | null;
        while (walker && (node = walker.nextNode())) {
          const index = (node.textContent ?? "").indexOf(needle);
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + needle.length);
          target = range.getBoundingClientRect();
          break;
        }
        if (!target) return { rects: rects.length, overlaps: false };

        const overlaps = rects.some((rect) => {
          const box = rect.getBoundingClientRect();
          return (
            box.left < target!.right && box.right > target!.left && box.top < target!.bottom && box.bottom > target!.top
          );
        });
        return { rects: rects.length, overlaps };
      }, PHRASE);

      expect(overlap.rects).toBeGreaterThan(0);
      expect(overlap.overlaps, "the highlight overlaps the phrase it quotes").toBe(true);
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("the highlight lines up with its text, at every zoom", async ({ page }) => {
    const file = await makeFile();
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      await selectPhrase(page, 1, PHRASE);
      await composeAnnotation(page, "Alignment check.");

      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await page.waitForFunction(() => document.querySelector(".pdfViewer .page .annoRect") !== null, undefined, {
        timeout: 30_000,
      });

      // **Alignment, not overlap.** The sibling test above asserts the highlight
      // overlaps its phrase, and that is genuinely the property that matters
      // most — but it is satisfied by a rect several pixels out of place, which
      // is exactly what shipped: two compounding coordinate bugs (globals.css's
      // `box-sizing: border-box` squeezing pdfjs's page content ~2%, and
      // capturing from the border box while rendering from the padding box) put
      // every highlight a few pixels off, and every test passed.
      //
      // Checked at three zooms because the two bugs failed differently: the
      // border offset was constant in CSS pixels, the box-sizing error scaled
      // with the quote's length. One zoom could have hidden either.
      for (const zoom of ["page-width", "1.5", "0.75"]) {
        await page.getByLabel("Zoom").selectOption(zoom);
        await page.waitForTimeout(600);

        const delta = await page.evaluate((needle) => {
          const layer = document.querySelector('.pdfViewer .page[data-page-number="1"] .textLayer');
          if (!layer) return null;
          const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
          let node: Node | null;
          let text: DOMRect | null = null;
          while ((node = walker.nextNode())) {
            const index = (node.textContent ?? "").indexOf(needle);
            if (index < 0) continue;
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + needle.length);
            text = range.getBoundingClientRect();
            break;
          }
          const rect = document.querySelector<HTMLElement>(".pdfViewer .page .annoRect")?.getBoundingClientRect();
          if (!text || !rect) return null;
          return {
            left: Math.abs(rect.left - text.left),
            top: Math.abs(rect.top - text.top),
            width: Math.abs(rect.width - text.width),
          };
        }, PHRASE);

        expect(delta, `no highlight or text found at zoom ${zoom}`).not.toBeNull();
        // 2px, which is sub-pixel rounding plus the highlight's own 1px radius —
        // tight enough that either original bug (4.5px wide, 9px offset) fails.
        expect(delta!.left, `left offset at zoom ${zoom}`).toBeLessThan(2);
        expect(delta!.top, `top offset at zoom ${zoom}`).toBeLessThan(2);
        expect(delta!.width, `width error at zoom ${zoom}`).toBeLessThan(2);
      }
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("the stored quote is cut from the server's own page text", async ({ page }) => {
    const file = await makeFile();
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      await selectPhrase(page, 1, PHRASE);
      await composeAnnotation(page, "Server-derived quote check.");
      await expect(visibleText(page, "Server-derived quote check.")).toBeVisible();

      // Read straight from the database, because this is the one property that
      // has no browser-visible symptom: a quote taken verbatim from the client
      // would *look* identical on screen.
      //
      // `quotedText === pageText.slice(position)` is the whole claim. The page
      // text is the server's own extraction, stored at upload; the position is
      // the client's hint. If the server had trusted the client's quote instead
      // of cutting its own, the two could disagree and this would catch it —
      // and it is the same invariant scripts/integrity/check-pdf-anchors.ts
      // re-checks later over every row.
      await expect
        .poll(async () => (await getFileAnnotationFacts(file.id)).length, { timeout: 15_000 })
        .toBe(1);
      const [facts] = await getFileAnnotationFacts(file.id);

      expect(facts.pageIndex).toBe(0);
      expect(facts.quadCount).toBeGreaterThan(0);
      expect(facts.textVersion).toBe(`6.2.108/1`);
      expect(facts.pageTextAtTarget, "the server kept page text at the target's own textVersion").not.toBeNull();
      expect(facts.position).not.toBeNull();
      expect(facts.quotedText).toBe(
        facts.pageTextAtTarget!.slice(facts.position!.start, facts.position!.end),
      );
      // And it is genuinely the phrase that was selected, not merely
      // self-consistent nonsense.
      expect(facts.quotedText).toBe(PHRASE);
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("an annotation stays listed while its page is scrolled away from", async ({ page }) => {
    const file = await createTestFile({
      authorEmail: ADMIN_EMAIL,
      visibility: "SHARED",
      pages: Array.from({ length: 12 }, (_, i) => [`Page ${i + 1} body text, distinct marker-${i + 1}-zebra.`]),
    });
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      await selectPhrase(page, 1, "marker-1-zebra");
      await composeAnnotation(page, "An annotation near the top.");

      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      const card = page.locator("[data-margin-note-id]").first();
      await expect(card).toBeVisible();
      // Its page is on screen, so it is positioned rather than greyed.
      await expect(card).not.toHaveClass(/offscreen/);

      await page.getByLabel("Page number").fill("12");
      await page.getByLabel("Page number").press("Enter");
      await page.waitForFunction(
        () => document.querySelector(".pdfViewer .page[data-page-number='12'] .textLayer") !== null,
        undefined,
        { timeout: 30_000 },
      );

      // Still listed and still readable. That is the guarantee: an annotation
      // whose page isn't on screen is off-screen, not detached.
      //
      // Deliberately *not* asserting that it becomes greyed here. Greying
      // follows pdfjs evicting the page, and its buffer size is an internal
      // with no contract — a 12-page document may well keep page 1 alive. A
      // test that pinned it would be asserting pdfjs's memory policy rather
      // than our behaviour, and would break on an upgrade that changed it for
      // unrelated reasons.
      await expect(card).toBeVisible();
      await expect(visibleText(page, "An annotation near the top.")).toBeVisible();
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("a PDF annotation appears in /annotations, linking to the viewer", async ({ page }) => {
    const file = await makeFile();
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      await selectPhrase(page, 1, PHRASE);
      await composeAnnotation(page, "Listed in the admin table.");

      // The whole point of annotations being Postgres rows rather than entries
      // in a per-file ydoc (PLAN.md §19) is that this listing can see them.
      await gotoOk(page, "/annotations");
      await expect(visibleText(page, "Listed in the admin table.")).toBeVisible();
      await expect(page.getByRole("link", { name: file.title })).toHaveAttribute("href", `/pdf/${file.slug}`);
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("deleting an annotation takes its highlight and tick with it", async ({ page }) => {
    const file = await makeFile();
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      await selectPhrase(page, 1, PHRASE);
      await composeAnnotation(page, "Doomed annotation.");

      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      // Four surfaces show an annotation, and all four have to let go of it.
      const highlight = page.locator(".pdfViewer .page .annoRect");
      const tick = page.locator('[aria-label="Document map"]').getByRole("button");
      const card = page.locator("[data-margin-note-id]");
      const badge = page.getByRole("button", { name: /Jump to this passage/ });

      await expect(highlight).not.toHaveCount(0, { timeout: 20_000 });
      await expect(tick).toHaveCount(1);
      await expect(card).toHaveCount(1);
      await expect(badge).toHaveCount(1);

      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("button", { name: "Yes", exact: true }).click();

      // **Deletion is a soft delete**, so the row survives — which is exactly
      // why this needs asserting on every surface rather than trusting the
      // query to stop returning it. The first cut hid only the card, leaving
      // the highlight painted on the page, its tick on the strip, and an
      // orphaned page badge: "I deleted it but it's still there".
      await expect(highlight).toHaveCount(0, { timeout: 20_000 });
      await expect(tick).toHaveCount(0);
      await expect(badge).toHaveCount(0);
      await expect(visibleText(page, "Doomed annotation.")).toHaveCount(0);

      // And it stays gone across a reload, i.e. the server-side view-model
      // agrees with what the client just did.
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await expect(page.locator(".pdfViewer .page .annoRect")).toHaveCount(0, { timeout: 20_000 });
      await expect(page.getByText("No annotations yet.", { exact: false })).toBeVisible();
    } finally {
      await deleteTestFile(file.id);
    }
  });
});
