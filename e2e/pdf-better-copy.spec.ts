import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, signIn, gotoOk, annotationEditor, visibleText } from "./fixtures";
import {
  ADMIN_EMAIL,
  addTestFileVersion,
  carryAcrossChanges,
  createTestAnnotation,
  createTestApiToken,
  createTestDoc,
  createTestFile,
  deleteTestDoc,
  deleteTestFile,
  deleteTestReferences,
  getFileAnchorMoves,
  getFileAnchorRows,
  getFileVersionFacts,
  setTestReferenceFile,
  undoCarryInSql,
  type TestAnchorRow,
  type TestFile,
} from "./db";
import { callTool, createAgent } from "./mcp";
import { expectAddress, expectSheetText, selectPhrase, token, waitForViewer, type Page } from "./pdf-version-helpers";
import { buildTestPdf, type TestPageLabelRange } from "../scripts/make-test-pdf";

// docs/PDF.md §13 — a better copy of the same text: uploaded as one, its
// pages matched with the latest's as soon as the upload has answered, and
// every link written against the earlier copy carried to it through the map.
//
// Two copies of one text. The second has its first sheet removed, a blank
// sheet added and one word changed, "modem" corrected to "modern":
//
//   first copy   1 cover   2 A      3 B (modem)   4 plate   5 C
//   better copy            1 A   2 blank   3 B (modern)   4 plate   5 C
//
// So the first copy's sheet 2 is the better copy's sheet 1, and its sheets 3
// to 5 keep their numbers.

// The first copy: a roman cover and an arabic body. Labels i, 1, 2, 3, 4.
const FIRST_LABELS: TestPageLabelRange[] = [
  { from: 1, style: "r" },
  { from: 2, style: "D" },
];
// The better copy: labels 1, none, 2, 3, 4. The blank sheet has no label of its own.
const BETTER_LABELS: TestPageLabelRange[] = [{ from: 1, style: "D" }, { from: 2 }, { from: 3, style: "D", start: 2 }];

const sheetA = (tag: string) => [
  `Participation is the first chapter's word ${tag}.`,
  "Every tribe the ethnographers met had a law of participation.",
  "The phenomena were not yet objects set over against a subject.",
  "A reader may annotate the word participation on this sheet.",
];
const sheetB = (tag: string, mind: "modem" | "modern") => [
  `The second chapter turns to the ${mind} mind ${tag}.`,
  "Here the scan misread a single word of the printed text.",
  "Idolatry is the name the argument gives to forgetting that.",
  "A passage about collective representations ends the sheet.",
];
const sheetC = (tag: string) => [
  `The last chapter gathers the argument ${tag}.`,
  "Final participation is what the imagination may yet achieve.",
  "A linked passage about symptoms of iconoclasm stands here.",
  "The book closes on a question about the future of meaning.",
];

const firstCopy = (tag: string): string[][] => [
  [`A cover sheet of the first copy ${tag}.`, "It was scanned with the book, and the better copy leaves it out."],
  sheetA(tag),
  sheetB(tag, "modem"),
  [],
  sheetC(tag),
];
const betterCopy = (tag: string): string[][] => [sheetA(tag), [], sheetB(tag, "modern"), [], sheetC(tag)];
const betterPdf = (tag: string): Buffer => Buffer.from(buildTestPdf(betterCopy(tag), { pageLabels: BETTER_LABELS, inked: [4] }));

/** The first copy's sheet 2 against the better copy's five: removed, then sheet 1, and the rest where they were. */
const MAP = [-1, 0, 2, 3, 4];

const fragmentBanner = (page: Page) => page.getByTestId("pdf-fragment-banner");

/** Opens a link from another page, so the page for the latest loads first and the viewer reads the fragment on arrival. */
async function follow(page: Page, address: string) {
  await gotoOk(page, "/files");
  await page.goto(address);
}

