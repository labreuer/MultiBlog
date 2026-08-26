import { test, expect, freshGoto, gotoOk } from "./fixtures";
import {
  ADMIN_EMAIL,
  createTestKeyword,
  deleteTestKeyword,
  getKeywordAnchorPartColumns,
  getKeywordFacts,
  tagWithTestKeyword,
  uniqueTitle,
  type TestKeyword,
} from "./db";

// PLAN.md §20d's tie-off — the PR 1 feature end to end: tag → chip → browse →
// untag, `/keywords` sorting through the `keyword_metrics` view, and the part
// columns staying unwritten.
//
// A note on what is *not* here. There is no spec driving the tagger on a PDF:
// /pdf/[slug] is a full-height `ssr: false` island and its chips are the
// Metadata tab of the viewer's side panel — the same component the doc and
// post specs already exercise, two containers further in.
// And there is no part-tagging spec, because there is no part-tagging — that
// is the tie-off, asserted directly against the columns at the end rather than
// through a UI that deliberately can't reach them.
//
// The doc editor's Settings panel *is* covered, at the end, and for a reason
// the reading view doesn't need: its chips are client state fetched when the
// panel opens, so the `revalidatePath` every other surface leans on cannot
// reach them. `onChange` is the only thing that brings them back, and it has
// no server-side fallback to be wrong about.

/**
 * The tagger panel's disclosure, wherever the strip is rendered.
 *
 * By its aria-label rather than its "+ keyword" text: a <summary> is the one
 * element whose implicit role differs across engines, and the label is what
 * KeywordTagger sets deliberately for exactly this reason.
 */
function tagger(page: import("@playwright/test").Page) {
  return page.getByLabel("Add or remove keywords");
}

/**
 * The doc editor's Settings panel, by the attribute rather than by its
 * summary's text.
 *
 * `data-doc-settings` is already load-bearing (EditorChrome.module.css keys the
 * editor's height floor off it, see DocSettingsPanel), so it is the one handle
 * here that cannot be renamed without something else breaking loudly first.
 */
function settingsPanel(page: import("@playwright/test").Page) {
  return page.locator("details[data-doc-settings]");
}

/**
 * The Settings panel's Keywords fieldset, and within it the one line that says
 * the chips haven't been fetched yet.
 *
 * Scoped this tightly on purpose: a bare `getByText("Loading…")` matches two
 * different things here. The field shows one while its own state is null, and
 * KeywordTagger shows one *inside its popover* while its state is — and a
 * closed <details> still has its content in the DOM, so the tagger's line is
 * there from the moment the field finishes loading. `> p` is the field's own,
 * since once loaded its only direct child is the strip.
 */
function keywordField(page: import("@playwright/test").Page) {
  return settingsPanel(page)
    .locator("fieldset")
    .filter({ has: page.locator("legend", { hasText: "Keywords" }) });
}

