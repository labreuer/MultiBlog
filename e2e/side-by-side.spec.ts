// PLAN.md §14 — the side-by-side doc-link surface. This spec covers what
// nothing else does: two docs rendered in parallel columns at
// /side-by-side/<left>/<right>. Grows phase by phase alongside §14l's build
// order; Phase 2 covers just the page shell (both columns read-only, laid
// out side by side, independently identifiable) and the left===right 404.
import type { Page } from "@playwright/test";
import { test, expect, waitForDocCollabReady, bodyEditor } from "./fixtures";
import {
  ADMIN_EMAIL,
  createTestDoc,
  deleteTestDoc,
  createTestDocLink,
  deleteTestDocLinkGroup,
  countDocLinks,
  getDocLinkGroupIds,
  getDocLinkFields,
} from "./db";

/**
 * Selects an exact substring in a contenteditable identified by aria-label,
 * without deleting it — the read-mode column's doc-link-creation trigger
 * (LiveDocBody's onSelectionUpdate). Same recipe as fixtures.ts's own
 * selectTextInBody, generalized over the label since this page's two
 * columns don't share the default "Post body" name (§14f).
 */
async function selectTextByAriaLabel(page: Page, ariaLabel: string, needle: string): Promise<void> {
  await page.evaluate(
    ({ ariaLabel, text }) => {
      const root = document.querySelector(`[aria-label="${ariaLabel}"]`);
      if (!root) throw new Error(`Editor with aria-label "${ariaLabel}" not found.`);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const index = node.textContent?.indexOf(text) ?? -1;
        if (index === -1) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        const selection = window.getSelection();
        if (!selection) throw new Error("No selection available.");
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        return;
      }
      throw new Error(`"${text}" not found in the "${ariaLabel}" editor.`);
    },
    { ariaLabel, text: needle },
  );
}

test.describe("side-by-side page shell", () => {
  test("both docs render as independent, side-by-side columns", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Left doc body text." });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Right doc body text." });

    try {
      const response = await page.goto(`/side-by-side/${left.id}/${right.id}`);
      expect(response?.status()).toBe(200);

      await expect(page.getByText(left.title)).toBeVisible();
      await expect(page.getByText(right.title)).toBeVisible();

      // Distinct accessible names — the whole point of §14f's ariaLabel prop,
      // and what keeps this page from breaking bodyEditor()'s strict-mode
      // locator elsewhere in the suite.
      const leftBody = page.getByRole("textbox", { name: "Left doc body" });
      const rightBody = page.getByRole("textbox", { name: "Right doc body" });
      await expect(leftBody).toBeVisible();
      await expect(rightBody).toBeVisible();
      await expect(leftBody).toContainText("Left doc body text.");
      await expect(rightBody).toContainText("Right doc body text.");

      // Side by side, not stacked: same row, left column left of right.
      const leftBox = await page.locator('[data-side="left"]').boundingBox();
      const rightBox = await page.locator('[data-side="right"]').boundingBox();
      expect(leftBox).not.toBeNull();
      expect(rightBox).not.toBeNull();
      expect(leftBox!.x).toBeLessThan(rightBox!.x);
      expect(Math.abs(leftBox!.y - rightBox!.y)).toBeLessThan(5);
      expect(leftBox!.height).toBeGreaterThan(0);
      expect(rightBox!.height).toBeGreaterThan(0);
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("the same doc on both sides 404s", async ({ page }) => {
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    try {
      const response = await page.goto(`/side-by-side/${doc.id}/${doc.id}`);
      expect(response?.status()).toBe(404);
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(doc.id);
    }
  });
});

