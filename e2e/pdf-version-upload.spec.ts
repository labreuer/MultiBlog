import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, signIn, gotoOk, annotationEditor, visibleText } from "./fixtures";
import { expectAddress, expectSheetText, fragmentOf, selectPhrase, token, waitForViewer, type Page } from "./pdf-version-helpers";
import {
  ADMIN_EMAIL,
  abandonTestVersion,
  createTestDoc,
  createTestFile,
  deleteTestDoc,
  deleteTestFile,
  getFileAnchorVersions,
  getFileVersionFacts,
  holdFileHashLock,
  promoteTestVersion,
  promoteTestVersionSlowly,
  raceVersionActs,
  renameTestFileSlug,
  uploadAcrossAbandon,
  type TestFile,
} from "./db";
import { createAgent } from "./mcp";
import { buildTestPdf, type TestPageLabelRange } from "../scripts/make-test-pdf";

// docs/PDF.md §13 — a file takes a new version: uploaded, read at its own
// address while it waits, promoted, and after that every address answering
// by version. e2e/pdf-versions.spec.ts gives a file its second version with a
// fixture and checks the reads; here the version is made the way a person or
// a bot makes one, and the writes are what is checked.
//
// Every version here is uploaded as a revised text, so none has a page map
// and nothing is carried: a note stays on the version it is on, and a link
// opens the version it names. e2e/pdf-better-copy.spec.ts is the other kind.
//
// **Every file's text is its own.** The store is content-addressed, so two
// tests uploading the same lines would share one blob, and an abandoning in
// one would count the other's row. A token in each line makes each test's
// bytes its own, which is also what lets a search name one version's text.

// Roman front matter and an arabic body, so a `p=` names a printed page.
const LABELS: TestPageLabelRange[] = [
  { from: 1, style: "r" },
  { from: 2, style: "D" },
];

/** A two-sheet copy whose every line carries `tag`: its bytes are no other test's. */
function copy(tag: string, which: string): string[][] {
  return [
    [`Front matter of the ${which} copy ${tag}.`, "It names participation here."],
    [`The body of the ${which} copy begins ${tag}.`, `Only the ${which} copy says this of totems.`],
  ];
}

const pdfOf = (pages: string[][]): Buffer => Buffer.from(buildTestPdf(pages, { pageLabels: LABELS }));

/** A new version sent to the browser's route, as the uploader sends one. */
async function putVersion(page: Page, fileId: string, bytes: Buffer, filename: string) {
  const response = await page.request.put(`/api/files/${fileId}?filename=${encodeURIComponent(filename)}`, {
    data: bytes,
    headers: { "Content-Type": "application/pdf" },
  });
  return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
}

const RELOAD = "Reload the page";

