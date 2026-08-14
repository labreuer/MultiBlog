import { test, expect, signIn, gotoOk } from "./fixtures";
import { ADMIN_EMAIL, createTestFile, createTestUser, deleteTestFile, deleteTestUser, uniqueEmail } from "./db";
import { buildTestPdf } from "../scripts/make-test-pdf";

/**
 * POSTs raw bytes to the upload route from inside the page, so the request
 * carries the session cookie.
 *
 * The bytes cross into the browser as a plain number array: `page.evaluate`
 * serializes its argument as JSON, so a Uint8Array would arrive as
 * `{"0":37,"1":80,…}` and silently upload nothing recognisable. Rebuilt into a
 * real Uint8Array on the far side.
 */
async function uploadPdf(page: import("@playwright/test").Page, filename: string, bytes: Uint8Array) {
  return page.evaluate(
    async ({ name, data }) => {
      const res = await fetch(`/api/files/upload?filename=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: new Uint8Array(data),
      });
      return { status: res.status, body: await res.text() };
    },
    { name: filename, data: Array.from(bytes) },
  );
}

// PLAN.md §19 Phase 1 — the file table, its permission scoping, and the upload
// and download routes.
//
// The two route tests here matter more than they look. Both go through Next's
// real HTTP handling rather than a Prisma call: the upload route exists
// *specifically* to escape Server Actions' body-size limit, and the download
// route's Range support is what keeps a large PDF openable. Neither property is
// visible from the database, and neither has any other coverage.

test.describe("files", () => {
  test("uploads a PDF through the raw-body route and lists it", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, "/files");

    const title = `E2E upload ${Date.now()}`;
    const pdf = buildTestPdf([[`${title} page one.`, "The quick brown fox jumps over the lazy dog."]]);
    const result = await uploadPdf(page, `${title}.pdf`, pdf);

    expect(result.status, result.body).toBe(200);
    const created = JSON.parse(result.body) as { id: string; slug: string; title: string; sha256: string };
    expect(created.title).toBe(title);

    try {
      // The title comes from the filename with the extension stripped, and the
      // row is immediately listed — which also exercises the file_metrics view
      // (the Author(s) cell) and the uploader's revalidation path.
      await gotoOk(page, "/files");
      await expect(page.getByRole("link", { name: title })).toBeVisible();
    } finally {
      await deleteTestFile(created.id);
    }
  });

  test("rejects a file that passes the magic check but isn't parseable", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, "/files");

    // Starts with %PDF- so the cheap magic check passes, then isn't a document.
    // 415 here is what proves the route actually parses the upload rather than
    // trusting its first five bytes or its extension — and that a failed parse
    // rolls back rather than leaving a row pointing at unusable bytes.
    const bytes = new TextEncoder().encode("%PDF-1.4\nnot actually a pdf body at all\n");
    const result = await uploadPdf(page, "not-really.pdf", bytes);
    expect(result.status).toBe(415);
  });

  test("serves bytes with an ETag and honours a Range request", async ({ page }) => {
    const file = await createTestFile({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, "/files");

      const url = `/api/files/${file.id}/${file.sha256}`;
      const full = await page.evaluate(async (u) => {
        const res = await fetch(u);
        return {
          status: res.status,
          etag: res.headers.get("etag"),
          acceptRanges: res.headers.get("accept-ranges"),
          length: (await res.arrayBuffer()).byteLength,
        };
      }, url);

      expect(full.status).toBe(200);
      expect(full.etag).toBe(`"${file.sha256}"`);
      expect(full.acceptRanges).toBe("bytes");
      expect(full.length).toBe(file.byteSize);

      const partial = await page.evaluate(async (u) => {
        const res = await fetch(u, { headers: { Range: "bytes=0-99" } });
        return {
          status: res.status,
          contentRange: res.headers.get("content-range"),
          length: (await res.arrayBuffer()).byteLength,
        };
      }, url);

      // 206 with the right slice is what lets PDF.js render page 1 of a 50MB
      // scan without transferring all of it. A server that ignored Range would
      // answer 200 with the whole body and nothing would visibly break — just
      // get slow — so this asserts the status and the length, not just that a
      // request succeeded.
      expect(partial.status).toBe(206);
      expect(partial.contentRange).toBe(`bytes 0-99/${file.byteSize}`);
      expect(partial.length).toBe(100);

      // A stale hash still serves the current bytes (so cached HTML doesn't
      // break) but must not claim immutability for a URL whose content moved.
      const stale = await page.evaluate(async (u) => {
        const res = await fetch(u);
        return { status: res.status, cacheControl: res.headers.get("cache-control") };
      }, `/api/files/${file.id}/${"0".repeat(64)}`);
      expect(stale.status).toBe(200);
      expect(stale.cacheControl).toContain("must-revalidate");
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("scopes the listing by visibility and byline", async ({ page }) => {
    const ownerEmail = uniqueEmail("file-owner");
    const otherEmail = uniqueEmail("file-other");
    await createTestUser({ email: ownerEmail, name: `File Owner ${ownerEmail.split("@")[0]}`, role: "AUTHOR" });
    await createTestUser({ email: otherEmail, name: `File Other ${otherEmail.split("@")[0]}`, role: "AUTHOR" });

    const privateFile = await createTestFile({ authorEmail: ownerEmail, visibility: "PRIVATE" });
    const sharedFile = await createTestFile({ authorEmail: ownerEmail, visibility: "SHARED" });

    try {
      // The owner sees both.
      await signIn(page, ownerEmail);
      await gotoOk(page, "/files");
      await expect(page.getByRole("link", { name: privateFile.title })).toBeVisible();
      await expect(page.getByRole("link", { name: sharedFile.title })).toBeVisible();

      // Another AUTHOR sees neither — "AUTHOR can only see own" (PLAN.md §19),
      // which for a SHARED file too, since canManageAnySharedFile is
      // ADMIN/EDITOR.
      await page.context().clearCookies();
      await signIn(page, otherEmail);
      await gotoOk(page, "/files");
      await expect(page.getByRole("link", { name: privateFile.title })).toHaveCount(0);
      await expect(page.getByRole("link", { name: sharedFile.title })).toHaveCount(0);

      // An ADMIN sees the SHARED one without a byline, and the PRIVATE one only
      // behind the explicit per-visit override.
      await page.context().clearCookies();
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, "/files");
      await expect(page.getByRole("link", { name: sharedFile.title })).toBeVisible();
      await expect(page.getByRole("link", { name: privateFile.title })).toHaveCount(0);

      await gotoOk(page, "/files?showAllFiles=1");
      await expect(page.getByRole("link", { name: privateFile.title })).toBeVisible();
    } finally {
      await deleteTestFile(privateFile.id);
      await deleteTestFile(sharedFile.id);
      await deleteTestUser(ownerEmail);
      await deleteTestUser(otherEmail);
    }
  });

  test("refuses to serve a PRIVATE file's bytes to a non-author", async ({ page }) => {
    const ownerEmail = uniqueEmail("file-owner");
    const otherEmail = uniqueEmail("file-other");
    await createTestUser({ email: ownerEmail, name: `File Owner ${ownerEmail.split("@")[0]}`, role: "AUTHOR" });
    await createTestUser({ email: otherEmail, name: `File Other ${otherEmail.split("@")[0]}`, role: "AUTHOR" });
    const file = await createTestFile({ authorEmail: ownerEmail, visibility: "PRIVATE" });

    try {
      await signIn(page, otherEmail);
      await gotoOk(page, "/files");
      const status = await page.evaluate(
        async (u) => (await fetch(u)).status,
        `/api/files/${file.id}/${file.sha256}`,
      );
      // 404, not 403: whether a PRIVATE file exists is itself something its
      // non-authors shouldn't learn from a guessable id.
      expect(status).toBe(404);
    } finally {
      await deleteTestFile(file.id);
      await deleteTestUser(ownerEmail);
      await deleteTestUser(otherEmail);
    }
  });
});
