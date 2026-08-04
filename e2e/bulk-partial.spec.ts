// PLAN.md §16f/§16g — what a *partially* failed bulk action leaves on screen.
//
// This is reachable through ordinary use, not a contrived edge: the batched
// actions are Promise.all over per-id calls that each enforce their own
// authorization (§16k), so any selection mixing rows the caller may change
// with rows it may not produces exactly this. Selecting the signed-in admin's
// own row is the cheapest such mix — deleteUser refuses to delete your own
// account while deleting everything else in the batch, and Promise.all rejects
// only after the successful ones have already committed.
//
// The regression this guards is specific: onDone used to run only on success,
// so the rows that *had* saved kept showing their pre-action values beside a
// red border until someone reloaded, which made §16k's "a partial application
// is visible" untrue. It now runs either way, refreshing regardless and
// clearing the selection only when the action succeeded.
import { test, expect } from "./fixtures";
import { ADMIN_EMAIL, createTestUser, deleteTestUser, uniqueEmail } from "./db";

const ERROR = "rgb(204, 0, 0)";
const SAVED = "rgb(0, 170, 85)";

test.describe("bulk actions, partially failing", () => {
  test("the rows that did save refresh in place, and the selection stays armed", async ({ page }) => {
    const victim = uniqueEmail("partial");
    await createTestUser({ email: victim, name: "Partial Victim", role: "AUTHOR" });

    try {
      // ?deleted=1 so a row that really is deleted stays on screen to be
      // asserted against, rather than dropping out of the refetch.
      await page.goto("/users?deleted=1");
      const rowFor = (email: string) => page.getByRole("row").filter({ hasText: email });
      const borderOf = (email: string) =>
        rowFor(email)
          .locator("td")
          .first()
          .evaluate((el) => getComputedStyle(el).borderLeftColor);

      await expect(rowFor(victim)).toBeVisible();
      await expect(rowFor(ADMIN_EMAIL)).toBeVisible();
      // The victim starts live, which is what makes the Restore assertion
      // below mean "this delete landed" rather than "it was already deleted".
      await expect(rowFor(victim).getByRole("button", { name: "Delete user" })).toBeVisible();

      await rowFor(victim).getByRole("checkbox").check();
      await rowFor(ADMIN_EMAIL).getByRole("checkbox").check();
      await expect(page.getByText("2 selected")).toBeVisible();

      await page.getByRole("button", { name: "Delete selected users" }).click();

      // The failure is reported, and reported once — the border says *that*,
      // this says *what*.
      await expect(page.getByText(/can't delete your own account/i)).toBeVisible();

      // Each row reports its *own* outcome. This is the whole point of the
      // batched actions returning a BulkResult instead of throwing on the
      // first bad id: green means this row saved, and means it.
      await expect.poll(() => borderOf(victim)).toBe(SAVED);
      await expect.poll(() => borderOf(ADMIN_EMAIL)).toBe(ERROR);

      // ...and the failed row carries its own reason, which is the only place
      // a per-row explanation can live when one toolbar serves N rows.
      await expect(rowFor(ADMIN_EMAIL).locator("td").first()).toHaveAttribute(
        "title",
        /can't delete your own account/i,
      );
      // The row that saved has nothing to explain.
      await expect(rowFor(victim).locator("td").first()).not.toHaveAttribute("title", /./);

      // The point of the fix: the deletion that *did* land is on screen with
      // no reload, so the red border sits beside true data rather than stale
      // data. Restore replacing Delete is the row saying it is deleted now.
      await expect(rowFor(victim).getByRole("button", { name: "Restore user" })).toBeVisible();
      // ...and the admin's own row is untouched, since its delete was refused.
      await expect(rowFor(ADMIN_EMAIL).getByRole("button", { name: "Delete user" })).toBeVisible();

      // Selection survives a failure so the action is re-runnable without
      // re-picking rows — the half of onDone that success does *not* share.
      await expect(page.getByText("2 selected")).toBeVisible();
    } finally {
      await deleteTestUser(victim);
    }
  });
});
