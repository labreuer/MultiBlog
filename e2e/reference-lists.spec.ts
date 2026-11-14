import { test, expect } from "./fixtures";
import { ADMIN_EMAIL, addTestReferenceAlias, createTestFile, fillTestFileMetadata, deleteTestDoc, deleteTestFile, deleteTestReferences, setTestReferenceFile } from "./db";
import { createAgent } from "./mcp";

// docs/CITATIONS.md, "Planned: one link to every work a citation names" — a
// citation of several works links to /references/<key>,<key>,…, one page
// listing them all, each work's page by its place in the fragment.

test("a list of works: each shown, missing keys warned of, 404s, redirects to its written form, ~ for an alias with a comma, and a doc's citation linking to it", async ({
  page,
  request,
}) => {
  const agent = await createAgent(request);
  const prefix = `e2elist${Date.now().toString(36)}`;
  const a = `${prefix}-radner2012`;
  const b = `${prefix}-barfield1957`;
  const titleA = `The Origin of Ideas ${prefix}`;
  const titleB = `Saving the Appearances ${prefix}`;
  const missing = `${prefix}-nobody`;
  let docId = "";
  try {
    for (const [key, title, family, year] of [
      [a, titleA, `Radner${prefix}`, 2012],
      [b, titleB, `Barfield${prefix}`, 1957],
    ] as const) {
      const made = await agent.call("create_ref", { csl: { type: "book", title, author: [{ family }], issued: { "date-parts": [[year]] } }, key });
      expect(made.isError, JSON.stringify(made.error)).toBe(false);
    }
    const status = async (at: string) => (await page.goto(at))?.status();
    const landing = async (at: string): Promise<string> => {
      const response = await page.goto(at);
      expect(response?.status(), at).toBeLessThan(400);
      const url = new URL(page.url());
      return `${url.pathname}${url.hash}`;
    };

    // Two works found and one key nothing answers to: both works, and a warning naming the one.
    expect(await status(`/references/${a},${missing},${b}`)).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("2 works");
    await expect(page).toHaveTitle(new RegExp(`^${titleA} and 1 more`));
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.getByRole("region", { name: titleA })).toContainText(`Radner${prefix} (2012). ${titleA}.`);
    await expect(page.getByRole("region", { name: titleB })).toContainText(`Barfield${prefix} (1957). ${titleB}.`);
    const warning = page.getByText("Keys in red were not found in the database.").locator("..");
    await expect(warning).toContainText(`/references/${a},${missing}`);
    await expect(warning).toContainText(`,${b}`);
    // The missing key alone is in red, and says so to a screen reader too.
    const red = warning.getByText("(not found)").locator("..");
    await expect(red).toHaveCount(1);
    await expect(red).toHaveText(`${missing} (not found)`);
    const colours = await red.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--error)";
      element.parentElement!.append(probe);
      const answer = { key: getComputedStyle(element).color, error: getComputedStyle(probe).color, address: getComputedStyle(element.parentElement!).color };
      probe.remove();
      return answer;
    });
    expect(colours.key).toBe(colours.error);
    expect(colours.address).not.toBe(colours.error);
    // A single work's page is unchanged, and indexed.
    await page.goto(`/references/${a}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(titleA);
    await expect(page.locator('meta[name="robots"]')).toHaveCount(0);

    // Nothing found, too many keys, and a list at a page: not found.
    expect(await status(`/references/${missing},${prefix}-nobody2`)).toBe(404);
    expect(await status(`/references/${missing}`)).toBe(404);
    expect(await status(`/references/${Array.from({ length: 21 }, () => a).join(",")}`)).toBe(404);
    expect(await status(`/references/${a},${b}/p/1`)).toBe(404);
    // A part that is no library key, whatever else is in the list.
    expect(await status(`/references/${a},${encodeURIComponent("not a key")}`)).toBe(404);

    // Redirected to the list as it should be written: an old key, another case, a work twice, a missing key twice.
    const old = `${prefix}-radner-origin`;
    await addTestReferenceAlias(a, old);
    expect(await landing(`/references/${old},${missing},${b}`)).toBe(`/references/${a},${missing},${b}`);
    expect(await landing(`/references/${a.toUpperCase()},${missing},${b}`)).toBe(`/references/${a},${missing},${b}`);
    expect(await landing(`/references/${a},${missing},${b},${old},${missing}`)).toBe(`/references/${a},${missing},${b}`);
    // A list that comes down to one work is that work's page.
    expect(await landing(`/references/${a},${old}`)).toBe(`/references/${a}`);

    // An alias holding a comma, given to b: `~` and it is b's key, which only redirects; without the `~` it is the list of a and b.
    const alias = `${a},${b}`;
    await addTestReferenceAlias(b, alias);
    expect(await landing(`/references/~${encodeURIComponent(alias)}`)).toBe(`/references/${b}`);
    expect(await landing(`/references/~${encodeURIComponent(alias)}/p/1`)).toBe(`/references/${b}#p=1`);
    expect(await status(`/references/${alias}`)).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("2 works");
    expect(await status(`/references/${alias}/p/1`)).toBe(404);

    // A doc's citation of the two links to the list, with the second's page by its place.
    const doc = await agent.call("create_doc", { markdown: `Ideas and appearances [@${a}; @${b}, p. 2].`, title: `List ${prefix}` });
    expect(doc.isError, JSON.stringify(doc.error)).toBe(false);
    docId = String(doc.result.id);
    await page.goto(`/doc/${docId}`);
    await expect(page.locator("a.entity-chip").filter({ visible: true })).toHaveAttribute("href", `/references/${a},${b}#p=,2`);
  } finally {
    await page.goto("about:blank");
    if (docId) await deleteTestDoc(docId);
    await deleteTestReferences(prefix);
    await agent.dispose();
  }
});

