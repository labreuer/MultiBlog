import { test, expect, gotoOk } from "./fixtures";
import { ADMIN_EMAIL, addTestFileVersion, createTestFile, deleteTestFile, makeVersionFault } from "./db";
import { selectPhrase, token, waitForViewer, type Page } from "./pdf-version-helpers";

// docs/PDF.md §14, "What the viewer keeps" — what the viewer says while a
// version waits to replace the latest: the version pinned above the
// Metadata pane's list for every reader, with whether its pages are matched;
// a manager's line under it and the dot on the Metadata tab; and the
// selection popover's line, which says what becomes of a capture made on the
// version shown. The default `page` is the shared admin's, who owns each file
// here; the reader is an AUTHOR who may read a SHARED file and not manage it.

const lines = (tag: string, version: number) => [
  [`The opening sheet of version ${version} of the book ${tag}.`, "It holds words of its own."],
  [`The closing sheet of version ${version} of the book ${tag}.`, "It holds other words."],
];

/** Base sheet 1 paired, sheet 2 unmapped with one open question proposing the version's sheet 2. */
const MAP_WITH_A_QUESTION = {
  from: 2,
  to: 2,
  sheets: [0, -2],
  runs: [{ kind: "place", start: 1, proposed: [1], answer: null }],
  blank: { from: [], to: [] },
};

/** Both sheets paired, nothing asked. */
const MAP_WHOLE = { from: 2, to: 2, sheets: [0, 1], runs: [], blank: { from: [], to: [] } };

const pinned = (page: Page) => page.getByTestId("pdf-version-waiting");
const popoverLine = (page: Page) => page.getByTestId("pdf-popover-waiting");
const metadataTab = (page: Page) => page.getByRole("tab", { name: "Metadata" });

async function openMetadata(page: Page) {
  await metadataTab(page).click();
  await expect(metadataTab(page)).toHaveAttribute("aria-selected", "true");
}

/** Selects a phrase and waits for the popover its selection raises. */
async function select(page: Page, sheet: number, phrase: string) {
  await selectPhrase(page, sheet, phrase);
  await expect(page.getByRole("button", { name: "Annotate" })).toBeVisible({ timeout: 15_000 });
}

/** The HTML a page is answered with, which carries what its server sent the viewer. */
async function sentHtml(page: Page, path: string): Promise<string> {
  const response = await page.request.get(path);
  expect(response.status()).toBe(200);
  return response.text();
}

