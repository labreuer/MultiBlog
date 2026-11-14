import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, expect, signIn, gotoOk } from "./fixtures";
import {
  ADMIN_EMAIL,
  createTestDoc,
  createTestFile,
  deleteTestDoc,
  deleteTestFile,
  deleteTestReferences,
  getFileVersionFacts,
  setTestReferenceFile,
  type TestFile,
} from "./db";
import { createAgent } from "./mcp";
import { expectAddress, expectSheetText, token, waitForViewer, type Page } from "./pdf-version-helpers";
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
});
