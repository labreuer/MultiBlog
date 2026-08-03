// PLAN.md §16 — the shared admin-table kit: filters/sort/pagination in the
// URL, and the row-status left border that replaced the saved-row pulse.
//
// /users is the subject for both because it's the one table with inline-edit
// cells, so it exercises the full idle → edited → saving → saved path that
// §16f describes; the URL assertions hold for every table on the kit.
import { test, expect } from "./fixtures";
import { createTestUser, deleteTestUser, uniqueEmail } from "./db";

// The four border colors from AdminTable.module.css, as the browser reports
// them. Asserting the computed color (rather than a class name) is what makes
// this a test of what an admin actually sees.
const IDLE = "rgba(0, 0, 0, 0)";
const EDITED = "rgb(153, 153, 153)";
const SAVED = "rgb(0, 170, 85)";

test.describe("admin table kit", () => {
  test("a row's left border tracks idle → edited → saved", async ({ page }) => {
    const email = uniqueEmail("rowstatus");
    await createTestUser({ email, name: "Row Status", role: "AUTHOR" });

    try {
      // ?q= narrows to this worker's own user, so parallel workers can't make
      // the row ambiguous (same reason moderation.spec.ts deep-links ?post=).
      await page.goto(`/users?q=${encodeURIComponent(email)}`);

      const row = page.getByRole("row").filter({ hasText: email });
      await expect(row).toBeVisible();
      const firstCell = row.locator("td").first();
      const borderColor = () =>
        firstCell.evaluate((el) => getComputedStyle(el).borderLeftColor);

      // Every row reserves the 3px border, transparent, so nothing shifts
      // horizontally when a status appears.
      await expect(firstCell).toHaveCSS("border-left-width", "3px");
      expect(await borderColor()).toBe(IDLE);

      const nameInput = firstCell.getByRole("textbox");
      await nameInput.fill("Row Status Edited");
      expect(await borderColor()).toBe(EDITED);

      // Blur commits. "saving" (amber) is real but too brief to assert
      // without racing the server action, so this polls for the settled state.
      await nameInput.blur();
      await expect.poll(borderColor).toBe(SAVED);

      // …and the edit actually landed, rather than the border merely claiming
      // so. Scoped to the first cell: a user row carries three textboxes
      // (name, initials, color).
      await page.reload();
      const reloadedName = page
        .getByRole("row")
        .filter({ hasText: email })
        .locator("td")
        .first()
        .getByRole("textbox");
      await expect(reloadedName).toHaveValue("Row Status Edited");
    } finally {
      await deleteTestUser(email);
    }
  });

  test("search, sort and page size are mirrored into the querystring", async ({ page }) => {
    const email = uniqueEmail("urlstate");
    await createTestUser({ email, name: "Url State", role: "AUTHOR" });

    try {
      await page.goto("/users");
      // No params at all on a default view: the sort matches the default and
      // the page size matches this admin's own stored preference (§16b), so
      // neither is worth spending a querystring on.
      await expect(page).toHaveURL(/\/users$/);

      // Debounced 400ms, so the URL lands a beat after the last keystroke.
      await page.getByRole("searchbox", { name: "Search users" }).fill(email);
      await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(email).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

      await page.getByRole("columnheader", { name: "Email" }).click();
      await expect(page).toHaveURL(/sort=email%3Aasc/);
      // Clicking the same lone column again flips it rather than adding a key.
      await page.getByRole("columnheader", { name: "Email" }).click();
      await expect(page).toHaveURL(/sort=email%3Adesc/);

      await page.getByLabel("Rows per page").selectOption("10");
      await expect(page).toHaveURL(/pageSize=10/);
      // Changing a filter resets to page 1, so `page` never appears here.
      await expect(page).not.toHaveURL(/[?&]page=/);

      // A page size equal to the stored preference drops back out of the URL
      // instead of being pinned as a redundant param.
      await page.getByLabel("Rows per page").selectOption("25");
      await expect(page).not.toHaveURL(/pageSize=/);
    } finally {
      await deleteTestUser(email);
    }
  });

  test("every admin table paginates and keeps its controls when nothing matches", async ({ page }) => {
    for (const path of ["/posts", "/docs", "/users", "/comments", "/annotations"]) {
      // A search no row can match: the table must still render its header and
      // an empty-state row rather than collapsing to a bare paragraph, or the
      // filter that produced the empty result would be unreachable (§16d).
      await page.goto(`${path}?q=zzz-no-such-row-zzz`);
      await expect(page.getByRole("table").first()).toBeVisible();
      await expect(page.getByText(/no .* matching the criteria/i)).toBeVisible();
      await expect(page.getByLabel("Rows per page")).toBeVisible();
      // Exact names: a bare "Next" also matches Next.js's dev-tools button.
      await expect(page.getByRole("button", { name: "◀ Prev", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Next ▶", exact: true })).toBeDisabled();
    }
  });
});