test.describe("a version waiting to replace the latest, in the viewer", () => {
  test("on the latest's page: pinned for every reader with its pages matched or not, a manager's line and dot, and the popover's line", async ({
    page,
    secondUser,
  }) => {
    test.setTimeout(120_000);
    const tag = token();
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: lines(tag, 1) });
    try {
      const waiting = await addTestFileVersion(file.id, { pages: lines(tag, 2), promote: false });
      const { page: reader } = await secondUser({ role: "AUTHOR" });

      // No map yet: a revised text, or a better copy whose map is still building. Both say the same.
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await expect(page.getByTestId("pdf-tab-dot-metadata")).toHaveAttribute("aria-label", `Version ${waiting.number} is waiting`);
      await openMetadata(page);
      await expect(pinned(page)).toContainText(`Version ${waiting.number} is waiting to replace version 1.`);
      await expect(pinned(page).getByTestId("pdf-version-waiting-matched")).toHaveText("Its pages are not matched with version 1's.");
      await expect(pinned(page).getByRole("link", { name: `See version ${waiting.number}` })).toHaveAttribute("href", `/pdf/${file.slug}/v/${waiting.number}`);
      const manageLine = pinned(page).getByTestId("pdf-version-waiting-manage");
      await expect(manageLine.getByRole("link", { name: "Review and promote it" })).toHaveAttribute("href", `/files/${file.id}/manage`);
      await expect(manageLine).not.toContainText("question");
      await select(page, 1, "opening sheet of version 1");
      await expect(popoverLine(page)).toHaveText(`Version ${waiting.number} is waiting. A note or link part made here stays on version 1 unless the pages are matched.`);

      await gotoOk(reader, `/pdf/${file.slug}`);
      await waitForViewer(reader);
      await openMetadata(reader);
      await expect(pinned(reader)).toContainText(`Version ${waiting.number} is waiting to replace version 1.`);
      await expect(pinned(reader).getByTestId("pdf-version-waiting-matched")).toHaveText("Its pages are not matched with version 1's.");
      await expect(reader.getByTestId("pdf-tab-dot-metadata")).toHaveCount(0);
      await expect(pinned(reader).getByTestId("pdf-version-waiting-manage")).toHaveCount(0);
      await select(reader, 1, "opening sheet of version 1");
      await expect(popoverLine(reader)).toHaveText(`Version ${waiting.number} is waiting. A note or link part made here stays on version 1 unless the pages are matched.`);

      // Its map built, with one question open.
      await makeVersionFault({ fault: "map", versionId: waiting.id, map: MAP_WITH_A_QUESTION });

      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await openMetadata(page);
      await expect(pinned(page).getByTestId("pdf-version-waiting-matched")).toHaveText("Its pages are matched with version 1's.");
      await expect(pinned(page).getByTestId("pdf-version-waiting-manage")).toContainText("1 question about its pages is still open.");
      await select(page, 1, "opening sheet of version 1");
      await expect(popoverLine(page)).toHaveText(`Version ${waiting.number} is waiting. A note or link part made here can be carried to it when it's promoted.`);

      await gotoOk(reader, `/pdf/${file.slug}`);
      await waitForViewer(reader);
      await openMetadata(reader);
      await expect(pinned(reader).getByTestId("pdf-version-waiting-matched")).toHaveText("Its pages are matched with version 1's.");
      await expect(pinned(reader)).not.toContainText("question");
      await select(reader, 1, "opening sheet of version 1");
      await expect(popoverLine(reader)).toHaveText(`Version ${waiting.number} is waiting. A note or link part made here can be carried to it when it's promoted.`);

      // What each was sent: the map's numbers and its base reach a manager
      // alone; whether it has one, and the pairing a link is carried with,
      // reach every reader. The props cross into the viewer island inside the
      // page's HTML, with their quotes escaped.
      const forManager = await sentHtml(page, `/pdf/${file.slug}`);
      const forReader = await sentHtml(reader, `/pdf/${file.slug}`);
      expect(forManager).toMatch(/openRuns\\?":1/);
      expect(forManager).toMatch(/baseNumber\\?":1/);
      expect(forReader).not.toContain("openRuns");
      expect(forReader).not.toMatch(/baseNumber\\?":\d/);
      expect(forReader).toMatch(/hasMap\\?":true/);
      expect(forReader).toMatch(/\[0,-2\]/);

      // Every question answered: a manager is told there are none.
      await makeVersionFault({ fault: "map", versionId: waiting.id, map: MAP_WHOLE });
      await gotoOk(page, `/pdf/${file.slug}`);
      await waitForViewer(page);
      await openMetadata(page);
      await expect(pinned(page).getByTestId("pdf-version-waiting-manage")).toContainText("Its page map has no open questions.");
    } finally {
      await deleteTestFile(file.id);
    }
  });

  test("on an earlier version's page the same box names both versions, the popover's line names the earlier one, and the waiting version's own page pins nothing", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const tag = token();
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: lines(tag, 1) });
    try {
      // Version 2 the latest, with no map from version 1; version 3 waiting, with a map from version 2.
      const latest = await addTestFileVersion(file.id, { pages: lines(tag, 2) });
      const waiting = await addTestFileVersion(file.id, { pages: lines(tag, 3), promote: false });
      await makeVersionFault({ fault: "map", versionId: waiting.id, map: MAP_WHOLE });

      await gotoOk(page, `/pdf/${file.slug}/v/1`);
      await waitForViewer(page);
      await openMetadata(page);
      await expect(pinned(page)).toContainText(`Version ${waiting.number} is waiting to replace version ${latest.number}.`);
      await expect(pinned(page).getByTestId("pdf-version-waiting-matched")).toHaveText(`Its pages are matched with version ${latest.number}'s.`);
      // Version 2's missing map breaks the way from version 1 to version 3.
      await select(page, 1, "opening sheet of version 1");
      await expect(popoverLine(page)).toHaveText(`Version ${waiting.number} is waiting. A note or link part made here stays on version 1 unless the pages are matched.`);

      // With version 2's map, the maps join version 1 to version 3.
      await makeVersionFault({ fault: "map", versionId: latest.id, map: MAP_WHOLE });
      await gotoOk(page, `/pdf/${file.slug}/v/1`);
      await waitForViewer(page);
      await select(page, 1, "opening sheet of version 1");
      await expect(popoverLine(page)).toHaveText(`Version ${waiting.number} is waiting. A note or link part made here can be carried to it when it's promoted.`);

      // The waiting version's own page: its banner says it waits, and nothing is pinned, dotted or said under the popover.
      await gotoOk(page, `/pdf/${file.slug}/v/${waiting.number}`);
      await waitForViewer(page);
      await expect(page.getByTestId("pdf-version-banner")).toContainText("It is not yet the latest.");
      await openMetadata(page);
      await expect(page.getByTestId("pdf-version-list")).toBeVisible();
      await expect(pinned(page)).toHaveCount(0);
      await expect(page.getByTestId("pdf-tab-dot-metadata")).toHaveCount(0);
      await select(page, 1, `opening sheet of version ${waiting.number}`);
      await expect(popoverLine(page)).toHaveCount(0);
    } finally {
      await deleteTestFile(file.id);
    }
  });
});
