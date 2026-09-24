// A renamed doc's old slug still reaches it (docs/DOCS.md "Routes"): the
// reading route falls back to doc_slug_history on a live-slug miss and
// redirects to the current slug, carrying ?sel= and ?at= across, and never
// discloses the new slug to a viewer the doc's own gate would turn away.
import { test, expect, visibleText } from "./fixtures";
import { ADMIN_EMAIL, createTestDoc, deleteTestDoc, renameTestDocSlug } from "./db";

test.describe("doc slug history (docs/DOCS.md \"Routes\")", () => {
  test("an old slug redirects to the current one, keeping ?sel= and ?at=", async ({ page }) => {
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Still here." });
    try {
      const newSlug = await renameTestDocSlug(doc.id);
      expect(newSlug).not.toBe(doc.slug);

      // The Location header itself, so the assertion is about what the route
      // answered rather than wherever the browser ended up.
      const response = await page.request.get(`/doc/${doc.slug}?sel=abc&at=1`, { maxRedirects: 0 });
      expect(response.status()).toBe(307);
      expect(response.headers()["location"]).toBe(`/doc/${newSlug}?sel=abc&at=1`);

      await page.goto(`/doc/${doc.slug}`);
      await expect(page).toHaveURL(new RegExp(`/doc/${newSlug}$`));
      await expect(visibleText(page, "Still here.")).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(doc.id);
    }
  });

  test("a viewer who can't read the doc gets Forbidden at the old slug, not the new one", async ({ secondUser }) => {
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "PRIVATE", bodyText: "Secret." });
    const { page: adminPage } = await secondUser({ role: "ADMIN" });
    try {
      const newSlug = await renameTestDocSlug(doc.id);

      const response = await adminPage.request.get(`/doc/${doc.slug}`, { maxRedirects: 0 });
      expect(response.status()).toBe(200);
      expect(await response.text()).not.toContain(newSlug);

      await adminPage.goto(`/doc/${doc.slug}`);
      await expect(adminPage).toHaveURL(new RegExp(`/doc/${doc.slug}$`));
      await expect(adminPage.getByRole("heading", { name: "Forbidden" })).toBeVisible();
    } finally {
      await adminPage.goto("about:blank").catch(() => {});
      await deleteTestDoc(doc.id);
    }
  });
});