test.describe("keywords", () => {
  let keyword: TestKeyword;

  test.beforeEach(async () => {
    keyword = await createTestKeyword({ creatorEmail: ADMIN_EMAIL, name: uniqueTitle("keyword") });
  });

  test.afterEach(async () => {
    await deleteTestKeyword(keyword.id);
  });

  test("tag a doc from its page, see the chip, browse to it, untag it", async ({ page, sharedDoc }) => {
    await gotoOk(page, `/doc/${sharedDoc.slug}`);

    // Nothing yet — the strip renders for a tagger, but with no chips.
    await expect(page.getByRole("link", { name: keyword.name })).toHaveCount(0);

    await tagger(page).click();
    await page.getByLabel("Find or add a keyword").fill(keyword.name);
    // The existing term appears in the picker rather than a "Create …" button:
    // an exact case-insensitive hit means apply, not mint a near-duplicate.
    await page.getByRole("button", { name: keyword.name, exact: true }).click();

    // The chip is server-rendered, so this also proves the action's
    // revalidatePath reached the right page (§20d's cache rule).
    const chip = page.getByRole("link", { name: keyword.name });
    await expect(chip).toBeVisible();

    const tagged = await getKeywordFacts(keyword.id);
    expect(tagged?.taggers).toEqual([ADMIN_EMAIL]);
    expect(tagged?.targets).toEqual([{ kind: "doc", id: sharedDoc.id }]);

    // The chip links to the browse page, which lists the doc under Docs.
    await chip.click();
    await page.waitForURL(`**/keyword/${keyword.slug}`);
    await expect(page.getByRole("heading", { name: keyword.name, level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Docs/ })).toBeVisible();
    await expect(page.getByRole("link", { name: sharedDoc.title })).toBeVisible();

    // Untag from the doc page, and the chip goes with it.
    await gotoOk(page, `/doc/${sharedDoc.slug}`);
    await tagger(page).click();
    await page.getByRole("button", { name: `Remove keyword ${keyword.name}` }).click();
    await expect(page.getByRole("link", { name: keyword.name })).toHaveCount(0);

    const untagged = await getKeywordFacts(keyword.id);
    expect(untagged?.taggers).toEqual([]);
    // The browse page follows: an untag is a soft delete of the assignment, and
    // every reader filters on it (§20c's by-hand filtering, since
    // keywordAssignment deliberately doesn't join the $extends filter).
    await gotoOk(page, `/keyword/${keyword.slug}`);
    await expect(page.getByRole("link", { name: sharedDoc.title })).toHaveCount(0);
  });

  test("minting a term and applying it are one gesture", async ({ page, sharedDoc }) => {
    const fresh = uniqueTitle("keyword");
    await gotoOk(page, `/doc/${sharedDoc.slug}`);
    await tagger(page).click();
    await page.getByLabel("Find or add a keyword").fill(fresh);
    await page.getByRole("button", { name: `Create “${fresh}”` }).click();

    const chip = page.getByRole("link", { name: fresh });
    await expect(chip).toBeVisible();

    // The slug comes off the chip's own href rather than being re-derived here:
    // uniqueKeywordSlug appends a -2 on collision, so recomputing it in the
    // spec would be a second implementation of the rule that could disagree
    // with the first — and would leak a fixture on the day it did.
    const href = await chip.getAttribute("href");
    const slug = href!.replace("/keyword/", "");

    const facts = await getKeywordFacts(slug);
    expect(facts?.name).toBe(fresh);
    expect(facts?.taggers).toEqual([ADMIN_EMAIL]);

    await deleteTestKeyword(slug);
  });

  test("a chip on a published post is visible to a signed-out reader", async ({ page, browser, publishedPost }) => {
    await tagWithTestKeyword({
      keywordId: keyword.id,
      target: { kind: "post", id: publishedPost.id },
      taggerEmail: ADMIN_EMAIL,
    });

    // A fresh context with no cookie jar — the post page is statically
    // generated and its chips are public, which is the whole reason
    // KeywordChips reads no session (PLAN.md §12f: a route with
    // generateStaticParams that also calls a dynamic API throws at build).
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const anonPage = await anon.newPage();
    // freshGoto, not goto: this tag was written straight to the DB, so against
    // the prod target the Full Route Cache may still be serving a render
    // without it (fixtures.ts's freshGoto comment). Exactly the hazard that
    // comes with keeping this route statically generated.
    await freshGoto(anonPage, `/${publishedPost.slug}`);
    await expect(anonPage.getByRole("link", { name: keyword.name })).toBeVisible();
    // …and no tagger, since applying a keyword needs an AUTHORIZED account.
    await expect(anonPage.getByText("+ keyword")).toHaveCount(0);
    await anon.close();

    // The browse page's Posts section, likewise, needs no viewer at all.
    await page.goto("about:blank");
    const anon2 = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const anonPage2 = await anon2.newPage();
    await anonPage2.goto(`/keyword/${keyword.slug}`);
    await expect(anonPage2.getByRole("link", { name: publishedPost.title })).toBeVisible();
    await anon2.close();
  });

  test("a PRIVATE doc's chips are as private as the doc", async ({ page, draftDoc, secondUser }) => {
    await tagWithTestKeyword({
      keywordId: keyword.id,
      target: { kind: "doc", id: draftDoc.id },
      taggerEmail: ADMIN_EMAIL,
    });

    // The admin, who authors it, sees the doc under the term.
    await gotoOk(page, `/keyword/${keyword.slug}`);
    await expect(page.getByRole("link", { name: draftDoc.title })).toBeVisible();

    // An EDITOR with no byline on it does not — docs/PERMISSIONS.md's
    // PRIVATE rule, with no ADMIN/EDITOR bypass (PLAN.md §12e). This is the
    // row that would break if /keyword/[slug] were ever built as one UNION
    // over the three types instead of three predicates (§20d).
    const { page: editorPage } = await secondUser({ role: "EDITOR" });
    await editorPage.goto(`/keyword/${keyword.slug}`);
    await expect(editorPage.getByRole("heading", { name: keyword.name, level: 1 })).toBeVisible();
    await expect(editorPage.getByRole("link", { name: draftDoc.title })).toHaveCount(0);
  });

  test("/keywords sorts through the keyword_metrics view", async ({ page, sharedDoc, publishedPost }) => {
    // Two terms, differing usage: one on a doc and a post, one on nothing.
    const unused = await createTestKeyword({ creatorEmail: ADMIN_EMAIL, name: uniqueTitle("keyword-unused") });
    await tagWithTestKeyword({
      keywordId: keyword.id,
      target: { kind: "doc", id: sharedDoc.id },
      taggerEmail: ADMIN_EMAIL,
    });
    await tagWithTestKeyword({
      keywordId: keyword.id,
      target: { kind: "post", id: publishedPost.id },
      taggerEmail: ADMIN_EMAIL,
    });

    try {
      // Descending by assignments puts the used term above the unused one. The
      // point isn't the order as such — it's that the ordering happened in
      // Postgres through a view Prisma treats as a to-one relation (§16e), so
      // it survives pagination.
      await gotoOk(page, "/keywords?sort=assignments:desc&q=E2E");
      const rows = page.locator("tbody tr");
      const usedIndex = await rows.filter({ hasText: keyword.name }).first().evaluate((el) => {
        const all = [...el.parentElement!.children];
        return all.indexOf(el);
      });
      const unusedIndex = await rows.filter({ hasText: unused.name }).first().evaluate((el) => {
        const all = [...el.parentElement!.children];
        return all.indexOf(el);
      });
      expect(usedIndex).toBeLessThan(unusedIndex);

      // An unused term has no view row at all — the doc_metrics semantic
      // (§16l) — and must still render, as an empty cell rather than a crash.
      const unusedRow = rows.filter({ hasText: unused.name }).first();
      await expect(unusedRow).toBeVisible();

      // The per-type counts are hidden by default (§16m); ask for them
      // explicitly and check the two arc legs that were written. Read as a
      // list of cell texts rather than by column index — the two alwaysVisible
      // columns (select, deleted) bracket the requested ones, so an index here
      // would encode the kit's layout rather than this table's data.
      await gotoOk(page, "/keywords?q=E2E&cols=name,assignments,docs,posts,files");
      const usedRow = page.locator("tbody tr").filter({ hasText: keyword.name }).first();
      const cells = await usedRow.locator("td").allTextContents();
      expect(cells).toContain("2"); // assignments: two acts of tagging
      // One doc and one post, one file — and Files is blank at zero, which is
      // what makes "exactly two 1s" the right assertion rather than "three".
      expect(cells.filter((c) => c.trim() === "1")).toHaveLength(2);
    } finally {
      await deleteTestKeyword(unused.id);
    }
  });

  test("the part columns ship present, constrained and unwritten", async ({ sharedDoc }) => {
    await tagWithTestKeyword({
      keywordId: keyword.id,
      target: { kind: "doc", id: sharedDoc.id },
      taggerEmail: ADMIN_EMAIL,
    });

    // §20d's tie-off, asserted where it actually lives. No UI can reach these,
    // so no UI-driven test can tell an unwritten column from an absent one —
    // and PR 2 is where each of these stops being null.
    const parts = await getKeywordAnchorPartColumns(keyword.id);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      selectorKind: null,
      anchorFrom: null,
      anchorTo: null,
      quotedText: "",
      hasSelector: false,
    });
  });

  test("the doc editor's Settings panel fetches its chips when it opens", async ({ page, sharedDoc }) => {
    // Applied by nobody's browser — the panel has to read this from the
    // database on open, which is the path a UI-driven tag would hide.
    await tagWithTestKeyword({
      keywordId: keyword.id,
      target: { kind: "doc", id: sharedDoc.id },
      taggerEmail: ADMIN_EMAIL,
    });

    await gotoOk(page, `/doc/${sharedDoc.slug}/edit`);
    const settings = settingsPanel(page);

    // Nothing is fetched until the panel is opened. That's the whole reason
    // the field isn't a prop on DocEditor, so it is worth pinning: a chip here
    // would mean the read is being paid for on every editing session, most of
    // which never open Settings at all.
    //
    // Asserted against the DOM rather than by role, and on the field's own
    // *loading line* rather than only on the chip's absence. A closed <details>
    // hides its subtree from the accessibility tree, so `getByRole` finds
    // nothing here whether or not the fetch has happened — the absence of a
    // chip alone would pass for the wrong reason.
    await expect(keywordField(page).locator("> p")).toHaveCount(1);
    await expect(settings.locator('a[href^="/keyword/"]')).toHaveCount(0);

    await settings.locator("> summary").click();
    await expect(keywordField(page).locator("> p")).toHaveCount(0);
    await expect(settings.getByRole("link", { name: keyword.name })).toBeVisible();
    // The same strip an object page carries, so the "+ keyword" control is
    // here too rather than a lookalike built out of the panel's own parts.
    await expect(settings.getByLabel("Add or remove keywords")).toBeVisible();
  });

  test("tagging from the Settings panel updates the panel's own chips", async ({ page, sharedDoc }) => {
    await gotoOk(page, `/doc/${sharedDoc.slug}/edit`);
    const settings = settingsPanel(page);
    await settings.locator("> summary").click();

    // Opened, and empty — so the chip that appears below is this tag and not
    // a stale render.
    await expect(settings.getByLabel("Add or remove keywords")).toBeVisible();
    await expect(settings.getByRole("link", { name: keyword.name })).toHaveCount(0);

    await settings.getByLabel("Add or remove keywords").click();
    await page.getByLabel("Find or add a keyword").fill(keyword.name);
    await page.getByRole("button", { name: keyword.name, exact: true }).click();

    // **This assertion is the point of the test.** These chips are client
    // state fetched when the panel opened, so the action's revalidatePath —
    // which is what refreshes the chips on /doc/[slug] — cannot reach them.
    // KeywordTagger's `onChange` is the only thing that can, and nothing on
    // the server compensates if it stops being called.
    await expect(settings.getByRole("link", { name: keyword.name })).toBeVisible();

    const tagged = await getKeywordFacts(keyword.id);
    expect(tagged?.taggers).toEqual([ADMIN_EMAIL]);
    expect(tagged?.targets).toEqual([{ kind: "doc", id: sharedDoc.id }]);

    // Retracting runs back through the same seam — from "Your tags here",
    // since the panel deliberately grew no removal control of its own.
    await page.getByRole("button", { name: `Remove keyword ${keyword.name}` }).click();
    await expect(settings.getByRole("link", { name: keyword.name })).toHaveCount(0);

    const untagged = await getKeywordFacts(keyword.id);
    expect(untagged?.taggers).toEqual([]);
  });
});