// PLAN.md §14g/§14l Phase 3 — the per-column read/write toggle, exercised
// with two identities so it also proves the hoisted provider is the same
// one a live collaborator sees through, not a private copy.
test.describe("side-by-side read/write toggle", () => {
  test("toggling a column to write, typing, and toggling back leaves content correct for both identities", async ({
    page,
    secondUser,
  }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Left starting text." });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Right starting text." });
    const { page: otherPage } = await secondUser();

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      await otherPage.goto(`/side-by-side/${left.id}/${right.id}`);

      const leftColumn = page.locator('[data-side="left"]');
      const leftBody = page.getByRole("textbox", { name: "Left doc body" });
      const otherLeftBody = otherPage.getByRole("textbox", { name: "Left doc body" });

      await expect(leftBody).toContainText("Left starting text.");

      // Toggle to write and type.
      await leftColumn.getByRole("button", { name: "Edit" }).click();
      await expect(leftColumn.locator("p", { hasText: "🟢 Live" })).toBeVisible({ timeout: 30_000 });
      await leftBody.click();
      await page.keyboard.press("End");
      await page.keyboard.type(" Edited live.");

      // The second identity, still in read mode, sees it through the same
      // provider — not a copy this column happens to hold privately.
      await expect(otherLeftBody).toContainText("Edited live.");

      // Toggle back to read — the hoisted-mode ydoc.off fix (§14g) is what
      // keeps this from leaking a setContent-on-a-destroyed-editor listener
      // on the next toggle.
      await leftColumn.getByRole("button", { name: "Doc Links" }).click();
      await expect(leftBody).toContainText("Left starting text. Edited live.");
      // Not duplicated — exactly one occurrence of the edited text.
      const bodyText = (await leftBody.textContent()) ?? "";
      expect(bodyText.match(/Edited live\./g)?.length ?? 0).toBe(1);

      // Toggle to write a second time and edit again — proves the previous
      // toggle didn't leave a stale listener that would double-apply this
      // update or throw against a torn-down editor.
      await leftColumn.getByRole("button", { name: "Edit" }).click();
      await expect(leftColumn.locator("p", { hasText: "🟢 Live" })).toBeVisible({ timeout: 30_000 });
      await leftBody.click();
      await page.keyboard.press("End");
      await page.keyboard.type(" And again.");
      await leftColumn.getByRole("button", { name: "Doc Links" }).click();
      await expect(leftBody).toContainText("Left starting text. Edited live. And again.");

      const finalText = (await leftBody.textContent()) ?? "";
      expect(finalText.match(/And again\./g)?.length ?? 0).toBe(1);

      // The right column was never touched — confirms the toggle is
      // per-column, not page-wide.
      await expect(page.getByRole("textbox", { name: "Right doc body" })).toContainText("Right starting text.");
    } finally {
      await page.goto("about:blank").catch(() => {});
      await otherPage.goto("about:blank").catch(() => {});
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });
});

// PLAN.md §14e/§14l Phase 4 — the decoration layer on the read path. Doc
// links are seeded directly via createTestDocLink (no UI to create one yet
// — that's Phase 5), and the assertions read the DOM's data-doc-link-ids/
// data-doc-link-group-ids attributes the plugin sets, not visible text,
// since a decoration's own text is identical to the surrounding prose.
test.describe("side-by-side doc-link highlights", () => {
  const BODY = "The quick brown fox jumps over the lazy dog.";

  test("a doc link highlights its anchored text, and overlapping links share one segment", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });

    // "quick brown" (chars 4-15) and "brown fox" (chars 10-19) overlap on
    // "brown" — two different groups, since overlap is a per-link-range
    // concern, not a per-group one.
    const linkA = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: BODY, quotedText: "quick brown" });
    const linkB = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: BODY, quotedText: "brown fox" });

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);

      const leftBody = page.getByRole("textbox", { name: "Left doc body" });
      await expect(leftBody).toContainText(BODY);

      // Each link's own (non-overlapping) portion carries just its own id.
      await expect(page.locator(`[data-doc-link-ids~="${linkA.id}"]`).first()).toBeVisible();
      await expect(page.locator(`[data-doc-link-ids~="${linkB.id}"]`).first()).toBeVisible();

      // The overlapping "brown" portion is its own segment, carrying both —
      // proof buildSegments split the ranges instead of one decoration
      // silently winning ProseMirror's merge.
      const overlap = page.locator(`[data-doc-link-ids~="${linkA.id}"][data-doc-link-ids~="${linkB.id}"]`);
      await expect(overlap.first()).toBeVisible();
      await expect(overlap.first()).toHaveText("brown");
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDocLinkGroup(linkA.groupId);
      await deleteTestDocLinkGroup(linkB.groupId);
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("a highlight survives a remote edit and re-finds after a shift", async ({ page, secondUser }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const link = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: BODY, quotedText: "brown fox jumps" });
    const { page: editorPage } = await secondUser();

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      const highlight = page.locator(`[data-doc-link-ids~="${link.id}"]`);
      await expect(highlight.first()).toBeVisible();

      // A genuinely remote edit — a different identity, editing through the
      // ordinary single-doc editor, not this page — inserts text *before*
      // the linked phrase, shifting every position after it. The stored
      // offsets no longer point at "brown fox jumps"; only a text re-search
      // (§14d step 2) finds it again.
      await editorPage.goto(`/doc/${left.id}/edit`);
      await waitForDocCollabReady(editorPage);
      await bodyEditor(editorPage).click();
      await editorPage.keyboard.press("Home");
      await editorPage.keyboard.type("Prefix inserted before the quote. ");

      const leftBody = page.getByRole("textbox", { name: "Left doc body" });
      await expect(leftBody).toContainText("Prefix inserted before the quote.", { timeout: 15_000 });
      await expect(highlight.first()).toBeVisible();
      await expect(highlight.first()).toHaveText("brown fox jumps");
    } finally {
      await page.goto("about:blank").catch(() => {});
      await editorPage.goto("about:blank").catch(() => {});
      await deleteTestDocLinkGroup(link.groupId);
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });
});

