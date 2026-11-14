import { test, expect, signIn, gotoOk, annotationEditor, visibleText } from "./fixtures";
import {
  ADMIN_EMAIL,
  addTestFileVersion,
  createTestFile,
  deleteTestAnchoredLink,
  deleteTestFile,
  getFileAnchorVersions,
  getFileAnnotationFacts,
  renameTestFileSlug,
  type TestFile,
  type TestFileVersion,
} from "./db";
import { createAgent, type Agent } from "./mcp";

// docs/PDF.md §13 — a file with two versions, read at each of its addresses.
//
// Nothing in the app can give a file a second version yet, so the fixture
// does (`addTestFileVersion`): a second, promoted version beside the first,
// with a note, a reply, a link part and an open link's part on version 1.
// Every other spec's file has one version, where a filter by version that is
// missing changes nothing; here it draws a note over other ink, lists it
// twice or links it at the wrong address.
//
// Each version has an id of its own, and neither is the file's (only a
// migrated version 1 shares its file's), so code that passes one id for the
// other finds nothing here.

const V1_LINES = ["The first version speaks of participation.", "It says little else here."];
const V2_LINES = ["The second version speaks of participation again.", "It says rather more now."];
const V1_NOTE_QUOTE = "first version speaks";
const V1_LINK_QUOTE = "says little else";
const V1_DRAFT_PHRASE = "of participation";
const V2_NOTE_QUOTE = "second version speaks";
const V1_NOTE = "A note on version one.";
const V1_REPLY = "A reply on version one.";
const V2_NOTE = "A note on version two.";
const FILE_NOTE = "A note on the whole file.";

type Page = import("@playwright/test").Page;

async function waitForViewer(page: Page) {
  await page.waitForFunction(() => document.querySelector(".pdfViewer .page .textLayer") !== null, undefined, {
    timeout: 30_000,
  });
}

/** The sheet's text as the viewer drew it: which bytes the page is showing. */
async function expectSheetText(page: Page, text: string) {
  await expect(page.locator(".pdfViewer .page[data-page-number='1'] .textLayer")).toContainText(text, { timeout: 30_000 });
}

async function selectPhrase(page: Page, pageNumber: number, needle: string) {
  const found = await page.evaluate(
    ({ pageNumber, needle }) => {
      const layer = document.querySelector(`.pdfViewer .page[data-page-number="${pageNumber}"] .textLayer`);
      if (!layer) return "no text layer";
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.textContent ?? "";
        const index = text.indexOf(needle);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + needle.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return "ok";
      }
      return "phrase not found in any single text node";
    },
    { pageNumber, needle },
  );
  expect(found, `selecting "${needle}" on page ${pageNumber}`).toBe("ok");
  await page.mouse.up();
  await page.dispatchEvent("body", "pointerup");
}

type TwoVersions = {
  file: TestFile;
  v2: TestFileVersion;
  agent: Agent;
  /** The note on version 1, its reply, the note on version 2 and the note with no target. */
  v1Note: { id: string; card: string };
  v1Reply: { id: string; card: string };
  v2Note: { id: string; card: string };
  fileNote: { id: string; card: string };
  linkId: string;
};

/** A card's fragment, from the card URL an MCP write answers. */
const fragmentOf = (card: string) => card.split("#")[1];

/**
 * The file as the fixture leaves it: version 1 with a note, a reply, a note
 * on the whole file and a minted link's part, then version 2 promoted over
 * it with a note of its own. `beforeSecondVersion` runs while version 1 is
 * the only one, for what a browser has to do there.
 */
async function twoVersions(request: import("@playwright/test").APIRequestContext, beforeSecondVersion?: (file: TestFile) => Promise<void>): Promise<TwoVersions> {
  const agent = await createAgent(request);
  const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: [V1_LINES] });
  // A card's name is its writer and the second it was made in, and one bot
  // writes every note here, so each is made in a second of its own.
  let lastSecond = 0;
  const note = async (args: Record<string, unknown>) => {
    while (Math.floor(Date.now() / 1000) <= lastSecond) await new Promise((resolve) => setTimeout(resolve, 100));
    const posted = await agent.call("add_note", args);
    lastSecond = Math.floor(Date.now() / 1000);
    expect(posted.isError, JSON.stringify(posted.error)).toBe(false);
    return { id: String(posted.result.id), card: String(posted.result.card) };
  };
  const v1Note = await note({ on: `/pdf/${file.slug}`, body: V1_NOTE, quote: V1_NOTE_QUOTE });
  const v1Reply = await note({ on: v1Note.id, body: V1_REPLY });
  const fileNote = await note({ on: `/pdf/${file.slug}`, body: FILE_NOTE });
  const minted = await agent.call("create_link", { links: [{ name: "Into version one", parts: [{ on: `/pdf/${file.slug}`, quote: V1_LINK_QUOTE }] }] });
  expect(minted.isError, JSON.stringify(minted.error)).toBe(false);
  const linkId = String((minted.result.links as { url: string }[])[0].url).split("/").pop()!;
  await beforeSecondVersion?.(file);

  const v2 = await addTestFileVersion(file.id, { pages: [V2_LINES] });
  const v2Note = await note({ on: `/pdf/${file.slug}`, body: V2_NOTE, quote: V2_NOTE_QUOTE });
  return { file, v2, agent, v1Note, v1Reply, v2Note, fileNote, linkId };
}

