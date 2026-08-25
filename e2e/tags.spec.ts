import { test, expect, freshGoto, gotoOk } from "./fixtures";
import {
  ADMIN_EMAIL,
  createTestTag,
  deleteTestTag,
  getTagAnchorPartColumns,
  getTagFacts,
  tagWithTestTag,
  uniqueTitle,
  type TestTag,
} from "./db";

// PLAN.md §20d's tie-off — the PR 1 feature end to end: tag → chip → browse →
// untag, `/tags` sorting through the `tag_metrics` view, and the part
// columns staying unwritten.
//
// A note on what is *not* here. There is no spec driving the tagger on a PDF:
// /pdf/[slug] is a full-height `ssr: false` island and the chips sit above it,
// which the doc and post specs already exercise the same component through.
// And there is no part-tagging spec, because there is no part-tagging — that
// is the tie-off, asserted directly against the columns at the end rather than
// through a UI that deliberately can't reach them.

/**
 * The tagger panel's disclosure, wherever the strip is rendered.
 *
 * By its aria-label rather than its "+ tag" text: a <summary> is the one
 * element whose implicit role differs across engines, and the label is what
 * TagTagger sets deliberately for exactly this reason.
 */
function tagger(page: import("@playwright/test").Page) {
  return page.getByLabel("Add or remove tags");
}

