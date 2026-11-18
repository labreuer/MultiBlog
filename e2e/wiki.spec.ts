// Wiki pages (docs/WIKI.md) — docs with a name and an address under /wiki.
// Each section pins rules the plan states, in the order the build lands
// them. Until pages can be created in the app, a page is a test doc given an
// address by writing its columns (createTestWikiPage), as the claims will.
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, visibleText, waitForDocCollabReady } from "./fixtures";
import {
  ADMIN_EMAIL,
  addTestDocAuthor,
  addTestDocSlugHistory,
  createTestAnnotation,
  createWikiPageAs,
  findTestWikiPageId,
  getUserIdByEmail,
  renameTestUserSlug,
  setTestUserRole,
  softDeleteTestUser,
  type TestWikiPage,
  appendTestDocParagraph,
  changeTestDocSetting,
  countPostsForDoc,
  createTestDoc,
  createTestFile,
  createTestWikiPage,
  deleteTestDoc,
  deleteTestFile,
  foldTestWikiName,
  forkDocAs,
  frontPagePreambleText,
  renameWikiPageAs,
  getTestWikiAddressHistory,
  ageTestWikiAddressHistory,
  getTestForkFacts,
  getTestWikiFacts,
  writeTestFileVisibility,
  writeTestWikiColumns,
} from "./db";
import { checkWikiName } from "@/lib/wiki-name";
import { wikiNameSegment } from "@/lib/wiki-address";
import { createAgent } from "./mcp";

test.describe("names and data (docs/WIKI.md \"Data model\", \"The name is the title\")", () => {
  test("a page's title is its name, whatever writes the title, and its search vector follows the name", async () => {
    // A stamp in each name, so copies of this test running at once don't
    // collide on the commons' addresses.
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const page = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", name: `E2E Quillwort (plant) ${stamp}` });
    try {
      expect(await getTestWikiFacts(page.id, "quillwort")).toMatchObject({
        title: `E2E Quillwort (plant) ${stamp}`,
        wikiNameKey: `e2e quillwort (plant) ${stamp}`,
        searchMatches: true,
      });
      // The collab server's cache write names `title` alone, with the
      // fragment's text: the name stays.
      expect(await writeTestWikiColumns(page.id, { title: "E2E something else" })).toEqual({ ok: true });
      expect(await getTestWikiFacts(page.id, "quillwort")).toMatchObject({ title: `E2E Quillwort (plant) ${stamp}`, searchMatches: true });
      // A new name is the title, its key and the vector's at once.
      expect(await writeTestWikiColumns(page.id, { wikiName: `E2E Bladderwort ${stamp}` })).toEqual({ ok: true });
      const renamed = await getTestWikiFacts(page.id, "bladderwort");
      expect(renamed).toMatchObject({ title: `E2E Bladderwort ${stamp}`, wikiNameKey: `e2e bladderwort ${stamp}`, searchMatches: true });
      expect((await getTestWikiFacts(page.id, "quillwort")).searchMatches).toBe(false);
    } finally {
      await deleteTestDoc(page.id);
    }
  });

  test("names compare by a key the database folds: one address per key in a namespace, and none across namespaces, variants or deleted pages", async ({
    secondUser,
  }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const first = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", name: `E2E Straße ${stamp}` });
    const second = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const iota = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", name: `E2E ΐ ${stamp}` });
    try {
      // Postgres 18's full folding: ß is ss.
      expect(await writeTestWikiColumns(second.id, { wikiName: `E2E STRASSE ${stamp}`, owner: "commons" })).toEqual({ ok: false, refusal: "unique" });
      // The fold normalized: ΐ and its capital, which folds to another spelling of the same letter.
      expect(await writeTestWikiColumns(second.id, { wikiName: `E2E Ϊ\u0301 ${stamp}`, owner: "commons" })).toEqual({
        ok: false,
        refusal: "unique",
      });
      // As a variant, or in a person's namespace, the same name is another address.
      expect(await writeTestWikiColumns(second.id, { wikiName: `E2E STRASSE ${stamp}`, owner: "commons", wikiVariant: "2" })).toEqual({ ok: true });
      expect(await writeTestWikiColumns(second.id, { wikiVariant: "", owner: owner.email, visibility: "SHARED" })).toEqual({ ok: true });
      // A deleted page gives its address back.
      expect(await writeTestWikiColumns(second.id, { owner: "commons", deleted: true })).toEqual({ ok: true });
      expect(await writeTestWikiColumns(first.id, { deleted: true })).toEqual({ ok: true });
      expect(await writeTestWikiColumns(second.id, { deleted: false })).toEqual({ ok: true });
      expect(await getTestWikiFacts(second.id)).toMatchObject({ wikiName: `E2E STRASSE ${stamp}`, wikiNameKey: `e2e strasse ${stamp}` });
    } finally {
      await deleteTestDoc(first.id);
      await deleteTestDoc(second.id);
      await deleteTestDoc(iota.id);
    }
  });

  test("the database refuses every name the rules refuse, and takes what they accept", async () => {
    const stamp = `e2e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    try {
      const refused = [
        "a/b",
        "Why?",
        "a~b",
        "a\\b",
        "a#b",
        "a|b",
        "a[b]",
        "x.RSC",
        "Smile :)",
        "a (b",
        "%41",
        "&amp;",
        "..",
        "a\u0001b",
        "a\uFFFD",
        "x".repeat(256),
        // Normalized forms the rules would have written otherwise:
        "a_b",
        "a  b",
        " a",
        "a\u00A0b",
        "a\u200Eb",
        "Cafe\u0301",
        // Unassigned in the database's Unicode, which the rules leave to it.
        "a\u{E0080}",
      ];
      for (const name of refused) {
        const result = await writeTestWikiColumns(doc.id, { wikiName: name, owner: "commons" });
        expect(result, JSON.stringify(name)).toEqual({ ok: false, refusal: "doc_wiki_name_valid" });
        const checked = checkWikiName(name);
        // The rules refuse it, or would have stored another spelling; only
        // the database knows what is unassigned.
        if (!name.includes("\u{E0080}")) expect(checked.ok && checked.name === name, JSON.stringify(name)).toBe(false);
      }
      const accepted = ["Mercury (planet)", "100% pure", "R&D (lab)", "& x;", "a\u200Bb", "Ὀδυσσεύς", "x".repeat(255)];
      for (const [i, name] of accepted.entries()) {
        expect(checkWikiName(name), JSON.stringify(name)).toEqual({ ok: true, name });
        // Its own variant per name and per run, so nothing here collides.
        const result = await writeTestWikiColumns(doc.id, { wikiName: name, owner: "commons", wikiVariant: `${stamp}-${i}` });
        expect(result, JSON.stringify(name)).toEqual({ ok: true });
      }
      expect(await writeTestWikiColumns(doc.id, { wikiVariant: "Not-A-Slug" })).toEqual({ ok: false, refusal: "doc_wiki_variant_is_slug" });
    } finally {
      await deleteTestDoc(doc.id);
    }
  });

  test("PUBLIC is a wiki page's alone and never a file's, a commons page is never PRIVATE, and an address needs a name", async () => {
    const lichen = `E2E Lichen ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL });
    const file = await createTestFile({ ownerEmail: ADMIN_EMAIL });
    try {
      expect(await writeTestWikiColumns(doc.id, { visibility: "PUBLIC" })).toEqual({ ok: false, refusal: "doc_public_only_wiki" });
      expect(await writeTestWikiColumns(doc.id, { wikiName: lichen, owner: "commons" })).toEqual({ ok: false, refusal: "doc_commons_not_private" });
      expect(await writeTestWikiColumns(doc.id, { wikiVariant: "x" })).toEqual({ ok: false, refusal: "doc_wiki_variant_needs_name" });
      expect(await writeTestWikiColumns(doc.id, { owner: ADMIN_EMAIL })).toEqual({ ok: false, refusal: "doc_wiki_owner_needs_name" });
      expect(await writeTestWikiColumns(doc.id, { wikiName: lichen, owner: "commons", visibility: "PUBLIC" })).toEqual({ ok: true });
      expect(await writeTestFileVisibility(file.id, "PUBLIC")).toEqual({ ok: false, refusal: "file_not_public" });
    } finally {
      await deleteTestDoc(doc.id);
      await deleteTestFile(file.id);
    }
  });

  test("a name is folded by the database, in one statement that also says whether it is assigned and held for editors", async () => {
    expect(await foldTestWikiName("Straße")).toEqual({ key: "strasse", assigned: true, heldInCommons: false });
    expect(await foldTestWikiName("FRONT page")).toEqual({ key: "front page", assigned: true, heldInCommons: true });
    expect(await foldTestWikiName("ABOUT")).toMatchObject({ heldInCommons: true });
    expect(await foldTestWikiName("About us")).toMatchObject({ heldInCommons: false });
    expect(await foldTestWikiName("a\u{E0080}")).toMatchObject({ assigned: false });
  });
});

