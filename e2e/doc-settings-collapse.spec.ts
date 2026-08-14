// The doc editor's Settings panel has to be closable again once it's open.
//
// It isn't, on a doc long enough to fill the editor: expanding <details>
// takes vertical space out of .editorFrame (flex: 1 1 auto), .editorContent
// refuses to go below its `min-height: 300px` floor, and the frame carries no
// `overflow: hidden` — deliberately, see EditorChrome.module.css's header —
// so the overflow paints *over* the siblings that follow it in the column.
// DocSettingsPanel is the last of those siblings, so the body text ends up on
// top of the very summary you'd click to collapse it. The click lands in the
// contenteditable instead: a caret blinks where the panel's header is drawn
// and the panel never closes.
//
// Asserted through elementFromPoint rather than a screenshot because this is
// a hit-testing failure, not a visual one — the summary is painted, visible,
// in the viewport, and `toBeVisible()` passes throughout. What's wrong is
// only which element receives the pointer. A plain `.click()` does catch it
// (Playwright times out on the intercepting element), but reports it as a
// generic timeout that reads like flake; the explicit hit-test probe is what
// makes a failure here self-explaining.
//
// Not Firefox-specific, despite being reported there — chromium fails this
// identically, so it lives in the default project rather than behind
// E2E_FIREFOX.
import { test, expect, waitForDocCollabReady } from "./fixtures";
import { createTestDoc, deleteTestDoc, ADMIN_EMAIL } from "./db";

// Long enough that .editorContent is already at its 300px floor before the
// panel opens — that's the precondition, so a shorter body wouldn't reproduce.
const LONG_BODY = "The quick brown fox jumps over the lazy dog. ".repeat(60);

/** What actually sits under the summary's own centre point. */
async function hitTestSummary(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const summary = [...document.querySelectorAll("summary")].find((s) => s.textContent?.trim() === "Settings");
    if (!summary) throw new Error("Settings summary not found");
    const r = summary.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      open: summary.closest("details")?.open ?? null,
      hitIsSummary: hit === summary || summary.contains(hit),
      hitTag: hit?.tagName ?? null,
      hitText: hit?.textContent?.trim().slice(0, 40) ?? null,
      hitIsContentEditable: (hit as HTMLElement | null)?.isContentEditable ?? null,
    };
  });
}

test("the Settings panel can be collapsed again on a doc long enough to fill the editor", async ({ page }) => {
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: LONG_BODY });

  try {
    await page.goto(`/doc/${doc.id}/edit`);
    await waitForDocCollabReady(page);

    const summary = page.getByRole("group").locator("summary", { hasText: "Settings" });
    await expect(summary).toBeVisible();

    // Closed, and clickable — the baseline the expanded state should match.
    expect(await hitTestSummary(page)).toMatchObject({ open: false, hitIsSummary: true });

    await summary.click();
    await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
    // onToggle scrolls the panel into view with behavior: "smooth"; let it land
    // before hit-testing, so a failure can't be blamed on a moving target.
    await page.waitForTimeout(1500);

    const expanded = await hitTestSummary(page);
    expect(expanded.open, "panel should be open after the first click").toBe(true);
    expect(
      expanded.hitIsSummary,
      `the Settings summary is covered by <${expanded.hitTag}> ("${expanded.hitText}"), ` +
        `contentEditable=${expanded.hitIsContentEditable} — a click there lands in the editor, not on the summary`,
    ).toBe(true);

    // The actual gesture from the bug report: click Settings again to collapse.
    await summary.click();
    await expect(page.getByRole("button", { name: "Delete" })).toBeHidden();
    expect((await hitTestSummary(page)).open, "panel should be collapsed again").toBe(false);
  } finally {
    await page.goto("about:blank").catch(() => {});
    await deleteTestDoc(doc.id);
  }
});