test.describe("a better copy of the same text", () => {
  test("its pages are matched at the upload, and links written against the earlier copy are carried to it", async ({ page, request, secondUser }) => {
    test.setTimeout(300_000);
    const tag = token();
    const agent = await createAgent(request);
    const file: TestFile = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: firstCopy(tag), pageLabels: FIRST_LABELS, inked: [4] });
    const at = `/pdf/${file.slug}`;
    const banner = page.getByTestId("pdf-version-banner");
    const prefix = `e2ecopy${Date.now().toString(36)}`;
    const key = `${prefix}-work`;
    const docs: string[] = [];
    try {
      // ---- the upload, as a better copy ------------------------------------
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, at);
      await waitForViewer(page);
      await page.getByRole("tab", { name: "Metadata" }).click();
      const chooser = page.waitForEvent("filechooser");
      await page.getByTestId("pdf-upload-better-copy").click();
      await (await chooser).setFiles({ name: "better-copy.pdf", mimeType: "application/pdf", buffer: betterPdf(tag) });
      // The map is asked for before the candidate's page opens, so that page can say what it found.
      await expect(page).toHaveURL(new RegExp(`${at}/v/2$`), { timeout: 90_000 });
      await waitForViewer(page);

      let versions = await getFileVersionFacts(file.id);
      expect(versions[1]).toMatchObject({ number: 2, state: "candidate", baseNumber: 1 });
      expect(versions[1].pageMap).toEqual({ sheets: MAP, openRuns: 0, storedByEmail: ADMIN_EMAIL, carryId: null });
      expect(versions[0].pageMap).toBeNull();

      // The candidate's page says what the map found, in numbers, and links its page.
      const actions = banner.getByTestId("pdf-candidate-actions");
      await expect(actions.getByTestId("pdf-candidate-map")).toContainText("4 sheets paired, 1 removed and 0 unmapped");
      await expect(actions.getByTestId("pdf-candidate-map").getByRole("link")).toHaveAttribute("href", `${at}/v/2/map`);
      await expect(actions).toContainText("A link written against version 1 is carried to version 2.");

      // ---- the map's own page ----------------------------------------------
      await gotoOk(page, `${at}/v/2/map`);
      await expect(page.getByTestId("pdf-map-numbers")).toContainText("4 paired, 1 removed, 0 unmapped");
      await expect(page.getByTestId("pdf-map-paired")).toContainText("2 → 1; 3–5 → 3–5");
      await expect(page.getByTestId("pdf-map-removed")).toContainText("1.");
      await expect(page.getByTestId("pdf-map-run")).toHaveCount(0);
      // It is its managers' page: a reader who may read the file is refused it.
      const { page: reader } = await secondUser({ role: "AUTHOR" });
      await reader.goto(`${at}/v/2/map`);
      await expect(reader.getByRole("heading", { name: "Forbidden" })).toBeVisible();
      // Version 1 has no earlier version to be matched with.
      await gotoOk(page, `${at}/v/1/map`);
      await expect(page.getByText("this file's first")).toBeVisible();

      // ---- a link is carried while the better copy still waits -------------
      // On the candidate's own address, a link stamped with version 1 is brought to it.
      await page.goto(`${at}/v/2#sheet=2&v=1&text=law+of+participation`);
      await waitForViewer(page);
      await expect(fragmentBanner(page).getByTestId("pdf-fragment-carried")).toContainText("Read as version 1: its sheet 2 is sheet 1 here", { timeout: 30_000 });
      // And on the bare address, which still shows version 1, an unstamped link is version 1's own.
      await follow(page, `${at}#sheet=2&text=law+of+participation`);
      await expectAddress(page, `${at}#sheet=2&text=law+of+participation`);
      await waitForViewer(page);
      await expect(fragmentBanner(page)).toContainText("law of participation", { timeout: 30_000 });
      await expect(fragmentBanner(page).getByTestId("pdf-fragment-carried")).toHaveCount(0);

      // ---- promoted: the bare address shows the better copy ----------------
      await gotoOk(page, `${at}/v/2`);
      await waitForViewer(page);
      await banner.getByRole("button", { name: "Promote version 2" }).click();
      await expect(page.locator("[data-pdf-viewer]")).toContainText(`${file.title}, version 2 (the latest)`, { timeout: 60_000 });
      versions = await getFileVersionFacts(file.id);
      expect(versions.map(({ number, state }) => ({ number, state }))).toEqual([
        { number: 1, state: "earlier" },
        { number: 2, state: "latest" },
      ]);

      // ---- where each link written against version 1 lands -----------------
      // By sheet: it stays on the bare address, opens the sheet its own became, and says how it was read.
      await follow(page, `${at}#sheet=2&text=law+of+participation`);
      await expectAddress(page, `${at}#sheet=2&text=law+of+participation`);
      await waitForViewer(page);
      await expectSheetText(page, `Participation is the first chapter's word ${tag}`, 1);
      const carried = fragmentBanner(page).getByTestId("pdf-fragment-carried");
      await expect(carried).toContainText("Read as version 1: its sheet 2 is sheet 1 here", { timeout: 30_000 });
      await expect(fragmentBanner(page)).toContainText("law of participation");
      // The link as it is now, to copy: the sheet it landed on, by its printed page, stamped with the latest.
      await expect(fragmentBanner(page).getByTestId("pdf-fragment-current-form")).toHaveAttribute("href", `${at}#p=1&v=2&text=law+of+participation`);
      // A hand that typed it without v= most likely meant the latest: that reading is offered beside the rule's.
      await expect(fragmentBanner(page).getByTestId("pdf-fragment-other-reading")).toHaveAttribute("href", `${at}#sheet=2&v=2&text=law+of+participation`);
      await expect(banner).toHaveCount(0);

      // By printed page: page 2 is page 2 in both copies, so it opens as it always did and nothing is said.
      await follow(page, `${at}#p=2&text=collective+representations`);
      await expectAddress(page, `${at}#p=2&text=collective+representations`);
      await waitForViewer(page);
      await expect(fragmentBanner(page)).toContainText("collective representations", { timeout: 30_000 });
      await expect(fragmentBanner(page).getByTestId("pdf-fragment-carried")).toHaveCount(0);
      await expect(fragmentBanner(page).getByTestId("pdf-fragment-miss")).toHaveCount(0);

      // Words the better copy corrected: not found where the link was carried, and offered on the version that holds them.
      await follow(page, `${at}#p=2&text=modem+mind`);
      await waitForViewer(page);
      await expect(fragmentBanner(page).getByTestId("pdf-fragment-miss")).toContainText("Not found on page 2", { timeout: 30_000 });
      await expect(fragmentBanner(page).getByTestId("pdf-fragment-on-named")).toHaveAttribute("href", `${at}/v/1#p=2&v=1&text=modem+mind`);

      // A sheet the better copy removed: carried only by its words, which it doesn't hold, so the link opens version 1.
      await follow(page, `${at}#sheet=1&text=cover+sheet+of+the+first+copy`);
      await expectAddress(page, `${at}/v/1#sheet=1&text=cover+sheet+of+the+first+copy`);
      await waitForViewer(page);
      await expect(fragmentBanner(page)).toContainText("cover sheet of the first copy", { timeout: 30_000 });
      // The same sheet named for words another sheet holds, once: carried by them.
      await follow(page, `${at}#sheet=1&text=symptoms+of+iconoclasm`);
      await expectAddress(page, `${at}#sheet=1&text=symptoms+of+iconoclasm`);
      await waitForViewer(page);
      await expect(fragmentBanner(page).getByTestId("pdf-fragment-carried")).toContainText("its sheet 1 is sheet 5 here", { timeout: 30_000 });

      // A link without words is carried by the map alone.
      await follow(page, `${at}#sheet=2`);
      await waitForViewer(page);
      await expect(fragmentBanner(page).getByTestId("pdf-fragment-carried")).toContainText("its sheet 2 is sheet 1 here", { timeout: 30_000 });
      // The viewer opened at that sheet, which the first copy's page 1 is printed on.
      await expect(page.getByLabel("Page number")).toHaveValue("1");
      // And one to the removed sheet is not carried at all.
      await follow(page, `${at}#sheet=1`);
      await expectAddress(page, `${at}/v/1#sheet=1`);

      // Backwards, on the earlier version's own address: the latest's sheet 1 is its sheet 2.
      await page.goto(`${at}/v/1#sheet=1&v=2&text=law+of+participation`);
      await waitForViewer(page);
      await expect(fragmentBanner(page).getByTestId("pdf-fragment-carried")).toContainText("Read as version 2: its sheet 1 is sheet 2 here", { timeout: 30_000 });
      // The blank sheet the better copy gained is one the first copy lacks.
      await page.goto(`${at}/v/1#sheet=2&v=2`);
      await waitForViewer(page);
      await expect(page.getByTestId("pdf-fragment-version-note")).toContainText("no counterpart on version 1", { timeout: 30_000 });

      // ---- MCP reads a link by the same rules ------------------------------
      const passage = await agent.call("read", { url: `${at}#sheet=2&text=law+of+participation` });
      expect(passage.isError, JSON.stringify(passage.error)).toBe(false);
      expect((passage.result.passages as { sheet: number; carriedFrom?: unknown }[])[0]).toMatchObject({ sheet: 1, carriedFrom: { version: 1, sheet: 2 } });
      expect(String(passage.result.note)).toContain("its sheet 2 is sheet 1 of version 2");
      const sheet = await agent.call("read", { url: `${at}#sheet=2` });
      expect((sheet.result.sheets as { sheet: number }[])[0].sheet).toBe(1);
      expect(String(sheet.result.note)).toContain("Read as version 1's");
      // The removed sheet is answered on the version it names, and the answer says why.
      const removed = await agent.call("read", { url: `${at}#sheet=1` });
      expect(String(removed.result.note)).toContain("has no counterpart on version 2");
      expect(String(removed.result.url)).toBe(`${at}/v/1`);

      // Its write check reads a link where it lands. Words the better copy corrected are refused.
      const corrected = await agent.call("create_doc", { markdown: `See [the passage](${at}#p=2&v=1&text=modem+mind).`, title: `Corrected ${tag}` });
      expect(corrected.isError).toBe(true);
      expect(String(corrected.error?.message)).toContain("version 1 holds it");
      const written = await agent.call("create_doc", {
        markdown: `See [the law](${at}#sheet=2&v=1&text=law+of+participation) and [the mind](${at}#p=2&v=1&text=collective+representations).`,
        title: `Carried ${tag}`,
      });
      expect(written.isError, JSON.stringify(written.error)).toBe(false);
      docs.push(String(written.result.id));

      // ---- the integrity check reads a link as the viewer does -------------
      const check = async (doc: string) => (await promisify(execFile)("npx", ["tsx", "scripts/integrity/check-pdf-fragment-links.ts", "--doc", doc, "--verbose"])).stdout;
      let report = await check(docs[0]);
      expect(report).toContain("0 error(s), 0 warning(s)");
      expect(report).toContain("names version 1, carried on sheet 1 of version 2; there it is #sheet=1&v=2&text=law+of+participation");
      expect(report).toContain("names version 1, carried on sheet 3 of version 2");
      // A link carried to a sheet that no longer holds its words is warned
      // of, where it lands: every reader of it is told "Not found". Written
      // into a doc by hand, since MCP's check refuses it.
      const stale = await createTestDoc({
        authorEmail: ADMIN_EMAIL,
        body: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "the passage", marks: [{ type: "link", attrs: { href: `${at}#p=2&v=1&text=modem+mind` } }] }] }],
        },
      });
      docs.push(stale.id);
      report = await check(stale.id);
      expect(report).toContain("0 error(s), 1 warning(s)");
      expect(report).toContain("[carried-miss]");
      expect(report).toContain("is carried to sheet 3 of version 2, which doesn't hold its words. Version 1 holds them");

      // ---- a citation's /pdf/ referent is carried by the cited-page route --
      const made = await agent.call("create_ref", { csl: { type: "book", title: `A Work ${prefix}`, author: [{ family: `Writer${prefix}` }], issued: { "date-parts": [[1957]] } }, key });
      expect(made.isError, JSON.stringify(made.error)).toBe(false);
      await setTestReferenceFile(key, file.id);
      const landing = async (query: string): Promise<string> => {
        const response = await page.goto(`/references/${key}/p/1?${query}`);
        expect(response?.status(), query).toBeLessThan(400);
        const url = new URL(page.url());
        return `${url.pathname}${url.hash}`;
      };
      // Carried on the server: the reader arrives on the latest, at the sheet the passage is on, stamped with it.
      expect(await landing("sheet=2&v=1&text=law+of+participation")).toBe(`${at}#sheet=1&v=2&text=law+of+participation`);
      expect(await landing("sheet=2&v=1")).toBe(`${at}#sheet=1&v=2`);
      // Words the better copy corrected are left as written, for the viewer to report and to offer on version 1.
      expect(await landing("p=2&v=1&text=modem+mind")).toBe(`${at}#p=2&v=1&text=modem+mind`);
      // The removed sheet is not carried: the version it names.
      expect(await landing("sheet=1&v=1&text=cover+sheet+of+the+first+copy")).toBe(`${at}/v/1#sheet=1&v=1&text=cover+sheet+of+the+first+copy`);
    } finally {
      for (const id of docs) await deleteTestDoc(id);
      await deleteTestReferences(prefix);
      await deleteTestFile(file.id);
    }
  });

  // The notes on the first copy, by two writers:
  //
  //   sheet 2   a word that stands three times on the sheet        posted   carried, by the words around it
  //   sheet 3   the word the better copy corrects ("modem")        posted   carried, its quote derived anew
  //   sheet 3   a passage kept private                             draft    stays: a carry takes no draft
  //   sheet 4   a rectangle on the plate, which has no text        posted   stays: a proposal, for its author
  //   sheet 5   a rectangle on a sheet of text, with a reply       posted   carried, its quads unchanged
  //   sheet 5   a passage in a minted link                         minted   carried
  //   sheet 5   a passage in a link still open in its tray         open     stays: the tray holds it as loaded
  test("its promotion carries the notes that place themselves, and a carry is replayed backwards from the database", async ({ page, request, secondUser }) => {
    test.setTimeout(300_000);
    const tag = token();
    const file: TestFile = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: firstCopy(tag), pageLabels: FIRST_LABELS, inked: [4] });
    const at = `/pdf/${file.slug}`;
    const banner = page.getByTestId("pdf-version-banner");
    // Two writers beside the manager, each a person with a browser and a token of their own.
    const one = await secondUser({ role: "AUTHOR" });
    const two = await secondUser({ role: "AUTHOR" });
    const speaksAs = async (email: string) => {
      const { secret } = await createTestApiToken({ email, issuerEmail: email, scopes: ["READ", "WRITE"], client: "CLAUDE_CODE" });
      return async (name: string, args: Record<string, unknown>) => {
        const answer = await callTool(request, secret, name, args);
        expect(answer.isError, JSON.stringify(answer.error)).toBe(false);
        return answer.result;
      };
    };
    // By the sheet's own element, never the page box: that takes a printed page, and the two copies label their sheets differently.
    const toSheet = async (reader: Page, sheet: number) => {
      await reader.locator(`.pdfViewer .page[data-page-number='${sheet}']`).scrollIntoViewIfNeeded();
      await expect(reader.locator(`.pdfViewer .page[data-page-number='${sheet}'] .textLayer`)).toBeAttached({ timeout: 30_000 });
    };
    const rowOf = (rows: TestAnchorRow[], id: string) => {
      const row = rows.find((candidate) => candidate.id === id);
      expect(row, `anchor ${id}`).toBeTruthy();
      return row!;
    };
    try {
      const asOne = await speaksAs(one.user.email);
      const asTwo = await speaksAs(two.user.email);

      // ---- on the first copy, by two users -----------------------------------
      const word = String((await asOne("add_note", { on: at, body: `The word ${tag}.`, quote: "participation", prefix: "annotate the word", sheet: 2 })).id);
      const changed = String((await asTwo("add_note", { on: at, body: `The misread word ${tag}.`, quote: "modem" })).id);
      await asOne("create_link", { links: [{ name: `Iconoclasm ${tag}`, parts: [{ on: at, quote: "symptoms of iconoclasm" }] }] });
      const rectangle = (await createTestAnnotation({ fileId: file.id, authorEmail: two.user.email, bodyText: `A rectangle ${tag}.`, pdfRect: { sheet: 5, rect: [80, 600, 300, 700] } })).id;
      await createTestAnnotation({ fileId: file.id, authorEmail: one.user.email, bodyText: `A reply to the rectangle ${tag}.`, parentAnnotationId: rectangle });
      const onPlate = (await createTestAnnotation({ fileId: file.id, authorEmail: one.user.email, bodyText: `On the plate ${tag}.`, pdfRect: { sheet: 4, rect: [150, 220, 320, 300] } })).id;
      // A draft, kept private by its writer.
      await gotoOk(two.page, at);
      await waitForViewer(two.page);
      await toSheet(two.page, 3);
      await expectSheetText(two.page, "Idolatry is the name", 3);
      await selectPhrase(two.page, 3, "Idolatry is the name");
      await two.page.getByRole("button", { name: "Annotate" }).click();
      await annotationEditor(two.page).click();
      await annotationEditor(two.page).pressSequentially(`A private thought ${tag}.`);
      await two.page.getByRole("combobox", { name: "Annotation visibility" }).selectOption("private");
      await two.page.getByRole("button", { name: "Save" }).click();
      await expect(two.page.getByRole("button", { name: "Write an annotation..." })).toBeVisible({ timeout: 15_000 });
      // A passage added to a link that its creator has not minted.
      await gotoOk(one.page, at);
      await waitForViewer(one.page);
      await toSheet(one.page, 5);
      await expectSheetText(one.page, "future of meaning", 5);
      await selectPhrase(one.page, 5, "future of meaning");
      await one.page.getByRole("button", { name: "Add to link" }).click();
      await expect(one.page.getByTestId("anchored-link-tray")).toContainText("1 passage", { timeout: 15_000 });

      let rows = await getFileAnchorRows(file.id);
      expect(rows.map((row) => row.versionNumber)).toEqual([1, 1, 1, 1, 1, 1, 1]);
      const draft = rows.find((row) => row.kind === "annotation" && row.quotedText === "Idolatry is the name")!.id;
      const [mintedPart, openPart] = ["symptoms of iconoclasm", "future of meaning"].map((quote) => rows.find((row) => row.kind === "link-part" && row.quotedText === quote)!.id);

      // ---- the better copy, uploaded as one -----------------------------------
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, at);
      await waitForViewer(page);
      await page.getByRole("tab", { name: "Metadata" }).click();
      const chooser = page.waitForEvent("filechooser");
      await page.getByTestId("pdf-upload-better-copy").click();
      await (await chooser).setFiles({ name: "better-copy.pdf", mimeType: "application/pdf", buffer: betterPdf(tag) });
      await expect(page).toHaveURL(new RegExp(`${at}/v/2$`), { timeout: 90_000 });
      await waitForViewer(page);

      // What the candidate's page says would carry, before anything is moved.
      const wouldCarry = banner.getByTestId("pdf-candidate-carry");
      await expect(wouldCarry).toHaveAttribute("data-carry-state", "ready", { timeout: 60_000 });
      await expect(wouldCarry).toContainText("3 notes and 1 link part would move to version 2.");
      await expect(wouldCarry).toContainText("1 on version 1 would stay, for its author to move or leave.");
      // Looking stored nothing and moved nothing.
      const before = await getFileAnchorRows(file.id);
      expect(before).toEqual(rows);
      expect(await getFileAnchorMoves(file.id)).toEqual([]);

      // ---- promoted with the carry --------------------------------------------
      await banner.getByTestId("pdf-candidate-promote-carry").click();
      await expect(page.locator("[data-pdf-viewer]")).toContainText(`${file.title}, version 2 (the latest)`, { timeout: 60_000 });
      // The page the promotion brings says what its carry did.
      const carried = page.getByTestId("pdf-carry-outcome");
      await expect(carried).toContainText("4 notes and link parts were moved to version 2.", { timeout: 30_000 });
      await expect(carried).toContainText("1 on version 1 stayed.");

      rows = await getFileAnchorRows(file.id);
      // Both writers' notes moved, and what a carry doesn't take stayed.
      for (const id of [word, changed, rectangle, mintedPart]) expect(rowOf(rows, id).versionNumber, id).toBe(2);
      for (const id of [onPlate, draft, openPart]) expect(rowOf(rows, id).versionNumber, id).toBe(1);
      // The changed word's quote is the better copy's.
      expect(rowOf(rows, changed).quotedText).toBe("modern");
      // The word went to the occurrence its prefix names: the better copy's sheet 1, the third "participation" on it.
      const wordTarget = JSON.parse(rowOf(rows, word).row).pdf_target;
      expect(wordTarget.pageIndex).toBe(0);
      expect(wordTarget.quote.prefix).toContain("annotate the word");
      // The rectangle is where the fit puts it: the same quads, on the sheet its own became.
      const quadsOf = (row: TestAnchorRow) => JSON.parse(row.row).pdf_target.quads;
      expect(quadsOf(rowOf(rows, rectangle))).toEqual(quadsOf(rowOf(before, rectangle)));
      expect(JSON.parse(rowOf(rows, rectangle).row).pdf_target.pageIndex).toBe(4);
      // A carry changes nothing else on a row.
      for (const id of [word, changed, rectangle]) {
        expect(JSON.parse(rowOf(rows, id).row).edited_at).toBe(JSON.parse(rowOf(before, id).row).edited_at);
        expect(JSON.parse(rowOf(rows, id).row).body_text).toBe(JSON.parse(rowOf(before, id).row).body_text);
      }

      // The history: one row for each anchor moved, all of one carry, hidden, by the manager who promoted.
      let moves = await getFileAnchorMoves(file.id);
      expect(moves.map((move) => move.anchorId).sort()).toEqual([word, changed, rectangle, mintedPart].sort());
      const firstCarry = moves[0].carryId!;
      expect(firstCarry).toBeTruthy();
      for (const move of moves) expect(move).toMatchObject({ fromNumber: 1, toNumber: 2, carryId: firstCarry, hidden: true, wasMarked: false, movedByEmail: ADMIN_EMAIL });
      expect(moves.find((move) => move.anchorId === changed)!.fromQuotedText).toBe("modem");

      // ---- the latest's page ----------------------------------------------------
      // The highlights are drawn on the better copy's sheets, both writers' among them.
      await expect(page.locator(`.annoRect[data-anno-id="${word}"]`).first()).toBeVisible({ timeout: 30_000 });
      await toSheet(page, 3);
      await expect(page.locator(`.annoRect[data-anno-id="${changed}"]`).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(`[data-comment-id="${changed}"]`).first()).toBeVisible({ timeout: 30_000 });
      await toSheet(page, 5);
      await expect(page.locator(`.annoRect[data-anno-id="${rectangle}"]`).first()).toBeVisible({ timeout: 30_000 });
      // The rectangle's reply came with it: a reply has no target and travels with its root.
      await expect(page.locator(`[data-comment-id="${rectangle}"]`).first()).toBeVisible({ timeout: 30_000 });
      await expect(visibleText(page, `A reply to the rectangle ${tag}.`)).toBeVisible({ timeout: 30_000 });
      // What stayed is listed under version 1.
      await expect(page.getByTestId("pdf-other-version-notes")).toContainText(`On the plate ${tag}.`);
      await expect(page.getByTestId("pdf-other-version-notes")).not.toContainText(`The word ${tag}.`);

      // The draft is still on version 1, and in its writer's private notes on the latest's page.
      await gotoOk(two.page, at);
      await waitForViewer(two.page);
      await expectSheetText(two.page, `Participation is the first chapter's word ${tag}`, 1);
      await expect(two.page.getByText("Your private notes").locator("..")).toContainText(`A private thought ${tag}.`, { timeout: 15_000 });
      // The open link's part is on version 1: in its creator's tray, and not drawn on the latest's sheets.
      await gotoOk(one.page, at);
      await waitForViewer(one.page);
      await expect(one.page.getByTestId("anchored-link-tray")).toContainText("1 passage", { timeout: 15_000 });
      await toSheet(one.page, 5);
      await expectSheetText(one.page, "future of meaning", 5);
      await expect(one.page.locator(".annoRectDraftLink")).toHaveCount(0);
      await gotoOk(one.page, `${at}/v/1`);
      await waitForViewer(one.page);
      await toSheet(one.page, 5);
      await expect(one.page.locator(".annoRectDraftLink").first()).toBeVisible({ timeout: 30_000 });

      // ---- a note posted on version 1 afterwards, and a second carry ----------
      const later = String((await asOne("add_note", { on: `${at}/v/1`, body: `Posted on version one afterwards ${tag}.`, quote: "collective representations" })).id);
      const beforeSecond = await getFileAnchorRows(file.id);
      expect(rowOf(beforeSecond, later).versionNumber).toBe(1);
      await gotoOk(page, at);
      await waitForViewer(page);
      await page.getByRole("tab", { name: "Metadata" }).click();
      const firstVersion = page.getByTestId("pdf-version-list").locator("[data-version='1']");
      await expect(firstVersion.getByTestId("pdf-version-notes-left")).toContainText("2 posted notes are still on this version.");
      // It shows what it would do first, and that moves nothing.
      await firstVersion.getByTestId("pdf-carry-look").click();
      await expect(firstVersion.getByTestId("pdf-carry-preview")).toContainText("1 note would move to version 2.", { timeout: 60_000 });
      await expect(firstVersion.getByTestId("pdf-carry-preview")).toContainText("1 on version 1 would stay");
      expect(await getFileAnchorRows(file.id)).toEqual(beforeSecond);
      await firstVersion.getByTestId("pdf-carry-run").click();
      await expect(firstVersion.getByTestId("pdf-carry-result")).toContainText("1 note or link part was moved to version 2.", { timeout: 60_000 });
      await firstVersion.getByTestId("pdf-carry-reload").click();
      await waitForViewer(page);
      rows = await getFileAnchorRows(file.id);
      expect(rowOf(rows, later).versionNumber).toBe(2);
      expect(rowOf(rows, onPlate).versionNumber).toBe(1);
      moves = await getFileAnchorMoves(file.id);
      expect(moves).toHaveLength(5);
      const secondCarry = moves[4].carryId!;
      expect(secondCarry).not.toBe(firstCarry);

      // ---- a manager shows a carry's moves together ----------------------------
      await page.getByRole("tab", { name: "Metadata" }).click();
      const records = page.getByTestId("pdf-version-list").locator("[data-version='2']").getByTestId("pdf-carry-record");
      await expect(records).toHaveCount(2);
      await expect(records.last()).toContainText("A carry moved 4 notes and link parts here");
      await expect(records.last()).toHaveAttribute("data-carry-hidden", "true");
      await records.last().getByTestId("pdf-carry-show").click();
      await expect
        .poll(async () => (await getFileAnchorMoves(file.id)).filter((move) => !move.hidden).map((move) => move.carryId), { timeout: 30_000 })
        .toEqual([firstCarry, firstCarry, firstCarry, firstCarry]);
      // A writer who doesn't manage the file is given no carry and may run none.
      await gotoOk(two.page, at);
      await waitForViewer(two.page);
      await two.page.getByRole("tab", { name: "Metadata" }).click();
      await expect(two.page.getByTestId("pdf-version-list")).toBeVisible();
      await expect(two.page.getByTestId("pdf-carry-record")).toHaveCount(0);
      await expect(two.page.getByTestId("pdf-carry")).toHaveCount(0);

      // ---- each carry replayed backwards, in SQL --------------------------------
      // The history holds what an undo needs: every anchor's row is again what it was.
      expect(await undoCarryInSql(secondCarry)).toEqual({ moves: 1, maps: 0 });
      expect(await getFileAnchorRows(file.id)).toEqual(beforeSecond);
      expect(await undoCarryInSql(firstCarry)).toEqual({ moves: 4, maps: 0 });
      const restored = await getFileAnchorRows(file.id);
      expect(restored.filter((row) => row.id !== later)).toEqual(before);
      expect(await getFileAnchorMoves(file.id)).toEqual([]);
    } finally {
      await deleteTestFile(file.id);
    }
  });

  // Working out where each note goes takes seconds and holds no lock, so the
  // write checks each row for itself. Each race is made to happen in order:
  // something is done to a note after the carry has placed it and before
  // the carry writes.
  test("a carry's write changes only the rows that are as its placements found them", async ({ request }) => {
    test.setTimeout(180_000);
    const tag = token();
    const agent = await createAgent(request, { person: true });
    const file: TestFile = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: firstCopy(tag), pageLabels: FIRST_LABELS, inked: [4] });
    const at = `/pdf/${file.slug}`;
    try {
      const note = async (quote: string) => {
        const posted = await agent.call("add_note", { on: at, body: `On "${quote}" ${tag}.`, quote });
        expect(posted.isError, JSON.stringify(posted.error)).toBe(false);
        return String(posted.result.id);
      };
      const untouched = await note("law of participation");
      const marked = await note("collective representations");
      const retargeted = await note("Final participation");
      const restamped = await note("symptoms of iconoclasm");
      const away = await note("future of meaning");
      // The better copy is promoted without a carry and with no page map: a
      // carry started on version 1 is what says the two hold the same text.
      const second = await addTestFileVersion(file.id, { pages: betterCopy(tag), pageLabels: BETTER_LABELS, inked: [4] });
      expect((await getFileVersionFacts(file.id))[1].pageMap).toBeNull();

      const result = await carryAcrossChanges(file.versionId, ADMIN_EMAIL, { mark: [marked], retarget: [retargeted], restamp: [restamped], away: [away] });
      // All five placed themselves. Two were written: the one nothing touched,
      // and the one whose target differs only in the text version it names.
      expect(result).toMatchObject({ moved: 2, skipped: 3, stayed: [], storedMaps: [2] });
      const rows = await getFileAnchorRows(file.id);
      const on = (id: string) => rows.find((row) => row.id === id)!;
      expect(on(untouched).versionNumber).toBe(2);
      expect(on(restamped).versionNumber).toBe(2);
      // A note marked "stays here" while the carry worked is refused by the write, and stays.
      expect(on(marked).versionNumber).toBe(1);
      // A note no longer at the target its placement started from is left as it is.
      expect(on(retargeted).versionNumber).toBe(1);
      expect(JSON.parse(on(retargeted).row).pdf_target.quads[0][0]).toBe(1);
      // A note that left the version meanwhile keeps the target it has there.
      expect(on(away).versionNumber).toBe(2);
      expect(on(away).quotedText).toBe("future of meaning");
      const moves = await getFileAnchorMoves(file.id);
      expect(moves.filter((move) => move.toNumber !== null).map((move) => move.anchorId).sort()).toEqual([untouched, restamped].sort());
      expect(moves.every((move) => move.toNumber === null || move.carryId === result.carryId)).toBe(true);
      // The map the carry stored on its way says so, and goes with the carry when it is undone.
      const versions = await getFileVersionFacts(file.id);
      expect(versions[1].pageMap).toMatchObject({ sheets: MAP, carryId: result.carryId });
      expect(second.number).toBe(2);
      expect(await undoCarryInSql(result.carryId)).toEqual({ moves: 2, maps: 1 });
      expect((await getFileVersionFacts(file.id))[1].pageMap).toBeNull();
      // The history kept the target each had when it was moved: the restamped one's names the text version it then named.
      const undone = await getFileAnchorRows(file.id);
      expect(undone.find((row) => row.id === untouched)!.versionNumber).toBe(1);
      expect(JSON.parse(undone.find((row) => row.id === restamped)!.row).pdf_target.textVersion).toBe("restamped/0");
    } finally {
      await deleteTestFile(file.id);
      await agent.dispose();
    }
  });

  // A sheet whose text the later copy reads quite otherwise is paired by no
  // rule: the map proposes it by its place and asks. Until a manager accepts,
  // a note on it whose words stand twice in the later copy has no place.
  test("accepting a run of sheets gives its notes a place, and the carry on the map's page takes them", async ({ page, request }) => {
    test.setTimeout(180_000);
    const tag = token();
    const agent = await createAgent(request, { person: true });
    const closing = [...sheetC(tag), "A refrain of the chorus is quoted again."];
    const file: TestFile = await createTestFile({
      ownerEmail: ADMIN_EMAIL,
      visibility: "SHARED",
      pages: [
        sheetA(tag),
        [`The second sheet of the first copy ${tag}.`, "The refrain of the chorus returns here.", "Its lines were set in a narrow measure.", "A footnote names the printer of the edition."],
        closing,
      ],
    });
    const at = `/pdf/${file.slug}`;
    try {
      const posted = await agent.call("add_note", { on: at, body: `On the refrain ${tag}.`, quote: "refrain of the chorus", sheet: 2 });
      expect(posted.isError, JSON.stringify(posted.error)).toBe(false);
      const note = String(posted.result.id);
      await addTestFileVersion(file.id, {
        pages: [
          sheetA(tag),
          [`Kx zzvy refrain of the chorus qpl ${tag}`, "Wm oblq trsk vnnd hjup ygge rrto pwcc", "Zud ekkl mmvo aapq ssfr dhty uuzb nnxe", "Qee rvvt bwwo ccma llpd ffgi hhjy oonz"],
          closing,
        ],
      });

      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `${at}/v/2/map`);
      await page.getByTestId("pdf-map-build").click();
      await expect(page.getByTestId("pdf-map-numbers")).toContainText("2 paired, 0 removed, 1 unmapped", { timeout: 60_000 });
      const run = page.getByTestId("pdf-map-run");
      await expect(run).toHaveAttribute("data-run-state", "open");

      // Before the run is answered: the note's sheet has no counterpart, and its words stand twice in version 2.
      const carry = page.getByTestId("pdf-map-carry");
      await carry.getByTestId("pdf-carry-look").click();
      await expect(carry.getByTestId("pdf-carry-preview")).toContainText("Nothing would move to version 2.", { timeout: 60_000 });
      await expect(carry.getByTestId("pdf-carry-preview")).toContainText("1 on version 1 would stay");
      await expect(carry.getByTestId("pdf-carry-run")).toHaveCount(0);

      // Accepting moves no note.
      await run.getByTestId("pdf-map-accept").click();
      await expect(run).toHaveAttribute("data-run-state", "accepted", { timeout: 30_000 });
      await expect(page.getByTestId("pdf-map-numbers")).toContainText("3 paired, 0 removed, 0 unmapped");
      expect((await getFileAnchorRows(file.id)).find((row) => row.id === note)!.versionNumber).toBe(1);

      // The carry then shows what the accepted sheets let it move, and moves it when it is run.
      await carry.getByTestId("pdf-carry-look").click();
      await expect(carry.getByTestId("pdf-carry-preview")).toContainText("1 note would move to version 2.", { timeout: 60_000 });
      expect((await getFileAnchorRows(file.id)).find((row) => row.id === note)!.versionNumber).toBe(1);
      await carry.getByTestId("pdf-carry-run").click();
      await expect(carry.getByTestId("pdf-carry-result")).toContainText("1 note or link part was moved to version 2.", { timeout: 60_000 });
      const moved = (await getFileAnchorRows(file.id)).find((row) => row.id === note)!;
      expect(moved.versionNumber).toBe(2);
      // On the sheet the run paired, and not the other one that holds its words.
      expect(JSON.parse(moved.row).pdf_target.pageIndex).toBe(1);
    } finally {
      await deleteTestFile(file.id);
      await agent.dispose();
    }
  });
});
