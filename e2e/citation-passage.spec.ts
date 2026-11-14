import { test, expect, bodyEditor, waitForDocCollabReady } from "./fixtures";
import { ADMIN_EMAIL, createTestFile, deleteTestDoc, deleteTestFile, deleteTestReferences, setTestReferenceFile, type TestFile } from "./db";
import { createAgent } from "./mcp";

// docs/CITATIONS.md, "A passage in a citation" — a link around a citation
// names the words it cites: the quotation beside it (`quote:prev`,
// `quote:next`) or a passage of the work's PDF. Set from the popover's
// "Points at", written as Pandoc's linked citation, checked when MCP writes
// it, and followed through the cited-page route to the passage outlined.
//
// The fixture is the fragment links' (pdf-fragment-links.spec.ts): page 3
// ends with a folio and a running head, so a quote across into page 4 has
// them between its halves. A test PDF has no page labels, so a page is its
// sheet.

const PAGES = [
  ["Front matter for the citation passage test."],
  [
    "The law of participation governs the earlier mind.",
    "Later the law of participation fades from view.",
    "It is a direction in which we had all better be moving,",
    "rather than a beatific consummation at the end.",
  ],
  ["A page before the break, whose last line runs on.", "It may also sometimes be detected within, but it", "3 Original Participation"],
  ["is detected primarily without, as the next page says.", "The rest of the fourth page."],
];

const banner = (page: import("@playwright/test").Page) => page.getByTestId("pdf-fragment-banner");