// PLAN.md §14i/§14l Phase 5 — creating a doc link through the UI. No group
// bar yet (that's Phase 6), so every save here creates a brand-new group;
// the count assertion is a direct DB read rather than a "← 1  1 →" UI
// string, which Phase 6 is what actually builds.
test.describe("side-by-side doc-link creation", () => {
  test("selecting text in each column and saving creates one doc link per doc", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "The quick brown fox." });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "A lazy dog sleeps." });

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      await expect(page.getByRole("textbox", { name: "Left doc body" })).toContainText("brown fox");
      await expect(page.getByRole("textbox", { name: "Right doc body" })).toContainText("lazy dog");

      await selectTextByAriaLabel(page, "Left doc body", "brown fox");
      const leftPopup = page.getByTestId("doc-link-popup");
      await expect(leftPopup).toBeVisible();
      await expect(leftPopup).toContainText("A new doc link group will be created.");
      await leftPopup.getByRole("button", { name: "Save" }).click();
      await expect(leftPopup).not.toBeVisible();
      await expect(page.locator("[data-doc-link-ids]").first()).toContainText("brown fox");

      await selectTextByAriaLabel(page, "Right doc body", "lazy dog");
      const rightPopup = page.getByTestId("doc-link-popup");
      await expect(rightPopup).toBeVisible();
      await rightPopup.getByRole("button", { name: "Save" }).click();
      await expect(rightPopup).not.toBeVisible();

      await expect.poll(() => countDocLinks(left.id)).toBe(1);
      await expect.poll(() => countDocLinks(right.id)).toBe(1);
    } finally {
      const groupIds = [...(await getDocLinkGroupIds(left.id)), ...(await getDocLinkGroupIds(right.id))];
      await page.goto("about:blank").catch(() => {});
      for (const groupId of groupIds) {
        await deleteTestDocLinkGroup(groupId);
      }
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });
});

