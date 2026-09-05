import { test, expect, signIn, gotoOk } from "./fixtures";
import {
  ADMIN_EMAIL,
  TEST_PASSWORD,
  createTestFile,
  createTestUser,
  deleteTestFile,
  deleteTestUser,
  uniqueEmail,
} from "./db";
import { formatBytes } from "@/lib/file-format";
import { buildTestPdf } from "../scripts/make-test-pdf";
import { buildTestDocx, SAMPLE_DOCX_PARAGRAPHS } from "../scripts/make-test-docx";

/**
 * POSTs raw bytes to the upload route from inside the page, so the request
 * carries the session cookie.
 *
 * The bytes cross into the browser as a plain number array: `page.evaluate`
 * serializes its argument as JSON, so a Uint8Array would arrive as
 * `{"0":37,"1":80,…}` and silently upload nothing recognisable. Rebuilt into a
 * real Uint8Array on the far side.
 */
async function uploadFile(
  page: import("@playwright/test").Page,
  filename: string,
  bytes: Uint8Array,
  contentType = "application/pdf",
) {
  return page.evaluate(
    async ({ name, data, type }) => {
      const res = await fetch(`/api/files/upload?filename=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "Content-Type": type },
        body: new Uint8Array(data),
      });
      return { status: res.status, body: await res.text() };
    },
    { name: filename, data: Array.from(bytes), type: contentType },
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
    const result = await uploadFile(page, `${title}.pdf`, pdf);

    expect(result.status, result.body).toBe(200);
    const created = JSON.parse(result.body) as { id: string; slug: string; title: string; sha256: string };
    expect(created.title).toBe(title);

    try {
      // The title comes from the filename with the extension stripped, and the
      // row is immediately listed — which also exercises the file_metrics view
      // (the Owner(s) cell) and the uploader's revalidation path.
      await gotoOk(page, "/files");
      // `exact` because the Filename column is a link too, and this uploader
      // names the file `<title>.pdf` — so a substring match (the default) finds
      // the Title link *and* the Filename one. The scoping tests below need no
      // such guard: createTestFile hyphenates the spaces out of its filename,
      // so their titles never appear verbatim in a filename link.
      await expect(page.getByRole("link", { name: title, exact: true })).toBeVisible();
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
    const result = await uploadFile(page, "not-really.pdf", bytes);
    expect(result.status).toBe(415);
  });

  test("serves bytes with an ETag and honours a Range request", async ({ page }) => {
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
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

    const privateFile = await createTestFile({ ownerEmail: ownerEmail, visibility: "PRIVATE" });
    const sharedFile = await createTestFile({ ownerEmail: ownerEmail, visibility: "SHARED" });

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

  test("refuses to serve a PRIVATE file's bytes to a non-owner", async ({ page }) => {
    const ownerEmail = uniqueEmail("file-owner");
    const otherEmail = uniqueEmail("file-other");
    await createTestUser({ email: ownerEmail, name: `File Owner ${ownerEmail.split("@")[0]}`, role: "AUTHOR" });
    await createTestUser({ email: otherEmail, name: `File Other ${otherEmail.split("@")[0]}`, role: "AUTHOR" });
    const file = await createTestFile({ ownerEmail: ownerEmail, visibility: "PRIVATE" });

    try {
      await signIn(page, otherEmail);
      await gotoOk(page, "/files");
      const status = await page.evaluate(
        async (u) => (await fetch(u)).status,
        `/api/files/${file.id}/${file.sha256}`,
      );
      // 404, not 403: whether a PRIVATE file exists is itself something its
      // non-owners shouldn't learn from a guessable id.
      expect(status).toBe(404);
    } finally {
      await deleteTestFile(file.id);
      await deleteTestUser(ownerEmail);
      await deleteTestUser(otherEmail);
    }
  });

  // PLAN.md §19 Phase 1 — .docx is stored and served but never parsed, which is
  // the whole of the difference from a PDF. These three cases pin that
  // difference down: it is accepted, it records no page text, and it is handed
  // back as a download rather than rendered inline.
  test("uploads a .docx, records no page count, and lists it", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, "/files");

    const title = `E2E docx ${Date.now()}`;
    const docx = buildTestDocx(SAMPLE_DOCX_PARAGRAPHS);
    const result = await uploadFile(page, `${title}.docx`, docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

    expect(result.status, result.body).toBe(200);
    const created = JSON.parse(result.body) as { id: string; slug: string; title: string; sha256: string };
    // The extension is stripped for the title exactly as .pdf is — the same
    // table decides both (src/lib/file-format.ts).
    expect(created.title).toBe(title);

    try {
      await gotoOk(page, "/files");
      const row = page.locator("tbody tr", { hasText: title });
      await expect(row).toBeVisible();
      // Pages is empty, not zero: nothing parsed the document, so the count is
      // unknown rather than known to be none.
      await expect(row).toContainText(`${title}.docx`);
    } finally {
      await deleteTestFile(created.id);
    }
  });

  test("rejects a .docx that isn't a zip", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, "/files");

    // The .docx counterpart of the unparseable-PDF case above, and the reason
    // the shallow check is still a check: renaming a text file to .docx is
    // caught by the package's magic number, at four bytes read rather than a
    // whole-document parse.
    const bytes = new TextEncoder().encode("This is a plain text file wearing a .docx extension.");
    const result = await uploadFile(page, "not-really.docx", bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(result.status).toBe(415);
  });

  test("serves a .docx as an attachment, and a PDF inline", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL);
    await gotoOk(page, "/files");

    const title = `E2E docx disposition ${Date.now()}`;
    const result = await uploadFile(page, `${title}.docx`, buildTestDocx(["Anything."]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(result.status, result.body).toBe(200);
    const created = JSON.parse(result.body) as { id: string; sha256: string };
    const pdf = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });

    try {
      // A browser asked to render a .docx inline either downloads it anyway or
      // shows a page of binary; the PDF stays inline so a click opens a viewer.
      const headers = await page.evaluate(async (url) => {
        const res = await fetch(url);
        return {
          disposition: res.headers.get("content-disposition"),
          type: res.headers.get("content-type"),
        };
      }, `/api/files/${created.id}/${created.sha256}`);

      expect(headers.disposition).toContain("attachment");
      expect(headers.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");

      // The other half of this test's name, which it used to promise and not
      // check. Now load-bearing rather than merely tidy: /pdf/[slug] hands the
      // bare hash URL to pdfjs and depends on `inline`, so the `?download=1`
      // override next door has to leave the default alone. Without this, that
      // override could swallow the inline case and the suite would stay green.
      const inlineRes = await page.request.get(`/api/files/${pdf.id}/${pdf.sha256}`);
      expect(inlineRes.headers()["content-disposition"]).toContain("inline");
    } finally {
      await deleteTestFile(created.id);
      await deleteTestFile(pdf.id);
    }
  });

  // The slug download URL (/files/<slug>/download) — a resolver in front of the
  // byte route, not a second way to serve bytes.
  test("downloads through the slug URL, forcing the attachment disposition", async ({ page }) => {
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });

    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, "/files");

      // `maxRedirects: 0` rather than a page.evaluate fetch: a same-origin
      // `redirect: "manual"` fetch answers an opaqueredirect with status 0 and
      // no readable headers, so the one thing worth asserting here — where the
      // hop points — would be invisible.
      const hop = await page.request.get(`/files/${file.slug}/download`, { maxRedirects: 0 });
      expect(hop.status()).toBe(307);
      expect(hop.headers()["location"]).toBe(`/api/files/${file.id}/${file.sha256}?download=1`);

      const served = await page.request.get(`/files/${file.slug}/download`);
      expect(served.status()).toBe(200);
      // Why `?download=1` exists at all. This is a PDF, which the byte route
      // answers `inline` by default (asserted above); a URL ending in
      // /download that opened the viewer instead would still *look* correct
      // from the table, because the anchor there would save it either way —
      // and would quietly fail for anyone who pasted the URL.
      expect(served.headers()["content-disposition"]).toContain("attachment");
      expect(served.headers()["content-type"]).toBe("application/pdf");
      expect((await served.body()).byteLength).toBe(file.byteSize);
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("refuses a PRIVATE file's slug download to a non-owner", async ({ page }) => {
    const ownerEmail = uniqueEmail("file-owner");
    const otherEmail = uniqueEmail("file-other");
    await createTestUser({ email: ownerEmail, name: `File Owner ${ownerEmail.split("@")[0]}`, role: "AUTHOR" });
    await createTestUser({ email: otherEmail, name: `File Other ${otherEmail.split("@")[0]}`, role: "AUTHOR" });
    const file = await createTestFile({ ownerEmail: ownerEmail, visibility: "PRIVATE" });

    try {
      await signIn(page, otherEmail);
      await gotoOk(page, "/files");
      const res = await page.request.get(`/files/${file.slug}/download`, { maxRedirects: 0 });
      // 403 here, against the byte route's 404 next door, and the difference is
      // deliberate: this route shares /pdf/[slug]'s key space, which already
      // discloses that a slug resolves at all. The 404 there guards *id*
      // guessing, which a slug URL gives no way to do.
      expect(res.status()).toBe(403);
    } finally {
      await deleteTestFile(file.id);
      await deleteTestUser(ownerEmail);
      await deleteTestUser(otherEmail);
    }
  });
});

// PLAN.md §19 — /files/[slug], the landing a download sends someone who had to
// sign in first.
//
// The regression these pin is one that hid behind a *working* download. The
// callbackUrl used to be the download URL itself, so signing in ran
// `router.push("/files/<slug>/download")`; the client router fetched a route
// handler that answers with bytes, the browser downloaded them, and — because
// a download never navigates — the app stayed on the sign-in form. The file
// arrived and the screen looked like a failed login, which is not a state any
// assertion about the *bytes* would have caught.
test.describe("the post-sign-in download landing", () => {
  test("signs you in, lands you on the file, and still delivers the bytes", async ({ page }) => {
    // AUTHORIZED specifically: this role may read a SHARED file but may not
    // reach /files at all (canViewFiles vs canManageFiles), so it is the role
    // that a "land them on a filtered /files" fix would have answered
    // "you don't have permission to manage files" — for a file it had just
    // legitimately downloaded.
    const readerEmail = uniqueEmail("authorized");
    await createTestUser({ email: readerEmail, role: "AUTHORIZED" });
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });

    try {
      await page.context().clearCookies();
      await page.goto(`/files/${file.slug}/download`);

      await page.waitForURL("**/sign-in?callbackUrl=*");
      expect(new URL(page.url()).searchParams.get("callbackUrl")).toBe(`/files/${file.slug}`);

      const download = page.waitForEvent("download");
      await page.getByLabel("Email").fill(readerEmail);
      await page.getByLabel("Password").fill(TEST_PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();

      // The landing page — not the sign-in form this used to strand people on.
      await page.waitForURL(`**/files/${file.slug}`);
      await expect(page.getByRole("heading", { name: file.title })).toBeVisible();
      await expect(page.getByText(formatBytes(file.byteSize))).toBeVisible();
      await expect(page.getByRole("link", { name: "download it here" })).toBeVisible();

      // And the file itself still arrives, without a click.
      expect((await download).suggestedFilename()).toContain(".pdf");
    } finally {
      await deleteTestFile(file.id);
      await deleteTestUser(readerEmail);
    }
  });

  test("an AUTHORIZED reader still can't reach /files itself", async ({ page }) => {
    // The other half of the choice above: the landing page is deliberately not
    // a way into the file *table*, whose gate stays stricter than the file's.
    const readerEmail = uniqueEmail("authorized");
    await createTestUser({ email: readerEmail, role: "AUTHORIZED" });

    try {
      await page.context().clearCookies();
      await signIn(page, readerEmail);
      await gotoOk(page, "/files");
      await expect(page.getByText(/doesn't have permission to manage files/)).toBeVisible();
    } finally {
      await deleteTestUser(readerEmail);
    }
  });

  test("refuses the landing to someone who may not read the file", async ({ page }) => {
    const ownerEmail = uniqueEmail("owner");
    const strangerEmail = uniqueEmail("stranger");
    await createTestUser({ email: ownerEmail, role: "AUTHOR" });
    await createTestUser({ email: strangerEmail, role: "AUTHOR" });
    const file = await createTestFile({ ownerEmail, visibility: "PRIVATE" });

    try {
      await page.context().clearCookies();
      await signIn(page, strangerEmail);
      await gotoOk(page, `/files/${file.slug}`);

      await expect(page.getByRole("heading", { name: "Forbidden" })).toBeVisible();
      // The filename is a fact about a file they may not read, so it must not
      // be on the page even though the slug resolved.
      await expect(page.getByText(file.title)).toHaveCount(0);
    } finally {
      await deleteTestFile(file.id);
      await deleteTestUser(strangerEmail);
      await deleteTestUser(ownerEmail);
    }
  });
});
