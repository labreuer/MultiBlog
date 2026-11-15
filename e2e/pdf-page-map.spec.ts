import { test, expect, signIn, gotoOk } from "./fixtures";
import { ADMIN_EMAIL, abandonTestVersion, addTestFileVersion, createTestFile, deleteTestFile, fillTestFileMetadata, makeVersionFault, type TestFile } from "./db";
import { token } from "./pdf-version-helpers";
import type { TestPageLabelRange } from "../scripts/make-test-pdf";

// docs/PDF.md §14, "A version's page map, sheet by sheet" — the map page's
// list of rows and a question's card. No fixture PDF makes the pairing rules
// produce a row of every kind on demand, so the map is written by hand
// (`makeVersionFault`'s "map"), onto two real versions with real text and
// labels: what the page reads besides the map is what an upload stores.

/** The base's labels: "i", then 1 to 8. */
const BASE_LABELS: TestPageLabelRange[] = [
  { from: 1, style: "r" },
  { from: 2, style: "D" },
];
/** The version's: "a", then 1 to 8, so that only the first pair's page numbers differ. */
const VERSION_LABELS: TestPageLabelRange[] = [
  { from: 1, style: "a" },
  { from: 2, style: "D" },
];

const sheet = (name: string, tag: string) => [`The ${name} sheet of the book ${tag}.`, `It holds words of its own about the ${name} matter at hand.`];

// Base sheets, 0-based: 2 and 6 have no text. Version sheets all have text.
const basePages = (tag: string): string[][] => [
  sheet("opening", tag),
  sheet("second", tag),
  [],
  sheet("dropped", tag),
  sheet("fifth", tag),
  sheet("sixth", tag),
  [],
  sheet("unplaced", tag),
  sheet("closing", tag),
];
const versionPages = (tag: string): string[][] => [
  sheet("opening", tag),
  sheet("second", tag),
  sheet("plate caption", tag),
  sheet("rewritten fifth", tag),
  sheet("labelled fifth", tag),
  sheet("rewritten sixth", tag),
  sheet("rewritten seventh", tag),
  sheet("labelled seventh", tag),
  sheet("closing", tag),
];

/**
 * Base 1–3 → 1–3, a stretch with a sheet without text (3) and a pair whose
 * page numbers differ (1). Base 4 removed. Base 5–7 a `labels` run, proposing
 * the version's 4, 6 and 7, which are not consecutive: base 5's label gave it
 * sheet 5, whose words are another page's; base 6's labels gave it nothing;
 * base 7 has no text, and its label gave it sheet 8. The version's 5 and 8 are
 * added, after the run, which holds the sheets before them. Base 8 unmapped
 * with nothing proposed. Base 9 → 9.
 */
const MAP = {
  from: 9,
  to: 9,
  sheets: [0, 1, 2, -1, -2, -2, -2, -2, 8],
  runs: [{ kind: "labels", start: 4, proposed: [3, 5, 6], byLabel: [4, null, 7], answer: null }],
  blank: { from: [], to: [] },
};

