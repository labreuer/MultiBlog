// Wiki pages (docs/WIKI.md) — docs with a name and an address under /wiki.
// Each section pins rules the plan states, in the order the build lands
// them. Until pages can be created in the app, a page is a test doc given an
// address by writing its columns (createTestWikiPage), as the claims will.
import { test, expect, waitForDocCollabReady } from "./fixtures";
import {
  ADMIN_EMAIL,
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
  getTestForkFacts,
  getTestWikiFacts,
  writeTestFileVisibility,
  writeTestWikiColumns,
} from "./db";
import { checkWikiName } from "@/lib/wiki-name";

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
  test("an EDITOR can't edit a person's SHARED page, or see an Edit link for it on /docs, and can a commons page", async ({
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
        await editor.goto(`/docs?q=${encodeURIComponent(doc.title)}`);
        const row = editor.getByRole("row").filter({ hasText: doc.title });
        await expect(row).toHaveCount(1);
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
