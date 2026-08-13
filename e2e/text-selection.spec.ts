// Selecting text and being offered somewhere to say something about it —
// the one gesture all three reading/writing surfaces share, and the one
// nothing covered end to end until now.
//
// Worth its own file rather than three additions to three existing specs,
// because the *comparison* is the point: the three surfaces reach the same
// gesture through three genuinely different mechanisms (COLLAB.md §1/§4/§5),
// and a regression in any one of them looks identical from the outside —
// "no widget appeared". Keeping them adjacent is what makes the odd one out
// obvious.
//
// This suite exists because of a bug it would have caught. `/doc/[slug]/edit`
// shipped with its selection widget unable to open at all: `yjs-relative-
// anchor.ts` imported `ySyncPluginKey` from `y-prosemirror` while Tiptap v3's
// Collaboration extension binds through `@tiptap/y-tiptap`, so the key never
// matched, `captureRelativeRange` always returned null, and every selection
// silently did nothing (PLAN.md §18f). Nothing failed: not `tsc`, not
// `eslint`, and not the e2e suite — which exercises that page by *typing*
// into it, never by selecting. Each test below therefore asserts the widget
// actually appears and names the exact selected text, which is the assertion
// that would have failed.
import {
  test,
  expect,
  annotationEditor,
  bodyEditor,
  selectTextInBody,
  waitForDocCollabReady,
  QUOTED_TEXT,
} from "./fixtures";