async function dispose(made: TwoVersions | undefined) {
  if (!made) return;
  await deleteTestAnchoredLink(made.linkId).catch(() => {});
  await deleteTestFile(made.file.id);
  await made.agent.dispose();
}

test.describe("a file with two versions", () => {
  test("each version has an id of its own, and every anchor names the version it was measured on", async ({ request }) => {
    let made: TwoVersions | undefined;
    try {
      made = await twoVersions(request);
      const { file, v2 } = made;
      expect(file.versionId).not.toBe(file.id);
      expect(v2.id).not.toBe(file.id);
      expect(v2.id).not.toBe(file.versionId);
      expect(v2.number).toBe(2);

      // The two notes with a target, oldest first, and the one link part. The
      // reply and the note on the whole file have no target and no version.
      const versions = await getFileAnchorVersions(file.id);
      expect(versions.annotations).toEqual([file.versionId, v2.id]);
      expect(versions.linkParts).toEqual([file.versionId]);
    } finally {
      await dispose(made);
    }
  });

  test("what is drawn is one version's, and what is listed is the file's, at each address", async ({ page, request, secondUser }) => {
    let made: TwoVersions | undefined;
    try {
      // A second reader leaves a part of their open link on version 1, while
      // it is the only version: the third source of drawn targets, which
      // reaches the surface from a client store and is narrowed in the browser.
      const { page: reader } = await secondUser({ role: "AUTHOR" });
      made = await twoVersions(request, async (file) => {
        await gotoOk(reader, `/pdf/${file.slug}`);
        await waitForViewer(reader);
        await selectPhrase(reader, 1, V1_DRAFT_PHRASE);
        await reader.getByRole("button", { name: "Add to link" }).click();
        await expect(reader.getByTestId("anchored-link-tray")).toContainText("1 passage", { timeout: 15_000 });
        await expect(reader.locator(".annoRectDraftLink")).not.toHaveCount(0);
      });
      const { file, v1Note, v1Reply, v2Note, fileNote, linkId } = made;
      const highlight = (id: string) => page.locator(`.annoRect[data-anno-id="${id}"]`);
      const others = page.getByTestId("pdf-other-version-notes");
      const banner = page.getByTestId("pdf-version-banner");
      await signIn(page, ADMIN_EMAIL);

      // ---- the bare address: the latest ------------------------------------
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await expectSheetText(page, V2_LINES[0]);
      await expect(page).toHaveTitle(new RegExp(`^${file.title}( |$)`));
      await expect(page).not.toHaveTitle(/version \d/);
      await expect(banner).toHaveCount(0);
      // Drawn: version 2's note, and nothing of version 1's.
      await expect(highlight(v2Note.id)).not.toHaveCount(0, { timeout: 20_000 });
      await expect(highlight(v1Note.id)).toHaveCount(0);
      // Cards: version 2's note and the file's own, which is on every page.
      await expect(page.locator(`#${fragmentOf(v2Note.card)}`)).toBeVisible();
      // In the panel, though beside no passage: a note with no target is not in the rail.
      await expect(page.locator(`#${fragmentOf(fileNote.card)}`)).toBeAttached();
      // Listed under its version, linked at that version's address, and not as a card.
      await expect(others).toContainText("On version 1");
      await expect(others).toContainText(V1_NOTE);
      await expect(others).not.toContainText(V2_NOTE);
      await expect(others.getByRole("link", { name: V1_NOTE })).toHaveAttribute("href", `/pdf/${file.slug}/v/1#${fragmentOf(v1Note.card)}`);
      await expect(page.locator(`[data-margin-note-id="${v1Note.id}"]`)).toHaveCount(0);
      // The version list, once a file has a second version.
      await page.getByRole("tab", { name: "Metadata" }).click();
      const list = page.getByTestId("pdf-version-list");
      await expect(list.locator("[data-version='2']")).toContainText("the latest");
      await expect(list.getByRole("link", { name: "Version 1" })).toHaveAttribute("href", `/pdf/${file.slug}/v/1`);

      // ---- a card's link, written for the bare address, finds a note on version 1
      // Same page, so this is a hashchange: the Metadata pane is open, and
      // the entry's own pane is brought back for it.
      await page.goto(`/pdf/${file.slug}#${fragmentOf(v1Note.card)}`);
      await expect(others.locator(`#${fragmentOf(v1Note.card)}`)).toBeInViewport({ timeout: 20_000 });
      // And on a fresh load, where the island mounts after the browser's own
      // scroll to a fragment has already missed. A reply's link lands on its
      // thread's entry.
      await page.goto(`/pdf/${file.slug}#${fragmentOf(v1Reply.card)}`);
      await page.reload();
      await waitForViewer(page);
      await expect(others.locator(`#${fragmentOf(v1Reply.card)}`)).toBeAttached({ timeout: 20_000 });
      await expect(others.locator(`[data-thread-id="${v1Note.id}"]`)).toBeInViewport({ timeout: 20_000 });

      // ---- version 1's own address -----------------------------------------
      await gotoOk(page, `/pdf/${file.slug}/v/1`);
      await waitForViewer(page);
      await expectSheetText(page, V1_LINES[0]);
      await expect(page).toHaveTitle(new RegExp(`^${file.title}, version 1( |$)`));
      await expect(banner).toContainText("version 1");
      await expect(banner).toContainText("an earlier version");
      await expect(banner.getByRole("link", { name: "version 2" })).toHaveAttribute("href", `/pdf/${file.slug}`);
      await expect(highlight(v1Note.id)).not.toHaveCount(0, { timeout: 20_000 });
      await expect(highlight(v2Note.id)).toHaveCount(0);
      await expect(page.locator(`#${fragmentOf(v1Note.card)}`)).toBeVisible();
      await expect(page.locator(`#${fragmentOf(v1Reply.card)}`)).toBeVisible();
      // In the panel, though beside no passage: a note with no target is not in the rail.
      await expect(page.locator(`#${fragmentOf(fileNote.card)}`)).toBeAttached();
      await expect(others).toContainText("On version 2");
      await expect(others.getByRole("link", { name: V2_NOTE })).toHaveAttribute("href", `/pdf/${file.slug}#${fragmentOf(v2Note.card)}`);
      await expect(others).not.toContainText(V1_NOTE);

      // The banner's link, followed without a reload, shows the latest's
      // bytes and none of version 1's ink: the surface is mounted per version.
      await banner.getByRole("link", { name: "version 2" }).click();
      await expect(page).toHaveURL(new RegExp(`/pdf/${file.slug}$`));
      await expectSheetText(page, V2_LINES[0]);
      await expect(highlight(v2Note.id)).not.toHaveCount(0, { timeout: 20_000 });
      await expect(highlight(v1Note.id)).toHaveCount(0);
      await expect(banner).toHaveCount(0);

      // ---- the latest's own address names its version ------------------------
      await gotoOk(page, `/pdf/${file.slug}/v/2`);
      await waitForViewer(page);
      await expect(page).toHaveTitle(new RegExp(`^${file.title}, version 2( |$)`));
      await expect(page.locator("[data-pdf-viewer]")).toContainText(`${file.title}, version 2 (the latest)`);
      await expect(banner).toHaveCount(0);
      await expect(highlight(v2Note.id)).not.toHaveCount(0, { timeout: 20_000 });

      // `/v<n>` redirects to `/v/<n>`; a number the file never had is no page.
      await page.goto(`/pdf/${file.slug}/v1`);
      await expect(page).toHaveURL(new RegExp(`/pdf/${file.slug}/v/1$`));
      expect((await page.request.get(`/pdf/${file.slug}/v/3`)).status()).toBe(404);
      expect((await page.request.get(`/pdf/${file.slug}/v/01`)).status()).toBe(404);
      expect((await page.request.get(`/pdf/${file.slug}/versions`)).status()).toBe(404);

      // ---- a followed link's parts -----------------------------------------
      // Its one part is on version 1, so that is where it lands, and where it is drawn.
      await page.goto(`/link/${linkId}`);
      await expect(page).toHaveURL(new RegExp(`/pdf/${file.slug}/v/1\\?sel=${linkId}`));
      await waitForViewer(page);
      await expect(page.locator(".pdfViewer .page[data-page-number='1'] .annoRectLink")).not.toHaveCount(0, { timeout: 20_000 });
      // On the latest the part is another version's: named in the banner,
      // linked at its own version, and drawn nowhere.
      await gotoOk(page, `/pdf/${file.slug}?sel=${linkId}`);
      await waitForViewer(page);
      await expectSheetText(page, V2_LINES[0]);
      await expect(highlight(v2Note.id)).not.toHaveCount(0, { timeout: 20_000 });
      await expect(page.locator(".annoRectLink")).toHaveCount(0);
      const elsewhere = page.getByTestId("anchored-link-other-versions");
      await expect(elsewhere).toContainText("on version 1");
      await expect(elsewhere.getByRole("link")).toHaveAttribute("href", `/pdf/${file.slug}/v/1?sel=${linkId}`);
      // The excerpts page names the version its part is on.
      await gotoOk(page, `/link/${linkId}?noredirect=1`);
      await expect(page.getByTestId("anchored-link-group")).toContainText(`${file.title}, version 1`);
      await expect(page.getByTestId("anchored-link-group").getByRole("link", { name: "Open in context" })).toHaveAttribute(
        "href",
        `/pdf/${file.slug}/v/1?sel=${linkId}`,
      );

      // ---- the open link's part --------------------------------------------
      // The reader's draft part is on version 1: painted there, and not on the latest.
      await gotoOk(reader, `/pdf/${file.slug}`);
      await waitForViewer(reader);
      await expectSheetText(reader, V2_LINES[0]);
      await expect(reader.getByTestId("anchored-link-tray")).toContainText("1 passage", { timeout: 15_000 });
      await expect(reader.locator(`.annoRect[data-anno-id="${v2Note.id}"]`)).not.toHaveCount(0, { timeout: 20_000 });
      await expect(reader.locator(".annoRectDraftLink")).toHaveCount(0);
      await gotoOk(reader, `/pdf/${file.slug}/v/1`);
      await waitForViewer(reader);
      await expect(reader.locator(".annoRectDraftLink")).not.toHaveCount(0, { timeout: 20_000 });

      // ---- /annotations: each note under its version's title, at its version's address
      await gotoOk(page, `/annotations?q=${encodeURIComponent("on version")}`);
      const row = (body: string) => page.locator("tr", { hasText: body });
      await expect(row(V1_NOTE).getByRole("link", { name: `${file.title}, version 1` })).toHaveAttribute(
        "href",
        `/pdf/${file.slug}/v/1#${fragmentOf(v1Note.card)}`,
      );
      // A reply has no target of its own: it is on its root's version.
      await expect(row(V1_REPLY).getByRole("link", { name: `${file.title}, version 1` })).toHaveAttribute(
        "href",
        `/pdf/${file.slug}/v/1#${fragmentOf(v1Reply.card)}`,
      );
      await expect(row(V2_NOTE).getByRole("link", { name: file.title, exact: true })).toHaveAttribute(
        "href",
        `/pdf/${file.slug}#${fragmentOf(v2Note.card)}`,
      );
    } finally {
      await dispose(made);
    }
  });

  test("the bytes, the downloads, search and MCP answer by version", async ({ page, request }) => {
    let made: TwoVersions | undefined;
    try {
      made = await twoVersions(request);
      const { file, v2, agent, v1Note, v1Reply, v2Note, fileNote, linkId } = made;
      await signIn(page, ADMIN_EMAIL);

      // ---- bytes: the hash a URL names, or nothing --------------------------
      const bytesOf = async (sha: string) => {
        const response = await page.request.get(`/api/files/${file.id}/${sha}`);
        return { status: response.status(), etag: response.headers()["etag"], cache: response.headers()["cache-control"] };
      };
      expect(await bytesOf(file.sha256)).toMatchObject({ status: 200, etag: `"${file.sha256}"`, cache: expect.stringContaining("immutable") });
      expect(await bytesOf(v2.sha256)).toMatchObject({ status: 200, etag: `"${v2.sha256}"` });
      // A hash no version holds is 404, never the current bytes.
      expect((await bytesOf("0".repeat(64))).status).toBe(404);

      // ---- downloads: each version under its own filename -------------------
      const hop = async (path: string) => (await page.request.get(path, { maxRedirects: 0 })).headers()["location"];
      expect(await hop(`/files/${file.slug}/download`)).toBe(`/api/files/${file.id}/${v2.sha256}?download=1`);
      expect(await hop(`/files/${file.slug}/v/1/download`)).toBe(`/api/files/${file.id}/${file.sha256}?download=1&v=1`);
      expect(await hop(`/files/${file.slug}/v/2/download`)).toBe(`/api/files/${file.id}/${v2.sha256}?download=1&v=2`);
      const saved = async (path: string) => (await page.request.get(path)).headers()["content-disposition"];
      expect(await saved(`/files/${file.slug}/v/1/download`)).toMatch(/^attachment; filename="[^"]*(?<!-v2)\.pdf"/);
      expect(await saved(`/files/${file.slug}/v/2/download`)).toContain("-v2.pdf");
      expect(await saved(`/files/${file.slug}/download`)).toContain("-v2.pdf");
      // A version that doesn't hold the hash names no download of it.
      expect((await page.request.get(`/api/files/${file.id}/${file.sha256}?download=1&v=2`)).status()).toBe(404);
      expect((await page.request.get(`/files/${file.slug}/v/3/download`, { maxRedirects: 0 })).status()).toBe(404);
      await gotoOk(page, `/files/${file.slug}/v/1`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${file.title}, version 1`);

      // ---- MCP's download: the address asked for is the version sent ---------
      const downloaded = async (ref: string, extra = "") => {
        const grant = await agent.call("download", { file: ref });
        expect(grant.isError, JSON.stringify(grant.error)).toBe(false);
        const url = String(grant.result.url);
        const response = await request.get(`${url}${extra}`);
        return { named: /[?&]v=(\d+)/.exec(url)?.[1] ?? null, status: response.status(), etag: response.headers()["etag"] };
      };
      expect(await downloaded(`/pdf/${file.slug}`)).toEqual({ named: null, status: 200, etag: `"${v2.sha256}"` });
      expect(await downloaded(`/pdf/${file.slug}/v/1`)).toEqual({ named: "1", status: 200, etag: `"${file.sha256}"` });
      expect(await downloaded(`/files/${file.slug}/v/2`)).toEqual({ named: "2", status: 200, etag: `"${v2.sha256}"` });
      // The route's own parameter, on a grant for the file.
      expect(await downloaded(`/pdf/${file.slug}`, "&v=1")).toMatchObject({ status: 200, etag: `"${file.sha256}"` });
      expect((await downloaded(`/pdf/${file.slug}`, "&v=3")).status).toBe(404);
      expect((await downloaded(`/pdf/${file.slug}`, "&v=01")).status).toBe(404);

      // ---- the presence channel is a version's ------------------------------
      const channel = async (query: string) => {
        const response = await page.request.post(`/api/file/${file.id}/token${query}`);
        return response.ok() ? ((await response.json()) as { documentName: string }).documentName : response.status();
      };
      expect(await channel("")).toBe(`ydoc:pdf:${v2.id}`);
      expect(await channel(`?v=${v2.id}`)).toBe(`ydoc:pdf:${v2.id}`);
      expect(await channel(`?v=${file.versionId}`)).toBe(`ydoc:pdf:${file.versionId}`);
      expect(await channel(`?v=${file.id}`)).toBe(404);

      // ---- search ranks the latest version's pages alone -------------------
      const pagesHit = async (q: string) => {
        const found = await agent.call("search", { q, kinds: ["pdfs"], exact: true });
        expect(found.isError, JSON.stringify(found.error)).toBe(false);
        return JSON.stringify(found.result);
      };
      expect(await pagesHit(`"says rather more"`)).toContain(`/pdf/${file.slug}`);
      expect(await pagesHit(`"says little else"`)).not.toContain(`/pdf/${file.slug}`);
      // A note's hit names its version and is linked there.
      const noteHits = JSON.stringify((await agent.call("search", { q: `"note on version one"`, kinds: ["annotations"], exact: true })).result);
      expect(noteHits).toContain(`/pdf/${file.slug}/v/1`);
      expect(noteHits).toContain(`${file.title}, version 1`);

      // ---- MCP's read -------------------------------------------------------
      const read = async (args: Record<string, unknown>) => {
        const answer = await agent.call("read", args);
        expect(answer.isError, JSON.stringify(answer.error)).toBe(false);
        return answer.result;
      };
      // The bare address is the latest; a version's own is that version.
      expect(JSON.stringify(await read({ url: `/pdf/${file.slug}`, page: 1 }))).toContain("second version speaks");
      const first = await read({ url: `/pdf/${file.slug}/v/1`, page: 1 });
      expect(JSON.stringify(first)).toContain("first version speaks");
      expect(first.url).toBe(`/pdf/${file.slug}/v/1`);
      expect((await agent.call("read", { url: `/pdf/${file.slug}/v/3` })).error.code).toBe("not_found");

      // Threads on the bare address: the latest's, then those on other
      // versions, each naming its version; the file's own note among them.
      type Group = { version?: number; page?: number; unanchored?: true; threads: { id: string }[] };
      const groupsOf = async (url: string) => ((await read({ url, include: ["annotations"] })).threads as { groups: Group[] }).groups;
      const bare = await groupsOf(`/pdf/${file.slug}`);
      const idsIn = (groups: Group[]) => groups.flatMap((group) => group.threads.map((thread) => thread.id));
      expect(idsIn(bare)).toEqual([v2Note.id, v1Note.id, fileNote.id]);
      expect(bare.find((group) => group.threads[0].id === v1Note.id)).toMatchObject({ version: 1, page: 1 });
      expect(bare.find((group) => group.threads[0].id === v2Note.id)?.version).toBeUndefined();
      // A version's own address answers that version's, with the file's own.
      expect(idsIn(await groupsOf(`/pdf/${file.slug}/v/1`))).toEqual([v1Note.id, fileNote.id]);
      expect(idsIn(await groupsOf(`/pdf/${file.slug}/v/2`))).toEqual([v2Note.id, fileNote.id]);

      // A card's URL, written for the bare address, answers the thread on the
      // version that holds it, and names that version. A reply's does too.
      for (const card of [v1Note.card, v1Reply.card]) {
        const thread = await read({ url: card });
        expect(thread.container).toMatchObject({ url: `/pdf/${file.slug}/v/1`, title: `${file.title}, version 1`, page: 1 });
        expect(String(thread.card)).toBe(`/pdf/${file.slug}/v/1#${fragmentOf(v1Note.card)}`);
      }
      expect((await read({ url: v2Note.card })).container).toMatchObject({ url: `/pdf/${file.slug}`, title: file.title });

      // A link's part is read on its own version, and the file's parts are
      // listed by version as its threads are.
      const link = await read({ url: `/link/${linkId}` });
      expect((link.groups as { target: string; title: string }[])[0]).toMatchObject({ target: `/pdf/${file.slug}/v/1`, title: `${file.title}, version 1` });
      const partsOf = async (url: string) => (await read({ url, include: ["links"] })).links as { total: number; parts: { version?: number }[] };
      expect(await partsOf(`/pdf/${file.slug}`)).toMatchObject({ total: 1, parts: [{ version: 1 }] });
      expect((await partsOf(`/pdf/${file.slug}/v/1`)).total).toBe(1);
      expect((await partsOf(`/pdf/${file.slug}/v/2`)).total).toBe(0);

      // `within` a version's address searches that version's pages.
      const within = async (url: string, q: string) =>
        ((await agent.call("search", { q, within: url, exact: true })).result as { total?: number }).total ?? 0;
      expect(await within(`/pdf/${file.slug}/v/1`, `"says little else"`)).toBe(1);
      expect(await within(`/pdf/${file.slug}`, `"says little else"`)).toBe(0);
      expect(await within(`/pdf/${file.slug}`, `"says rather more"`)).toBe(1);

      // ---- a renamed file's old slug keeps the rest of the address ----------
      // A version has no slug of its own: it follows its file's.
      const oldSlug = file.slug;
      file.slug = await renameTestFileSlug(file.id);
      const moved = async (path: string) => (await page.request.get(path, { maxRedirects: 0 })).headers()["location"];
      expect(await moved(`/pdf/${oldSlug}/v/1`)).toBe(`/pdf/${file.slug}/v/1`);
      expect(await moved(`/pdf/${oldSlug}/v/1?sel=${linkId}`)).toBe(`/pdf/${file.slug}/v/1?sel=${linkId}`);
      expect(await moved(`/pdf/${oldSlug}`)).toBe(`/pdf/${file.slug}`);
      expect(await moved(`/files/${oldSlug}/v/1`)).toBe(`/files/${file.slug}/v/1`);
    } finally {
      await dispose(made);
    }
  });
  test("a capture names the version its viewer loaded, and its write checks it", async ({ page, request }) => {
    const agent = await createAgent(request);
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: [V1_LINES] });
    const RELOAD = "Reload the page";
    const tray = page.getByTestId("anchored-link-tray");
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await expectSheetText(page, V1_LINES[0]);

      // A second version is promoted while this tab stays open on the bare
      // address. The tab still shows version 1's bytes and isn't told.
      const v2 = await addTestFileVersion(file.id, { pages: [V2_LINES] });

      // ---- the stale tab: every capture is refused, and nothing is written --
      await selectPhrase(page, 1, V1_DRAFT_PHRASE);
      await page.getByRole("button", { name: "Add to link" }).click();
      await expect(page.getByText(RELOAD).first()).toBeVisible({ timeout: 15_000 });
      await selectPhrase(page, 1, V1_NOTE_QUOTE);
      await page.getByRole("button", { name: "Annotate" }).click();
      await expect(page.getByText(RELOAD).first()).toBeVisible({ timeout: 15_000 });
      expect(await getFileAnchorVersions(file.id)).toEqual({ annotations: [], linkParts: [] });

      // ---- version 1's own address: its page has said which version it is ----
      // A note and a link part made there are on version 1, though it is no
      // longer the latest.
      await gotoOk(page, `/pdf/${file.slug}/v/1`);
      await waitForViewer(page);
      await selectPhrase(page, 1, V1_DRAFT_PHRASE);
      await page.getByRole("button", { name: "Add to link" }).click();
      await expect(tray).toContainText("1 passage", { timeout: 15_000 });
      await selectPhrase(page, 1, V1_NOTE_QUOTE);
      await page.getByRole("button", { name: "Annotate" }).click();
      const editor = annotationEditor(page);
      await editor.click();
      await editor.pressSequentially("Made on version one's own page.");
      await page.getByRole("button", { name: "Save" }).click();
      // The composer collapsing back to its placeholder is the signal that
      // the post landed: the draft row has its target and version from the
      // moment the composer opened, so neither says the note was posted.
      await expect(page.getByRole("button", { name: "Write an annotation..." })).toBeVisible({ timeout: 15_000 });
      await expect(visibleText(page, "Made on version one's own page.")).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await getFileAnchorVersions(file.id)).annotations, { timeout: 15_000 }).toEqual([file.versionId]);
      expect((await getFileAnchorVersions(file.id)).linkParts).toEqual([file.versionId]);
      // Drawn here, and not on the latest, where it is listed under its version.
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await expectSheetText(page, V2_LINES[0]);
      await expect(page.getByTestId("pdf-other-version-notes")).toContainText("Made on version one's own page.");
      await expect(page.locator(".annoRect[data-anno-id]")).toHaveCount(0);

      // ---- the reloaded bare address: a capture is on the latest -------------
      await selectPhrase(page, 1, V2_NOTE_QUOTE);
      await page.getByRole("button", { name: "Add to link" }).click();
      await expect(tray).toContainText("2 passages", { timeout: 15_000 });
      await expect
        .poll(async () => [...(await getFileAnchorVersions(file.id)).linkParts].sort(), { timeout: 15_000 })
        .toEqual([file.versionId, v2.id].sort());

      // ---- MCP: the address read is the version written ---------------------
      const onFirst = await agent.call("add_note", { on: `/pdf/${file.slug}/v/1`, body: "The bot, on version one.", quote: V1_LINK_QUOTE });
      expect(onFirst.isError, JSON.stringify(onFirst.error)).toBe(false);
      expect(String(onFirst.result.card)).toMatch(new RegExp(`^/pdf/${file.slug}/v/1#`));
      const onLatest = await agent.call("add_note", { on: `/pdf/${file.slug}`, body: "The bot, on the latest.", quote: "says rather more" });
      expect(onLatest.isError, JSON.stringify(onLatest.error)).toBe(false);
      expect(String(onLatest.result.card)).toMatch(new RegExp(`^/pdf/${file.slug}#`));
      // Version 1's words are not the latest's: the bare address quotes the latest alone.
      expect((await agent.call("add_note", { on: `/pdf/${file.slug}`, body: "x", quote: V1_LINK_QUOTE })).error.code).toBe("no_match");
      const linked = await agent.call("create_link", { links: [{ parts: [{ on: `/pdf/${file.slug}/v/1`, quote: V1_LINK_QUOTE }] }] });
      expect(linked.isError, JSON.stringify(linked.error)).toBe(false);
      const versions = await getFileAnchorVersions(file.id);
      expect(versions.annotations).toEqual([file.versionId, file.versionId, v2.id]);
      expect([...versions.linkParts].sort()).toEqual([file.versionId, file.versionId, v2.id].sort());

      // ---- a candidate takes no note and no link part -----------------------
      const v3 = await addTestFileVersion(file.id, { pages: [["A third version, not yet promoted.", "It waits."]], promote: false });
      expect(v3.number).toBe(3);
      const refusedNote = await agent.call("add_note", { on: `/pdf/${file.slug}/v/3`, body: "x", quote: "third version" });
      expect(refusedNote.error.code).toBe("conflict");
      const refusedLink = await agent.call("create_link", { links: [{ parts: [{ on: `/pdf/${file.slug}/v/3`, quote: "third version" }] }] });
      expect(refusedLink.error.code).toBe("conflict");
      // Its page is readable, says what it is, and refuses a capture made on it.
      await gotoOk(page, `/pdf/${file.slug}/v/3`);
      await waitForViewer(page);
      await expectSheetText(page, "A third version");
      await expect(page.getByTestId("pdf-version-banner")).toContainText("not yet the latest");
      await selectPhrase(page, 1, "third version");
      await page.getByRole("button", { name: "Add to link" }).click();
      await expect(page.getByText("takes no notes or link parts").first()).toBeVisible({ timeout: 15_000 });
      // The bare address still shows version 2: an upload changes nothing until it is promoted.
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await expectSheetText(page, V2_LINES[0]);
      // A note with no target is the file's, and may be written from a candidate's address.
      const whole = await agent.call("add_note", { on: `/pdf/${file.slug}/v/3`, body: "On the whole file, from the candidate." });
      expect(whole.isError, JSON.stringify(whole.error)).toBe(false);
      expect((await getFileAnchorVersions(file.id)).annotations).toEqual([file.versionId, file.versionId, v2.id]);
    } finally {
      await deleteTestFile(file.id);
      await agent.dispose();
    }
  });

  test("a draft is posted from a page showing its version, and a post that page can't make keeps it", async ({ page }) => {
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: [V1_LINES] });
    const KEPT = "A private note, kept for later.";
    const OPEN = "A draft left open when another is reopened.";
    const STALE = "Typed before the promotion, posted after.";
    const privateNotes = page.getByText("Your private notes").locator("..");
    const listed = (body: string) => privateNotes.locator("li", { hasText: body });
    const posted = async () => (await getFileAnnotationFacts(file.id)).map((note) => ({ body: note.bodyText, quote: note.quotedText }));
    const openDraft = async (quote: string, body: string) => {
      await selectPhrase(page, 1, quote);
      await page.getByRole("button", { name: "Annotate" }).click();
      const editor = annotationEditor(page);
      await editor.click();
      await editor.pressSequentially(body);
    };
    const savePrivately = async () => {
      await page.getByRole("combobox", { name: "Annotation visibility" }).selectOption("private");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("button", { name: "Write an annotation..." })).toBeVisible({ timeout: 15_000 });
    };
    try {
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);

      // ---- one version, as every file has today -----------------------------
      // Reopening a private note while another draft is open posts the open
      // one, with its passage. The post names the page's version like any
      // other; one that didn't was refused, and the draft discarded for it.
      await openDraft(V1_LINK_QUOTE, KEPT);
      await savePrivately();
      await expect(listed(KEPT)).toBeVisible({ timeout: 15_000 });
      await openDraft(V1_NOTE_QUOTE, OPEN);
      await listed(KEPT).getByRole("button", { name: "Edit" }).click();
      await expect(annotationEditor(page)).toHaveText(KEPT, { timeout: 15_000 });
      await expect.poll(posted, { timeout: 15_000 }).toEqual([{ body: OPEN, quote: V1_NOTE_QUOTE }]);
      await savePrivately();
      await expect(listed(KEPT)).toBeVisible({ timeout: 15_000 });

      // ---- a second version is promoted under an open composer --------------
      await openDraft(V1_DRAFT_PHRASE, STALE);
      const v2 = await addTestFileVersion(file.id, { pages: [V2_LINES] });
      // The same gesture now can't post the open draft: this page shows
      // version 1 at the address that means "the latest". The draft has
      // words, so it is kept, where an empty one would be discarded.
      await listed(KEPT).getByRole("button", { name: "Edit" }).click();
      await expect(annotationEditor(page)).toHaveText(KEPT, { timeout: 15_000 });
      // And the composer's own post (SHARED is the select's default) is
      // refused, with the reason.
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText("Reload the page").first()).toBeVisible({ timeout: 15_000 });
      expect(await posted()).toEqual([{ body: OPEN, quote: V1_NOTE_QUOTE }]);

      // ---- reloaded: the latest's page lists both drafts under their version
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await expectSheetText(page, V2_LINES[0]);
      for (const body of [KEPT, STALE]) {
        await expect(listed(body).getByRole("link", { name: "On version 1" })).toHaveAttribute("href", `/pdf/${file.slug}/v/1`, { timeout: 15_000 });
      }
      // Reopened where its passage is, and nowhere else.
      await expect(privateNotes.getByRole("button", { name: "Edit" })).toHaveCount(0);

      // ---- version 1's page reopens and posts it, on version 1 ---------------
      await listed(STALE).getByRole("link", { name: "On version 1" }).click();
      await expect(page).toHaveURL(new RegExp(`/pdf/${file.slug}/v/1$`));
      await waitForViewer(page);
      await listed(STALE).getByRole("button", { name: "Edit" }).click();
      await expect(annotationEditor(page)).toHaveText(STALE, { timeout: 15_000 });
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("button", { name: "Write an annotation..." })).toBeVisible({ timeout: 15_000 });
      await expect.poll(posted, { timeout: 15_000 }).toEqual([
        { body: OPEN, quote: V1_NOTE_QUOTE },
        { body: STALE, quote: V1_DRAFT_PHRASE },
      ]);
      // Both posted notes and the private one are version 1's; nothing is on version 2.
      const versions = (await getFileAnchorVersions(file.id)).annotations;
      expect(versions).toEqual([file.versionId, file.versionId, file.versionId]);
      expect(versions).not.toContain(v2.id);

      // ---- a deleted note is listed on no version's page --------------------
      // Deletion keeps the row, so the list of notes on other versions has to
      // let go of it as the cards do.
      // Dispatched, not clicked: with two cards in the rail this one sits
      // under the panel's toolbar until the rail is scrolled, and where a
      // card rests is not what is being tested.
      await page.locator("[data-margin-note-id]", { hasText: OPEN }).getByRole("button", { name: "Delete", exact: true }).dispatchEvent("click");
      await page.getByRole("button", { name: "Yes", exact: true }).dispatchEvent("click");
      await expect(page.locator("[data-margin-note-id]", { hasText: OPEN })).toHaveCount(0, { timeout: 20_000 });
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      const others = page.getByTestId("pdf-other-version-notes");
      await expect(others).toContainText(STALE, { timeout: 15_000 });
      await expect(others).not.toContainText(OPEN);
      await expect(others).not.toContainText("(deleted)");
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("a version's address, bytes and channel are behind its file's gate", async ({ page, request, secondUser }) => {
    const agent = await createAgent(request);
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "PRIVATE", pages: [V1_LINES] });
    try {
      const v2 = await addTestFileVersion(file.id, { pages: [V2_LINES] });
      // The owner reads every address.
      await signIn(page, ADMIN_EMAIL);
      expect((await page.request.get(`/pdf/${file.slug}/v/1`)).status()).toBe(200);
      expect((await page.request.get(`/api/files/${file.id}/${file.sha256}`)).status()).toBe(200);

      // A signed-in reader the file isn't shared with gets, at a version's
      // address, exactly what the bare address answers them.
      const { page: outsider } = await secondUser({ role: "AUTHOR" });
      const status = async (path: string) => (await outsider.request.get(path)).status();
      // A refused page is a 200 that says so, so what is compared is what it
      // lets out: the file's title, its id (the bytes' address) and a hash.
      const shown = async (path: string) => {
        const response = await outsider.request.get(path);
        const html = await response.text();
        return { status: response.status(), leaks: [file.title, file.id, file.sha256, v2.sha256].filter((secret) => html.includes(secret)) };
      };
      for (const root of ["pdf", "files"]) {
        const bare = await shown(`/${root}/${file.slug}`);
        expect(bare.leaks).toEqual([]);
        expect(await shown(`/${root}/${file.slug}/v/1`)).toEqual(bare);
        expect(await shown(`/${root}/${file.slug}/v/2`)).toEqual(bare);
      }
      expect(await status(`/files/${file.slug}/v/1/download`)).toBe(await status(`/files/${file.slug}/download`));
      const latestBytes = await status(`/api/files/${file.id}/${v2.sha256}`);
      expect(latestBytes).toBeGreaterThanOrEqual(400);
      expect(await status(`/api/files/${file.id}/${file.sha256}`)).toBe(latestBytes);
      // The channel's gate answers before anything about the version does:
      // an id that is a version and one that is not are refused alike.
      const channel = async (query: string) => (await outsider.request.post(`/api/file/${file.id}/token${query}`)).status();
      expect(await channel("")).toBe(403);
      expect(await channel(`?v=${file.versionId}`)).toBe(403);
      expect(await channel(`?v=${file.id}`)).toBe(403);

      // A token whose account can't read the file: a version's address is as absent as the file's.
      const code = async (args: Record<string, unknown>, tool = "read") => (await agent.call(tool, args)).error?.code;
      const absent = await code({ url: `/pdf/${file.slug}` });
      expect(absent).toBeTruthy();
      expect(await code({ url: `/pdf/${file.slug}/v/1` })).toBe(absent);
      expect(await code({ file: `/pdf/${file.slug}/v/1` }, "download")).toBe(await code({ file: `/pdf/${file.slug}` }, "download"));
      expect(await code({ on: `/pdf/${file.slug}/v/1`, body: "x", quote: V1_NOTE_QUOTE }, "add_note")).toBeTruthy();
    } finally {
      await deleteTestFile(file.id);
      await agent.dispose();
    }
  });
});