test.describe("a wiki page's settings (docs/WIKI.md \"Permissions\")", () => {
  test("an EDITOR can't edit a person's SHARED page, or see an Edit link for it in the wiki table, and can a commons page", async ({
    secondUser,
  }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const { user: editorUser, page: editor } = await secondUser({ role: "EDITOR" });
    const personal = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "SHARED" });
    const commons = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "SHARED" });
    try {
      await editor.goto(`/doc/${personal.id}/edit`);
      await expect(editor.getByRole("heading", { name: "Forbidden" })).toBeVisible();
      await editor.goto(`/doc/${commons.id}/edit`);
      await waitForDocCollabReady(editor);

      for (const [doc, editable] of [
        [personal, false],
        [commons, true],
      ] as const) {
        const row = await wikiTableRow(editor, doc);
        await expect(row.getByRole("link", { name: "edit", exact: true })).toHaveCount(editable ? 1 : 0);
      }

      // doc-manage.ts asks the same rule, under the doc's lock.
      expect(await changeTestDocSetting({ actorEmail: editorUser.email, docId: personal.id, change: { visibility: "PRIVATE" } })).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(
        await changeTestDocSetting({ actorEmail: editorUser.email, docId: personal.id, change: { byline: [owner.email, editorUser.email] } }),
      ).toMatchObject({ ok: false, code: "forbidden" });
      expect(await changeTestDocSetting({ actorEmail: editorUser.email, docId: commons.id, change: { visibility: "PUBLIC" } })).toEqual({ ok: true });
    } finally {
      await editor.goto("about:blank").catch(() => {});
      await deleteTestDoc(personal.id);
      await deleteTestDoc(commons.id);
    }
  });

  test("a doc takes only a visibility allowedVisibilities offers: no PUBLIC off the wiki, no PRIVATE in the commons", async ({ secondUser }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL });
    const commons = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons" });
    const personal = await createTestWikiPage({ authorEmail: owner.email, namespace: "person" });
    try {
      for (const value of ["PUBLIC", "UNLISTED"]) {
        expect(await changeTestDocSetting({ actorEmail: ADMIN_EMAIL, docId: doc.id, change: { visibility: value } })).toMatchObject({
          ok: false,
          code: "invalid",
        });
      }
      expect(await changeTestDocSetting({ actorEmail: ADMIN_EMAIL, docId: doc.id, change: { visibility: "SHARED" } })).toEqual({ ok: true });
      expect(await changeTestDocSetting({ actorEmail: ADMIN_EMAIL, docId: commons.id, change: { visibility: "PRIVATE" } })).toMatchObject({
        ok: false,
        code: "invalid",
      });
      expect(await changeTestDocSetting({ actorEmail: ADMIN_EMAIL, docId: commons.id, change: { visibility: "PUBLIC" } })).toEqual({ ok: true });
      expect(await changeTestDocSetting({ actorEmail: owner.email, docId: personal.id, change: { visibility: "PUBLIC" } })).toEqual({ ok: true });
      expect((await getTestWikiFacts(personal.id)).visibility).toBe("PUBLIC");
    } finally {
      await deleteTestDoc(doc.id);
      await deleteTestDoc(commons.id);
      await deleteTestDoc(personal.id);
    }
  });
});