test.describe("a file takes a new version", () => {
  test("uploaded, read while it waits, promoted, and every address answers by version", async ({ page, request, secondUser }) => {
    test.setTimeout(240_000);
    const tag = token();
    const V1 = copy(tag, "first");
    const V2 = copy(tag, "second");
    const agent = await createAgent(request);
    const file: TestFile = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: V1, pageLabels: LABELS });
    const banner = page.getByTestId("pdf-version-banner");
    const others = page.getByTestId("pdf-other-version-notes");
    const highlight = (on: Page, id: string) => on.locator(`.annoRect[data-anno-id="${id}"]`);
    try {
      // A word annotated on the first copy, while it is the only one.
      const posted = await agent.call("add_note", { on: `/pdf/${file.slug}`, body: `A note on the first copy ${tag}.`, quote: "first copy begins" });
      expect(posted.isError, JSON.stringify(posted.error)).toBe(false);
      const v1Note = { id: String(posted.result.id), card: String(posted.result.card) };

      // Two links written against it, by sheet and by printed page, as every
      // link was before the file had a second version: neither says which.
      const sheetLink = `#sheet=2&text=first+copy+begins`;
      const pageLink = `#p=1&text=says+this+of+totems`;

      // A reader who can't manage the file, with a tab left open on it.
      const { page: reader } = await secondUser({ role: "AUTHOR" });
      const stale = await reader.context().newPage();
      await gotoOk(stale, `/pdf/${file.slug}`);
      await waitForViewer(stale);
      await expectSheetText(stale, `first copy ${tag}`);

      // ---- the upload, from the file's own page ----------------------------
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      // A file with one version lists none to a reader, and gives its manager the upload.
      await page.getByRole("tab", { name: "Metadata" }).click();
      await expect(page.getByTestId("pdf-version-uploader")).toBeVisible();
      await page.getByTestId("pdf-version-file").setInputFiles({ name: "second-copy.pdf", mimeType: "application/pdf", buffer: pdfOf(V2) });
      // It answers the candidate's own address, and that is where the uploader lands.
      await expect(page).toHaveURL(new RegExp(`/pdf/${file.slug}/v/2$`), { timeout: 60_000 });
      await waitForViewer(page);
      await expectSheetText(page, `second copy ${tag}`);
      await expect(banner).toContainText("not yet the latest");
      await expect(page).toHaveTitle(new RegExp(`^${file.title}, version 2( |$)`));

      let versions = await getFileVersionFacts(file.id);
      expect(versions.map(({ number, state, baseNumber, bytesOnDisk, uploadedByEmail, filename }) => ({ number, state, baseNumber, bytesOnDisk, uploadedByEmail, filename }))).toEqual([
        expect.objectContaining({ number: 1, state: "latest", baseNumber: null, bytesOnDisk: true }),
        { number: 2, state: "candidate", baseNumber: 1, bytesOnDisk: true, uploadedByEmail: ADMIN_EMAIL, filename: "second-copy.pdf" },
      ]);
      expect(versions[1].pageTextRows).toBe(2);
      expect(versions[1].promotedAtUpdateId).toBe(false);

      // One candidate at a time: a second upload is refused, naming the one that stands.
      const second = await putVersion(page, file.id, pdfOf(copy(tag, "refused")), "refused.pdf");
      expect(second.status).toBe(409);
      expect(String(second.body.error)).toContain("version 2");
      // Whoever can't manage the file can't give it a version, before any body is read.
      expect((await putVersion(reader, file.id, pdfOf(copy(tag, "theirs")), "theirs.pdf")).status).toBe(403);
      // Something that isn't a PDF isn't a version of one.
      const notPdf = await page.request.put(`/api/files/${file.id}?filename=notes.docx`, { data: Buffer.from("PK\u0003\u0004 not a pdf") });
      expect([409, 415]).toContain(notPdf.status());

      // ---- before the promotion: each address, to a reader who can't manage --
      await gotoOk(reader, `/pdf/${file.slug}`);
      await waitForViewer(reader);
      await expectSheetText(reader, `first copy ${tag}`);
      await expect(reader.getByTestId("pdf-version-banner")).toHaveCount(0);
      await gotoOk(reader, `/pdf/${file.slug}/v/1`);
      await waitForViewer(reader);
      await expectSheetText(reader, `first copy ${tag}`);
      await gotoOk(reader, `/pdf/${file.slug}/v/2`);
      await waitForViewer(reader);
      await expectSheetText(reader, `second copy ${tag}`);
      await expect(reader.getByTestId("pdf-version-banner")).toContainText("not yet the latest");
      // The version list shows the reader both, and none of its management half.
      await reader.getByRole("tab", { name: "Metadata" }).click();
      await expect(reader.getByTestId("pdf-version-list").locator("[data-version='2']")).toContainText("not yet the latest");
      await expect(reader.getByTestId("pdf-candidate-actions")).toHaveCount(0);
      await expect(reader.getByTestId("pdf-version-uploader")).toHaveCount(0);
      await reader.getByRole("tab", { name: "Annotations" }).click();

      // An annotation is refused on the candidate: abandoning it would take the sheets it was measured on.
      await selectPhrase(reader, 1, "second copy");
      await reader.getByRole("button", { name: "Annotate" }).click();
      await expect(reader.getByText("takes no notes or link parts").first()).toBeVisible({ timeout: 15_000 });
      expect((await getFileAnchorVersions(file.id)).annotations).toEqual([file.versionId]);
      // A note with no target is the file's, written from the candidate's page, and listed on every version's.
      const FILE_NOTE = `On the whole file ${tag}.`;
      const whole = await agent.call("add_note", { on: `/pdf/${file.slug}/v/2`, body: FILE_NOTE });
      expect(whole.isError, JSON.stringify(whole.error)).toBe(false);
      for (const address of [`/pdf/${file.slug}`, `/pdf/${file.slug}/v/1`, `/pdf/${file.slug}/v/2`]) {
        await gotoOk(reader, address);
        await waitForViewer(reader);
        await expect(reader.locator(`#${fragmentOf(String(whole.result.card))}`)).toBeAttached({ timeout: 20_000 });
      }

      // ---- the promotion, from the candidate's banner ----------------------
      await expect(banner.getByTestId("pdf-candidate-actions")).toContainText("Promoting makes version 2");
      await banner.getByRole("button", { name: "Promote version 2" }).click();
      // The page reloads in full, on the same address, which is now the latest's own.
      await expect(page.locator("[data-pdf-viewer]")).toContainText(`${file.title}, version 2 (the latest)`, { timeout: 60_000 });
      await expect(banner).toHaveCount(0);
      await expect(page).toHaveTitle(new RegExp(`^${file.title}, version 2( |$)`));
      versions = await getFileVersionFacts(file.id);
      expect(versions.map(({ number, state }) => ({ number, state }))).toEqual([
        { number: 1, state: "earlier" },
        { number: 2, state: "latest" },
      ]);
      expect(versions[1]).toMatchObject({ promotedByEmail: ADMIN_EMAIL, promotedAtUpdateId: true, bytesOnDisk: true });
      // Nothing moved: the note is where it was.
      expect((await getFileAnchorVersions(file.id)).annotations).toEqual([file.versionId]);

      // ---- after it: the bare address shows the second bytes ---------------
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await expectSheetText(page, `second copy ${tag}`);
      // The note is drawn on version 1 alone, and listed here under its version.
      await expect(others).toContainText("On version 1", { timeout: 20_000 });
      await expect(others.getByRole("link", { name: `A note on the first copy ${tag}.` })).toHaveAttribute(
        "href",
        `/pdf/${file.slug}/v/1#${fragmentOf(v1Note.card)}`,
      );
      await expect(highlight(page, v1Note.id)).toHaveCount(0);
      // Its card's link, written for the bare address, lands on that entry.
      await page.goto(`/pdf/${file.slug}#${fragmentOf(v1Note.card)}`);
      await expect(others.locator(`#${fragmentOf(v1Note.card)}`)).toBeInViewport({ timeout: 20_000 });
      // A manager is told how many posted notes are still on the earlier version.
      await page.getByRole("tab", { name: "Metadata" }).click();
      await expect(page.getByTestId("pdf-version-list").locator("[data-version='1']").getByTestId("pdf-version-notes-left")).toContainText("1 posted note");

      await gotoOk(page, `/pdf/${file.slug}/v/1`);
      await waitForViewer(page);
      await expectSheetText(page, `first copy ${tag}`);
      await expect(highlight(page, v1Note.id)).not.toHaveCount(0, { timeout: 20_000 });
      // The banner's link to the latest, followed without a reload, shows the second bytes.
      await banner.getByRole("link", { name: "version 2" }).click();
      await expect(page).toHaveURL(new RegExp(`/pdf/${file.slug}$`));
      await expectSheetText(page, `second copy ${tag}`);
      await expect(highlight(page, v1Note.id)).toHaveCount(0);

      // ---- both links, unstamped, open version 1 ---------------------------
      // From another page, so the page for the latest loads first and the viewer goes on from it.
      await gotoOk(page, "/files");
      await page.goto(`/pdf/${file.slug}${sheetLink}`);
      await expectAddress(page, `/pdf/${file.slug}/v/1#sheet=2&text=first+copy+begins`);
      await waitForViewer(page);
      await expectSheetText(page, `first copy begins ${tag}`, 2);
      await expect(page.getByTestId("pdf-fragment-banner")).toContainText("first copy begins", { timeout: 20_000 });
      await expect(banner).toContainText("an earlier version");
      // From here the banner's link reaches the latest and stays there: the
      // address bar still holds this page's fragment while the latest's page
      // first renders, and read then it would name version 1 and send the
      // reader straight back.
      await banner.getByRole("link", { name: "version 2" }).click();
      await expectSheetText(page, `second copy ${tag}`);
      await expect(highlight(page, v1Note.id)).toHaveCount(0);
      await expectAddress(page, `/pdf/${file.slug}`);
      await expect(banner).toHaveCount(0);
      await expect(page.getByTestId("pdf-fragment-banner")).toHaveCount(0);
      // By printed page, and into the page already open: a fragment's change alone.
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await page.goto(`/pdf/${file.slug}${pageLink}`);
      await expectAddress(page, `/pdf/${file.slug}/v/1#p=1&text=says+this+of+totems`);
      await waitForViewer(page);
      await expect(page.getByTestId("pdf-fragment-banner")).toContainText("says this of totems", { timeout: 20_000 });
      // Stamped with the latest, a link stays on the bare address.
      await page.goto(`/pdf/${file.slug}#sheet=2&v=2&text=second+copy+begins`);
      await waitForViewer(page);
      await expectAddress(page, `/pdf/${file.slug}#sheet=2&v=2&text=second+copy+begins`);
      await expect(page.getByTestId("pdf-fragment-banner")).toContainText("second copy begins", { timeout: 20_000 });
      await expect(banner).toHaveCount(0);
      // On a version's own address the viewer stays, and offers a passage of another version there.
      await page.goto(`/pdf/${file.slug}/v/2#sheet=2&v=1&text=first+copy+begins`);
      await waitForViewer(page);
      const offered = page.getByTestId("pdf-fragment-other-version");
      await expect(offered).toContainText("On version 1", { timeout: 20_000 });
      await expect(offered.getByRole("link")).toHaveAttribute("href", `/pdf/${file.slug}/v/1#sheet=2&v=1&text=first+copy+begins`);
      // Followed, it opens the passage on version 1; and the plain link back
      // to the latest then arrives with no fragment of that visit's.
      await offered.getByRole("link").click();
      await expectAddress(page, `/pdf/${file.slug}/v/1#sheet=2&v=1&text=first+copy+begins`);
      await waitForViewer(page);
      await expect(page.getByTestId("pdf-fragment-banner")).toContainText("first copy begins", { timeout: 20_000 });
      await banner.getByRole("link", { name: "version 2" }).click();
      await expectSheetText(page, `second copy ${tag}`);
      await expectAddress(page, `/pdf/${file.slug}`);
      // A stamp no version of the file has: the sheet as written, and a line saying so.
      await page.goto(`/pdf/${file.slug}#sheet=2&v=9`);
      await waitForViewer(page);
      await expect(page.getByTestId("pdf-fragment-version-note")).toContainText("no version 9", { timeout: 20_000 });

      // ---- a link the app writes afterwards carries v=2 --------------------
      // Search's page link, which is copied into bodies from the address bar.
      await gotoOk(page, `/search?q=${encodeURIComponent(`"second copy begins ${tag}"`)}`);
      await expect(page.locator(`a[href="/pdf/${file.slug}#p=1&v=2"]`).first()).toBeVisible({ timeout: 20_000 });
      const found = await agent.call("search", { q: `"second copy begins ${tag}"`, kinds: ["pdfs"], exact: true });
      expect(JSON.stringify(found.result)).toContain(`/pdf/${file.slug}`);
      const read = await agent.call("read", { url: `/pdf/${file.slug}`, sheet: 2 });
      expect((read.result.sheets as { link?: string }[])[0].link).toBe(`/pdf/${file.slug}#p=1&v=2`);
      // And a search hit comes from the latest version's text alone.
      const stale1 = await agent.call("search", { q: `"first copy begins ${tag}"`, kinds: ["pdfs"], exact: true });
      expect(JSON.stringify(stale1.result)).not.toContain(`/pdf/${file.slug}`);
      // MCP reads an unstamped link as the viewer does, on version 1, and says so.
      const asViewer = await agent.call("read", { url: `/pdf/${file.slug}${sheetLink}` });
      expect(asViewer.isError, JSON.stringify(asViewer.error)).toBe(false);
      expect(asViewer.result.url).toBe(`/pdf/${file.slug}/v/1`);
      expect(String(asViewer.result.note)).toContain("version 1");
      // And refuses to write one, giving its stamped form where the words are.
      const unstamped = await agent.call("create_doc", { markdown: `See [the passage](/pdf/${file.slug}#sheet=2&text=second+copy+begins).`, title: `Unstamped ${tag}` });
      expect(unstamped.isError).toBe(true);
      expect(unstamped.error.stamped).toBe(`/pdf/${file.slug}#sheet=2&v=2&text=second+copy+begins`);
      const wordless = await agent.call("create_doc", { markdown: `See [the page](/pdf/${file.slug}#sheet=2).`, title: `Wordless ${tag}` });
      expect(wordless.isError).toBe(true);
      expect((wordless.error.readings as { version: number; link: string }[]).map((reading) => reading.link)).toEqual([
        `/pdf/${file.slug}#sheet=2&v=1`,
        `/pdf/${file.slug}#sheet=2&v=2`,
      ]);

      // ---- a viewer opened before the promotion ----------------------------
      // It still reads the first bytes, and isn't told. Its capture is refused.
      await expectSheetText(stale, `first copy ${tag}`);
      await selectPhrase(stale, 1, "first copy");
      await stale.getByRole("button", { name: "Annotate" }).click();
      await expect(stale.getByText(RELOAD).first()).toBeVisible({ timeout: 15_000 });
      expect((await getFileAnchorVersions(file.id)).annotations).toEqual([file.versionId]);
      await stale.close();

      // ---- a note made on version 1 after the promotion --------------------
      // Arrived by a link, whose banner the reader dismisses before writing.
      const LATE = `Made on the first copy afterwards ${tag}.`;
      await gotoOk(reader, `/pdf/${file.slug}/v/1#sheet=1&text=names+participation`);
      await waitForViewer(reader);
      const linked = reader.getByTestId("pdf-fragment-banner");
      await expect(linked).toContainText("names participation", { timeout: 20_000 });
      await linked.getByRole("button", { name: "Dismiss linked passages" }).click();
      await expect(linked).toHaveCount(0);
      await selectPhrase(reader, 1, "names participation");
      await reader.getByRole("button", { name: "Annotate" }).click();
      const editor = annotationEditor(reader);
      await editor.click();
      await editor.pressSequentially(LATE);
      await reader.getByRole("button", { name: "Save" }).click();
      await expect(reader.getByRole("button", { name: "Write an annotation..." })).toBeVisible({ timeout: 15_000 });
      await expect(visibleText(reader, LATE)).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await getFileAnchorVersions(file.id)).annotations, { timeout: 15_000 }).toEqual([file.versionId, file.versionId]);
      // The post refreshes the page's server data. That is no new arrival by
      // the link: the banner stays dismissed, and the reader is not taken
      // back to the passage.
      await reader.waitForLoadState("networkidle");
      await expect(linked).toHaveCount(0);
      // Drawn there, and not on the latest, where it is listed under its version.
      await gotoOk(reader, `/pdf/${file.slug}`);
      await waitForViewer(reader);
      await expectSheetText(reader, `second copy ${tag}`);
      await expect(reader.getByTestId("pdf-other-version-notes")).toContainText(LATE, { timeout: 20_000 });
      await expect(reader.locator(".annoRect[data-anno-id]")).toHaveCount(0);

      // ---- `/v<n>`, and each version's download under its own filename ------
      await page.goto(`/pdf/${file.slug}/v2`);
      await expect(page).toHaveURL(new RegExp(`/pdf/${file.slug}/v/2$`));
      const saved = async (path: string) => (await page.request.get(path)).headers()["content-disposition"];
      expect(await saved(`/files/${file.slug}/v/2/download`)).toContain(`filename="second-copy.pdf"`);
      expect(await saved(`/files/${file.slug}/download`)).toContain(`filename="second-copy.pdf"`);
      expect(await saved(`/files/${file.slug}/v/1/download`)).toContain(`filename="${versions[0].filename}"`);
      expect(versions[0].filename).not.toBe("second-copy.pdf");

      // ---- the latest's bytes again are no new version ---------------------
      expect(await putVersion(page, file.id, pdfOf(V2), "second-copy-again.pdf")).toMatchObject({ status: 200, body: { unchanged: true } });
      expect((await getFileVersionFacts(file.id)).length).toBe(2);

      // ---- a second candidate, abandoned -----------------------------------
      const V3 = copy(tag, "third");
      const third = await putVersion(page, file.id, pdfOf(V3), "third-copy.pdf");
      expect(third).toMatchObject({ status: 201, body: { version: 3, url: `/pdf/${file.slug}/v/3` } });
      await gotoOk(page, `/pdf/${file.slug}/v/3#sheet=2`);
      await waitForViewer(page);
      await banner.getByRole("button", { name: "Abandon version 3" }).click();
      await banner.getByRole("button", { name: "Abandon it for good" }).click();
      // Its address answers with a page that says so, and offers the link on the latest's, stamped.
      const gone = page.getByTestId("pdf-abandoned-version");
      await expect(gone).toContainText("Version 3 of this file was abandoned", { timeout: 60_000 });
      await expect(page.getByTestId("pdf-abandoned-latest")).toHaveAttribute("href", `/pdf/${file.slug}#sheet=2&v=3`);
      versions = await getFileVersionFacts(file.id);
      expect(versions[2]).toMatchObject({ number: 3, state: "abandoned", bytesOnDisk: false, pageTextRows: 0, baseNumber: 2 });
      expect(versions[1].state).toBe("latest");
      // To a reader as to a manager; a number the file never had is no page.
      await gotoOk(reader, `/pdf/${file.slug}/v/3`);
      await expect(reader.getByTestId("pdf-abandoned-version")).toBeVisible();
      expect((await reader.request.get(`/pdf/${file.slug}/v/7`)).status()).toBe(404);
      // It has no download, and its bytes answer nothing.
      expect((await page.request.get(`/files/${file.slug}/v/3/download`, { maxRedirects: 0 })).status()).toBe(404);
      expect((await page.request.get(`/api/files/${file.id}/${versions[2].sha256}`)).status()).toBe(404);
      // The link it offers: the latest's viewer says the version was abandoned, and opens no sheet for it.
      await page.getByTestId("pdf-abandoned-latest").click();
      await expectAddress(page, `/pdf/${file.slug}#sheet=2&v=3`);
      await waitForViewer(page);
      await expect(page.getByTestId("pdf-fragment-version-note")).toContainText("Version 3 was abandoned", { timeout: 20_000 });
      // On the latest, and still there once the viewer has read the link: not on version 1, which says the same of version 3.
      await expectSheetText(page, `second copy ${tag}`);
      await expectAddress(page, `/pdf/${file.slug}#sheet=2&v=3`);
      await expect(page.getByTestId("pdf-version-banner")).toHaveCount(0);
      // MCP answers the same of its address: the version is gone, and where the latest is.
      const goneRead = await agent.call("read", { url: `/pdf/${file.slug}/v/3` });
      expect(goneRead.error).toMatchObject({ code: "not_found" });
      expect(String(goneRead.error.message)).toContain(`/pdf/${file.slug}`);

      // The next takes a new number: 3 is never reused.
      const fourth = await putVersion(page, file.id, pdfOf(copy(tag, "fourth")), "fourth-copy.pdf");
      expect(fourth).toMatchObject({ status: 201, body: { version: 4, url: `/pdf/${file.slug}/v/4` } });
      expect((await getFileVersionFacts(file.id)).map(({ number, state }) => `${number} ${state}`)).toEqual(["1 earlier", "2 latest", "3 abandoned", "4 candidate"]);

      // ---- the addresses follow a rename of the file -----------------------
      const oldSlug = file.slug;
      file.slug = await renameTestFileSlug(file.id);
      const moved = async (path: string) => (await page.request.get(path, { maxRedirects: 0 })).headers()["location"];
      expect(await moved(`/pdf/${oldSlug}/v/1`)).toBe(`/pdf/${file.slug}/v/1`);
      expect(await moved(`/pdf/${oldSlug}/v/4`)).toBe(`/pdf/${file.slug}/v/4`);
      expect(await moved(`/pdf/${oldSlug}/v/3`)).toBe(`/pdf/${file.slug}/v/3`);
      await gotoOk(page, `/pdf/${file.slug}/v/3`);
      await expect(gone).toBeVisible();

      // ---- the integrity checks are clean over all of it -------------------
      const { stdout } = await promisify(execFile)("npx", ["tsx", "scripts/integrity/check-file-versions.ts", "--file", file.id]);
      expect(stdout).toContain("0 error(s).");
    } finally {
      await deleteTestFile(file.id);
      await agent.dispose();
    }
  });

  test("a bot uploads a version of a file only its person owns, through MCP's route", async ({ request, secondUser }) => {
    const tag = token();
    // The person owns the file alone, and it is PRIVATE: their bot is not on it.
    const { user: person, page: personPage } = await secondUser({ role: "AUTHOR" });
    const file = await createTestFile({ ownerEmail: person.email, visibility: "PRIVATE", pages: copy(tag, "first"), pageLabels: LABELS });
    const bot = await createAgent(request, { issuerEmail: person.email });
    // Another person's bot: neither it nor the person it works for manages the file.
    const stranger = await createAgent(request);
    const second = pdfOf(copy(tag, "second"));
    const send = async (as: typeof bot, bytes: Buffer, query = "") => {
      const granted = await as.call("upload", { kind: "file", versionOf: `/pdf/${file.slug}` });
      if (granted.isError) return { refused: granted.error, status: 0, body: {} as Record<string, unknown> };
      expect(String(granted.result.url)).toContain(`versionOf=${file.id}`);
      const res = await request.post(`${granted.result.url}&filename=second.pdf${query}`, { data: bytes, headers: { "Content-Type": "application/pdf" } });
      return { refused: null, status: res.status(), body: (await res.json()) as Record<string, unknown> };
    };
    try {
      // The bot borrows its person's place among the owners, though it can't read the file itself.
      expect((await bot.call("read", { url: `/pdf/${file.slug}` })).error.code).toBe("not_found");
      const first = await send(bot, second);
      expect(first.status, JSON.stringify(first)).toBe(201);
      expect(first.body).toMatchObject({ id: file.id, version: 2, url: `/pdf/${file.slug}/v/2` });
      let versions = await getFileVersionFacts(file.id);
      expect(versions[1]).toMatchObject({ number: 2, state: "candidate", uploadedByEmail: bot.user.email, baseNumber: 1, bytesOnDisk: true });
      // It makes a candidate and nothing more: the file's address shows what it did.
      expect(versions[0].state).toBe("latest");

      // A retry answers the candidate the first request made, where the candidate standing would refuse it.
      const retry = await send(bot, second);
      expect(retry.body).toMatchObject({ code: "already_done", result: { version: 2, url: `/pdf/${file.slug}/v/2` } });
      // Other bytes are refused while it stands, naming it.
      const other = await send(bot, pdfOf(copy(tag, "other")));
      expect(other.status).toBe(409);
      expect(String(other.body.message)).toContain("version 2");
      expect((await getFileVersionFacts(file.id)).length).toBe(2);

      // What is a new file's is refused beside versionOf, before any body is stored.
      for (const param of ["&title=Another", "&issuerOnly=1", "&duplicate=1"]) {
        const refused = await send(bot, second, param);
        expect(refused.body, param).toMatchObject({ code: "invalid" });
      }

      // A token whose user neither manages the file nor works for someone who does: the tool, and the route itself.
      const refusedTool = await send(stranger, second);
      expect(refusedTool.refused).toMatchObject({ code: "not_found" });
      const ownGrant = await stranger.call("upload", { kind: "file" });
      const refusedRoute = await request.post(`${ownGrant.result.url}&versionOf=${file.id}&filename=second.pdf`, { data: second, headers: { "Content-Type": "application/pdf" } });
      expect(refusedRoute.status()).toBe(404);

      // The rule is this upload's alone: the bot may neither promote nor abandon what it uploaded.
      expect(await promoteTestVersion(versions[1].id, bot.user.email)).toMatchObject({ ok: false });
      expect(await abandonTestVersion(versions[1].id, bot.user.email)).toMatchObject({ ok: false });

      // Its person abandons the candidate, and the bot sends the same file
      // again, which is how a wrong upload is put right. It is a new upload,
      // not a repeat of the first: the answer is a new candidate, never the
      // one that is gone.
      expect(await abandonTestVersion(versions[1].id, person.email)).toEqual({ ok: true, number: 2 });
      const resent = await send(bot, second);
      expect(resent.status, JSON.stringify(resent)).toBe(201);
      expect(resent.body).toMatchObject({ version: 3, url: `/pdf/${file.slug}/v/3` });
      // And a retry of that one is answered with it.
      expect((await send(bot, second)).body).toMatchObject({ code: "already_done", result: { version: 3 } });
      versions = await getFileVersionFacts(file.id);
      expect(versions.map(({ number, state, bytesOnDisk }) => `${number} ${state} ${bytesOnDisk}`)).toEqual(["1 latest true", "2 abandoned true", "3 candidate true"]);

      // Its person promotes it.
      await gotoOk(personPage, `/pdf/${file.slug}/v/3`);
      await personPage.getByTestId("pdf-version-banner").getByRole("button", { name: "Promote version 3" }).click();
      await expect(personPage.locator("[data-pdf-viewer]")).toContainText("version 3 (the latest)", { timeout: 60_000 });
      versions = await getFileVersionFacts(file.id);
      expect(versions[2]).toMatchObject({ state: "latest", promotedByEmail: person.email });
      // The latest's bytes again: unchanged, and nothing written.
      const again = await request.post(`${(await bot.call("upload", { kind: "file", versionOf: file.id })).result.url}&filename=again.pdf`, {
        data: second,
        headers: { "Content-Type": "application/pdf" },
      });
      expect(await again.json()).toMatchObject({ unchanged: true });
    } finally {
      await deleteTestFile(file.id);
      await bot.dispose();
      await stranger.dispose();
    }
  });

  test("promoting and abandoning name the version they mean", async ({ page, secondUser }) => {
    const tag = token();
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: copy(tag, "first") });
    try {
      await signIn(page, ADMIN_EMAIL);
      expect((await putVersion(page, file.id, pdfOf(copy(tag, "second")), "second.pdf")).status).toBe(201);
      const second = (await getFileVersionFacts(file.id))[1];

      // A manager opens the candidate's page, and stops to think.
      await gotoOk(page, `/pdf/${file.slug}/v/2`);
      await waitForViewer(page);
      const actions = page.getByTestId("pdf-version-banner").getByTestId("pdf-candidate-actions");
      await expect(actions).toBeVisible();

      // Another manager abandons that candidate and uploads a different one.
      const { user: other } = await secondUser({ role: "ADMIN" });
      expect(await abandonTestVersion(second.id, other.email)).toEqual({ ok: true, number: 2 });
      const { page: otherPage } = await secondUser({ role: "ADMIN" });
      expect((await putVersion(otherPage, file.id, pdfOf(copy(tag, "third")), "third.pdf")).body).toMatchObject({ version: 3 });

      // The first manager's click names version 2, which is no longer the
      // candidate: it is refused, and the version they never saw is not promoted.
      await actions.getByRole("button", { name: "Promote version 2" }).click();
      await expect(actions.getByRole("alert")).toContainText("was abandoned", { timeout: 15_000 });
      let versions = await getFileVersionFacts(file.id);
      expect(versions.map(({ number, state }) => `${number} ${state}`)).toEqual(["1 latest", "2 abandoned", "3 candidate"]);
      // Neither act lands twice, or on a version that has left the state it was clicked in.
      expect(await abandonTestVersion(second.id, ADMIN_EMAIL)).toMatchObject({ ok: false });
      expect(await promoteTestVersion(second.id, ADMIN_EMAIL)).toMatchObject({ ok: false });
      const third = versions[2];
      expect(await promoteTestVersion(third.id, ADMIN_EMAIL)).toEqual({ ok: true, number: 3 });
      expect(await promoteTestVersion(third.id, ADMIN_EMAIL)).toMatchObject({ ok: false });
      expect(await abandonTestVersion(third.id, ADMIN_EMAIL)).toMatchObject({ ok: false });
      // The latest is never abandoned, nor an earlier version.
      expect(await abandonTestVersion(versions[0].id, ADMIN_EMAIL)).toMatchObject({ ok: false });
      versions = await getFileVersionFacts(file.id);
      expect(versions.map(({ number, state, bytesOnDisk }) => `${number} ${state} ${bytesOnDisk}`)).toEqual(["1 earlier true", "2 abandoned false", "3 latest true"]);

      // Someone who can read the file and not manage it does neither.
      const { user: reader } = await secondUser({ role: "AUTHOR" });
      expect((await putVersion(page, file.id, pdfOf(copy(tag, "fourth")), "fourth.pdf")).status).toBe(201);
      const fourth = (await getFileVersionFacts(file.id))[3];
      expect(await promoteTestVersion(fourth.id, reader.email)).toMatchObject({ ok: false });
      expect(await abandonTestVersion(fourth.id, reader.email)).toMatchObject({ ok: false });
      expect((await getFileVersionFacts(file.id))[3].state).toBe("candidate");

      // ---- two managers' clicks on one candidate, at once ------------------
      // One promotes and one abandons, begun together. Each checks under the
      // file row's lock that the version is still the candidate, so exactly
      // one does what it was asked, whichever got there first. Without the
      // lock both pass their check, and the file's latest version is left
      // abandoned, with no bytes. Several rounds, since a race has to overlap
      // to show.
      let candidate = fourth;
      for (let round = 0; round < 5; round++) {
        const { promoted, abandoned } = await raceVersionActs(candidate.id, ADMIN_EMAIL);
        expect([promoted.ok, abandoned.ok].filter(Boolean), `round ${round}: ${JSON.stringify({ promoted, abandoned })}`).toHaveLength(1);
        const after = await getFileVersionFacts(file.id);
        const raced = after.find((version) => version.id === candidate.id)!;
        expect(raced).toMatchObject(promoted.ok ? { state: "latest", bytesOnDisk: true, promotedAtUpdateId: true } : { state: "abandoned", pageTextRows: 0 });
        // The latest always has its bytes and its page text, and is never abandoned.
        const latest = after.filter((version) => version.state === "latest");
        expect(latest).toHaveLength(1);
        expect(latest[0]).toMatchObject({ bytesOnDisk: true });
        expect(latest[0].pageTextRows).toBeGreaterThan(0);
        expect((await putVersion(page, file.id, pdfOf(copy(tag, `round${round}`)), `round-${round}.pdf`)).status).toBe(201);
        candidate = (await getFileVersionFacts(file.id)).at(-1)!;
      }
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("a capture that starts beside a promotion waits for it, and is refused", async ({ request }) => {
    const tag = token();
    const agent = await createAgent(request);
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: copy(tag, "first") });
    try {
      const staged = await request.put(`/api/files/${file.id}?filename=second.pdf`, { data: pdfOf(copy(tag, "second")), headers: { "Content-Type": "application/pdf" } });
      expect(staged.status()).toBe(201);
      const candidate = (await getFileVersionFacts(file.id))[1];

      // A promotion that holds the file row for two seconds before it commits.
      // Until then every other transaction still reads version 1 as the latest.
      const HOLD = 2_000;
      const promotion = promoteTestVersionSlowly(candidate.id, ADMIN_EMAIL, HOLD);
      await new Promise((resolve) => setTimeout(resolve, 400));

      // A note on the bare address, begun meanwhile: it resolves version 1,
      // finds its quote there, and measures it. Its check is inside the
      // transaction that inserts, with the file row locked, so it waits for
      // the promotion and is then refused. A check made before that
      // transaction would pass, and the note would land on version 1 unseen.
      const started = Date.now();
      const note = agent.call("add_note", { on: `/pdf/${file.slug}`, body: `Beside the promotion ${tag}.`, quote: "first copy begins" });
      const link = agent.call("create_link", { links: [{ parts: [{ on: `/pdf/${file.slug}`, quote: "says this of totems" }] }] });
      const [noted, linked, { committedAt }] = await Promise.all([note, link, promotion]);
      expect(noted.isError, JSON.stringify(noted.result)).toBe(true);
      expect(String(noted.error.message)).toContain(RELOAD);
      expect(linked.isError, JSON.stringify(linked.result)).toBe(true);
      // Each answered only once the promotion had committed.
      expect(Date.now()).toBeGreaterThanOrEqual(committedAt);
      expect(Date.now() - started).toBeGreaterThanOrEqual(HOLD - 600);
      // Nothing was written on either version.
      expect(await getFileAnchorVersions(file.id)).toEqual({ annotations: [], linkParts: [] });
      expect((await getFileVersionFacts(file.id)).map(({ number, state }) => `${number} ${state}`)).toEqual(["1 earlier", "2 latest"]);

      // The same note asked again reads the new latest, where the first copy's words are not.
      expect((await agent.call("add_note", { on: `/pdf/${file.slug}`, body: "x", quote: "first copy begins" })).error.code).toBe("no_match");
      // And on version 1's own address it is written, on version 1.
      const onFirst = await agent.call("add_note", { on: `/pdf/${file.slug}/v/1`, body: `On the first copy ${tag}.`, quote: "first copy begins" });
      expect(onFirst.isError, JSON.stringify(onFirst.error)).toBe(false);
      expect((await getFileAnchorVersions(file.id)).annotations).toEqual([file.versionId]);
    } finally {
      await deleteTestFile(file.id);
      await agent.dispose();
    }
  });

  test("a browser's captures begun beside a promotion wait for it, and are refused", async ({ page }) => {
    const tag = token();
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: copy(tag, "first") });
    try {
      await signIn(page, ADMIN_EMAIL);
      expect((await putVersion(page, file.id, pdfOf(copy(tag, "second")), "second.pdf")).status).toBe(201);
      const candidate = (await getFileVersionFacts(file.id))[1];

      // Three tabs on the bare address, each one click from a capture: a
      // draft about to be posted, a selection about to open a draft, and a
      // selection about to join a link. Each of the three is a writer of its
      // own, with its own transaction to check its version in.
      const posting = page;
      await gotoOk(posting, `/pdf/${file.slug}`);
      await waitForViewer(posting);
      await selectPhrase(posting, 1, "Front matter");
      await posting.getByRole("button", { name: "Annotate" }).click();
      const editor = annotationEditor(posting);
      await editor.click();
      await editor.pressSequentially(`A draft beside the promotion ${tag}.`);
      const drafting = await page.context().newPage();
      await gotoOk(drafting, `/pdf/${file.slug}`);
      await waitForViewer(drafting);
      await selectPhrase(drafting, 1, "names participation");
      await expect(drafting.getByRole("button", { name: "Annotate" })).toBeVisible();
      const linking = await page.context().newPage();
      await gotoOk(linking, `/pdf/${file.slug}`);
      await waitForViewer(linking);
      await selectPhrase(linking, 1, "participation here");
      await expect(linking.getByRole("button", { name: "Add to link" })).toBeVisible();
      // The draft is on version 1, which is the latest, and nothing else is written yet.
      expect(await getFileAnchorVersions(file.id)).toEqual({ annotations: [file.versionId], linkParts: [] });

      // The promotion holds the file row before it commits, and the three
      // clicks land while it does. Each writer's check waits for the commit
      // and then finds another version the latest. One that checked before
      // its transaction would have passed, and written on version 1 unseen.
      const HOLD = 5_000;
      const promotion = promoteTestVersionSlowly(candidate.id, ADMIN_EMAIL, HOLD);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const clicked = Date.now();
      await Promise.all([
        posting.getByRole("button", { name: "Save" }).click(),
        drafting.getByRole("button", { name: "Annotate" }).click(),
        linking.getByRole("button", { name: "Add to link" }).click(),
      ]);
      // The clicks landed inside the hold, or this proves nothing.
      expect(Date.now() - clicked).toBeLessThan(HOLD - 1_500);
      for (const tab of [posting, drafting, linking]) {
        await expect(tab.getByText(RELOAD).first()).toBeVisible({ timeout: 30_000 });
      }
      await promotion;
      // Nothing more was written: the draft is still the only row, still on
      // version 1, and neither a second draft nor a link part exists.
      expect(await getFileAnchorVersions(file.id)).toEqual({ annotations: [file.versionId], linkParts: [] });
      expect((await getFileVersionFacts(file.id)).map(({ number, state }) => `${number} ${state}`)).toEqual(["1 earlier", "2 latest"]);
      // The draft was not posted. The latest's page lists it for its writer alone, as a private
      // note of theirs on version 1 that is still to be moved, and lists no posted note.
      await gotoOk(linking, `/pdf/${file.slug}`);
      await waitForViewer(linking);
      const listed = linking.getByTestId("pdf-other-version-notes");
      await expect(listed.locator("li")).toHaveCount(1);
      await expect(listed.getByTestId("pdf-worklist-item")).toContainText("Private note");
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("the link check reads a link on the version it names, and dates one without v=", async ({ request }) => {
    const tag = token();
    const agent = await createAgent(request);
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: copy(tag, "first"), pageLabels: LABELS });
    const docs: string[] = [];
    const check = async (doc: string) => (await promisify(execFile)("npx", ["tsx", "scripts/integrity/check-pdf-fragment-links.ts", "--doc", doc, "--verbose"])).stdout;
    const linking = (href: string) => ({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "See " }, { type: "text", text: "the passage", marks: [{ type: "link", attrs: { href } }] }, { type: "text", text: "." }] }],
    });
    try {
      // Written while the file has one version: a link without v=, as every link then is.
      const unstampedLink = `/pdf/${file.slug}#sheet=2&text=first+copy+begins`;
      const before = await agent.call("create_doc", { markdown: `See [the passage](${unstampedLink}).`, title: `Before ${tag}` });
      expect(before.isError, JSON.stringify(before.error)).toBe(false);
      docs.push(String(before.result.id));

      const staged = await request.put(`/api/files/${file.id}?filename=second.pdf`, { data: pdfOf(copy(tag, "second")), headers: { "Content-Type": "application/pdf" } });
      expect(staged.status()).toBe(201);
      expect(await promoteTestVersion((await getFileVersionFacts(file.id))[1].id, ADMIN_EMAIL)).toEqual({ ok: true, number: 2 });

      // The first doc is edited afterwards, so its history runs across the
      // second version's upload: the check replays it to that moment to see
      // the link was already there. The new link says which version it names.
      const edited = await agent.call("edit_doc", { url: `/doc/${before.result.id}`, edits: [{ append: `And [the new one](/pdf/${file.slug}#sheet=2&v=2&text=second+copy+begins).` }] });
      expect(edited.isError, JSON.stringify(edited.error)).toBe(false);
      let report = await check(String(before.result.id));
      // The old link names version 1 and finds its words there: no fault, though the latest lacks them.
      expect(report).toContain("0 error(s), 0 warning(s)");
      expect(report).toContain("is read on version 1; the latest is version 2");
      expect(report).not.toContain("[unstamped]");

      // The same link, typed by hand into a doc written after the second version: read as version 1's, and warned of.
      const after = await createTestDoc({ authorEmail: ADMIN_EMAIL, body: linking(unstampedLink) });
      docs.push(after.id);
      report = await check(after.id);
      expect(report).toContain("[unstamped]");
      expect(report).toContain("0 error(s), 1 warning(s)");

      // A stamp for a version the file never had is an error; a link on one version's address that names another is a warning.
      const lacking = await createTestDoc({ authorEmail: ADMIN_EMAIL, body: linking(`/pdf/${file.slug}#sheet=2&v=9&text=first+copy+begins`) });
      docs.push(lacking.id);
      expect(await check(lacking.id).catch((err: { stdout?: string }) => err.stdout ?? "")).toContain("[no-such-version]");
      const crossed = await createTestDoc({ authorEmail: ADMIN_EMAIL, body: linking(`/pdf/${file.slug}/v/2#sheet=2&v=1&text=first+copy+begins`) });
      docs.push(crossed.id);
      expect(await check(crossed.id)).toContain("[another-version]");
      // A link to a version's own address is a link into that version, and is checked there.
      const own = await createTestDoc({ authorEmail: ADMIN_EMAIL, body: linking(`/pdf/${file.slug}/v/1#sheet=2&text=first+copy+begins`) });
      docs.push(own.id);
      expect(await check(own.id)).toContain("1 fragment and page link(s) and 0 citation passage(s) checked: 0 error(s), 0 warning(s)");
      // Words the version named doesn't hold are a miss there, whatever the other version holds.
      const missing = await createTestDoc({ authorEmail: ADMIN_EMAIL, body: linking(`/pdf/${file.slug}/v/1#sheet=2&text=second+copy+begins`) });
      docs.push(missing.id);
      expect(await check(missing.id).catch((err: { stdout?: string }) => err.stdout ?? "")).toContain("[no-match]");

      // A link naming an abandoned version: nothing can confirm it.
      expect((await request.put(`/api/files/${file.id}?filename=third.pdf`, { data: pdfOf(copy(tag, "third")), headers: { "Content-Type": "application/pdf" } })).status()).toBe(201);
      expect(await abandonTestVersion((await getFileVersionFacts(file.id))[2].id, ADMIN_EMAIL)).toEqual({ ok: true, number: 3 });
      const abandoned = await createTestDoc({ authorEmail: ADMIN_EMAIL, body: linking(`/pdf/${file.slug}#sheet=2&v=3&text=third+copy+begins`) });
      docs.push(abandoned.id);
      expect(await check(abandoned.id)).toContain("[abandoned-version]");
      // MCP refuses to write either.
      for (const stamp of [3, 9]) {
        const refused = await agent.call("create_doc", { markdown: `See [it](/pdf/${file.slug}#sheet=2&v=${stamp}&text=third+copy+begins).`, title: `Refused ${tag}` });
        expect(refused.error.code, `v=${stamp}`).toBe("no_match");
      }
    } finally {
      for (const id of docs) await deleteTestDoc(id);
      await deleteTestFile(file.id);
      await agent.dispose();
    }
  });

  test("an upload and an abandoning of the same bytes take one lock on the hash", async ({ page }) => {
    const tag = token();
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: copy(tag, "first") });
    const made: string[] = [];
    try {
      await signIn(page, ADMIN_EMAIL);
      const SECOND = copy(tag, "second");
      expect((await putVersion(page, file.id, pdfOf(SECOND), "second.pdf")).status).toBe(201);
      let candidate = (await getFileVersionFacts(file.id))[1];

      // ---- the interleaving the lock exists for, made to happen in order ----
      // The same bytes are uploaded again as a new file: staged while the
      // candidate holds them, so the store finds the blob and writes nothing;
      // recorded while the candidate's abandoning holds the lock on the hash,
      // so its insert waits; and the blob is removed before the lock is let
      // go. Its row would name bytes that are gone: it is refused instead.
      const crossed = await uploadAcrossAbandon({ candidateVersionId: candidate.id, email: ADMIN_EMAIL, pages: SECOND, pageLabels: LABELS });
      expect(crossed.deduped).toBe(true);
      expect(crossed.recorded).toMatchObject({ ok: false, status: 409 });
      expect(crossed.recorded.ok === false && crossed.recorded.error).toContain("Send the file again");
      expect((await getFileVersionFacts(file.id))[1]).toMatchObject({ state: "abandoned", bytesOnDisk: false, pageTextRows: 0 });

      // The same crossing for a version's upload, which has its own insert:
      // the abandoned candidate's bytes are sent again, to this file, and
      // another candidate of them is abandoned underneath.
      expect((await putVersion(page, file.id, pdfOf(SECOND), "second.pdf")).body).toMatchObject({ version: 3 });
      const other = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: copy(tag, "other") });
      made.push(other.id);
      const crossedVersion = await uploadAcrossAbandon({
        candidateVersionId: (await getFileVersionFacts(file.id))[2].id,
        email: ADMIN_EMAIL,
        pages: SECOND,
        pageLabels: LABELS,
        asVersionOf: other.id,
      });
      expect(crossedVersion.deduped).toBe(true);
      expect(crossedVersion.recorded).toMatchObject({ ok: false, status: 409 });
      expect((await getFileVersionFacts(other.id)).length).toBe(1);
      expect((await getFileVersionFacts(file.id))[2]).toMatchObject({ state: "abandoned", bytesOnDisk: false });

      // Sent again, as the refusal says, the bytes are stored anew and the version is made.
      expect((await putVersion(page, file.id, pdfOf(SECOND), "second.pdf")).body).toMatchObject({ version: 4 });
      candidate = (await getFileVersionFacts(file.id))[3];
      expect(candidate).toMatchObject({ number: 4, state: "candidate", bytesOnDisk: true, sha256: (await getFileVersionFacts(file.id))[1].sha256 });

      // ---- an abandoning waits for whoever holds the hash -------------------
      const HOLD = 1_500;
      let held = holdFileHashLock(candidate.sha256, HOLD);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const abandoned = await abandonTestVersion(candidate.id, ADMIN_EMAIL);
      expect(abandoned).toEqual({ ok: true, number: 4 });
      expect(Date.now()).toBeGreaterThanOrEqual((await held).releasedAt);
      expect((await getFileVersionFacts(file.id))[3]).toMatchObject({ state: "abandoned", bytesOnDisk: false });

      // ---- and so does an upload's insert ----------------------------------
      const FOURTH = pdfOf(copy(tag, "fourth"));
      const sha = (await import("node:crypto")).createHash("sha256").update(FOURTH).digest("hex");
      held = holdFileHashLock(sha, HOLD);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const uploaded = await putVersion(page, file.id, FOURTH, "fourth.pdf");
      expect(uploaded).toMatchObject({ status: 201, body: { version: 5 } });
      expect(Date.now()).toBeGreaterThanOrEqual((await held).releasedAt);

      // ---- a version another row shares its bytes with keeps them -----------
      // The candidate's bytes, uploaded as a file of their own; abandoning the candidate leaves that file's blob alone.
      const twin = await page.request.post(`/api/files/upload?filename=${encodeURIComponent(`twin-${tag}.pdf`)}`, { data: FOURTH, headers: { "Content-Type": "application/pdf" } });
      expect(twin.status()).toBe(200);
      made.push(String(((await twin.json()) as { id: string }).id));
      const fifth = (await getFileVersionFacts(file.id))[4];
      expect(await abandonTestVersion(fifth.id, ADMIN_EMAIL)).toEqual({ ok: true, number: 5 });
      expect((await getFileVersionFacts(file.id))[4]).toMatchObject({ state: "abandoned", bytesOnDisk: true, pageTextRows: 0 });
      expect((await getFileVersionFacts(made.at(-1)!))[0]).toMatchObject({ state: "latest", bytesOnDisk: true });

      const { stdout } = await promisify(execFile)("npx", ["tsx", "scripts/integrity/check-file-versions.ts", "--file", file.id]);
      expect(stdout).toContain("0 error(s).");
    } finally {
      for (const id of made) await deleteTestFile(id);
      await deleteTestFile(file.id);
    }
  });
});