test.describe("a version's page map, sheet by sheet", () => {
  test("every sheet of each version is in one row, in the base's order, and a question's card says what is going on", async ({ page }) => {
    test.setTimeout(120_000);
    const tag = token();
    const file: TestFile = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: basePages(tag), pageLabels: BASE_LABELS, inked: [3, 7] });
    try {
      expect(await fillTestFileMetadata(file.id)).toHaveLength(9);
      const version = await addTestFileVersion(file.id, { pages: versionPages(tag), pageLabels: VERSION_LABELS, promote: false });
      expect(await fillTestFileMetadata(file.id, version.id)).toHaveLength(9);
      await makeVersionFault({ fault: "map", versionId: version.id, map: MAP });

      await signIn(page, ADMIN_EMAIL);
      const at = `/pdf/${file.slug}/v/${version.number}/map`;
      await gotoOk(page, at);
      await expect(page.getByTestId("pdf-map-numbers")).toContainText("4 paired, 1 removed, 4 unmapped");

      const rows = page.getByTestId("pdf-map-row");
      expect(await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-row-kind")))).toEqual([
        "matched",
        "removed",
        "run",
        "added",
        "added",
        "unmapped",
        "matched",
      ]);
      // The sheets each row names, base then version, with their printed pages: every sheet of each exactly once.
      expect(await rows.evaluateAll((items) => items.map((item) => item.firstElementChild!.textContent!.replace(/\s+/g, " ").trim()))).toEqual([
        "1–3 (pp. i–2)→1–3 (pp. a–2)3 sheets",
        "4 (p. 3)→—1 sheet",
        "5–7 (pp. 4–6)→4, 6–7 (pp. 3–6)3 sheets",
        "—→5 (p. 4)1 sheet",
        "—→8 (p. 7)1 sheet",
        "8 (p. 7)→—1 sheet",
        "9 (p. 8)→9 (p. 8)1 sheet",
      ]);
      // A sheet without text and a pair whose page numbers differ are counted on one row, and split it nowhere.
      await expect(rows.nth(0)).toContainText("Paired, each in its place. Their page numbers agree on 2, and 1 has a sheet without text.");
      await rows.nth(0).locator("summary").click();
      await expect(rows.nth(0).locator("details li")).toHaveText(["1 → 1 (page numbers differ)", "2 → 2", "3 → 3 (a sheet has no text)"]);
      // Each sheet links to its version's own page, stamped with that version.
      await expect(rows.nth(0).locator("details li").first().getByRole("link").last()).toHaveAttribute(
        "href",
        `/pdf/${file.slug}/v/${version.number}#sheet=1&v=${version.number}`,
      );
      await expect(rows.nth(1)).toContainText(`Removed: nothing stands in its place in version ${version.number}.`);
      await expect(rows.nth(3)).toContainText("Added in version 2: no sheet of version 1 goes to it.");
      await expect(rows.nth(5)).toContainText("Unmapped, with nothing proposed");

      // ---- the question's card --------------------------------------------
      const card = rows.nth(2).getByTestId("pdf-map-run");
      await expect(card).toHaveAttribute("data-run-state", "open");
      // Only the sheet whose label gave another sheet, and whose words refused it, is in the opening sentence.
      await expect(card).toContainText(
        "By their printed page numbers, sheet 5 of version 1 would go to sheet 5 of version 2. The words there are a different page's. The words are on sheet 4.",
      );
      const lines = card.getByTestId("pdf-map-run-line");
      expect(await lines.evaluateAll((items) => items.map((item) => item.getAttribute("data-line")))).toEqual(["refused", "counted", "no-text"]);
      await expect(lines.nth(0)).toContainText("Not sheet 5 (p. 4), whose page number matches: its words are a different page's.");
      // With that sheet's words under it.
      await expect(lines.nth(0)).toContainText(`The labelled fifth sheet of the book ${tag}.`);
      await expect(lines.nth(1)).toContainText("Its page number gives it no sheet. It is placed by counting from the sheets around it.");
      await expect(lines.nth(2)).toContainText("Not sheet 8 (p. 7), whose page number matches. There is no text to compare");
      // The words of each sheet of the base and each proposed one, and "(no text)" for the one without.
      await expect(card.locator("tbody tr").nth(0)).toContainText(`The fifth sheet of the book ${tag}.`);
      await expect(card.locator("tbody tr").nth(0)).toContainText(`The rewritten fifth sheet of the book ${tag}.`);
      await expect(card.locator("tbody tr").nth(2).locator("td").first()).toContainText("(no text)");
      // Two choices, each saying what it does.
      await expect(card.getByTestId("pdf-map-accept")).toHaveText("Pair them by their words");
      await expect(card.getByTestId("pdf-map-decline")).toHaveText("Leave them unmatched");
      await expect(card).toContainText("Un-pairing them later makes them a question again");
      await expect(card.getByTestId("pdf-map-unpair")).toHaveCount(0);

      // ---- the strip, and "Questions only" ----------------------------------
      const segments = page.getByTestId("pdf-map-strip").locator("a");
      await expect(segments).toHaveCount(7);
      await expect(segments.nth(3)).toHaveAttribute("title", "Added in version 2: sheet 5 (p. 4)");
      await expect(segments.nth(1)).toHaveAttribute("title", "Sheet 4 (p. 3) of version 1: removed");
      await segments.nth(5).click();
      await expect(page).toHaveURL(new RegExp(`${at}#map-row-5$`));
      await page.getByTestId("pdf-map-questions-only").check();
      await expect(rows.filter({ visible: true })).toHaveCount(1);
      await expect(rows.filter({ visible: true })).toHaveAttribute("data-row-kind", "run");
      await page.getByTestId("pdf-map-questions-only").uncheck();
      await expect(rows.filter({ visible: true })).toHaveCount(7);
    } finally {
      await deleteTestFile(file.id);
    }
  });

  // Abandoning deletes a version's page text and may leave its map: the list
  // then says nothing about text, and the card shows no words.
  test("an abandoned version's map is drawn with no words and nothing said about text", async ({ page }) => {
    test.setTimeout(120_000);
    const tag = token();
    const file: TestFile = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: basePages(tag), pageLabels: BASE_LABELS, inked: [3, 7] });
    try {
      await fillTestFileMetadata(file.id);
      const version = await addTestFileVersion(file.id, { pages: versionPages(tag), pageLabels: VERSION_LABELS, promote: false });
      await fillTestFileMetadata(file.id, version.id);
      await makeVersionFault({ fault: "map", versionId: version.id, map: MAP });
      expect(await abandonTestVersion(version.id, ADMIN_EMAIL)).toMatchObject({ ok: true });

      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, `/pdf/${file.slug}/v/${version.number}/map`);
      const rows = page.getByTestId("pdf-map-row");
      await expect(rows).toHaveCount(7);
      await expect(rows.nth(0)).toContainText("Paired, each in its place. Their page numbers agree on 2.");
      await expect(page.getByTestId("pdf-map-list")).not.toContainText("text");
      const card = rows.nth(2).getByTestId("pdf-map-run");
      await expect(card).not.toContainText(tag);
      expect(await card.getByTestId("pdf-map-run-line").evaluateAll((items) => items.map((item) => item.getAttribute("data-line")))).toEqual([
        "label-other",
        "counted",
        "label-other",
      ]);
      await expect(card).toContainText("By their printed page numbers, sheets 5, 7 of version 1 would go to sheets 5, 8 of version 2. The map proposes sheets 4, 7, from their words.");
    } finally {
      await deleteTestFile(file.id);
    }
  });
});
