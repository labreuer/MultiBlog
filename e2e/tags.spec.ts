import { test, expect, freshGoto, gotoOk } from "./fixtures";
import {
  ADMIN_EMAIL,
  addTestPostAuthor,
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
// /pdf/[slug] is a full-height `ssr: false` island and its chips are the
// Metadata tab of the viewer's side panel — the same component the doc and
// post specs already exercise, two containers further in.
// And there is no part-tagging spec, because there is no part-tagging — that
// is the tie-off, asserted directly against the columns at the end rather than
// through a UI that deliberately can't reach them.
//
// §20m's "From the doc" offer is covered in the middle, in two specs rather
// than one: what it does, and who may see it. The second is the one that
// matters — it is the only place in §20 where a page's own gate is the wrong
// one to inherit, so the leak it guards against would look exactly like the
// feature working.
//
// The doc editor's Settings panel *is* covered, at the end, and for a reason
// the reading view doesn't need: its chips are client state fetched when the
// panel opens, so the `revalidatePath` every other surface leans on cannot
// reach them. `onChange` is the only thing that brings them back, and it has
// no server-side fallback to be wrong about.

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
 * The Settings panel's Tags fieldset, and within it the one line that says
 * the chips haven't been fetched yet.
 *
 * Scoped this tightly on purpose: a bare `getByText("Loading…")` matches two
 * different things here. The field shows one while its own state is null, and
 * TagTagger shows one *inside its popover* while its state is — and a
 * closed <details> still has its content in the DOM, so the tagger's line is
 * there from the moment the field finishes loading. `> p` is the field's own,
 * since once loaded its only direct child is the strip.
 */
/**
 * The post editor's source-doc tag offer (PLAN.md §20m), by its data
 * attribute rather than by its label.
 *
 * Its label *is* prose, and the obvious `getByText(/^From doc/)` matched
 * PostPublisher's own "From doc: …" status line as well — two elements saying
 * nearly the same words about two different docs. Both were then renamed;
 * this handle is what makes the next rename a non-event.
 */
function docTagOffer(page: import("@playwright/test").Page) {
  return page.locator("[data-doc-tag-offer]");
}

function tagField(page: import("@playwright/test").Page) {
  return settingsPanel(page)
    .locator("fieldset")
    .filter({ has: page.locator("legend", { hasText: "Tags" }) });
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
    await freshGoto(anonPage, publishedPost.path);
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

  test("an unpublished post is taggable, and only its editors see it under the term", async ({
    page,
    browser,
    draftPost,
    secondUser,
  }) => {
    // PLAN.md §20l. The act and its containment are one rule, so they are one
    // spec: tagging a draft has to *work*, and the browse page has to be what
    // keeps the draft's title away from everyone else. Proving either alone
    // would pass in the world where the other is broken — and the broken
    // version of the second is a leak that looks exactly like a feature.

    // Through the tagger rather than tagWithTestTag, unlike the specs above:
    // the DB helper writes past `canUserTagTarget` entirely, and that gate is
    // half of what is being asserted. Before §20l this click failed with
    // "You don't have permission to tag this".
    await gotoOk(page, `/post/${draftPost.id}/edit`);
    await tagger(page).click();
    await page.getByLabel("Find or add a tag").fill(tag.name);
    await page.getByRole("button", { name: tag.name, exact: true }).click();
    await expect(page.getByRole("link", { name: tag.name })).toBeVisible();

    const tagged = await getTagFacts(tag.id);
    expect(tagged?.targets).toEqual([{ kind: "post", id: draftPost.id }]);

    // The admin who authors it sees the draft under the term — marked as one,
    // and pointing at the editor rather than at a dated URL that does not
    // exist: postPath throws on a null publishedAt by design.
    await gotoOk(page, `/tag/${tag.slug}`);
    const row = page.getByRole("listitem").filter({ hasText: draftPost.title });
    await expect(row.getByRole("link", { name: draftPost.title })).toHaveAttribute(
      "href",
      `/post/${draftPost.id}/edit`,
    );
    await expect(row.getByText("draft")).toBeVisible();

    // An AUTHOR with no byline on it does not — `readablePostWhere` widens by
    // "may you edit this", and AUTHOR is the role where that turns on the
    // byline rather than on the role alone. An EDITOR would be the wrong
    // second user here: canEditAnyPost means they *should* see it.
    const { page: authorPage } = await secondUser({ role: "AUTHOR" });
    await authorPage.goto(`/tag/${tag.slug}`);
    await expect(authorPage.getByRole("heading", { name: tag.name, level: 1 })).toBeVisible();
    await expect(authorPage.getByText(draftPost.title)).toHaveCount(0);
    // Nothing else is tagged with this term, so the whole page is the empty
    // state for them. Asserted because the absence above would also pass if
    // the page had failed to render its sections at all.
    await expect(authorPage.getByText("Nothing you can see carries this tag yet.")).toBeVisible();

    // And a signed-out reader, for whom the predicate is unchanged from what
    // PR 1 shipped: published posts only.
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const anonPage = await anon.newPage();
    await anonPage.goto(`/tag/${tag.slug}`);
    await expect(anonPage.getByRole("heading", { name: tag.name, level: 1 })).toBeVisible();
    await expect(anonPage.getByText(draftPost.title)).toHaveCount(0);
    await anon.close();
  });

  test("the post editor offers its doc's tags, one at a time and all at once", async ({
    page,
    draftPost,
  }) => {
    // PLAN.md §20m. createTestPost creates the post's backing doc, so
    // draftPost.docId is exactly the source doc the offer reads — the same
    // relationship createPostFromDoc sets up.
    const second = await createTestTag({ creatorEmail: ADMIN_EMAIL, name: uniqueTitle("tag-b") });
    const third = await createTestTag({ creatorEmail: ADMIN_EMAIL, name: uniqueTitle("tag-c") });
    try {
      for (const t of [tag, second, third]) {
        await tagWithTestTag({ tagId: t.id, target: { kind: "doc", id: draftPost.docId }, taggerEmail: ADMIN_EMAIL });
      }
      // One of the three is already on the post, so the offer has to subtract
      // it — otherwise "Add all 3" would offer to change nothing for a third
      // of its work, and the count in its label would be a lie.
      await tagWithTestTag({ tagId: third.id, target: { kind: "post", id: draftPost.id }, taggerEmail: ADMIN_EMAIL });

      await gotoOk(page, `/post/${draftPost.id}/edit`);
      await expect(docTagOffer(page)).toBeVisible();
      await expect(page.getByLabel(`Add tag ${tag.name} from the doc`)).toBeVisible();
      await expect(page.getByLabel(`Add tag ${second.name} from the doc`)).toBeVisible();
      await expect(page.getByLabel(`Add tag ${third.name} from the doc`)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Add all 2" })).toBeVisible();

      // One chip: it lands on the post and leaves the offer, which is the
      // whole interaction — the offer is rendered from `tagsNotYetOn`, so a
      // term staying put after a successful write would mean the refresh
      // never reached the server tree.
      await page.getByLabel(`Add tag ${tag.name} from the doc`).click();
      await expect(page.getByRole("link", { name: tag.name })).toBeVisible();
      await expect(page.getByLabel(`Add tag ${tag.name} from the doc`)).toHaveCount(0);

      // The doc keeps it — this copies, it does not move (§20m). Asserted on
      // the anchors rather than through a second page load: `targets` is
      // every live assignment of the term, and there are now two.
      const carried = await getTagFacts(tag.id);
      expect(carried?.taggers).toEqual([ADMIN_EMAIL, ADMIN_EMAIL]);
      // arrayContaining plus a length, not one or the other: neither
      // `assignments` nor `anchors` is ordered by getTagFacts, and
      // arrayContaining alone would also pass on a third target nobody asked
      // for — which is exactly what a move-instead-of-copy bug would not be,
      // but a double-write would.
      expect(carried?.targets).toHaveLength(2);
      expect(carried?.targets).toEqual(
        expect.arrayContaining([
          { kind: "doc", id: draftPost.docId },
          { kind: "post", id: draftPost.id },
        ]),
      );

      // One term left, so the bulk button is gone — it appears only where it
      // saves a click over the chips beside it.
      await expect(page.getByRole("button", { name: /^Add all/ })).toHaveCount(0);
      await page.getByLabel(`Add tag ${second.name} from the doc`).click();
      await expect(page.getByRole("link", { name: second.name })).toBeVisible();

      // Nothing left to carry across, so the row itself goes rather than
      // lingering as an empty label.
      await expect(docTagOffer(page)).toHaveCount(0);
    } finally {
      await deleteTestTag(second.id);
      await deleteTestTag(third.id);
    }
  });

  test("the offer wears the doc's read gate, not the post editor's", async ({ page, draftPost, secondUser }) => {
    // **The leak this exists to prevent.** A post author need not be an author
    // of the doc the post was made from, and createTestPost's backing doc is
    // PRIVATE — which docs/PERMISSIONS.md makes its listed authors' alone, with
    // no ADMIN/EDITOR bypass (PLAN.md §12e). So the post editor's own gate
    // (ownership or canEditAnyPost) is exactly the wrong one to inherit here.
    await tagWithTestTag({
      tagId: tag.id,
      target: { kind: "doc", id: draftPost.docId },
      taggerEmail: ADMIN_EMAIL,
    });

    // The admin authors both, and sees the offer.
    await gotoOk(page, `/post/${draftPost.id}/edit`);
    await expect(docTagOffer(page)).toBeVisible();
    await expect(page.getByLabel(`Add tag ${tag.name} from the doc`)).toBeVisible();

    // An AUTHOR put on the post's byline and nowhere near the doc. AUTHOR
    // rather than EDITOR deliberately: an EDITOR passes canEditAnyPost, so
    // this would still prove the gate — but AUTHOR is the role where reaching
    // the page at all depends on the byline, which is the shape being
    // described. They must see the post's own chips and not the doc's.
    const { user, page: authorPage } = await secondUser({ role: "AUTHOR" });
    await addTestPostAuthor(draftPost.id, user.email);
    await authorPage.goto(`/post/${draftPost.id}/edit`);
    await expect(authorPage.getByLabel("Post title")).toHaveValue(draftPost.title);
    await expect(docTagOffer(authorPage)).toHaveCount(0);
    await expect(authorPage.getByLabel(`Add tag ${tag.name} from the doc`)).toHaveCount(0);
    // Not merely "the page failed to render": the post's own tagger is there.
    await expect(authorPage.getByLabel("Add or remove tags")).toBeVisible();
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

  test("the doc editor's Settings panel fetches its chips when it opens", async ({ page, sharedDoc }) => {
    // Applied by nobody's browser — the panel has to read this from the
    // database on open, which is the path a UI-driven tag would hide.
    await tagWithTestTag({
      tagId: tag.id,
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
    await expect(tagField(page).locator("> p")).toHaveCount(1);
    await expect(settings.locator('a[href^="/tag/"]')).toHaveCount(0);

    await settings.locator("> summary").click();
    await expect(tagField(page).locator("> p")).toHaveCount(0);
    await expect(settings.getByRole("link", { name: tag.name })).toBeVisible();
    // The same strip an object page carries, so the "+ tag" control is
    // here too rather than a lookalike built out of the panel's own parts.
    await expect(settings.getByLabel("Add or remove tags")).toBeVisible();
  });

  test("tagging from the Settings panel updates the panel's own chips", async ({ page, sharedDoc }) => {
    await gotoOk(page, `/doc/${sharedDoc.slug}/edit`);
    const settings = settingsPanel(page);
    await settings.locator("> summary").click();

    // Opened, and empty — so the chip that appears below is this tag and not
    // a stale render.
    await expect(settings.getByLabel("Add or remove tags")).toBeVisible();
    await expect(settings.getByRole("link", { name: tag.name })).toHaveCount(0);

    await settings.getByLabel("Add or remove tags").click();
    await page.getByLabel("Find or add a tag").fill(tag.name);
    await page.getByRole("button", { name: tag.name, exact: true }).click();

    // **This assertion is the point of the test.** These chips are client
    // state fetched when the panel opened, so the action's revalidatePath —
    // which is what refreshes the chips on /doc/[slug] — cannot reach them.
    // TagTagger's `onChange` is the only thing that can, and nothing on
    // the server compensates if it stops being called.
    await expect(settings.getByRole("link", { name: tag.name })).toBeVisible();

    const tagged = await getTagFacts(tag.id);
    expect(tagged?.taggers).toEqual([ADMIN_EMAIL]);
    expect(tagged?.targets).toEqual([{ kind: "doc", id: sharedDoc.id }]);

    // Retracting runs back through the same seam — from "Your tags here",
    // since the panel deliberately grew no removal control of its own.
    await page.getByRole("button", { name: `Remove tag ${tag.name}` }).click();
    await expect(settings.getByRole("link", { name: tag.name })).toHaveCount(0);

    const untagged = await getTagFacts(tag.id);
    expect(untagged?.taggers).toEqual([]);
  });
});
