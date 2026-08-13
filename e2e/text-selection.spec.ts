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
import { test, expect, bodyEditor, selectTextInBody, waitForDocCollabReady, QUOTED_TEXT } from "./fixtures";

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

  // The doc editor — the surface the bug in this file's header actually hit.
  // Unlike both reading views this editor is Collaboration-bound, so its
  // selection is captured as a pair of Y.RelativePositions rather than
  // offsets (COLLAB.md §5), through a completely separate hook
  // (useEditorAnnotationWidget, not useSelectionPopover).
  test("a doc editor offers to annotate the selection", async ({ page, sharedDoc }) => {
    await page.goto(`/doc/${sharedDoc.id}/edit`);
    await waitForDocCollabReady(page);

    await selectTextInBody(page, QUOTED_TEXT);

    const popup = page.getByTestId("annotation-popup");
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("Annotating:");
    await expect(popup).toContainText(QUOTED_TEXT);
    await expect(popup.getByRole("button", { name: "Annotate" })).toBeVisible();
    // The other half of the read-view assertion above: no bottom composer
    // exists on this page for a draft to be moved to, so the control that
    // would move it there must not be offered.
    await expect(popup.getByRole("button", { name: "Move to bottom" })).toHaveCount(0);

    // The selected range is also decorated, not merely popped over —
    // PendingAnnotation is registered on this editor (PLAN.md §18f) so the
    // source text stays visibly marked once focus moves into the composer
    // and the browser's own selection highlight goes away.
    await expect(page.locator(".pending-annotation")).toHaveCount(1);
  });
});