test("a list's page offers each work's PDF at the page its place in #p= names, and still does after a renamed key redirects", async ({ page, request }) => {
  const agent = await createAgent(request);
  const prefix = `e2elistpdf${Date.now().toString(36)}`;
  const a = `${prefix}-bhaskar1975`;
  const b = `${prefix}-archer1995`;
  const titleA = `A Realist Theory of Science ${prefix}`;
  const titleB = `Realist Social Theory ${prefix}`;
  // Test PDFs carry no page labels, so a page is the sheet: these have two.
  const fileA = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
  const fileB = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
  try {
    for (const [key, title] of [
      [a, titleA],
      [b, titleB],
    ] as const) {
      const made = await agent.call("create_ref", { csl: { type: "book", title, author: [{ family: `Author${prefix}` }], issued: { "date-parts": [[1990]] } }, key });
      expect(made.isError, JSON.stringify(made.error)).toBe(false);
    }
    await setTestReferenceFile(a, fileA.id);
    await setTestReferenceFile(b, fileB.id);
    // One read already, as a real PDF is once opened: its labels stored as none, and a page still the sheet.
    expect(await fillTestFileMetadata(fileB.id)).toEqual([]);

    const offered = async () => {
      const first = page.getByRole("region", { name: titleA });
      const second = page.getByRole("region", { name: titleB });
      await expect(second.getByRole("link", { name: fileB.title })).toHaveAttribute("href", `/pdf/${fileB.slug}#sheet=2`);
      await expect(second).toContainText(", at p. 2");
      await expect(first.getByRole("link", { name: fileA.title })).toHaveAttribute("href", `/pdf/${fileA.slug}`);
      await expect(first).not.toContainText(", at p.");
      // Each work's own section is the named region; the island names none of its own.
      await expect(page.getByRole("region", { name: "Where you can read it" })).toHaveCount(0);
    };
    await page.goto(`/references/${a},${b}#p=,2`);
    await offered();

    const old = `${prefix}-bhaskar-old`;
    await addTestReferenceAlias(a, old);
    await page.goto(`/references/${old},${b}#p=,2`);
    await expect(page).toHaveURL(new RegExp(`/references/${a},${b}#p=,2$`));
    await offered();
  } finally {
    await page.goto("about:blank");
    await deleteTestReferences(prefix);
    await deleteTestFile(fileA.id);
    await deleteTestFile(fileB.id);
    await agent.dispose();
  }
});
