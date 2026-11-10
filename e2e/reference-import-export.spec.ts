import type { Page, Route } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  ADMIN_EMAIL,
  countTestReferences,
  createTestDoc,
  createTestPost,
  deleteTestDoc,
  deleteTestImportRows,
  deleteTestPost,
  deleteTestReferences,
  getCitationSources,
  getReferenceId,
  getTestReference,
  getTestReferenceTitle,
  setTestReferenceDeleted,
} from "./db";
import { createAgent } from "./mcp";

// docs/CITATIONS.md, "Planned: import and export" as built — an import that
// replaces a duplicate's record, survives a reload, and adds nothing twice;
// update_ref; and the downloads, each an attachment under its name.

let isbnCounter = 0;
/** A valid ISBN-13 no other call uses: a 978 prefix, digits from the clock and a counter, and its check digit. */
function freshIsbn(): string {
  const body = `978${String((Date.now() * 10 + isbnCounter++) % 1_000_000_000).padStart(9, "0")}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return `${body}${(10 - (sum % 10)) % 10}`;
}

/** The import panel's box, filled and previewed. */
async function preview(page: Page, text: string) {
  await page.getByText("Add references").click();
  await page.getByRole("textbox", { name: "References to import" }).fill(text);
  await page.getByRole("button", { name: "Preview" }).click();
  return page.getByRole("list", { name: "Import preview" });
}

/** Whether a request is a batch of an import: a server action on /references sending records. */
function isImportBatch(route: Route): boolean {
  const request = route.request();
  const body = request.postDataBuffer()?.toString() ?? "";
  return request.method() === "POST" && Boolean(request.headers()["next-action"]) && body.includes('"csl":') && body.includes('"place":');
}

/** `count` books whose made keys begin with `prefix`: its family name and a year each. */
function books(prefix: string, count: number) {
  return JSON.stringify(Array.from({ length: count }, (_, i) => ({ type: "book", title: `Work ${i} ${prefix}`, author: [{ family: prefix }], issued: { "date-parts": [[1800 + i]] } })));
}

test("an import replaces a duplicate's record from the preview, and a deleted duplicate's, restoring it", async ({ page, request }) => {
  const agent = await createAgent(request);
  const prefix = `e2erepl${Date.now().toString(36)}`;
  const [isbnA, isbnB] = [freshIsbn(), freshIsbn()];
  try {
    for (const [key, isbn] of [[`${prefix}-a`, isbnA], [`${prefix}-b`, isbnB]]) {
      const made = await agent.call("create_ref", { csl: { type: "book", title: `Old ${key}`, ISBN: isbn }, key, short: "OA" });
      expect(made.isError, JSON.stringify(made.error)).toBe(false);
    }
    await setTestReferenceDeleted(`${prefix}-b`, true);

    await page.goto("/references");
    const list = await preview(page, JSON.stringify([{ type: "book", title: `New A ${prefix}`, ISBN: isbnA }, { type: "book", title: `New B ${prefix}`, ISBN: isbnB }]));
    await expect(list).toContainText(`Already in the library as ${prefix}-a, “Old ${prefix}-a”`);
    await expect(list).toContainText(`${prefix}-b (deleted)`);
    await page.getByLabel("Replace the record of every work already in the library with the one being imported").check();
    await page.getByRole("button", { name: "Replace 2" }).click();
    const report = page.getByRole("list", { name: "Import results" });
    await expect(report).toContainText(`Replaced the record of ${prefix}-a: New A ${prefix}`);
    await expect(report).toContainText(`Replaced the record of ${prefix}-b, and restored it: New B ${prefix}`);

    // Its key and abbreviation stay, and the deleted one is back.
    expect(await getTestReferenceTitle(`${prefix}-a`)).toBe(`New A ${prefix}`);
    expect(await getTestReference(`${prefix}-a`)).toMatchObject({ short: "OA", deleted: false, identifiers: [`ISBN:${isbnA}`] });
    expect(await getTestReference(`${prefix}-b`)).toMatchObject({ deleted: false });
  } finally {
    await page.goto("about:blank");
    await deleteTestReferences(prefix);
    await deleteTestImportRows(prefix);
    await agent.dispose();
  }
});

test("an import interrupted part-way resumes after a reload, a batch the server answered but the browser never heard sent again, with nothing added twice", async ({ page }) => {
  const prefix = `e2eresume${Date.now().toString(36)}`;
  let cut = false;
  try {
    // The second batch reaches the server and is written; its answer never reaches the browser.
    await page.route(
      (url) => url.pathname === "/references",
      async (route) => {
        const body = route.request().postDataBuffer()?.toString() ?? "";
        if (!cut && isImportBatch(route) && body.includes('"place":100,')) {
          cut = true;
          await route.fetch();
          await route.abort();
          return;
        }
        await route.continue();
      },
    );
    await page.goto("/references");
    await preview(page, books(prefix, 150));
    await page.getByRole("button", { name: "Import 150" }).click();
    await expect(page.getByText("reload to resume the rest")).toBeVisible();
    expect(await countTestReferences(prefix)).toBe(150);

    await page.unrouteAll();
    await page.reload();
    await expect(page.getByText("An import you started is unfinished: 50 of 150 records left.")).toBeVisible();
    await page.getByRole("button", { name: "Resume" }).click();
    // The report is the server's, read from every record's row: all 150, the resent ones as they were answered.
    await expect(page.getByRole("list", { name: "Import results" }).getByRole("listitem")).toHaveCount(150);
    await expect(page.getByRole("list", { name: "Import results" })).toContainText(`Added ${prefix}1949: Work 149 ${prefix}`);
    expect(await countTestReferences(prefix)).toBe(150);
  } finally {
    await page.goto("about:blank");
    await deleteTestReferences(prefix);
    await deleteTestImportRows(prefix);
  }
});

test("one import resumed from two tabs at once creates each record once, and answers both alike", async ({ page }) => {
  const prefix = `e2etwotab${Date.now().toString(36)}`;
  const second = await page.context().newPage();
  try {
    // The batch never leaves the first tab, so the import is kept to resume.
    await page.route(
      (url) => url.pathname === "/references",
      (route) => (isImportBatch(route) ? route.abort() : route.continue()),
    );
    await page.goto("/references");
    await preview(page, books(prefix, 3));
    await page.getByRole("button", { name: "Import 3" }).click();
    await expect(page.getByText("reload to resume the rest")).toBeVisible();
    await page.unrouteAll();

    await page.reload();
    await second.goto("/references");
    for (const tab of [page, second]) await expect(tab.getByText("An import you started is unfinished: 3 of 3 records left.")).toBeVisible();
    await Promise.all([page.getByRole("button", { name: "Resume" }).click(), second.getByRole("button", { name: "Resume" }).click()]);
    for (const tab of [page, second]) {
      const report = tab.getByRole("list", { name: "Import results" });
      await expect(report.getByRole("listitem")).toHaveCount(3);
      await expect(report).toContainText(`Added ${prefix}1800: Work 0 ${prefix}`);
    }
    expect(await countTestReferences(prefix)).toBe(3);
  } finally {
    await second.close();
    await page.goto("about:blank");
    await deleteTestReferences(prefix);
    await deleteTestImportRows(prefix);
  }
});

test("update_ref corrects a work's record, keeping its key and abbreviation, and refuses a deleted one", async ({ request }) => {
  const agent = await createAgent(request);
  const prefix = `e2eupd${Date.now().toString(36)}`;
  const key = `${prefix}-Frank_1970`;
  try {
    const made = await agent.call("create_ref", { csl: { type: "book", title: `Mistyped ${prefix}`, author: [{ family: "Frank" }] }, key, short: "SOW" });
    expect(made.isError, JSON.stringify(made.error)).toBe(false);
    // Asked for in another case, it is still the work.
    const fixed = await agent.call("update_ref", { key: key.toUpperCase(), csl: { type: "article-journal", title: `The Structure of Ordinary Water ${prefix}`, author: [{ family: "Frank", given: "Henry S." }], issued: { "date-parts": [[1970]] }, "container-title": "Science" } });
    expect(fixed.isError, JSON.stringify(fixed.error)).toBe(false);
    expect(fixed.result).toMatchObject({ key, entry: `Frank, H. S. (1970). “The Structure of Ordinary Water ${prefix}.” Science.` });
    expect(await getTestReference(key)).toMatchObject({ short: "SOW", deleted: false });

    await setTestReferenceDeleted(key, true);
    const refused = await agent.call("update_ref", { key, csl: { type: "book", title: "Anything" } });
    expect(refused.error.code).toBe("conflict");
    expect(await getTestReferenceTitle(key)).toBe(`The Structure of Ordinary Water ${prefix}`);
  } finally {
    await deleteTestReferences(prefix);
    await agent.dispose();
  }
});

test("each download is an attachment under its name: a work's, a doc's and a post's References, and the library's, each behind its gate", async ({ page, request, browser }) => {
  const agent = await createAgent(request);
  const prefix = `e2edl${Date.now().toString(36)}`;
  const key = `${prefix}-x:y.z`;
  let doc: Awaited<ReturnType<typeof createTestDoc>> | null = null;
  let post: Awaited<ReturnType<typeof createTestPost>> | null = null;
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const made = await agent.call("create_ref", {
      csl: { type: "chapter", title: `A Chapter ${prefix}`, author: [{ family: "Humboldt", given: "Alexander", "dropping-particle": "von" }], "container-title": "A Book", page: "49–51", issued: { "date-parts": [[1990, 6, 15]] } },
      key,
    });
    expect(made.isError, JSON.stringify(made.error)).toBe(false);
    const refId = (await getReferenceId(key))!;

    // A work's own download: public, each format under its name, a key's `:` as `_`.
    const files = { bibtex: [".bib", "application/x-bibtex"], biblatex: [".biblatex.bib", "application/x-bibtex"], ris: [".ris", "application/x-research-info-systems"], "csl-json": [".json", "application/vnd.citationstyles.csl+json"] };
    for (const [format, [ending, type]] of Object.entries(files)) {
      const response = await anonymous.request.get(`/api/references/export?format=${format}&key=${encodeURIComponent(key)}`);
      expect(response.status(), format).toBe(200);
      expect(response.headers()["content-type"]).toBe(`${type}; charset=utf-8`);
      expect(response.headers()["content-disposition"]).toContain(`attachment; filename="${prefix}-x_y.z${ending}"`);
    }
    const bib = await (await anonymous.request.get(`/api/references/export?format=bibtex&key=${encodeURIComponent(key)}`)).text();
    expect(bib).toContain(`@incollection{${key},`);
    expect(bib).toMatch(/\tmonth = jun,\n\tday = \{15\},/);
    expect(bib).toContain("von Humboldt, Alexander");
    const ris = await (await anonymous.request.get(`/api/references/export?format=ris&key=${encodeURIComponent(key)}`)).text();
    expect(ris).toContain("SP  - 49\nEP  - 51");
    expect(ris).toContain("AU  - Humboldt, Alexander von");

    // The reference's page links each, and the link downloads.
    await page.goto(`/references/${encodeURIComponent(key)}`);
    const waiting = page.waitForEvent("download");
    await page.getByRole("link", { name: "RIS", exact: true }).click();
    expect((await waiting).suggestedFilename()).toBe(`${prefix}-x_y.z.ris`);

    // A doc's References: its icon, behind the doc's own gate.
    doc = await createTestDoc({
      authorEmail: ADMIN_EMAIL,
      visibility: "SHARED",
      body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "As argued " }, { type: "entityChip", attrs: { kind: "citation", iid: "c1", data: { items: [{ refId }] } } }] }] },
    });
    await expect.poll(() => getCitationSources(key)).toContain(`doc:${doc!.id}`);
    expect((await anonymous.request.get(`/api/references/export?format=bibtex&doc=${doc.id}`)).status()).toBe(404);
    await page.goto(`/doc/${doc.slug}`);
    await page.getByLabel("Download these references").filter({ visible: true }).click();
    const fromDoc = page.waitForEvent("download");
    await page.getByRole("link", { name: "BibTeX", exact: true }).filter({ visible: true }).click();
    expect((await fromDoc).suggestedFilename()).toBe(`${doc.slug}.bib`);

    // A post's References are its text: the icon is drawn beside them, for anyone who may read the post.
    post = await createTestPost({
      authorEmail: ADMIN_EMAIL,
      publish: true,
      body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "As argued " }, { type: "entityChip", attrs: { kind: "citation", iid: "c1", data: { items: [{ refId }] } } }] }] },
    });
    await expect.poll(() => getCitationSources(key)).toContain(`post:${post!.id}`);
    const fromPost = await anonymous.request.get(`/api/references/export?format=csl-json&post=${post.id}`);
    expect(fromPost.status()).toBe(200);
    expect((await fromPost.json()).map((item: { id: string }) => item.id)).toEqual([key]);
    const reader = await anonymous.newPage();
    await reader.goto(post.path!);
    await reader.getByLabel("Download these references").filter({ visible: true }).click();
    const fromPage = reader.waitForEvent("download");
    await reader.getByRole("link", { name: "BibLaTeX", exact: true }).filter({ visible: true }).click();
    expect((await fromPage).suggestedFilename()).toBe(`${post.slug}.biblatex.bib`);

    // The library's: what a search matches, and rows chosen by id, for members only.
    expect((await anonymous.request.get(`/api/references/export?format=bibtex&q=${prefix}`)).status()).toBe(404);
    const matched = await page.request.get(`/api/references/export?format=csl-json&q=${prefix}`);
    expect(matched.headers()["content-disposition"]).toContain('filename="references.json"');
    expect((await matched.json()).map((item: { id: string }) => item.id)).toEqual([key]);
    const chosen = await page.request.get(`/api/references/export?format=csl-json&ids=${refId}`);
    expect((await chosen.json()).map((item: { id: string }) => item.id)).toEqual([key]);
  } finally {
    await anonymous.close();
    await page.goto("about:blank");
    if (post) await deleteTestPost(post.id);
    if (doc) await deleteTestDoc(doc.id);
    await deleteTestReferences(prefix);
    await agent.dispose();
  }
});
