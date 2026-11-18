// The doc editor's remote carets (CollabEditorBody's `caretRenderer`, styled
// in EditorChrome.module.css): a 2px bar in the collaborator's color, a flag
// of their admin initials riding on it, and their full name on hover.
//
// What each test holds down, since none of it fails a typecheck:
// - the flag and the name share one box and one text color, so hovering swaps
//   only the words — the color is picked per fill (onAuthorColor), and a light
//   fill is what tells "picked" apart from the white a token would give;
// - the flag itself is a hover target, and hiding it on hover must not take
//   it out of hit-testing, or the name flickers;
// - the viewer's own caret from another tab gets no flag.
import type { Locator, Page } from "@playwright/test";
import { test, expect, bodyEditor, waitForDocCollabReady } from "./fixtures";
import { ADMIN_EMAIL, addTestDocAuthor, getUserIdentityFields } from "./db";

// Light enough that onAuthorColor picks black text: white on it would be the
// failure this file exists to catch.
const LIGHT_FILL = "#f5e663";
const LIGHT_FILL_RGB = "rgb(245, 230, 99)";
const BLACK = "rgb(0, 0, 0)";

function caret(page: Page): Locator {
  return bodyEditor(page).getByTestId("collab-caret");
}

/**
 * Puts the caret on a second line, so its flag sits over the first line
 * inside the editor rather than above the editor's top edge, where the
 * scroll container could clip it out from under a hover.
 */
async function parkCaretOnSecondLine(page: Page): Promise<void> {
  await bodyEditor(page).click();
  await page.keyboard.type("A first line to hang the flag over.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("And the caret");
}

/** Everything that decides where the box is drawn and how big. */
function boxOf(locator: Locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      top: r.top,
      left: r.left,
      height: r.height,
      fontSize: s.fontSize,
      padding: s.padding,
      borderRadius: s.borderRadius,
    };
  });
}

test.describe("collaborator carets", () => {
  test("a collaborator's caret flies their initials, and hovering the flag shows their name in the same box", async ({
    page,
    draftDoc,
    secondUser,
  }) => {
    const { user: other, page: otherPage } = await secondUser({ color: LIGHT_FILL, adminInitials: "QZ" });
    // draftDoc is PRIVATE and bylined to the shared admin alone.
    await addTestDocAuthor(draftDoc.id, other.email);

    await page.goto(`/doc/${draftDoc.id}/edit`);
    await otherPage.goto(`/doc/${draftDoc.id}/edit`);
    await waitForDocCollabReady(page);
    await waitForDocCollabReady(otherPage);
    await parkCaretOnSecondLine(otherPage);

    const remote = caret(page);
    const flag = remote.getByText("QZ", { exact: true });
    const label = remote.getByText(other.name, { exact: true });
    await expect(flag).toBeVisible();
    await expect(label).toBeHidden();

    await expect(flag).toHaveCSS("background-color", LIGHT_FILL_RGB);
    await expect(label).toHaveCSS("background-color", LIGHT_FILL_RGB);
    await expect(flag).toHaveCSS("color", BLACK);
    await expect(label).toHaveCSS("color", BLACK);
    expect(await boxOf(label)).toEqual(await boxOf(flag));

    // The bar is 2px wide; the flag is the target a reader can actually hit.
    await flag.hover();
    await expect(label).toBeVisible();
    await expect(label).toHaveCSS("opacity", "1");
    await expect(flag).toHaveCSS("opacity", "0");

    // And it stays shown. A flag hidden with `visibility` drops out of
    // hit-testing, which ends the hover it just started — so sample every
    // frame for half a second rather than trusting one look.
    const seen = await label.evaluate(
      (el) =>
        new Promise<string[]>((resolve) => {
          const states: string[] = [];
          const end = performance.now() + 500;
          const tick = () => {
            states.push(getComputedStyle(el).visibility);
            if (performance.now() < end) requestAnimationFrame(tick);
            else resolve(states);
          };
          tick();
        }),
    );
    expect(new Set(seen)).toEqual(new Set(["visible"]));
  });

  test("the viewer's own caret from another tab carries no flag", async ({ page, draftDoc }) => {
    const me = await getUserIdentityFields(ADMIN_EMAIL);
    expect(me?.name).toBeTruthy();

    // Same cookie jar, so the same user — but a second Y.Doc client, which
    // y-prosemirror draws like anyone else's.
    const otherTab = await page.context().newPage();
    try {
      await page.goto(`/doc/${draftDoc.id}/edit`);
      await otherTab.goto(`/doc/${draftDoc.id}/edit`);
      await waitForDocCollabReady(page);
      await waitForDocCollabReady(otherTab);
      await parkCaretOnSecondLine(otherTab);

      const mine = caret(page);
      // The positive control: the caret is drawn, name label and all, so the
      // missing flag is a decision and not a caret that never arrived.
      await expect(mine.getByText(me!.name!, { exact: true })).toBeAttached();
      await expect(mine.getByText(me!.adminInitials, { exact: true })).toHaveCount(0);
    } finally {
      await otherTab.close();
    }
  });
});