// PLAN.md §14h/§14l Phase 6 — the group bar in full.
test.describe("side-by-side group bar", () => {
  const LEFT_BODY = "The quick brown fox.";
  const RIGHT_BODY = "A lazy dog sleeps.";

  test("dropdown prefixes, the first-entry swap, and the panel", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: LEFT_BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: RIGHT_BODY });

    // A two-sided group (↔) and a left-only group (←).
    const bothSides = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: LEFT_BODY, quotedText: "brown fox" });
    await createTestDocLink({
      docId: right.id,
      authorEmail: ADMIN_EMAIL,
      bodyText: RIGHT_BODY,
      quotedText: "lazy dog",
      groupId: bothSides.groupId,
    });
    const leftOnly = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: LEFT_BODY, quotedText: "quick brown" });

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      const select = page.getByRole("combobox", { name: "Doc link groups" });
      await expect(select).toBeVisible();

      // Neutral first entry, and both groups present with the right prefix.
      await expect(select.locator("option").first()).toHaveText("Doc Link Groups");
      const options = await select.locator("option").allTextContents();
      expect(options.some((o) => o.startsWith("↔ "))).toBe(true);
      expect(options.some((o) => o.startsWith("← "))).toBe(true);
      expect(options).toContain("New Doc Link Group");

      // Selecting a group swaps the first entry's label and opens the panel.
      await select.selectOption(bothSides.groupId);
      await expect(select.locator("option").first()).toHaveText("Hide all Groups");
      const panel = page.getByTestId("doc-link-group-panel");
      await expect(panel).toBeVisible();

      // The count line sums across both groups: 2 links land in the left
      // doc (one from each group), 1 in the right (bothSides only).
      await expect(page.locator("text=/←\\s*2\\s*1\\s*→/")).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDocLinkGroup(bothSides.groupId);
      await deleteTestDocLinkGroup(leftOnly.groupId);
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("switching the dropdown to a different group updates the panel's fields, not just its visibility", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: LEFT_BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    // createTestDocLink names each new group after its quotedText, so these
    // two groups start with distinct, known names ("brown fox" / "quick
    // brown") to tell apart in the panel.
    const groupA = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: LEFT_BODY, quotedText: "brown fox" });
    const groupB = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: LEFT_BODY, quotedText: "quick brown" });

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      const select = page.getByRole("combobox", { name: "Doc link groups" });
      const panel = page.getByTestId("doc-link-group-panel");
      const nameInput = panel.getByPlaceholder("Group name");

      await select.selectOption(groupA.groupId);
      await expect(nameInput).toHaveValue("brown fox");

      // Regression: without a `key` on <DocLinkGroupPanel>, React reuses
      // the same component instance across groups (same JSX position), so
      // its name/text/overrideColor state — only ever initialized once,
      // from the initial* props — kept showing group A's fields here.
      await select.selectOption(groupB.groupId);
      await expect(nameInput).toHaveValue("quick brown");

      await select.selectOption(groupA.groupId);
      await expect(nameInput).toHaveValue("brown fox");
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDocLinkGroup(groupA.groupId);
      await deleteTestDocLinkGroup(groupB.groupId);
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("unchecking Display? hides the group's highlight; selecting darkens it", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: LEFT_BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const link = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: LEFT_BODY, quotedText: "brown fox" });

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      const highlight = page.locator(`[data-doc-link-ids~="${link.id}"]`);
      await expect(highlight.first()).toBeVisible();

      const select = page.getByRole("combobox", { name: "Doc link groups" });
      await select.selectOption(link.groupId);
      await expect(highlight.first()).toHaveClass(/doc-link-active/);

      const displayCheckbox = page.getByTestId("doc-link-group-panel").getByLabel("Display?");
      await displayCheckbox.uncheck();
      await expect(page.locator(`[data-doc-link-ids~="${link.id}"]`)).toHaveCount(0);

      await displayCheckbox.check();
      await expect(highlight.first()).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDocLinkGroup(link.groupId);
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("selecting a hidden group from the dropdown re-checks Display?", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: LEFT_BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const link = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: LEFT_BODY, quotedText: "brown fox" });

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      const highlight = page.locator(`[data-doc-link-ids~="${link.id}"]`);
      const select = page.getByRole("combobox", { name: "Doc link groups" });
      const displayCheckbox = page.getByTestId("doc-link-group-panel").getByLabel("Display?");

      await select.selectOption(link.groupId);
      await displayCheckbox.uncheck();
      await expect(highlight).toHaveCount(0);

      // Deselect (closes the panel) without touching Display?, then pick the
      // same group again from the dropdown. Regression: previously,
      // hiddenGroupIds only ever changed via the checkbox itself, so
      // re-selecting a hidden group opened its panel and highlighted it in
      // the bar while its segments stayed dark — reading as broken rather
      // than "you already hid this."
      await select.selectOption("__none__");
      await select.selectOption(link.groupId);

      await expect(displayCheckbox).toBeChecked();
      await expect(highlight.first()).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDocLinkGroup(link.groupId);
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("editing the panel's name debounce-saves, and deleting the group soft-deletes its links", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: LEFT_BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const link = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: LEFT_BODY, quotedText: "brown fox" });
    let groupDeleted = false;

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      const select = page.getByRole("combobox", { name: "Doc link groups" });
      await select.selectOption(link.groupId);

      const panel = page.getByTestId("doc-link-group-panel");
      const nameInput = panel.getByPlaceholder("Group name");
      await nameInput.fill("Renamed group");
      await expect(panel.getByText("Saved")).toBeVisible({ timeout: 5_000 });

      await panel.getByRole("button", { name: "Delete" }).click();
      groupDeleted = true;
      await expect(panel).not.toBeVisible();
      await expect.poll(() => countDocLinks(left.id)).toBe(0);
    } finally {
      await page.goto("about:blank").catch(() => {});
      if (!groupDeleted) await deleteTestDocLinkGroup(link.groupId);
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("the group panel's override checkbox previews live and only nulls the color, not the swatch, when unchecked", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: LEFT_BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const link = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: LEFT_BODY, quotedText: "brown fox" });

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      const select = page.getByRole("combobox", { name: "Doc link groups" });
      await select.selectOption(link.groupId);

      const panel = page.getByTestId("doc-link-group-panel");
      const checkbox = panel.getByRole("checkbox", { name: "Override color" });
      const colorInput = panel.locator('input[type="color"]');
      const highlight = page.locator(`[data-doc-link-ids~="${link.id}"]`).first();

      await expect(checkbox).not.toBeChecked();

      // Picking a color checks the box and repaints the highlight
      // immediately, ahead of the debounced save.
      await colorInput.fill("#445566");
      await expect(checkbox).toBeChecked();
      await expect(highlight).toHaveAttribute("style", /--doc-link-color: ?#445566/);

      // Unchecking clears the group's override (persisted as null once the
      // debounce fires) but leaves the swatch on #445566.
      await checkbox.uncheck();
      await expect(colorInput).toHaveValue("#445566");
      await expect(highlight).not.toHaveAttribute("style", /--doc-link-color: ?#445566/);
      await expect(panel.getByText("Saved")).toBeVisible({ timeout: 5_000 });
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDocLinkGroup(link.groupId);
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("New Doc Link Group creates a group on first save, with no links yet", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: LEFT_BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    let createdGroupId: string | null = null;

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      const select = page.getByRole("combobox", { name: "Doc link groups" });
      await select.selectOption({ label: "New Doc Link Group" });

      const panel = page.getByTestId("doc-link-group-panel");
      await panel.getByPlaceholder("Group name").fill("Fresh group");
      await expect(panel.getByText("Saved")).toBeVisible({ timeout: 5_000 });

      // Now present in the dropdown, proving the row was actually written.
      await expect(select.locator("option", { hasText: "Fresh group" })).toHaveCount(1);
      const optionValue = await select.locator("option", { hasText: "Fresh group" }).getAttribute("value");
      createdGroupId = optionValue;
    } finally {
      await page.goto("about:blank").catch(() => {});
      if (createdGroupId) await deleteTestDocLinkGroup(createdGroupId);
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("New Doc Link Group saves with a null name, and becomes active so the next selection joins it instead of making a second group", async ({
    page,
  }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: LEFT_BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: RIGHT_BODY });
    let createdGroupId: string | null = null;

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      // Wait for the live tap to connect before touching either body — the
      // aria-labelled textbox doesn't exist yet while the pre-connection
      // static fallback is still showing (§14g).
      await expect(page.getByRole("textbox", { name: "Left doc body" })).toContainText(LEFT_BODY);
      const select = page.getByRole("combobox", { name: "Doc link groups" });

      // Open the panel and save with both name and description left blank —
      // doc_link_group.name/text are nullable columns, so a group with
      // neither set is a legitimate row, not an error state. Typing
      // triggers the usual debounced autosave; with nothing typed, the
      // panel's explicit Save button is the only way to create it.
      await select.selectOption({ label: "New Doc Link Group" });
      const panel = page.getByTestId("doc-link-group-panel");
      await panel.getByRole("button", { name: "Save" }).click();
      await expect(panel.getByText("Saved")).toBeVisible({ timeout: 5_000 });
      createdGroupId = await select.locator("option", { hasText: "(untitled)" }).getAttribute("value");
      expect(createdGroupId).not.toBeNull();

      // §14l's own dropdown swap already proves a group is active; the
      // popover's group note is what proves *creating a link* now joins it
      // rather than spinning up a second group (§14i).
      await selectTextByAriaLabel(page, "Left doc body", "brown fox");
      const popup = page.getByTestId("doc-link-popup");
      await expect(popup).toBeVisible();
      await expect(popup).toContainText("Added to the selected group.");
      await popup.getByRole("button", { name: "Save" }).click();
      await expect(popup).not.toBeVisible();

      await expect.poll(() => countDocLinks(left.id)).toBe(1);
      await expect.poll(() => getDocLinkGroupIds(left.id)).toEqual([createdGroupId]);

      // Still exactly one group in the dropdown — the link didn't spawn a
      // second one.
      await expect(select.locator("option")).toHaveCount(
        // "Doc Link Groups"/"Hide all Groups" + the one real group + "New Doc Link Group"
        3,
      );
    } finally {
      await page.goto("about:blank").catch(() => {});
      if (createdGroupId) await deleteTestDocLinkGroup(createdGroupId);
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("creating a doc link while 'New Doc Link Group' is selected but not yet saved succeeds", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: LEFT_BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    let groupIds: string[] = [];

    try {
      // 1. Open a side-by-side pair.
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      await expect(page.getByRole("textbox", { name: "Left doc body" })).toContainText(LEFT_BODY);

      // 2. Select "New Doc Link Group" — its panel opens, unsaved (no real
      // group id exists yet, only the NEW_GROUP sentinel is "active").
      const select = page.getByRole("combobox", { name: "Doc link groups" });
      await select.selectOption({ label: "New Doc Link Group" });
      await expect(page.getByTestId("doc-link-group-panel")).toBeVisible();

      // 3. Without saving that draft, try to create a doc link.
      await selectTextByAriaLabel(page, "Left doc body", "brown fox");
      const popup = page.getByTestId("doc-link-popup");
      await expect(popup).toBeVisible();
      await popup.getByRole("button", { name: "Save" }).click();

      // The popup should close on success — if it's still open, Save
      // failed (e.g. the NEW_GROUP sentinel "__new__" got sent to the
      // server as a real groupId and createDocLink rejected it with
      // "Group not found").
      await expect(popup).not.toBeVisible({ timeout: 5_000 });
      await expect(popup.locator("text=Group not found")).toHaveCount(0);

      await expect.poll(() => countDocLinks(left.id)).toBe(1);
      groupIds = await getDocLinkGroupIds(left.id);
      expect(groupIds).toHaveLength(1);

      // The dropdown follows the group that was actually created, rather
      // than staying on "New Doc Link Group" with a stale empty draft panel
      // open beside a group it has nothing to do with (§14i).
      await expect(select).toHaveValue(groupIds[0]);
      await expect(select.locator("option").first()).toHaveText("Hide all Groups");
    } finally {
      await page.goto("about:blank").catch(() => {});
      for (const groupId of groupIds) {
        await deleteTestDocLinkGroup(groupId);
      }
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });
});

// PLAN.md §14j/§14l Phase 7 — clicking a marked range.
test.describe("side-by-side click routing", () => {
  const BODY = "The quick brown fox.";

  test("clicking a single link opens its edit popover, and Save persists the note", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const link = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: BODY, quotedText: "brown fox" });

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      const highlight = page.locator(`[data-doc-link-ids~="${link.id}"]`).first();
      await expect(highlight).toBeVisible();

      await highlight.click();
      const popup = page.getByTestId("doc-link-popup");
      await expect(popup).toBeVisible();
      await expect(popup).toContainText("Editing link over");
      // Delete only appears in edit mode, never in the create-a-new-link
      // popover — confirms this really is the edit path, not a second
      // creation triggered by the click falling through to a selection.
      await expect(popup.getByRole("button", { name: "Delete" })).toBeVisible();

      await popup.getByPlaceholder("Optional note").fill("A note about this link.");
      await popup.getByRole("button", { name: "Save" }).click();
      await expect(popup).not.toBeVisible();

      await expect.poll(async () => (await getDocLinkFields(link.id))?.text).toBe("A note about this link.");
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDocLinkGroup(link.groupId);
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("clicking a different link while the edit popover is already open refreshes its override checkbox and color", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const linkA = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: BODY, quotedText: "quick brown", overrideColor: "#6b70ff" });
    const linkB = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: BODY, quotedText: "fox" });

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      const popup = page.getByTestId("doc-link-popup");
      const checkbox = popup.getByRole("checkbox", { name: "Override color" });
      const colorInput = popup.locator('input[type="color"]');

      await page.locator(`[data-doc-link-ids~="${linkA.id}"]`).first().click();
      await expect(checkbox).toBeChecked();
      await expect(colorInput).toHaveValue("#6b70ff");

      // Regression: without a `key` on the editing-mode <DocLinkPopover>,
      // React reuses the same instance across links (same JSX position), so
      // its overrideChecked/colorValue state — only ever initialized once,
      // from the initial* props — kept showing linkA's override here, even
      // though the quoted-text preview (read straight from props) updated
      // correctly.
      await page.locator(`[data-doc-link-ids~="${linkB.id}"]`).first().click();
      await expect(popup).toContainText("“fox”");
      await expect(checkbox).not.toBeChecked();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDocLinkGroup(linkA.groupId);
      await deleteTestDocLinkGroup(linkB.groupId);
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("the edit popover's override checkbox previews live and only nulls the color, not the swatch, when unchecked", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const link = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: BODY, quotedText: "brown fox" });

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      const highlight = page.locator(`[data-doc-link-ids~="${link.id}"]`).first();
      await highlight.click();

      const popup = page.getByTestId("doc-link-popup");
      const checkbox = popup.getByRole("checkbox", { name: "Override color" });
      const colorInput = popup.locator('input[type="color"]');

      // No override yet — unchecked.
      await expect(checkbox).not.toBeChecked();

      // Picking a color checks the box and repaints the highlight
      // immediately, before Save is ever clicked.
      await colorInput.fill("#112233");
      await expect(checkbox).toBeChecked();
      await expect(highlight).toHaveAttribute("style", /--doc-link-color: ?#112233/);

      // Unchecking clears the override (persisted as null on Save) but
      // leaves the swatch showing #112233 rather than resetting it.
      await checkbox.uncheck();
      await expect(colorInput).toHaveValue("#112233");
      await expect(highlight).not.toHaveAttribute("style", /--doc-link-color: ?#112233/);

      await popup.getByRole("button", { name: "Save" }).click();
      await expect(popup).not.toBeVisible();
      await expect.poll(async () => (await getDocLinkFields(link.id))?.overrideColor).toBeNull();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDocLinkGroup(link.groupId);
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("clicking overlapping links opens a chooser; picking one opens its own popover", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const linkA = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: BODY, quotedText: "quick brown" });
    const linkB = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: BODY, quotedText: "brown fox" });

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      // The "brown" segment is covered by both links (no active group, so
      // the chooser offers all hits).
      const overlap = page.locator(`[data-doc-link-ids~="${linkA.id}"][data-doc-link-ids~="${linkB.id}"]`).first();
      await expect(overlap).toBeVisible();
      await overlap.click();

      const chooser = page.getByTestId("doc-link-chooser");
      await expect(chooser).toBeVisible();
      await expect(chooser.locator("button", { hasText: "quick brown" })).toBeVisible();
      await expect(chooser.locator("button", { hasText: "brown fox" })).toBeVisible();

      await chooser.locator("button", { hasText: "quick brown" }).click();
      await expect(chooser).not.toBeVisible();
      const popup = page.getByTestId("doc-link-popup");
      await expect(popup).toBeVisible();
      await expect(popup).toContainText("quick brown");
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDocLinkGroup(linkA.groupId);
      await deleteTestDocLinkGroup(linkB.groupId);
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("Delete in the edit popover removes the link and its highlight", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: BODY });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const link = await createTestDocLink({ docId: left.id, authorEmail: ADMIN_EMAIL, bodyText: BODY, quotedText: "brown fox" });

    try {
      await page.goto(`/side-by-side/${left.id}/${right.id}`);
      const highlight = page.locator(`[data-doc-link-ids~="${link.id}"]`).first();
      await expect(highlight).toBeVisible();
      await highlight.click();

      const popup = page.getByTestId("doc-link-popup");
      await popup.getByRole("button", { name: "Delete" }).click();
      await expect(popup).not.toBeVisible();
      await expect(page.locator(`[data-doc-link-ids~="${link.id}"]`)).toHaveCount(0);
      await expect.poll(() => countDocLinks(left.id)).toBe(0);
    } finally {
      // deleteDocLink (the app action, called by the UI's Delete button)
      // soft-deletes the link but never its group — same shape as a group
      // delete, §14b — so this cleanup always has a group row to remove.
      await page.goto("about:blank").catch(() => {});
      await deleteTestDocLinkGroup(link.groupId);
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });
});