test.describe("doc rules a wiki page doesn't inherit (docs/WIKI.md)", () => {
  test("a wiki page publishes nothing: /posts/new neither offers it nor accepts it", async ({ page }) => {
    const wiki = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "person", visibility: "SHARED" });
    try {
      await page.goto("/posts/new");
      const picker = page.locator('select[name="docId"]');
      await expect(picker.locator(`option[value="${wiki.id}"]`)).toHaveCount(0);

      // The hand-made call the server's own refusal exists for: the same
      // form, sent with the wiki page's id.
      await picker.evaluate((select, id) => {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = "hand-made";
        select.appendChild(option);
        (select as HTMLSelectElement).value = id;
      }, wiki.id);
      const answered = page.waitForResponse(
        (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/posts/new",
      );
      await page.getByRole("button", { name: "Create post" }).click();
      await answered;
      expect(await countPostsForDoc(wiki.id)).toBe(0);
      await expect(page).not.toHaveURL(/\/post\/[^/]+\/edit/);
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(wiki.id);
    }
  });

  test("a wiki page named FRONT PAGE is never the landing page's preamble", async () => {
    // Backdated, so it would win as the first-created FRONT PAGE doc if wiki
    // pages weren't left out. Its name is its title, by the mirror.
    const marker = `E2E wiki front page ${Date.now()}`;
    const wiki = await createTestWikiPage({
      authorEmail: ADMIN_EMAIL,
      namespace: "commons",
      name: "FRONT PAGE",
      variant: `e2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      bodyText: marker,
      createdAt: "2000-01-01T00:00:00.000Z",
    });
    try {
      expect((await getTestWikiFacts(wiki.id)).title).toBe("FRONT PAGE");
      expect((await frontPagePreambleText()) ?? "").not.toContain(marker);
    } finally {
      await deleteTestDoc(wiki.id);
    }
  });

  test("a wiki page forks as a doc, titled with its name rather than its title fragment, and never as PUBLIC", async () => {
    // createTestDoc seeded the fragment with a title of its own, as a doc
    // moved into the wiki keeps the title it had.
    const wiki = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "SHARED", bodyText: "Leaves." });
    const forks: string[] = [];
    try {
      await appendTestDocParagraph({ docId: wiki.id, text: "More leaves." });
      expect(await forkDocAs({ actorEmail: ADMIN_EMAIL, parentId: wiki.id, visibility: "PUBLIC" })).toMatchObject({ ok: false, code: "invalid" });
      const fork = await forkDocAs({ actorEmail: ADMIN_EMAIL, parentId: wiki.id, visibility: "SHARED" });
      expect(fork).toMatchObject({ ok: true });
      if (!fork.ok) return;
      forks.push(fork.id);
      expect(await getTestWikiFacts(fork.id)).toMatchObject({ title: wiki.wikiName, wikiName: null, visibility: "SHARED" });
      expect((await getTestForkFacts(fork.id)).forkedFromDocId).toBe(wiki.id);
    } finally {
      for (const id of forks) await deleteTestDoc(id);
      await deleteTestDoc(wiki.id);
    }
  });
});

/** A request's status and Location, with no redirect followed. */
async function answer(request: APIRequestContext, path: string): Promise<[number, string | undefined]> {
  const res = await request.get(path, { maxRedirects: 0 });
  return [res.status(), res.headers()["location"]];
}

const toSignIn = expect.stringMatching(/^\/sign-in\?callbackUrl=/);

/** The message the name rules refuse a name with. */
function checkWikiNameMessage(name: string): string {
  const checked = checkWikiName(name);
  if (checked.ok) throw new Error(`${name} is accepted`);
  return checked.message;
}

/** The wiki table's row for a page, by its name. */
async function wikiTableRow(page: Page, wiki: { wikiName: string }) {
  await page.goto(`/wiki/special/pages?q=${encodeURIComponent(wiki.wikiName)}`);
  const row = page.getByRole("row").filter({ hasText: wiki.wikiName });
  await expect(row).toHaveCount(1);
  return row;
}

test.describe("a person's page and its owner (docs/WIKI.md \"Permissions\")", () => {
  test("an ADMIN may lower a person's PUBLIC page from the wiki table, and may not raise, edit or delete it", async ({
    page,
    secondUser,
  }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const wiki = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "PUBLIC" });
    try {
      const row = await wikiTableRow(page, wiki);
      await expect(row.getByRole("link", { name: "edit", exact: true })).toHaveCount(0);
      await expect(row.getByRole("button", { name: /^(Delete|Restore)/ })).toHaveCount(0);
      const visibility = row.locator("select");
      await expect(visibility.locator("option")).toHaveText(["PRIVATE", "SHARED", "PUBLIC"]);
      await visibility.selectOption("SHARED");
      await expect.poll(async () => (await getTestWikiFacts(wiki.id)).visibility).toBe("SHARED");
      await expect((await wikiTableRow(page, wiki)).locator("select option")).toHaveText(["PRIVATE", "SHARED"]);

      // Raising it back and deleting it are its owner's, whatever an ADMIN sends.
      expect(await changeTestDocSetting({ actorEmail: ADMIN_EMAIL, docId: wiki.id, change: { visibility: "PUBLIC" } })).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await changeTestDocSetting({ actorEmail: ADMIN_EMAIL, docId: wiki.id, change: { deleted: true } })).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      await page.goto(`${wiki.path}/edit`);
      await expect(page.getByRole("heading", { name: "Forbidden" })).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(wiki.id);
    }
  });

  test("a co-author may lower the owner's page and add to its byline, and may not raise or delete it", async ({ secondUser }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const { user: coauthor, page: coauthorPage } = await secondUser({ role: "AUTHOR" });
    const { user: third } = await secondUser({ role: "AUTHOR" });
    const wiki = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "PUBLIC" });
    try {
      await addTestDocAuthor(wiki.id, coauthor.email);
      // The editor's Settings offer a co-author no raise above what the page is.
      await coauthorPage.goto(`${wiki.path}/edit`);
      await waitForDocCollabReady(coauthorPage);
      const settings = coauthorPage.locator("details").filter({ has: coauthorPage.locator("summary", { hasText: "Settings" }) });
      await settings.locator("summary").click();
      await expect(settings.getByLabel("Visibility").locator("option")).toHaveText(["PRIVATE", "SHARED", "PUBLIC"]);

      const as = (change: Parameters<typeof changeTestDocSetting>[0]["change"]) =>
        changeTestDocSetting({ actorEmail: coauthor.email, docId: wiki.id, change });
      expect(await as({ visibility: "SHARED" })).toEqual({ ok: true });
      expect(await as({ visibility: "PUBLIC" })).toMatchObject({ ok: false, code: "forbidden" });
      expect(await as({ byline: [owner.email, coauthor.email, third.email] })).toEqual({ ok: true });
      expect(await as({ deleted: true })).toMatchObject({ ok: false, code: "forbidden" });
      expect(await getTestWikiFacts(wiki.id)).toMatchObject({
        visibility: "SHARED",
        deleted: false,
        bylineEmails: [owner.email, coauthor.email, third.email],
      });
    } finally {
      await coauthorPage.goto("about:blank").catch(() => {});
      await deleteTestDoc(wiki.id);
    }
  });

  test("an owner demoted or deleted after signing in can no longer raise, delete or create in their namespace", async ({ secondUser }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const wiki = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "PRIVATE" });
    // A session signed in as an AUTHOR keeps saying so, whatever the account becomes.
    const asOwner = (change: Parameters<typeof changeTestDocSetting>[0]["change"]) =>
      changeTestDocSetting({ actorEmail: owner.email, sessionRole: "AUTHOR", docId: wiki.id, change });
    try {
      expect(await asOwner({ visibility: "SHARED" })).toEqual({ ok: true });
      expect(await asOwner({ visibility: "PRIVATE" })).toEqual({ ok: true });

      await setTestUserRole(owner.email, "COMMENTER");
      expect(await asOwner({ visibility: "SHARED" })).toMatchObject({ ok: false, code: "forbidden" });
      expect(await asOwner({ deleted: true })).toMatchObject({ ok: false, code: "forbidden" });
      expect(
        await createWikiPageAs({ actorEmail: owner.email, sessionRole: "AUTHOR", page: { namespace: "person", name: `${wiki.wikiName} more`, visibility: "PRIVATE" } }),
      ).toMatchObject({ ok: false, code: "forbidden" });

      await setTestUserRole(owner.email, "AUTHOR");
      await softDeleteTestUser(owner.email, ADMIN_EMAIL);
      expect(await asOwner({ visibility: "SHARED" })).toMatchObject({ ok: false, code: "forbidden" });
      expect(await asOwner({ deleted: true })).toMatchObject({ ok: false, code: "forbidden" });
      expect(await getTestWikiFacts(wiki.id)).toMatchObject({ visibility: "PRIVATE", deleted: false });
    } finally {
      await deleteTestDoc(wiki.id);
    }
  });

  test("the owner stays on the byline, through the worker's call and MCP's manage, and a wiki doc's slug is frozen", async ({
    request,
    secondUser,
  }) => {
    const agent = await createAgent(request, { scopes: ["READ", "WRITE", "MANAGE"], person: true });
    const { user: other } = await secondUser({ role: "AUTHOR" });
    const wiki = await createTestWikiPage({ authorEmail: agent.user.email, namespace: "person", visibility: "SHARED" });
    try {
      await addTestDocAuthor(wiki.id, other.email);
      expect(
        await changeTestDocSetting({ actorEmail: agent.user.email, docId: wiki.id, change: { byline: [other.email] } }),
      ).toMatchObject({ ok: false, code: "invalid", message: expect.stringContaining("keeps its owner") });

      const otherId = await getUserIdByEmail(other.email);
      const byline = await agent.call("manage", { target: `/doc/${wiki.slug}`, byline: [otherId], allowRemovals: true });
      expect(byline.isError).toBe(true);
      expect(byline.error).toMatchObject({ code: "invalid", owner: agent.user.id });

      const slug = await agent.call("manage", { target: wiki.path, slug: "a-new-handle" });
      expect(slug.isError).toBe(true);
      expect(String(slug.error.message)).toContain("can't be changed");
      expect((await getTestWikiFacts(wiki.id)).slug).toBe(wiki.slug);
      expect((await getTestWikiFacts(wiki.id)).bylineEmails).toEqual([agent.user.email, other.email]);
    } finally {
      await deleteTestDoc(wiki.id);
      await agent.dispose();
    }
  });

  test("/doc/<slug>/slug shows a wiki page's address and its past urls, with nothing to change", async ({ page }) => {
    const wiki = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "SHARED" });
    const old = `e2e-old-${Date.now()}`;
    try {
      await addTestDocSlugHistory(wiki.id, old);
      await page.goto(`/doc/${wiki.slug}/slug`);
      await expect(page.getByRole("link", { name: wiki.path })).toBeVisible();
      await expect(page.getByText(`/doc/${old}`)).toBeVisible();
      for (const name of ["Change…", "Use this url", "Revert"]) {
        await expect(page.getByRole("button", { name })).toHaveCount(0);
      }
      await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(1);
      expect(await changeTestDocSetting({ actorEmail: ADMIN_EMAIL, docId: wiki.id, change: { slug: "renamed" } })).toMatchObject({
        ok: false,
        message: expect.stringContaining("can't be changed"),
      });
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(wiki.id);
    }
  });

  test("a page restored after its address was taken comes back at the next free variant, and says where", async ({ secondUser }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const first = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "SHARED" });
    let second: TestWikiPage | null = null;
    const asOwner = (deleted: boolean) => changeTestDocSetting({ actorEmail: owner.email, docId: first.id, change: { deleted } });
    try {
      expect(await asOwner(true)).toMatchObject({ ok: true });
      // Taken in other capitals, which is the same address.
      second = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", name: first.wikiName.toUpperCase(), visibility: "SHARED" });
      expect(await asOwner(false)).toEqual({ ok: true, wikiPath: `${first.path}~2`, renamedFrom: first.path, removedAddresses: [] });
      expect(await getTestWikiFacts(first.id)).toMatchObject({ deleted: false, wikiVariant: "2" });
    } finally {
      await deleteTestDoc(first.id);
      if (second) await deleteTestDoc(second.id);
    }
  });

  test("the commons' held names are an ADMIN's or EDITOR's to claim, in any capitals, and a person's namespace holds none", async ({
    secondUser,
  }) => {
    const { user: author } = await secondUser({ role: "AUTHOR" });
    const created: string[] = [];
    try {
      // An AUTHOR on a commons page's byline restores it, and a held name is refused there.
      const about = await createTestWikiPage({ authorEmail: author.email, namespace: "commons", name: "ABOUT", variant: `e2e-${Date.now()}` });
      created.push(about.id);
      expect(await changeTestDocSetting({ actorEmail: author.email, docId: about.id, change: { deleted: true } })).toMatchObject({ ok: true });
      expect(await changeTestDocSetting({ actorEmail: author.email, docId: about.id, change: { deleted: false } })).toMatchObject({
        ok: false,
        code: "forbidden",
        message: expect.stringContaining("kept for editors"),
      });
      expect(await changeTestDocSetting({ actorEmail: ADMIN_EMAIL, docId: about.id, change: { deleted: false } })).toMatchObject({ ok: true });

      const mine = await createWikiPageAs({ actorEmail: author.email, page: { namespace: "person", name: "About", visibility: "PRIVATE" } });
      expect(mine).toMatchObject({ ok: true });
      if (mine.ok) created.push(mine.id);
    } finally {
      for (const id of created) await deleteTestDoc(id);
    }
  });
});

test.describe("wiki addresses (docs/WIKI.md \"URLs\", \"Requests and responses\")", () => {
  test("a reader gets the page at its address; uppercase, common, a spelling and sub-paths redirect permanently, a name's case and an old user slug temporarily, each keeping the query", async ({
    page,
    secondUser,
  }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const personal = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "SHARED", bodyText: "Personal page body." });
    const commons = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "SHARED" });
    const request = page.request;
    const segment = commons.path.slice("/wiki/commons/".length);
    try {
      const opened = await request.get(personal.path);
      expect(opened.status()).toBe(200);
      expect(await opened.text()).toContain("Personal page body.");

      expect(await answer(request, `/wiki/common/${segment}?a=1`)).toEqual([308, `${commons.path}?a=1`]);
      expect(await answer(request, `/wiki/COMMONS/${segment}?a=1`)).toEqual([308, `${commons.path}?a=1`]);
      expect(await answer(request, `/wiki/commons/${segment.replace(/_/g, "%20")}`)).toEqual([308, commons.path]);
      expect(await answer(request, `/wiki/commons/__${segment}_`)).toEqual([308, commons.path]);
      expect(await answer(request, `${commons.path}/EDIT?b=2`)).toEqual([308, `${commons.path}/edit?b=2`]);
      expect(await answer(request, `${commons.path}/Foo/Bar`)).toEqual([308, `${commons.path}/foo/bar`]);
      expect((await answer(request, `${commons.path}/foo/bar`))[0]).toBe(404);
      // A name in other capitals is the page's, for a reader: one hop, a 307 since it is reader-only.
      expect(await answer(request, `/wiki/COMMONS/${segment.toUpperCase()}?a=1`)).toEqual([307, `${commons.path}?a=1`]);
      expect(await answer(request, `/wiki/commons/${segment.toLowerCase()}/edit`)).toEqual([307, `${commons.path}/edit`]);

      const { oldSlug, newSlug } = await renameTestUserSlug(owner.email);
      const personalSegment = personal.path.slice(personal.path.lastIndexOf("/") + 1);
      expect(await answer(request, `/wiki/@${oldSlug}/${personalSegment}?x=1`)).toEqual([307, `/wiki/@${newSlug}/${personalSegment}?x=1`]);
      // Two redirects at once are one hop, a 307 since one of them is.
      expect(await answer(request, `/wiki/@${oldSlug.toUpperCase()}/${personalSegment}`)).toEqual([307, `/wiki/@${newSlug}/${personalSegment}`]);
      expect(await answer(request, `/wiki/@${oldSlug}`)).toEqual([307, `/wiki/@${newSlug}`]);
    } finally {
      await deleteTestDoc(personal.id);
      await deleteTestDoc(commons.id);
    }
  });

  test("a name with spaces, parentheses, non-ASCII and a bare % opens, with its tab title, through the address wikiPagePath writes", async ({ page }) => {
    const created = await createWikiPageAs({
      actorEmail: ADMIN_EMAIL,
      page: { namespace: "commons", name: `E2E 100% Straße (lab) ${Date.now()}`, visibility: "SHARED" },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    try {
      expect(created.path).toMatch(/^\/wiki\/commons\/E2E_100%25_Stra%C3%9Fe_\(lab\)_\d+$/);
      const response = await page.goto(created.path);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveTitle(/E2E 100% Straße \(lab\)/);
      await expect(page.locator("h1")).toContainText("E2E 100% Straße (lab)");
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(created.id);
    }
  });

  test("/doc/<slug> sends a reader of a wiki doc to its address with a 307 that keeps ?sel= and ?at=, by id, slug or an old slug, and its editor to the wiki editor", async ({
    page,
  }) => {
    const wiki = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "SHARED" });
    const old = `e2e-old-${Date.now()}`;
    try {
      await addTestDocSlugHistory(wiki.id, old);
      for (const handle of [wiki.slug, wiki.id, old]) {
        expect(await answer(page.request, `/doc/${handle}?sel=abc&at=1`)).toEqual([307, `${wiki.path}?sel=abc&at=1`]);
      }
      expect(await answer(page.request, `/doc/${wiki.id}/edit`)).toEqual([307, `${wiki.path}/edit`]);
    } finally {
      await deleteTestDoc(wiki.id);
    }
  });

  test("a signed-in reader who can't read a wiki doc gets a 404 at every /doc/ surface, side-by-side and the diff, and the link preview's null", async ({
    page,
    secondUser,
  }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    // PRIVATE is its byline's alone, so the suite's ADMIN can't read it.
    const wiki = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "PRIVATE" });
    const other = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Readable." });
    try {
      for (const path of [
        `/doc/${wiki.slug}`,
        `/doc/${wiki.id}/edit`,
        `/doc/${wiki.slug}/slug`,
        `/side-by-side/${wiki.id}/${other.id}`,
        `/diff/${wiki.id}/${other.id}`,
        `/api/diff/${wiki.id}/${other.id}`,
        wiki.path,
        `${wiki.path}/edit`,
      ]) {
        expect((await answer(page.request, path))[0], path).toBe(404);
      }
      expect(await forkDocAs({ actorEmail: ADMIN_EMAIL, parentId: wiki.id })).toMatchObject({ ok: false, code: "not_found" });
      // A missing page answers the same, with its status a real 404.
      expect((await answer(page.request, `/wiki/commons/E2E_no_such_page_${Date.now()}`))[0]).toBe(404);
    } finally {
      await deleteTestDoc(wiki.id);
      await deleteTestDoc(other.id);
    }
  });

  test("signed out, a missing page, a page that isn't public, a name in the wrong case and an empty or unknown namespace all send you to sign in, at the canonical spelling", async ({
    playwright,
    baseURL,
    secondUser,
  }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const wiki = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "SHARED" });
    const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    try {
      for (const path of [
        wiki.path,
        wiki.path.toLowerCase(),
        `/wiki/@${owner.slug}/E2E_no_such_page`,
        `${wiki.path}/edit`,
        `/wiki/@${owner.slug}`,
        `/wiki/@e2e-nobody-${Date.now()}`,
      ]) {
        expect(await answer(anonymous, path), path).toEqual([307, toSignIn]);
      }
      // The return path is the one wikiPagePath writes, not Next's re-encoded param.
      const amp = await createWikiPageAs({ actorEmail: owner.email, page: { namespace: "person", name: `E2E R&D ${Date.now()}`, visibility: "SHARED" } });
      if (!amp.ok) throw new Error(amp.message);
      try {
        const [, location] = await answer(anonymous, amp.path);
        expect(new URL(location!, baseURL).searchParams.get("callbackUrl")).toBe(amp.path);
        expect(amp.path).toContain("@");
        expect(amp.path).toContain("R&D");
      } finally {
        await deleteTestDoc(amp.id);
      }
      // A NUL in a /doc/ param is answered, never a 500.
      expect((await answer(anonymous, "/doc/a%00b"))[0]).toBe(307);
    } finally {
      await anonymous.dispose();
      await deleteTestDoc(wiki.id);
    }
  });

  test("a namespace with nothing the viewer may read answers as an unknown one, a deleted owner's included, and a deleted owner's old slug redirects only a reader", async ({
    page,
    playwright,
    baseURL,
    secondUser,
  }) => {
    const { user: live } = await secondUser({ role: "AUTHOR" });
    const { user: gone } = await secondUser({ role: "AUTHOR" });
    const { user: moved } = await secondUser({ role: "AUTHOR" });
    const { page: commenter } = await secondUser({ role: "COMMENTER" });
    const livePage = await createTestWikiPage({ authorEmail: live.email, namespace: "person", visibility: "PRIVATE" });
    const gonePage = await createTestWikiPage({ authorEmail: gone.email, namespace: "person", visibility: "PRIVATE" });
    const movedPage = await createTestWikiPage({ authorEmail: moved.email, namespace: "person", visibility: "SHARED" });
    const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    try {
      await softDeleteTestUser(gone.email, ADMIN_EMAIL);
      const lists = [`/wiki/@${live.slug}`, `/wiki/@${gone.slug}`, `/wiki/@e2e-nobody-${Date.now()}`];
      for (const path of lists) {
        expect((await answer(page.request, path))[0], path).toBe(404);
        expect(await answer(anonymous, path), path).toEqual([307, toSignIn]);
      }

      const { oldSlug, newSlug } = await renameTestUserSlug(moved.email);
      await softDeleteTestUser(moved.email, ADMIN_EMAIL);
      // A deleted person's pages stay where they were, for those who could read them.
      const now = movedPage.path.replace(`@${oldSlug}/`, `@${newSlug}/`);
      expect((await answer(page.request, now))[0]).toBe(200);
      expect(await answer(page.request, movedPage.path)).toEqual([307, now]);
      expect((await answer(commenter.request, movedPage.path))[0]).toBe(404);
      expect(await answer(anonymous, movedPage.path)).toEqual([307, toSignIn]);
    } finally {
      await anonymous.dispose();
      for (const doc of [livePage, gonePage, movedPage]) await deleteTestDoc(doc.id);
    }
  });

  test("a page's editor: Forbidden with a link to the page for a reader who can't edit it, the editor for one who can, its name the rename field", async ({
    page,
    secondUser,
  }) => {
    const { user: owner, page: ownerPage } = await secondUser({ role: "AUTHOR" });
    const { page: reader } = await secondUser({ role: "AUTHORIZED" });
    const wiki = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "SHARED" });
    try {
      await reader.goto(`${wiki.path}/edit`);
      await expect(reader.getByRole("heading", { name: "Forbidden" })).toBeVisible();
      await expect(reader.getByRole("link", { name: "Read it" })).toHaveAttribute("href", wiki.path);
      // The suite's ADMIN reads a SHARED page and, on a person's page, edits nothing.
      await page.goto(`${wiki.path}/edit`);
      await expect(page.getByRole("heading", { name: "Forbidden" })).toBeVisible();
      await ownerPage.goto(`${wiki.path}/edit`);
      await waitForDocCollabReady(ownerPage);
      await expect(ownerPage.getByRole("link", { name: "View and Annotate" })).toHaveAttribute("href", wiki.path);
      await expect(ownerPage.locator("[data-wiki-name]")).toHaveValue(wiki.wikiName);
      await expect(ownerPage.locator("[data-wiki-name-field] [contenteditable]")).toHaveCount(0);
    } finally {
      await deleteTestDoc(wiki.id);
    }
  });

  test("the wiki editor's Delete goes to /doc/<id>/edit, whose Undelete comes back at the address, or at the next variant when it was taken", async ({
    page,
  }) => {
    const wiki = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "person", visibility: "SHARED" });
    let squatter: TestWikiPage | null = null;
    const settings = page.locator("details").filter({ has: page.locator("summary", { hasText: "Settings" }) });
    try {
      await page.goto(`${wiki.path}/edit`);
      await waitForDocCollabReady(page);
      await settings.locator("summary").click();
      await settings.getByRole("button", { name: "Delete" }).click();
      await page.waitForURL(`**/doc/${wiki.id}/edit`);
      await settings.locator("summary").click();
      await expect(settings.getByRole("button", { name: "Undelete" })).toBeVisible();

      squatter = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "person", name: wiki.wikiName, visibility: "SHARED" });
      await settings.getByRole("button", { name: "Undelete" }).click();
      await page.waitForURL((url) => url.pathname === `${wiki.path}~2/edit`);
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(wiki.id);
      if (squatter) await deleteTestDoc(squatter.id);
    }
  });

  test("a namespace list's links go to its pages and Back, client-side, through Next's %40 params", async ({ page }) => {
    const first = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "person", visibility: "SHARED", bodyText: "First page." });
    const second = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "person", visibility: "SHARED", bodyText: "Second page." });
    const list = first.path.slice(0, first.path.lastIndexOf("/"));
    try {
      await page.goto(list);
      await page.getByRole("link", { name: first.wikiName, exact: true }).click();
      await page.waitForURL((url) => url.pathname === first.path);
      await expect(visibleText(page, "First page.")).toBeVisible();
      // Back only once the page's mount-time server actions have answered: one
      // still in flight is discarded by Next's router queue, and its answer
      // then empties the queue under the next navigation, so a server action
      // started during that navigation (the open-link store's second read,
      // under dev's StrictMode) lands on the list's state and undoes the click
      // (TODO.md, "A discarded server action can undo the next navigation").
      await Promise.race([page.waitForLoadState("networkidle"), page.waitForTimeout(3_000)]);
      await page.goBack();
      await page.waitForURL((url) => url.pathname === list);
      await page.getByRole("link", { name: second.wikiName, exact: true }).click();
      await page.waitForURL((url) => url.pathname === second.path);
      await expect(visibleText(page, "Second page.")).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(first.id);
      await deleteTestDoc(second.id);
    }
  });

  test("/annotations' link to a card on a wiki page goes to its address with the card's fragment", async ({ page }) => {
    const wiki = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "SHARED", bodyText: "A page with a note." });
    try {
      await createTestAnnotation({ docId: wiki.id, authorEmail: ADMIN_EMAIL, bodyText: "E2E note on a wiki page" });
      await page.goto(`/annotations?q=${encodeURIComponent("E2E note on a wiki page")}`);
      const link = page.getByRole("row").filter({ hasText: wiki.wikiName }).locator(`a[href^="${wiki.path}#"]`);
      await expect(link.first()).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(wiki.id);
    }
  });
});

test.describe("public pages (docs/WIKI.md \"Public pages\")", () => {
  test("each visibility as a reader with canViewDocs, a COMMENTER and someone signed out sees it", async ({
    playwright,
    baseURL,
    secondUser,
  }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const { page: reader } = await secondUser({ role: "AUTHORIZED" });
    const { page: commenter } = await secondUser({ role: "COMMENTER" });
    const ownerId = (await getUserIdByEmail(owner.email))!;
    const marked = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Words with an author, ", marks: [{ type: "authorHighlight", attrs: { authorId: ownerId } }] },
            { type: "entityChip", attrs: { kind: "mention", iid: "m1", data: { userId: ownerId } } },
            { type: "text", text: "." },
          ],
        },
      ],
    };
    const pages = {
      PRIVATE: await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "PRIVATE" }),
      SHARED: await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "SHARED" }),
      PUBLIC: await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "PUBLIC", body: marked }),
    };
    const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    // "doc" is the doc view, "public" the public render.
    const seen = async (request: APIRequestContext, path: string) => {
      const res = await request.get(path, { maxRedirects: 0 });
      if (res.status() !== 200) return res.status() === 307 && /^\/sign-in/.test(res.headers()["location"] ?? "") ? "sign-in" : res.status();
      return (await res.text()).includes("data-public-render") ? "public" : "doc";
    };
    try {
      expect(await seen(reader.request, pages.PRIVATE.path)).toBe(404);
      expect(await seen(commenter.request, pages.PRIVATE.path)).toBe(404);
      expect(await seen(anonymous, pages.PRIVATE.path)).toBe("sign-in");
      expect(await seen(reader.request, pages.SHARED.path)).toBe("doc");
      expect(await seen(commenter.request, pages.SHARED.path)).toBe(404);
      expect(await seen(anonymous, pages.SHARED.path)).toBe("sign-in");
      expect(await seen(reader.request, pages.PUBLIC.path)).toBe("doc");
      expect(await seen(commenter.request, pages.PUBLIC.path)).toBe("public");
      expect(await seen(anonymous, pages.PUBLIC.path)).toBe("public");

      // The public render's text, its author marks stripped, its mention a
      // labelled link, and its owner's namespace named.
      const html = await (await anonymous.get(pages.PUBLIC.path)).text();
      expect(html).toContain("Words with an author,");
      expect(html).not.toContain("data-author-id");
      expect(html).toContain(`href="/authors/${owner.slug}"`);
      expect(html).toContain(`href="/wiki/@${owner.slug}"`);
    } finally {
      await anonymous.dispose();
      for (const doc of Object.values(pages)) await deleteTestDoc(doc.id);
    }
  });

  test("PUBLIC widens who reads the text, not what hangs off it: a COMMENTER gets no collab token, no replay and no diff", async ({
    secondUser,
  }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const { page: commenter } = await secondUser({ role: "COMMENTER" });
    const wiki = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "PUBLIC" });
    try {
      expect((await commenter.request.post(`/api/doc/${wiki.id}/token`)).status()).toBe(403);
      expect((await commenter.request.get(`/api/doc/${wiki.id}/replay`)).status()).toBe(403);
      expect((await commenter.request.get(`/api/diff/${wiki.id}/${wiki.id}`)).status()).toBe(404);
    } finally {
      await deleteTestDoc(wiki.id);
    }
  });

  test("signed out, /wiki and a namespace list show only their PUBLIC pages", async ({ playwright, baseURL, secondUser }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const open = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "PUBLIC" });
    const shut = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "SHARED" });
    const mine = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "PUBLIC" });
    const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    try {
      const front = await anonymous.get("/wiki");
      expect(front.status()).toBe(200);
      const html = await front.text();
      expect(html).toContain(open.wikiName);
      expect(html).not.toContain(shut.wikiName);
      const list = await anonymous.get(`/wiki/@${owner.slug}`);
      expect(list.status()).toBe(200);
      expect(await list.text()).toContain(mine.wikiName);
    } finally {
      await anonymous.dispose();
      for (const doc of [open, shut, mine]) await deleteTestDoc(doc.id);
    }
  });

  test("/doc/<slug> sends someone signed out, or a COMMENTER, to a PUBLIC page by its id, slug or an old slug, and nothing else", async ({
    playwright,
    baseURL,
    secondUser,
  }) => {
    const { page: commenter } = await secondUser({ role: "COMMENTER" });
    const open = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "PUBLIC" });
    const shut = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "SHARED" });
    const old = `e2e-old-${Date.now()}`;
    const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    try {
      await addTestDocSlugHistory(open.id, old);
      for (const handle of [open.id, open.slug, old]) {
        expect(await answer(anonymous, `/doc/${handle}?sel=x`), handle).toEqual([307, `${open.path}?sel=x`]);
        expect(await answer(commenter.request, `/doc/${handle}`), handle).toEqual([307, open.path]);
      }
      // A page that isn't public, and a missing doc, look alike signed out.
      expect(await answer(anonymous, `/doc/${shut.slug}`)).toEqual([307, toSignIn]);
      expect(await answer(anonymous, `/doc/e2e-no-such-doc-${Date.now()}`)).toEqual([307, toSignIn]);
      expect((await answer(commenter.request, `/doc/${shut.slug}`))[0]).toBe(404);
    } finally {
      await anonymous.dispose();
      await deleteTestDoc(open.id);
      await deleteTestDoc(shut.id);
    }
  });
});

test.describe("creating a page (docs/WIKI.md \"Creating a page\")", () => {
  test("/wiki/new makes a page in your namespace, its title its name, and opens its editor", async ({ page }) => {
    const name = `E2E Created (page) ${Date.now()}`;
    let id: string | null = null;
    try {
      await page.goto("/wiki/new");
      await page.getByLabel("Name").fill(`  ${name}  `);
      await expect(page.locator("[data-wiki-new-address]")).toHaveText(new RegExp(`^/wiki/@e2e-admin/E2E_Created_\\(page\\)_\\d+$`));
      await expect(page.getByLabel("Who can read it")).toHaveValue("PRIVATE");
      await page.getByRole("button", { name: "Create page" }).click();
      await page.waitForURL((url) => url.pathname.startsWith("/wiki/@e2e-admin/E2E_Created_(page)_") && url.pathname.endsWith("/edit"));
      await waitForDocCollabReady(page);
      id = await findTestWikiPageId(ADMIN_EMAIL, name);
      expect(id).not.toBeNull();
      expect(await getTestWikiFacts(id!)).toMatchObject({ title: name, wikiName: name, visibility: "PRIVATE" });
    } finally {
      await page.goto("about:blank").catch(() => {});
      if (id) await deleteTestDoc(id);
    }
  });

  test("a name the rules refuse is refused as it is typed, and by the server whatever a form sends", async ({ page }) => {
    await page.goto("/wiki/new");
    for (const bad of ["a/b", "x?y", "[x]", "Smile :)", "x~y"]) {
      await page.getByLabel("Name").fill(bad);
      await expect(page.getByText(checkWikiNameMessage(bad))).toBeVisible();
      await expect(page.getByRole("button", { name: "Create page" })).toBeDisabled();
      expect(
        await createWikiPageAs({ actorEmail: ADMIN_EMAIL, page: { namespace: "commons", name: bad, visibility: "SHARED" } }),
      ).toMatchObject({ ok: false, code: "invalid" });
    }
  });

  test("a typed address that is taken, by its key, is refused, with a link to the page there", async ({ page }) => {
    const there = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "SHARED" });
    try {
      await page.goto(`/wiki/new?where=commons&name=${encodeURIComponent(there.wikiName.toLowerCase())}`);
      await page.getByRole("button", { name: "Create page" }).click();
      await expect(page.getByText("That address is taken.")).toBeVisible();
      await expect(page.getByRole("link", { name: "The page there" })).toHaveAttribute("href", there.path.toLowerCase());
      // ΐ and its capital are one key.
      const greek = `E2E ΐ ${Date.now()}`;
      const first = await createWikiPageAs({ actorEmail: ADMIN_EMAIL, page: { namespace: "commons", name: greek, visibility: "SHARED" } });
      try {
        expect(first.ok).toBe(true);
        expect(
          await createWikiPageAs({ actorEmail: ADMIN_EMAIL, page: { namespace: "commons", name: greek.replace("ΐ", "Ϊ́"), visibility: "SHARED" } }),
        ).toMatchObject({ ok: false, code: "conflict" });
      } finally {
        if (first.ok) await deleteTestDoc(first.id);
      }
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(there.id);
    }
  });

  test("a nameless account may not create in its own namespace, since its slug is its email's, and may in the commons as an EDITOR", async ({
    secondUser,
  }) => {
    const { user: nameless, page } = await secondUser({ role: "EDITOR", nameless: true });
    const name = `E2E nameless ${Date.now()}`;
    let id: string | null = null;
    try {
      await page.goto("/wiki/new");
      await expect(page.getByText("Your url is made from your email address")).toBeVisible();
      await expect(page.getByRole("radio", { name: /Your pages/ })).toBeDisabled();
      await expect(page.getByRole("radio", { name: "The commons" })).toBeChecked();
      await page.getByLabel("Name").fill(name);
      await page.getByRole("button", { name: "Create page" }).click();
      await page.waitForURL((url) => url.pathname === `/wiki/commons/${name.replace(/ /g, "_")}/edit`);
      id = await findTestWikiPageId(null, name);
      expect(id).not.toBeNull();
      // And refused by createWikiPage itself, whatever a form sends.
      expect(
        await createWikiPageAs({ actorEmail: nameless.email, page: { namespace: "person", name: `${name} x`, visibility: "PRIVATE" } }),
      ).toMatchObject({ ok: false, code: "forbidden", message: expect.stringContaining("made from your email") });
    } finally {
      await page.goto("about:blank").catch(() => {});
      if (id) await deleteTestDoc(id);
    }
  });

  test("a missing page is a 404 that offers to create it to its namespace's owner, and in the commons to an EDITOR, and to nobody else", async ({
    page,
    secondUser,
  }) => {
    const { page: author } = await secondUser({ role: "AUTHOR" });
    const { page: editor } = await secondUser({ role: "EDITOR" });
    const missing = `E2E missing (x) ${Date.now()}`;
    const segment = missing.replace(/ /g, "_");
    const mine = `/wiki/@e2e-admin/${segment}`;
    const commons = `/wiki/commons/${segment}~v`;
    const offerTo = (where: string, variant?: string) =>
      `/wiki/new?${new URLSearchParams({ where, name: missing, ...(variant ? { variant } : {}) })}`;

    const offered = async (viewer: typeof page, path: string) => {
      const response = await viewer.goto(path);
      expect(response?.status(), path).toBe(404);
      const offer = viewer.getByRole("link", { name: "Create this page" });
      return (await offer.count()) > 0 ? await offer.getAttribute("href") : null;
    };
    expect(await offered(page, mine)).toBe(offerTo("person"));
    expect(await offered(page, commons)).toBe(offerTo("commons", "v"));
    expect(await offered(author, mine)).toBeNull();
    expect(await offered(author, commons)).toBeNull();
    expect(await offered(editor, commons)).toBe(offerTo("commons", "v"));
  });
});

test.describe("telling a wiki page from a doc (docs/WIKI.md \"Telling a wiki page from a doc\")", () => {
  test("a wiki page's doc view carries its address and who can read it above its name, and a doc has none", async ({ page }) => {
    const shared = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "person", visibility: "SHARED" });
    const open = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "PUBLIC" });
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED" });
    const line = page.locator("[data-wiki-address]");
    try {
      await page.goto(shared.path);
      await expect(line.getByRole("link", { name: "Wiki", exact: true })).toHaveAttribute("href", "/wiki");
      await expect(line.getByRole("link", { name: "@e2e-admin" })).toHaveAttribute("href", "/wiki/@e2e-admin");
      await expect(line).toContainText(shared.wikiName);
      await expect(line).toContainText("SHARED");
      await expect(line).not.toContainText("PUBLIC");
      // The name is the title, and the title's link goes to the wiki editor.
      await expect(page.locator("h1").getByRole("link")).toHaveText(shared.wikiName);
      await expect(page.locator("h1").getByRole("link")).toHaveAttribute("href", `${shared.path}/edit`);

      await page.goto(open.path);
      await expect(line.getByRole("link", { name: "commons" })).toHaveAttribute("href", "/wiki/commons");
      await expect(line).toContainText("PUBLIC: anyone can read this, signed out");

      await page.goto(`/doc/${doc.id}`);
      await expect(page.locator("h1")).toContainText(doc.title);
      await expect(line).toHaveCount(0);
    } finally {
      await page.goto("about:blank").catch(() => {});
      for (const d of [shared, open, doc]) await deleteTestDoc(d.id);
    }
  });

  test("a PUBLIC page's editor says so above its name, and follows a change made in Settings", async ({ page }) => {
    const wiki = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "person", visibility: "SHARED" });
    const notice = page.getByText("This page is PUBLIC: anyone can read it, signed out");
    const line = page.locator("[data-wiki-address]");
    try {
      await page.goto(`${wiki.path}/edit`);
      await waitForDocCollabReady(page);
      await expect(line).toContainText("SHARED");
      await expect(notice).toHaveCount(0);

      await page.getByText("Settings", { exact: true }).click();
      await page.getByLabel("Visibility").selectOption("PUBLIC");
      await expect(notice).toBeVisible();
      await expect(line).toContainText("PUBLIC: anyone can read this, signed out");
      expect((await getTestWikiFacts(wiki.id)).visibility).toBe("PUBLIC");

      await page.getByLabel("Visibility").selectOption("SHARED");
      await expect(notice).toHaveCount(0);
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(wiki.id);
    }
  });
});

test.describe("listing wiki pages (docs/WIKI.md \"Listing wiki pages\", \"Labels\")", () => {
  test("/docs lists no wiki page, the wiki table does, and search gives them a section of their own", async ({ page }) => {
    const word = `e2ewikiword${Date.now()}`;
    const wiki = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "SHARED", bodyText: `A page about ${word}.` });
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: `A doc about ${word}.` });
    try {
      await page.goto(`/docs?q=${encodeURIComponent(wiki.wikiName)}`);
      await expect(page.getByRole("row").filter({ hasText: wiki.wikiName })).toHaveCount(0);
      const row = await wikiTableRow(page, wiki);
      await expect(row.getByRole("link", { name: wiki.wikiName })).toHaveAttribute("href", wiki.path);

      await expect.poll(async () => {
        await page.goto(`/search?q=${word}`);
        return page.locator(`a[href="${wiki.path}"]`).count();
      }).toBeGreaterThan(0);
      await expect(page.getByRole("heading", { name: /Wiki pages/ })).toBeVisible();
      await expect(page.locator(`a[href="/doc/${doc.slug}"]`).first()).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(wiki.id);
      await deleteTestDoc(doc.id);
    }
  });

  test("the [[ menu's option shows a page's label, and what it inserts is the name linking to /doc/<slug>", async ({ page }) => {
    const wiki = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "SHARED", variant: "e2e" });
    const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Linking from here." });
    try {
      await page.goto(`/doc/${doc.id}/edit`);
      await waitForDocCollabReady(page);
      const body = page.locator(".ProseMirror").last();
      await body.click();
      await page.keyboard.press("End");
      await page.keyboard.type(` [[${wiki.wikiName}`);
      const option = page.getByRole("option").filter({ hasText: `commons/${wiki.wikiName}~e2e` });
      await expect(option).toBeVisible();
      await option.click();
      await expect(body.locator(`a[href="/doc/${wiki.slug}"]`)).toHaveText(wiki.wikiName);
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(wiki.id);
      await deleteTestDoc(doc.id);
    }
  });
});

/** A page's path at another name in its own namespace. */
function pathAt(wiki: { path: string }, name: string, variant = ""): string {
  const base = wiki.path.slice(0, wiki.path.lastIndexOf("/") + 1);
  return `${base}${wikiNameSegment(name)}${variant ? `~${variant}` : ""}`;
}

test.describe("renaming (docs/WIKI.md \"Renaming\")", () => {
  test("a rename reserves the address it leaves: every claim refuses it, a restore passes over it, and a reader is sent on, a 307 keeping the sub-path and query", async ({
    page,
    playwright,
    baseURL,
    secondUser,
  }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const wiki = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "SHARED" });
    const renamed = `${wiki.wikiName} renamedword`;
    const created: string[] = [];
    try {
      expect(await renameWikiPageAs({ actorEmail: owner.email, docId: wiki.id, change: { name: renamed } })).toEqual({
        ok: true,
        path: pathAt(wiki, renamed),
        renamedFrom: wiki.path,
      });
      expect(await getTestWikiFacts(wiki.id, "renamedword")).toMatchObject({ wikiName: renamed, title: renamed, searchMatches: true });
      expect(await getTestWikiAddressHistory(wiki.id)).toMatchObject([
        { ownerEmail: owner.email, name: wiki.wikiName, variant: "", reserved: true, movedByEmail: owner.email },
      ]);

      // Creating at it, in any capitals, is refused, naming the address.
      const taken = await createWikiPageAs({
        actorEmail: owner.email,
        page: { namespace: "person", name: wiki.wikiName.toUpperCase(), visibility: "SHARED" },
      });
      expect(taken).toMatchObject({ ok: false, code: "conflict" });

      // A deleted page restored to an address a reserved row holds comes back at the next free variant.
      const other = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "SHARED" });
      created.push(other.id);
      expect(await changeTestDocSetting({ actorEmail: owner.email, docId: other.id, change: { deleted: true } })).toMatchObject({ ok: true });
      expect(await renameWikiPageAs({ actorEmail: owner.email, docId: wiki.id, change: { name: other.wikiName } })).toMatchObject({ ok: true });
      expect(await changeTestDocSetting({ actorEmail: owner.email, docId: other.id, change: { deleted: false } })).toMatchObject({
        ok: true,
        wikiPath: `${other.path}~2`,
      });

      // A reader at the old address is sent on, keeping the sub-path and the query; the first rename's
      // address still holds, and now sends them to the page's current name.
      const now = pathAt(wiki, other.wikiName);
      expect(await answer(page.request, `${wiki.path}?a=1`)).toEqual([307, `${now}?a=1`]);
      expect(await answer(page.request, `${pathAt(wiki, renamed)}/edit`)).toEqual([307, `${now}/edit`]);
      expect(await answer(page.request, wiki.path.toUpperCase().replace("/WIKI/", "/wiki/").replace(/^\/wiki\/@[^/]+/, (m) => m.toLowerCase()))).toEqual([
        307,
        now,
      ]);
      // Signed out, a page that isn't public: the old address is the sign-in redirect, as a missing page is.
      const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
      try {
        expect(await answer(anonymous, wiki.path)).toEqual([307, toSignIn]);
      } finally {
        await anonymous.dispose();
      }
    } finally {
      await deleteTestDoc(wiki.id);
      for (const id of created) await deleteTestDoc(id);
    }
  });

  test("renaming back takes the page's own rows, a change of case alone keeps none, and Revert keeps none inside the hour", async ({ secondUser }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const wiki = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "SHARED" });
    const as = (change: Parameters<typeof renameWikiPageAs>[0]["change"]) => renameWikiPageAs({ actorEmail: owner.email, docId: wiki.id, change });
    const names = async () => (await getTestWikiAddressHistory(wiki.id)).map((row) => `${row.name}${row.variant ? `~${row.variant}` : ""}`);
    const b = `${wiki.wikiName} B`;
    const c = `${wiki.wikiName} C`;
    try {
      expect(await as({ name: b })).toMatchObject({ ok: true });
      expect(await names()).toEqual([wiki.wikiName]);
      // Back to where it was: its own row there goes, and the one it leaves is kept.
      expect(await as({ name: wiki.wikiName })).toMatchObject({ ok: true, path: wiki.path });
      expect(await names()).toEqual([b]);
      // Case alone: no row, and nothing refused.
      expect(await as({ name: wiki.wikiName.toUpperCase() })).toMatchObject({ ok: true });
      expect(await names()).toEqual([b]);
      expect(await getTestWikiFacts(wiki.id)).toMatchObject({ wikiName: wiki.wikiName.toUpperCase() });
      // A variant is a rename too.
      expect(await as({ name: wiki.wikiName, variant: "v" })).toMatchObject({ ok: true, path: pathAt(wiki, wiki.wikiName, "v") });
      expect(await names()).toEqual([wiki.wikiName.toUpperCase(), b]);

      // Revert inside the hour: back to the newest reserved row, keeping none for where it was.
      expect(await as({ revert: true })).toMatchObject({ ok: true, path: pathAt(wiki, wiki.wikiName.toUpperCase()) });
      expect(await names()).toEqual([b]);
      // An hour on, Revert keeps a row for the address it leaves.
      expect(await as({ name: c })).toMatchObject({ ok: true });
      await ageTestWikiAddressHistory(wiki.id, 2 * 60 * 60 * 1000);
      expect(await as({ revert: true })).toMatchObject({ ok: true });
      expect(await names()).toEqual([c, b]);
      // Nothing left to go back to once the rows are gone.
      for (const row of await getTestWikiAddressHistory(wiki.id)) expect(await as({ deleteRow: row.id })).toEqual({ ok: true });
      expect(await as({ revert: true })).toMatchObject({ ok: false, code: "invalid" });
    } finally {
      await deleteTestDoc(wiki.id);
    }
  });

  test("who may rename: a person's page's byline, a commons page's byline plus ADMIN and EDITOR, a held name an editor alone; an unreadable page is not_found", async ({
    secondUser,
  }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const { user: coauthor } = await secondUser({ role: "AUTHOR" });
    const { user: editor } = await secondUser({ role: "EDITOR" });
    const personal = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "SHARED" });
    const hidden = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "PRIVATE" });
    const commons = await createTestWikiPage({ authorEmail: owner.email, namespace: "commons", visibility: "SHARED" });
    const rename = (actorEmail: string, docId: string, name: string, variant?: string) =>
      renameWikiPageAs({ actorEmail, docId, change: { name, variant } });
    try {
      // A person's page: no bypass for an ADMIN or EDITOR, who can read it; a co-author may.
      expect(await rename(ADMIN_EMAIL, personal.id, `${personal.wikiName} x`)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await rename(editor.email, personal.id, `${personal.wikiName} x`)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await rename(ADMIN_EMAIL, hidden.id, `${hidden.wikiName} x`)).toMatchObject({ ok: false, code: "not_found" });
      await addTestDocAuthor(personal.id, coauthor.email);
      expect(await rename(coauthor.email, personal.id, `${personal.wikiName} x`)).toMatchObject({ ok: true });

      // A commons page: its byline, and an EDITOR off it.
      expect(await rename(editor.email, commons.id, `${commons.wikiName} x`)).toMatchObject({ ok: true });
      // The held names are an ADMIN's or EDITOR's to give, in any capitals and with any variant.
      for (const [name, variant] of [["ABOUT", `e2e-${Date.now()}`], ["Front Page", "x"]]) {
        expect(await rename(owner.email, commons.id, name, variant)).toMatchObject({ ok: false, code: "forbidden", message: expect.stringContaining("kept for editors") });
      }
      expect(await rename(editor.email, commons.id, "About", `e2e-${Date.now()}`)).toMatchObject({ ok: true });
      // A deleted page is renamed after it is restored.
      expect(await changeTestDocSetting({ actorEmail: owner.email, docId: hidden.id, change: { deleted: true } })).toMatchObject({ ok: true });
      expect(await rename(owner.email, hidden.id, `${hidden.wikiName} x`)).toMatchObject({ ok: false, code: "invalid" });
      // A doc that isn't a wiki page has a title, not a name.
      const doc = await createTestDoc({ authorEmail: owner.email, visibility: "SHARED" });
      try {
        expect(await rename(owner.email, doc.id, "Anything")).toMatchObject({ ok: false, code: "invalid" });
      } finally {
        await deleteTestDoc(doc.id);
      }
    } finally {
      for (const id of [personal.id, hidden.id, commons.id]) await deleteTestDoc(id);
    }
  });

  test("two renames of one page queue on its row, each recording the address the other left, and neither ends as a deadlock", async ({ secondUser }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const wiki = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "SHARED" });
    try {
      const [first, second] = await Promise.all(
        ["Alpha", "Omega"].map((suffix) => renameWikiPageAs({ actorEmail: owner.email, docId: wiki.id, change: { name: `${wiki.wikiName} ${suffix}` } })),
      );
      expect(first).toMatchObject({ ok: true });
      expect(second).toMatchObject({ ok: true });
      const facts = await getTestWikiFacts(wiki.id);
      const left = (await getTestWikiAddressHistory(wiki.id)).map((row) => row.name).sort();
      // The page ends at one of the two names, and its history holds the original and the other.
      const other = facts.wikiName === `${wiki.wikiName} Alpha` ? `${wiki.wikiName} Omega` : `${wiki.wikiName} Alpha`;
      expect(left).toEqual([wiki.wikiName, other].sort());
    } finally {
      await deleteTestDoc(wiki.id);
    }
  });

  test("a deleted row ends its redirect and frees its address", async ({ page, secondUser }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const wiki = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "SHARED" });
    const created: string[] = [];
    try {
      expect(await renameWikiPageAs({ actorEmail: owner.email, docId: wiki.id, change: { name: `${wiki.wikiName} moved` } })).toMatchObject({ ok: true });
      expect((await answer(page.request, wiki.path))[0]).toBe(307);
      const [row] = await getTestWikiAddressHistory(wiki.id);
      // Only its editors may delete it.
      expect(await renameWikiPageAs({ actorEmail: ADMIN_EMAIL, docId: wiki.id, change: { deleteRow: row.id } })).toMatchObject({ ok: false, code: "forbidden" });
      expect(await renameWikiPageAs({ actorEmail: owner.email, docId: wiki.id, change: { deleteRow: row.id } })).toEqual({ ok: true });
      expect((await answer(page.request, wiki.path))[0]).toBe(404);
      const again = await createWikiPageAs({ actorEmail: owner.email, page: { namespace: "person", name: wiki.wikiName, visibility: "SHARED" } });
      expect(again).toMatchObject({ ok: true });
      if (again.ok) created.push(again.id);
    } finally {
      await deleteTestDoc(wiki.id);
      for (const id of created) await deleteTestDoc(id);
    }
  });

  test("the editor's name field renames and goes on to the new address; /doc/<slug>/slug lists the history, renames with a variant, reverts and deletes", async ({
    page,
  }) => {
    const wiki = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "SHARED" });
    const renamed = `${wiki.wikiName} (renamed)`;
    try {
      await page.goto(`${wiki.path}/edit`);
      await waitForDocCollabReady(page);
      const field = page.locator("[data-wiki-name]");
      await field.fill(`${renamed} [`);
      await expect(page.locator("[data-wiki-name-field]").getByText(checkWikiNameMessage(`${renamed} [`))).toBeVisible();
      await expect(page.getByRole("button", { name: "Rename", exact: true })).toBeDisabled();
      await field.fill(renamed);
      await page.getByRole("button", { name: "Rename", exact: true }).click();
      await page.waitForURL((url) => url.pathname === `${pathAt(wiki, renamed)}/edit`);
      await expect(page.locator("[data-wiki-name]")).toHaveValue(renamed);
      await expect(page).toHaveTitle(new RegExp(renamed.replace(/[()]/g, "\\$&")));

      await page.goto(`/doc/${wiki.slug}/slug`);
      const manager = page.locator("[data-wiki-address-manager]");
      await expect(manager.getByRole("link", { name: pathAt(wiki, renamed) })).toBeVisible();
      await expect(manager.locator(`[data-wiki-address-row="${wiki.path}"]`)).toContainText("Yes");
      await manager.getByRole("button", { name: "Rename…" }).click();
      await manager.getByLabel("Variant").fill("e2e-v");
      await manager.getByRole("button", { name: "Rename", exact: true }).click();
      await expect(manager.getByRole("link", { name: pathAt(wiki, renamed, "e2e-v") })).toBeVisible();
      await expect(manager.locator("[data-wiki-address-row]")).toHaveCount(2);

      // Revert inside the hour goes back and keeps nothing for the variant.
      await manager.getByRole("button", { name: "Revert" }).click();
      await expect(manager.getByRole("link", { name: pathAt(wiki, renamed) })).toBeVisible();
      await expect(manager.locator("[data-wiki-address-row]")).toHaveCount(1);
      await manager.getByRole("button", { name: "Delete" }).click();
      await manager.getByRole("button", { name: "Yes" }).click();
      await expect(manager.getByText("No past addresses.")).toBeVisible();
      expect(await getTestWikiAddressHistory(wiki.id)).toEqual([]);
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(wiki.id);
    }
  });
});

test.describe("deleting a page (docs/WIKI.md \"Deleting a page\")", () => {
  test("a delete takes the page's past addresses with it, and a restore doesn't bring them back", async ({ page, secondUser }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const wiki = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "SHARED" });
    try {
      expect(await renameWikiPageAs({ actorEmail: owner.email, docId: wiki.id, change: { name: `${wiki.wikiName} 2` } })).toMatchObject({ ok: true });
      expect(await changeTestDocSetting({ actorEmail: owner.email, docId: wiki.id, change: { deleted: true } })).toEqual({
        ok: true,
        wikiPath: null,
        renamedFrom: null,
        removedAddresses: [wiki.path],
      });
      expect(await getTestWikiAddressHistory(wiki.id)).toEqual([]);
      expect((await answer(page.request, wiki.path))[0]).toBe(404);
      expect(await changeTestDocSetting({ actorEmail: owner.email, docId: wiki.id, change: { deleted: false } })).toMatchObject({ ok: true });
      expect(await getTestWikiAddressHistory(wiki.id)).toEqual([]);
    } finally {
      await deleteTestDoc(wiki.id);
    }
  });

  test("the editor's Delete and the wiki table's row and bulk Delete list the past addresses first, and a page with none deletes at once", async ({
    page,
  }) => {
    const moved = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "SHARED" });
    const plain = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "SHARED" });
    const renamed = `${moved.wikiName} now`;
    const settings = page.locator("details").filter({ has: page.locator("summary", { hasText: "Settings" }) });
    const reset = async () => {
      await changeTestDocSetting({ actorEmail: ADMIN_EMAIL, docId: moved.id, change: { deleted: false } });
      await renameWikiPageAs({ actorEmail: ADMIN_EMAIL, docId: moved.id, change: { name: moved.wikiName } });
      await renameWikiPageAs({ actorEmail: ADMIN_EMAIL, docId: moved.id, change: { name: renamed } });
    };
    try {
      expect(await renameWikiPageAs({ actorEmail: ADMIN_EMAIL, docId: moved.id, change: { name: renamed } })).toMatchObject({ ok: true });

      // The editor: asks, lists, and Cancel deletes nothing.
      await page.goto(`${pathAt(moved, renamed)}/edit`);
      await waitForDocCollabReady(page);
      await settings.locator("summary").click();
      await settings.getByRole("button", { name: "Delete" }).click();
      const confirm = settings.locator("[data-delete-addresses-confirm]");
      await expect(confirm).toContainText(moved.path);
      await confirm.getByRole("button", { name: "Cancel" }).click();
      expect(await getTestWikiFacts(moved.id)).toMatchObject({ deleted: false });
      await settings.getByRole("button", { name: "Delete" }).click();
      await confirm.getByRole("button", { name: "Delete" }).click();
      await page.waitForURL(`**/doc/${moved.id}/edit`);
      expect(await getTestWikiFacts(moved.id)).toMatchObject({ deleted: true });
      expect(await getTestWikiAddressHistory(moved.id)).toEqual([]);

      // The wiki table's row Delete asks for the page with history, and not for one without.
      await reset();
      const row = await wikiTableRow(page, { wikiName: renamed });
      await row.getByRole("button", { name: /Delete/ }).click();
      const tableConfirm = page.locator("[data-delete-addresses-confirm]");
      await expect(tableConfirm).toContainText(moved.path);
      await tableConfirm.getByRole("button", { name: "Delete" }).click();
      await expect.poll(async () => (await getTestWikiFacts(moved.id)).deleted).toBe(true);
      const plainRow = await wikiTableRow(page, plain);
      await plainRow.getByRole("button", { name: /Delete/ }).click();
      await expect.poll(async () => (await getTestWikiFacts(plain.id)).deleted).toBe(true);
      await expect(page.locator("[data-delete-addresses-confirm]")).toHaveCount(0);
      await changeTestDocSetting({ actorEmail: ADMIN_EMAIL, docId: plain.id, change: { deleted: false } });

      // The bulk Delete lists the selected pages that have history before any is deleted.
      await reset();
      await page.goto(`/wiki/special/pages?q=${encodeURIComponent(moved.wikiName)}`);
      await page.getByRole("checkbox", { name: "Select all rows" }).check();
      await page.getByRole("button", { name: "Delete selected pages" }).click();
      const bulkConfirm = page.locator("[data-bulk-confirm]");
      await expect(bulkConfirm).toContainText(moved.path);
      expect(await getTestWikiFacts(moved.id)).toMatchObject({ deleted: false });
      await bulkConfirm.getByRole("button", { name: "Delete selected pages" }).click();
      await expect.poll(async () => (await getTestWikiFacts(moved.id)).deleted).toBe(true);
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(moved.id);
      await deleteTestDoc(plain.id);
    }
  });
});

test.describe("MCP and a page's address (docs/WIKI.md \"URLs\")", () => {
  test("read and tag take a page's address, in other capitals too, and an unreadable page is not_found as a missing one is", async ({
    request,
    secondUser,
  }) => {
    const agent = await createAgent(request, { scopes: ["READ", "WRITE"], person: true });
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const wiki = await createTestWikiPage({ authorEmail: ADMIN_EMAIL, namespace: "commons", visibility: "SHARED", bodyText: "Read through MCP." });
    const hidden = await createTestWikiPage({ authorEmail: owner.email, namespace: "person", visibility: "PRIVATE" });
    try {
      const read = await agent.call("read", { url: wiki.path });
      expect(read.isError).toBeFalsy();
      expect(JSON.stringify(read.result)).toContain("Read through MCP.");
      const folded = await agent.call("read", { url: wiki.path.toLowerCase() });
      expect(folded.isError).toBeFalsy();
      // An old address reaches the page, as a slug in a doc's history does.
      expect(await renameWikiPageAs({ actorEmail: ADMIN_EMAIL, docId: wiki.id, change: { name: `${wiki.wikiName} renamed` } })).toMatchObject({ ok: true });
      const moved = await agent.call("read", { url: wiki.path });
      expect(moved.isError).toBeFalsy();
      expect(JSON.stringify(moved.result)).toContain("Read through MCP.");
      for (const url of [hidden.path, "/wiki/commons/E2E_no_such_page"]) {
        const refused = await agent.call("read", { url });
        expect(refused.isError, url).toBe(true);
        expect(refused.error, url).toMatchObject({ code: "not_found" });
      }
    } finally {
      await deleteTestDoc(wiki.id);
      await deleteTestDoc(hidden.id);
      await agent.dispose();
    }
  });
});