test.describe("text selection offers somewhere to respond", () => {
  // A published post's public page — AnnotatableArticle, the original
  // surface (COLLAB.md §1). Its anchor is a pair of stored offsets against
  // an immutable published snapshot, so there is no live document to wait
  // on: the editor being mounted is the whole readiness condition.
  test("a post's reading view offers to comment on the selection", async ({ page, publishedPost }) => {
    await page.goto(`/${publishedPost.slug}`);
    // Not just "attached": AnnotatableArticle keeps the SSR'd static copy in
    // the DOM and swaps which of the two is display:none once `ready`
    // (onCreate) fires. Selecting before that swap targets a copy
    // ProseMirror isn't watching.
    await expect(bodyEditor(page)).toBeVisible();

    await selectTextInBody(page, QUOTED_TEXT);

    // Scoped to the popup throughout — this page also renders the general
    // CommentForm below the article, whose "Post comment" button is named
    // identically and would otherwise trip strict mode.
    const popup = page.getByTestId("comment-popup");
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("Commenting on:");
    await expect(popup).toContainText(QUOTED_TEXT);
    await expect(popup.getByRole("button", { name: "Post comment" })).toBeVisible();
  });

  // A doc's reading view for someone who cannot edit it — the AUTHORIZED
  // reader is the point, not incidental: their token is readOnly (PLAN.md
  // §12g), which is a different connection to the same live document, and
  // the surface still has to let them annotate it.
  test("a read-only doc's reading view offers to annotate the selection", async ({ sharedDoc, secondUser }) => {
    const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });

    await readerPage.goto(`/doc/${sharedDoc.slug}`);
    await expect(bodyEditor(readerPage)).toBeVisible();
    // The live tap's first sync pushes its own setContent through the
    // editor, which would silently collapse a selection made before it
    // lands (DocReadingBody's note on `synced`) — wait it out.
    await expect(readerPage.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });

    await selectTextInBody(readerPage, QUOTED_TEXT);

    const popup = readerPage.getByTestId("annotation-popup");
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("Annotating:");
    await expect(popup).toContainText(QUOTED_TEXT);
    await expect(popup.getByRole("button", { name: "Annotate" })).toBeVisible();
    // Present here and absent on the editor below — the one behavioural
    // difference between the two doc surfaces' otherwise-shared popover
    // (AnnotationPopover's `allowMoveToBottom`), asserted from both sides so
    // neither can quietly drift into the other.
    await expect(popup.getByRole("button", { name: "Move to bottom" })).toBeVisible();
  });

  // The doc editor — the surface the bug in this file's header actually hit,
  // and the one that answers a selection differently on purpose (PLAN.md
  // §18f). Unlike both reading views this editor is Collaboration-bound, so
  // its selection is captured as a pair of Y.RelativePositions rather than
  // offsets (COLLAB.md §5), through a separate hook
  // (useEditorAnnotationWidget, not useSelectionPopover).
  test("a doc editor offers a marker beside the document, not a panel over it", async ({ page, sharedDoc }) => {
    await page.goto(`/doc/${sharedDoc.id}/edit`);
    await waitForDocCollabReady(page);

    await selectTextInBody(page, QUOTED_TEXT);

    // Stage one, and the whole point of this surface differing: selecting
    // text while editing is mostly *not* a request to annotate, so nothing
    // opens over the text.
    const marker = page.getByTestId("annotate-marker");
    await expect(marker).toBeVisible();
    await expect(page.getByTestId("annotation-popup")).toHaveCount(0);

    // "Beside the document" is the requirement, so it's asserted as
    // geometry rather than taken on trust from a class name: the marker
    // starts at or past the right edge of the editor's own text box.
    // Measured at the default 1280px here; the width sweep below is what
    // holds that true across the supported range rather than at one size.
    const frameBox = await page.locator("[data-editor-scroll]").boundingBox();
    const markerBox = await marker.boundingBox();
    expect(frameBox).not.toBeNull();
    expect(markerBox).not.toBeNull();
    expect(markerBox!.x).toBeGreaterThanOrEqual(frameBox!.x + frameBox!.width);
    // ...and level with the selection rather than parked at a corner.
    const highlight = await page.locator(".pending-annotation").first().boundingBox();
    expect(highlight).not.toBeNull();
    expect(Math.abs(markerBox!.y - highlight!.y)).toBeLessThan(40);

    // Stage two: clicking expands it into the composer. No second
    // "Annotate" button — the marker already was that question, so this
    // goes straight to a live annotation editor (AnnotationPopover's
    // `autoOpen`).
    await marker.click();
    const popup = page.getByTestId("annotation-popup");
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("Annotating:");
    await expect(popup).toContainText(QUOTED_TEXT);
    await expect(annotationEditor(page)).toBeVisible({ timeout: 15_000 });
    await expect(popup.getByRole("button", { name: "Annotate", exact: true })).toHaveCount(0);
    // The other half of the read-view assertion above: no bottom composer
    // exists on this page for a draft to be moved to, so the control that
    // would move it there must not be offered.
    await expect(popup.getByRole("button", { name: "Move to bottom" })).toHaveCount(0);

    // The marker gives way to the panel rather than both being on screen.
    await expect(marker).toHaveCount(0);
  });

  // The marker's whole justification is that it stays out of the text's way,
  // so "is it actually beside the document" has to hold across the range it
  // is offered in — not just at Playwright's default 1280. The floor
  // (DocEditor's ANNOTATION_WIDGET_MEDIA_QUERY) is derived from this exact
  // geometry: `.container` is a centred 800px column, so a gutter wide
  // enough for the marker doesn't exist until ~856px. These cases are what
  // stop that arithmetic from silently going stale if the column's width or
  // padding is ever changed.
  for (const width of [1280, 960, 900]) {
    test(`the editor's marker clears the text column at ${width}px`, async ({ page, sharedDoc }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/doc/${sharedDoc.id}/edit`);
      await waitForDocCollabReady(page);
      await selectTextInBody(page, QUOTED_TEXT);

      const marker = page.getByTestId("annotate-marker");
      await expect(marker).toBeVisible();
      const frameBox = await page.locator("[data-editor-scroll]").boundingBox();
      const markerBox = await marker.boundingBox();
      expect(markerBox!.x).toBeGreaterThanOrEqual(frameBox!.x + frameBox!.width);
      // And fully on screen — clamping it back inside the viewport is what
      // would put it over the text, so overflowing is not the better failure.
      expect(markerBox!.x + markerBox!.width).toBeLessThanOrEqual(width);
    });
  }

  test("the editor offers no marker where there is no room beside the document", async ({ page, sharedDoc }) => {
    // Below the floor the marker is not merely repositioned, it is not
    // offered — a marker clamped back over the text would defeat its own
    // purpose. Annotating is still reachable here, from the doc's reading
    // view, which has no width floor of its own.
    await page.setViewportSize({ width: 700, height: 800 });
    await page.goto(`/doc/${sharedDoc.id}/edit`);
    await waitForDocCollabReady(page);
    await selectTextInBody(page, QUOTED_TEXT);

    // The selection is still decorated — the anchor was captured, only the
    // marker is withheld — so this asserts the absence of a widget rather
    // than the absence of a working selection.
    await expect(page.locator(".pending-annotation")).toHaveCount(1);
    await expect(page.getByTestId("annotate-marker")).toHaveCount(0);
    await expect(page.getByTestId("annotation-popup")).toHaveCount(0);
  });
});
