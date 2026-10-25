import { test, expect, annotationEditor, selectTextInBody, QUOTED_TEXT } from "./fixtures";
import { getAnnotationStates } from "./db";
import { createAgent } from "./mcp";

// An annotation body has no length limit, as a doc has none
// (docs/ANNOTATIONS.md, "Posting"). Each test posts one of about 7,000
// characters, through one front door: taller than the screen, in the
// selection popover's case.

/** About 7,200 characters in twelve paragraphs, each naming its own number. */
const PARAGRAPHS = Array.from(
  { length: 12 },
  (_, i) => `E2E long paragraph ${i + 1} of 12. ` + "A margin note this long is an essay beside its passage. ".repeat(10).trim(),
);
/** The body as `bodyText` holds it: blocks joined by a blank line. */
const LONG_TEXT = PARAGRAPHS.join("\n\n");

// The project's own desktop window, and a phone whose keyboard comes up
// after the box is placed: 390×664, then 300px tall, so the box has to be
// re-placed for the smaller screen. Playwright raises no software keyboard,
// so a shorter viewport stands in for one. On a real phone the layout
// viewport, and `dvh` with it, would still measure the whole screen; only
// the visual viewport, which fitHeight reads, shrinks.
const SCREENS = [
  { name: "a desktop window", size: null, keyboardUp: null },
  { name: "a phone with its keyboard up", size: { width: 390, height: 664 }, keyboardUp: { width: 390, height: 300 } },
];

for (const screen of SCREENS) {
  test(`a long annotation posts from the selection popover on ${screen.name}, whose buttons stay on screen`, async ({
    page,
    sharedDoc,
  }) => {
    expect(LONG_TEXT.length).toBeGreaterThan(5000);
    if (screen.size) await page.setViewportSize(screen.size);
    await page.goto(`/doc/${sharedDoc.slug}`);
    await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });

    await selectTextInBody(page, QUOTED_TEXT);
    const popover = page.getByTestId("annotation-popup");
    await popover.getByRole("button", { name: "Annotate" }).click();
    const composer = annotationEditor(page);
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.click();
    for (const [i, paragraph] of PARAGRAPHS.entries()) {
      if (i > 0) await page.keyboard.press("Enter");
      await page.keyboard.insertText(paragraph);
    }

    if (screen.keyboardUp) await page.setViewportSize(screen.keyboardUp);

    // The popover is fixed, so nothing scrolls it into view: a box that grew
    // with the body would leave the button row below the screen. It is no
    // taller than the screen, and the editor, not the box, gives up the rest.
    const post = popover.getByRole("button", { name: "Post annotation" });
    await expect(post).toBeInViewport({ ratio: 1 });
    await expect.poll(async () => (await popover.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    await expect
      .poll(async () => {
        const box = (await popover.boundingBox())!;
        return box.y + box.height;
      })
      .toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    // Nor wider: on a phone the button row wraps rather than running off the side.
    const box = (await popover.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    const scrolls = (el: Element) => el.scrollHeight > el.clientHeight + 1;
    expect(await popover.evaluate(scrolls)).toBe(false);
    expect(await composer.locator("..").evaluate(scrolls)).toBe(true);

    await post.click();
    await expect(composer).toHaveCount(0);

    await expect
      .poll(async () => (await getAnnotationStates(sharedDoc.id)).map((a) => [a.status, a.bodyText]), { timeout: 15_000 })
      .toEqual([["LIVE", LONG_TEXT]]);
  });
}

test("a long note posts and is edited through MCP", async ({ request, sharedDoc }) => {
  const agent = await createAgent(request);
  try {
    const note = await agent.call("add_note", { on: `/doc/${sharedDoc.slug}`, body: LONG_TEXT });
    expect(note.isError, JSON.stringify(note.error)).toBe(false);

    const added = "E2E paragraph added by edit_note.";
    const edited = await agent.call("edit_note", { id: note.result.id, body: `${LONG_TEXT}\n\n${added}` });
    expect(edited.isError, JSON.stringify(edited.error)).toBe(false);

    const [row] = await getAnnotationStates(sharedDoc.id);
    expect([row.status, row.bodyText]).toEqual(["LIVE", `${LONG_TEXT}\n\n${added}`]);
  } finally {
    await agent.dispose();
  }
});