// PLAN.md §14k/§14l Phase 8 — the "Compare with…" entry point.
test.describe("compare with entry point", () => {
  test("picking another doc from /doc/[slug] navigates to the side-by-side pair", async ({ page }) => {
    const left = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Left doc." });
    const right = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Right doc." });

    try {
      await page.goto(`/doc/${left.id}`);
      const picker = page.getByLabel("Compare with…");
      await expect(picker).toBeVisible();
      // The doc itself is never offered as its own comparison partner.
      await expect(picker.locator("option", { hasText: left.title })).toHaveCount(0);
      await expect(picker.locator("option", { hasText: right.title })).toHaveCount(1);

      await picker.selectOption(right.id);
      await page.waitForURL(`**/side-by-side/${left.id}/${right.id}`);
      await expect(page.getByRole("textbox", { name: "Left doc body" })).toContainText("Left doc.");
      await expect(page.getByRole("textbox", { name: "Right doc body" })).toContainText("Right doc.");
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(left.id);
      await deleteTestDoc(right.id);
    }
  });

  test("a PRIVATE doc is never offered to a lower-privilege reader who isn't its author", async ({ secondUser }) => {
    const visible = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Visible doc." });
    // A second SHARED doc, so the picker has something to offer at all —
    // otherwise CompareWithPicker renders nothing (§14k) and the "not
    // offered" assertion below would trivially pass for the wrong reason.
    const otherVisible = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Other visible doc." });
    const privateDoc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "PRIVATE", bodyText: "Private doc." });
    // AUTHORIZED (§12e) can read SHARED docs (canViewDocs) but manages none
    // (canManageDocs is false), so readableDocsFor's PRIVATE branch — which
    // requires both canManageDocs *and* byline authorship — excludes this
    // doc regardless of who authored it.
    const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });

    try {
      await readerPage.goto(`/doc/${visible.id}`);
      const picker = readerPage.getByLabel("Compare with…");
      await expect(picker).toBeVisible();
      await expect(picker.locator(`option[value="${otherVisible.id}"]`)).toHaveCount(1);
      await expect(picker.locator(`option[value="${privateDoc.id}"]`)).toHaveCount(0);
    } finally {
      await readerPage.goto("about:blank").catch(() => {});
      await deleteTestDoc(privateDoc.id);
      await deleteTestDoc(otherVisible.id);
      await deleteTestDoc(visible.id);
    }
  });
});