test.describe("a passage in a citation", () => {
  let file: TestFile;

  test.beforeAll(async () => {
    file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: PAGES });
  });

  test.afterAll(async () => {
    await deleteTestFile(file.id);
  });

  test("Points at the quotation before: highlighted and named in the popover, linked with its words, and followed to them", async ({ page, request }) => {
    const agent = await createAgent(request);
    const prefix = `e2epass${Date.now().toString(36)}`;
    const key = `${prefix}-barfield1957`;
    let docId = "";
    try {
      const made = await agent.call("create_ref", {
        csl: { type: "book", title: `Saving the Appearances ${prefix}`, author: [{ family: `Barfield${prefix}` }], issued: { "date-parts": [[1957]] } },
        key,
      });
      expect(made.isError, JSON.stringify(made.error)).toBe(false);
      await setTestReferenceFile(key, file.id);
      const quotation = "the law of participation governs the earlier mind";
      const doc = await agent.call("create_doc", { markdown: `Barfield: "${quotation}" [@${key}, p. 2].`, title: `Points at ${prefix}` });
      expect(doc.isError, JSON.stringify(doc.error)).toBe(false);
      docId = String(doc.result.id);

      await page.goto(`/doc/${docId}/edit`);
      await waitForDocCollabReady(page);
      const chip = bodyEditor(page).locator(".entity-chip");
      const iid = await chip.getAttribute("data-iid");
      await chip.click();
      const popover = page.locator(`[data-cite-popover="${iid}"]`);
      const pointsAt = popover.getByRole("group", { name: "Points at" });
      await expect(pointsAt.getByLabel("Nothing")).toBeChecked();

      // The quotation before it: named under the control, and highlighted in the text.
      await pointsAt.getByLabel("The quotation before").check();
      await expect(pointsAt.getByRole("status")).toHaveText(`“${quotation}”`);
      await expect(bodyEditor(page).locator(".cite-quotation")).toHaveText(quotation);
      // There is none after it: the citation would link to its page.
      await pointsAt.getByLabel("The quotation after").check();
      await expect(pointsAt.getByRole("status")).toHaveText("There is no quotation there, so it links to its page.");
      await expect(bodyEditor(page).locator(".cite-quotation")).toHaveCount(0);
      await pointsAt.getByLabel("The quotation before").check();

      // A citation without a page takes no quotation: removing the page drops it, and says so.
      const work = popover.getByRole("group", { name: key });
      await work.getByLabel("Page").fill("");
      await work.getByLabel("Page").press("Enter");
      await expect(pointsAt.getByLabel("Nothing")).toBeChecked();
      await expect(pointsAt.getByLabel("The quotation before")).toBeDisabled();
      await expect(pointsAt.getByRole("status")).toHaveText(/needs one work at a page\. It points at nothing now\./);
      await work.getByLabel("Page").fill("2");
      await work.getByLabel("Page").press("Enter");
      await pointsAt.getByLabel("The quotation before").check();
      // Other edits keep it: the form, there and back.
      await popover.getByLabel("In the sentence").check();
      await popover.getByLabel("In parentheses").check();
      await expect(pointsAt.getByLabel("The quotation before")).toBeChecked();
      await popover.getByRole("button", { name: "Done" }).click();

      // Written as the link around the citation, once the collab server has stored it.
      await expect
        .poll(async () => String((await agent.call("read", { url: `/doc/${docId}` })).result.markdown), { timeout: 15_000 })
        .toBe(`Barfield: "${quotation}" [[@${key}, p. 2]](quote:prev).`);

      // The reading view links the words, and following the link outlines them in the PDF.
      await page.goto(`/doc/${docId}`);
      const link = page.locator("a.entity-chip").filter({ visible: true });
      const words = quotation.replaceAll(" ", "+");
      await expect(link).toHaveAttribute("href", `/references/${key}/p/2?text=${words}`);
      await link.click();
      await expect(page).toHaveURL(`/pdf/${file.slug}#sheet=2&text=${words}`);
      // The banner shows the PDF's words, never the URL's.
      await expect(banner(page)).toContainText("The law of participation governs the earlier mind", { timeout: 20_000 });
    } finally {
      await page.goto("about:blank");
      if (docId) await deleteTestDoc(docId);
      await deleteTestReferences(prefix);
      await agent.dispose();
    }
  });

  test("MCP writes a citation's passage and refuses one its cited page doesn't hold; a quotation over two pages lands on both", async ({ page, browser, request }) => {
    const agent = await createAgent(request);
    const prefix = `e2epmcp${Date.now().toString(36)}`;
    const key = `${prefix}-barfield1957`;
    const other = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const docs: string[] = [];
    try {
      const made = await agent.call("create_ref", {
        csl: { type: "book", title: `Saving the Appearances ${prefix}`, author: [{ family: `Barfield${prefix}` }], issued: { "date-parts": [[1957]] } },
        key,
      });
      expect(made.isError, JSON.stringify(made.error)).toBe(false);
      await setTestReferenceFile(key, file.id);

      const markdown = [
        `"It may also sometimes be detected within, but it is detected primarily without" [[@${key}, pp. 3–4]](quote:prev)`,
        `[@${key} [p. 2]](quote:next) writes "[T]he law of participation … fades from view".`,
        `See also [[@${key}, p. 2]](/pdf/${file.slug}#page=2&text=a+direction...beatific+consummation).`,
      ].join("\n\n");
      const written = await agent.call("create_doc", { markdown, title: `Passages ${prefix}` });
      expect(written.isError, JSON.stringify(written.error)).toBe(false);
      docs.push(String(written.result.id));
      // A read writes each one back as it was written.
      const read = String((await agent.call("read", { url: `/doc/${written.result.id}` })).result.markdown);
      expect(read).toContain(`[[@${key}, pp. 3–4]](quote:prev)`);
      expect(read).toContain(`[@${key} [p. 2]](quote:next)`);
      expect(read).toContain(`[[@${key}, p. 2]](/pdf/${file.slug}#page=2&text=a+direction...beatific+consummation)`);

      // Refused: a quotation the cited page doesn't hold, a /pdf/ passage in another work's PDF, and a key nothing has.
      const miss = await agent.call("create_doc", { markdown: `"nothing at all like this page" [[@${key}, p. 2]](quote:prev)` });
      expect(miss.error).toMatchObject({ code: "no_match" });
      const elsewhere = await agent.call("create_doc", { markdown: `[[@${key}, p. 2]](/pdf/${other.slug}#page=2&text=xylophone+marmalade)` });
      expect(elsewhere.error).toMatchObject({ code: "no_match" });
      const unknown = await agent.call("create_doc", { markdown: `[@${prefix}nobody](https://x.example/nobody)` });
      expect(unknown.error).toMatchObject({ code: "unknown_chip" });
      expect(String(unknown.error?.message)).toContain(`[\\@${prefix}nobody](https://x.example/nobody)`);

      // Each link carries its passage, and the route places it: across the break, the bracket settled, the pairs as written.
      await page.goto(`/doc/${written.result.id}`);
      const links = page.locator("a.entity-chip").filter({ visible: true });
      await expect(links).toHaveCount(3);
      const hrefs = await links.evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href") ?? ""));
      expect(hrefs).toEqual([
        `/references/${key}/p/${encodeURIComponent("3–4")}?text=It+may+also+sometimes+be+detected+within+but+it+is+detected+primarily+without`,
        `/references/${key}/p/2?text=%5BT%5Dhe+law+of+participation...fades+from+view`,
        `/references/${key}/p/2?page=2&text=a+direction...beatific+consummation`,
      ]);
      const follow = async (href: string) => {
        await page.goto(href);
        const url = new URL(page.url());
        return `${url.pathname}${url.hash}`;
      };
      expect(await follow(hrefs[0])).toBe(`/pdf/${file.slug}#sheet=3&text=It+may+also,within+but+it&sheet=4&text=is+detected+primarily+without`);
      await expect(banner(page)).toContainText("is detected primarily without", { timeout: 20_000 });
      expect(await follow(hrefs[1])).toBe(`/pdf/${file.slug}#sheet=2&text=The+law+of+participation...fades+from+view`);
      // A /pdf/ referent's pairs go through as its writer wrote them, page= included.
      expect(await follow(hrefs[2])).toBe(`/pdf/${file.slug}#page=2&text=a+direction...beatific+consummation`);

      // Signed out, the PDF isn't theirs to open: the reference's page, without the words.
      const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
      try {
        const outsider = await anonymous.newPage();
        await outsider.goto(hrefs[1]);
        const url = new URL(outsider.url());
        expect(`${url.pathname}${url.hash}`).toBe(`/references/${key}#p=2`);
      } finally {
        await anonymous.close();
      }
    } finally {
      await page.goto("about:blank");
      for (const id of docs) await deleteTestDoc(id);
      await deleteTestReferences(prefix);
      await deleteTestFile(other.id);
      await agent.dispose();
    }
  });
});