test.describe("tags", () => {
  let tag: TestTag;

  test.beforeEach(async () => {
    tag = await createTestTag({ creatorEmail: ADMIN_EMAIL, name: uniqueTitle("tag") });
  });

  test.afterEach(async () => {
    await deleteTestTag(tag.id);
  });

  test("tag a doc from its page, see the chip, browse to it, untag it", async ({ page, sharedDoc }) => {
    await gotoOk(page, `/doc/${sharedDoc.slug}`);

    // Nothing yet — the strip renders for a tagger, but with no chips.
    await expect(page.getByRole("link", { name: tag.name })).toHaveCount(0);

    await tagger(page).click();
    await page.getByLabel("Find or add a tag").fill(tag.name);
    // The existing term appears in the picker rather than a "Create …" button:
    // an exact case-insensitive hit means apply, not mint a near-duplicate.
    await page.getByRole("button", { name: tag.name, exact: true }).click();

    // The chip is server-rendered, so this also proves the action's
    // revalidatePath reached the right page (§20d's cache rule).
    const chip = page.getByRole("link", { name: tag.name });
    await expect(chip).toBeVisible();

    const tagged = await getTagFacts(tag.id);
    expect(tagged?.taggers).toEqual([ADMIN_EMAIL]);
    expect(tagged?.targets).toEqual([{ kind: "doc", id: sharedDoc.id }]);

    // The chip links to the browse page, which lists the doc under Docs.
    await chip.click();
    await page.waitForURL(`**/tag/${tag.slug}`);
    await expect(page.getByRole("heading", { name: tag.name, level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Docs/ })).toBeVisible();
    await expect(page.getByRole("link", { name: sharedDoc.title })).toBeVisible();

    // Untag from the doc page, and the chip goes with it.
    await gotoOk(page, `/doc/${sharedDoc.slug}`);
    await tagger(page).click();
    await page.getByRole("button", { name: `Remove tag ${tag.name}` }).click();
    await expect(page.getByRole("link", { name: tag.name })).toHaveCount(0);

    const untagged = await getTagFacts(tag.id);
    expect(untagged?.taggers).toEqual([]);
    // The browse page follows: an untag is a soft delete of the assignment, and
    // every reader filters on it (§20c's by-hand filtering, since
    // tagAssignment deliberately doesn't join the $extends filter).
    await gotoOk(page, `/tag/${tag.slug}`);
    await expect(page.getByRole("link", { name: sharedDoc.title })).toHaveCount(0);
  });

  test("minting a term and applying it are one gesture", async ({ page, sharedDoc }) => {
    const fresh = uniqueTitle("tag");
    await gotoOk(page, `/doc/${sharedDoc.slug}`);
    await tagger(page).click();
    await page.getByLabel("Find or add a tag").fill(fresh);
    await page.getByRole("button", { name: `Create “${fresh}”` }).click();

    const chip = page.getByRole("link", { name: fresh });
    await expect(chip).toBeVisible();

    // The slug comes off the chip's own href rather than being re-derived here:
    // uniqueTagSlug appends a -2 on collision, so recomputing it in the
    // spec would be a second implementation of the rule that could disagree
    // with the first — and would leak a fixture on the day it did.
    const href = await chip.getAttribute("href");
    const slug = href!.replace("/tag/", "");

    const facts = await getTagFacts(slug);
    expect(facts?.name).toBe(fresh);
    expect(facts?.taggers).toEqual([ADMIN_EMAIL]);

    await deleteTestTag(slug);
  });

  test("a chip on a published post is visible to a signed-out reader", async ({ page, browser, publishedPost }) => {
    await tagWithTestTag({
      tagId: tag.id,
      target: { kind: "post", id: publishedPost.id },
      taggerEmail: ADMIN_EMAIL,
    });

    // A fresh context with no cookie jar — the post page is statically
    // generated and its chips are public, which is the whole reason
    // TagChips reads no session (PLAN.md §12f: a route with
    // generateStaticParams that also calls a dynamic API throws at build).
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const anonPage = await anon.newPage();
    // freshGoto, not goto: this tag was written straight to the DB, so against
    // the prod target the Full Route Cache may still be serving a render
    // without it (fixtures.ts's freshGoto comment). Exactly the hazard that
    // comes with keeping this route statically generated.
    await freshGoto(anonPage, `/${publishedPost.slug}`);
    await expect(anonPage.getByRole("link", { name: tag.name })).toBeVisible();
    // …and no tagger, since applying a tag needs an AUTHORIZED account.
    await expect(anonPage.getByText("+ tag")).toHaveCount(0);
    await anon.close();

    // The browse page's Posts section, likewise, needs no viewer at all.
    await page.goto("about:blank");
    const anon2 = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const anonPage2 = await anon2.newPage();
    await anonPage2.goto(`/tag/${tag.slug}`);
    await expect(anonPage2.getByRole("link", { name: publishedPost.title })).toBeVisible();
    await anon2.close();
  });

  test("a PRIVATE doc's chips are as private as the doc", async ({ page, draftDoc, secondUser }) => {
    await tagWithTestTag({
      tagId: tag.id,
      target: { kind: "doc", id: draftDoc.id },
      taggerEmail: ADMIN_EMAIL,
    });

    // The admin, who authors it, sees the doc under the term.
    await gotoOk(page, `/tag/${tag.slug}`);
    await expect(page.getByRole("link", { name: draftDoc.title })).toBeVisible();

    // An EDITOR with no byline on it does not — docs/PERMISSIONS.md's
    // PRIVATE rule, with no ADMIN/EDITOR bypass (PLAN.md §12e). This is the
    // row that would break if /tag/[slug] were ever built as one UNION
    // over the three types instead of three predicates (§20d).
    const { page: editorPage } = await secondUser({ role: "EDITOR" });
    await editorPage.goto(`/tag/${tag.slug}`);
    await expect(editorPage.getByRole("heading", { name: tag.name, level: 1 })).toBeVisible();
    await expect(editorPage.getByRole("link", { name: draftDoc.title })).toHaveCount(0);
  });

  test("/tags sorts through the tag_metrics view", async ({ page, sharedDoc, publishedPost }) => {
    // Two terms, differing usage: one on a doc and a post, one on nothing.
    const unused = await createTestTag({ creatorEmail: ADMIN_EMAIL, name: uniqueTitle("tag-unused") });
    await tagWithTestTag({
      tagId: tag.id,
      target: { kind: "doc", id: sharedDoc.id },
      taggerEmail: ADMIN_EMAIL,
    });
    await tagWithTestTag({
      tagId: tag.id,
      target: { kind: "post", id: publishedPost.id },
      taggerEmail: ADMIN_EMAIL,
    });

    try {
      // Descending by assignments puts the used term above the unused one. The
      // point isn't the order as such — it's that the ordering happened in
      // Postgres through a view Prisma treats as a to-one relation (§16e), so
      // it survives pagination.
      await gotoOk(page, "/tags?sort=assignments:desc&q=E2E");
      const rows = page.locator("tbody tr");
      const usedIndex = await rows.filter({ hasText: tag.name }).first().evaluate((el) => {
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
      await gotoOk(page, "/tags?q=E2E&cols=name,assignments,docs,posts,files");
      const usedRow = page.locator("tbody tr").filter({ hasText: tag.name }).first();
      const cells = await usedRow.locator("td").allTextContents();
      expect(cells).toContain("2"); // assignments: two acts of tagging
      // One doc and one post, one file — and Files is blank at zero, which is
      // what makes "exactly two 1s" the right assertion rather than "three".
      expect(cells.filter((c) => c.trim() === "1")).toHaveLength(2);
    } finally {
      await deleteTestTag(unused.id);
    }
  });

  test("the part columns ship present, constrained and unwritten", async ({ sharedDoc }) => {
    await tagWithTestTag({
      tagId: tag.id,
      target: { kind: "doc", id: sharedDoc.id },
      taggerEmail: ADMIN_EMAIL,
    });

    // §20d's tie-off, asserted where it actually lives. No UI can reach these,
    // so no UI-driven test can tell an unwritten column from an absent one —
    // and PR 2 is where each of these stops being null.
    const parts = await getTagAnchorPartColumns(tag.id);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      selectorKind: null,
      anchorFrom: null,
      anchorTo: null,
      quotedText: "",
      hasSelector: false,
    });
  });
});
