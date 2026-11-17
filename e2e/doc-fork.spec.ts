import type { JSONContent } from "@tiptap/core";
import type { Page } from "@playwright/test";
import { test, expect, bodyEditor, docActionItems, docActionsMenu, gotoOk, openDocActions, waitForDocCollabReady, QUOTED_BODY } from "./fixtures";
import {
  ADMIN_EMAIL,
  appendTestDocParagraph,
  countDocYdocSnapshots,
  countDocYdocUpdates,
  createTestDoc,
  deleteTestDoc,
  deleteTestDocYdoc,
  forkDocAs,
  getDocMarkFacts,
  getDocSearchText,
  getDocYdocUpdateIds,
  getTestForkFacts,
  getUserIdByEmail,
  softDeleteTestDoc,
  type TestDoc,
} from "./db";

// docs/FORKS.md "Forks" — a new doc seeded from another doc's text at one
// version, which records where it came from: the Actions menu and the Fork
// dialog, what a fork takes and what stays, who may fork what, the family
// lines with their diff links, and the fork-point exception to who may see a
// doc's history.
//
// Most of it asks `forkDoc` directly (`forkDocAs`), the function the dialog's
// action wraps: the dialog never sends a version its reader may not have, a
// visibility that is neither value, or a parent that is gone, and the server
// must refuse each all the same.
//
// What this doesn't check: how the diff page's headers show a fork against
// its parent (docs/FORKS.md, "Which side is later"), whose pairs are in
// diff-side.test.ts; and the seed's strip at every depth, in
// fork-seed.test.ts.

const FIRST = "A second paragraph, appended as the parent's second version.";
const SECOND = "A third paragraph, which the parent gained after it was forked.";

/** Postgres's largest bigint, and the number after it. */
const MAX_UPDATE_ID = "9223372036854775807";
const PAST_THE_BOUND = "9223372036854775808";

const SLIDER = "Scrub through this doc's edit history";

/** The diff page's rows, once the worker has answered. */
async function done(page: Page) {
  const island = page.locator('[data-state="done"]');
  await expect(island).toBeVisible({ timeout: 30_000 });
  return island;
}

/** A range input ignores fill()/click, per docs/BROWSER_PANE.md's recipe. */
async function scrubTo(page: Page, value: number): Promise<void> {
  await page.getByLabel(SLIDER).evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

/** Opens the Fork dialog from the Actions menu, again until hydration has wired the item's click. */
async function openForkDialog(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Fork this doc" });
  await expect(async () => {
    await openDocActions(page);
    await page.getByRole("button", { name: "Fork…" }).click();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  return dialog;
}

const family = (page: Page) => page.getByRole("complementary", { name: "This doc's family" });
/** Every link in the family lines, in order: each doc, then its diffs. */
const familyHrefs = (page: Page) => family(page).locator("a").evaluateAll((links) => links.map((a) => a.getAttribute("href")));

type Forked = Extract<Awaited<ReturnType<typeof forkDocAs>>, { ok: true }>;
async function mustFork(opts: Parameters<typeof forkDocAs>[0]): Promise<Forked> {
  const result = await forkDocAs(opts);
  if (!result.ok) throw new Error(`fork failed: ${JSON.stringify(result)}`);
  return result;
}

/** A doc's last update: what a fork of it as it is now records. */
async function tailOf(doc: TestDoc): Promise<string> {
  return (await getDocYdocUpdateIds(doc.id)).slice(-1)[0];
}

test.describe("the Actions menu and the Fork dialog (docs/FORKS.md \"The doc view\")", () => {
  test("the menu offers each item only to whoever may do it", async ({ page, sharedDoc, secondUser }) => {
    const { page: author } = await secondUser({ role: "AUTHOR" });
    const { page: reader } = await secondUser({ role: "AUTHORIZED" });

    // An editor of a doc with no post.
    await page.goto(`/doc/${sharedDoc.slug}`);
    expect(await docActionItems(page)).toEqual(["Publish as blog post", "Fork…"]);
    // A reader who can't edit it may still fork it, having canManageDocs.
    await author.goto(`/doc/${sharedDoc.slug}`);
    expect(await docActionItems(author)).toEqual(["Fork…"]);
    // A reader who creates nothing is offered nothing, so there is no menu.
    await reader.goto(`/doc/${sharedDoc.slug}`);
    await expect(bodyEditor(reader)).toBeVisible();
    await expect(docActionsMenu(reader)).toHaveCount(0);
  });

  test("a reader who can't edit a doc forks it as it is now: PRIVATE, theirs alone, on its editor", async ({ secondUser }) => {
    const adminId = (await getUserIdByEmail(ADMIN_EMAIL))!;
    const body: JSONContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Written by the admin, ", marks: [{ type: "authorHighlight", attrs: { authorId: adminId } }] },
            {
              type: "text",
              text: "and noted.",
              marks: [
                { type: "authorHighlight", attrs: { authorId: adminId } },
                { type: "annotation", attrs: { id: "e2e-note-id" } },
              ],
            },
          ],
        },
      ],
    };
    const parent = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", body });
    const { user: forker, page } = await secondUser({ role: "AUTHOR" });
    let forkSlug: string | null = null;
    try {
      expect((await getDocMarkFacts(parent.id)).annotations).toEqual({ "e2e-note-id": "and noted." });
      const snapshotsBefore = await countDocYdocSnapshots(parent.id);

      await page.goto(`/doc/${parent.slug}`);
      const dialog = await openForkDialog(page);
      await expect(dialog.locator('[data-kind="fork-copies"]')).toContainText("as it is now");
      await expect(dialog.getByLabel("Who can read it")).toHaveValue("PRIVATE");
      await dialog.getByRole("button", { name: "Fork", exact: true }).click();
      // Its slug comes from the parent's title, which it keeps.
      await page.waitForURL((url) => url.pathname === `/doc/${parent.slug}-2/edit`);
      forkSlug = `${parent.slug}-2`;
      await waitForDocCollabReady(page);

      const facts = await getTestForkFacts(forkSlug);
      expect(facts).toMatchObject({
        forkedFromDocId: parent.id,
        forkedFromUpdateId: await tailOf(parent),
        visibility: "PRIVATE",
        byline: [forker.email],
        createdByEmail: forker.email,
        record: false,
        importKey: null,
        importedUpdateId: null,
      });
      const marks = await getDocMarkFacts(facts.id);
      expect(marks.text).toBe("Written by the admin, and noted.");
      expect(marks.title).toBe(parent.title);
      // The parent's author still shows on the inherited text; its note's mark didn't follow.
      expect(marks.authors).toEqual({ [ADMIN_EMAIL]: "Written by the admin, and noted." });
      expect(marks.annotations).toEqual({});
      // The seed is the forker's, by the clients map.
      expect(marks.clients).toContain(forker.email);
      expect(marks.clients).not.toContain(ADMIN_EMAIL);
      // A fork writes nothing to its parent.
      expect(await countDocYdocSnapshots(parent.id)).toBe(snapshotsBefore);
      expect((await getDocMarkFacts(parent.id)).annotations).toEqual({ "e2e-note-id": "and noted." });
    } finally {
      await page.goto("about:blank").catch(() => {});
      if (forkSlug) await deleteTestDoc(forkSlug);
      await deleteTestDoc(parent.id);
    }
  });

  test("an editor forks at the version the scrub bar is on, and as it is now from the live end", async ({ page, sharedDoc }) => {
    const [first] = await getDocYdocUpdateIds(sharedDoc.id);
    await appendTestDocParagraph({ docId: sharedDoc.id, text: FIRST });
    let forkSlug: string | null = null;
    try {
      await page.goto(`/doc/${sharedDoc.slug}`);
      await expect(bodyEditor(page)).toBeVisible();
      await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });

      // Before the bar has loaded its history, and then at its live end, the reader is on the live text.
      let dialog = await openForkDialog(page);
      await expect(dialog.locator('[data-kind="fork-copies"]')).toContainText("as it is now");
      await expect(dialog.locator('input[name="revision"]')).toHaveValue("");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();

      await page.getByLabel(SLIDER).focus();
      await expect.poll(() => page.getByLabel(SLIDER).getAttribute("max"), { timeout: 15_000 }).toBe("1");
      dialog = await openForkDialog(page);
      await expect(dialog.locator('[data-kind="fork-copies"]')).toContainText("as it is now");
      await dialog.getByRole("button", { name: "Cancel" }).click();

      // Scrubbed back: the dialog names that version, read from the bar and not from ?at=.
      await scrubTo(page, 0);
      dialog = await openForkDialog(page);
      await expect(dialog.locator('[data-kind="fork-copies"]')).toContainText("as it was at");
      await expect(dialog.locator('input[name="revision"]')).toHaveValue(first);
      await dialog.getByLabel("Who can read it").selectOption("SHARED");
      await dialog.getByRole("button", { name: "Fork", exact: true }).click();
      await page.waitForURL((url) => url.pathname === `/doc/${sharedDoc.slug}-2/edit`);
      forkSlug = `${sharedDoc.slug}-2`;
      await waitForDocCollabReady(page);

      const facts = await getTestForkFacts(forkSlug);
      expect(facts).toMatchObject({ forkedFromDocId: sharedDoc.id, forkedFromUpdateId: first, visibility: "SHARED", byline: [ADMIN_EMAIL] });
      // The parent as it was at that version, without what it gained since.
      expect((await getDocMarkFacts(facts.id)).text).toBe(QUOTED_BODY);
    } finally {
      await page.goto("about:blank").catch(() => {});
      if (forkSlug) await deleteTestDoc(forkSlug);
    }
  });
});

test.describe("who may fork what (docs/FORKS.md \"Who may fork\")", () => {
  /** Everything a fork made, so a test can delete it. */
  const made: string[] = [];
  const keep = <T extends { ok: boolean }>(result: T) => {
    if (result.ok) made.push((result as unknown as { id: string }).id);
    return result;
  };
  test.afterEach(async () => {
    for (const id of made.splice(0)) await deleteTestDoc(id);
  });

  test("a version needs the parent's history first, then to be in its log, within Postgres's bigint", async ({ sharedDoc, draftDoc, secondUser }) => {
    const { user: reader } = await secondUser({ role: "AUTHOR" });
    const [first] = await getDocYdocUpdateIds(sharedDoc.id);
    const [foreign] = await getDocYdocUpdateIds(draftDoc.id);
    await appendTestDocParagraph({ docId: sharedDoc.id, text: FIRST });
    const snapshotsBefore = await countDocYdocSnapshots(sharedDoc.id);

    // A reader without the history is refused whatever the id, so the answer
    // doesn't say which ids are in the log.
    for (const revision of [first, foreign, "1", MAX_UPDATE_ID, PAST_THE_BOUND, "not-a-number"]) {
      expect(await forkDocAs({ actorEmail: reader.email, parentId: sharedDoc.id, revision })).toMatchObject({ ok: false, code: "forbidden" });
    }
    // An editor's version must be this doc's.
    for (const revision of [foreign, MAX_UPDATE_ID, PAST_THE_BOUND, "0", "not-a-number"]) {
      expect(await forkDocAs({ actorEmail: ADMIN_EMAIL, parentId: sharedDoc.id, revision })).toMatchObject({ ok: false, code: "invalid" });
    }

    const atFirst = keep(await forkDocAs({ actorEmail: ADMIN_EMAIL, parentId: sharedDoc.id, revision: first }));
    expect(atFirst).toMatchObject({ ok: true });
    expect(await getTestForkFacts((atFirst as Forked).id)).toMatchObject({ forkedFromUpdateId: first });
    expect((await getDocMarkFacts((atFirst as Forked).id)).text).toBe(QUOTED_BODY);

    // The reader may fork it as it is now, at its last update.
    const asNow = keep(await forkDocAs({ actorEmail: reader.email, parentId: sharedDoc.id }));
    expect(asNow).toMatchObject({ ok: true });
    expect(await getTestForkFacts((asNow as Forked).id)).toMatchObject({ forkedFromUpdateId: await tailOf(sharedDoc), byline: [reader.email] });
    expect((await getDocMarkFacts((asNow as Forked).id)).text).toBe(`${QUOTED_BODY}\n${FIRST}`);

    // Neither fork left a snapshot on the parent.
    expect(await countDocYdocSnapshots(sharedDoc.id)).toBe(snapshotsBefore);
  });

  test("a deleted or missing parent is not found, an unreadable one Forbidden, and one with no log refused", async ({ draftDoc, secondUser }) => {
    const { user: author } = await secondUser({ role: "AUTHOR" });
    const deleted = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Gone." });
    const logless = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "No history." });
    try {
      await softDeleteTestDoc(deleted.id);
      // To its own editor too.
      expect(await forkDocAs({ actorEmail: ADMIN_EMAIL, parentId: deleted.id })).toMatchObject({ ok: false, code: "not_found" });
      expect(await forkDocAs({ actorEmail: author.email, parentId: deleted.id })).toMatchObject({ ok: false, code: "not_found" });
      expect(await forkDocAs({ actorEmail: ADMIN_EMAIL, parentId: "nosuchdoc0000" })).toMatchObject({ ok: false, code: "not_found" });

      // The admin's PRIVATE doc: there, and not this author's to read.
      expect(await forkDocAs({ actorEmail: author.email, parentId: draftDoc.id })).toMatchObject({
        ok: false,
        code: "forbidden",
        message: expect.stringContaining("read that doc"),
      });
      // Its own byline may fork it, and to SHARED: a fork's visibility is its own.
      const own = keep(await forkDocAs({ actorEmail: ADMIN_EMAIL, parentId: draftDoc.id, visibility: "SHARED" }));
      expect(own).toMatchObject({ ok: true });
      expect(await getTestForkFacts((own as Forked).id)).toMatchObject({ visibility: "SHARED" });

      await deleteTestDocYdoc(logless.id);
      expect(await forkDocAs({ actorEmail: ADMIN_EMAIL, parentId: logless.id })).toMatchObject({
        ok: false,
        code: "invalid",
        message: expect.stringContaining("no history"),
      });
    } finally {
      await deleteTestDoc(deleted.id);
      await deleteTestDoc(logless.id);
    }
  });

  test("a visibility that is neither value is refused before anything is read, and an actor who creates no docs before the parent is looked up", async ({
    sharedDoc,
    secondUser,
  }) => {
    const { user: reader } = await secondUser({ role: "AUTHORIZED" });
    for (const visibility of ["PUBLIC", "private", "", "SHARED "]) {
      // The same answer for a parent that exists and one that doesn't.
      for (const parentId of [sharedDoc.id, "nosuchdoc0000"]) {
        expect(await forkDocAs({ actorEmail: ADMIN_EMAIL, parentId, visibility })).toMatchObject({ ok: false, code: "invalid", message: "Invalid visibility." });
      }
    }
    // An AUTHORIZED reader reads the doc and creates nothing: told that, and nothing about the parent.
    const refusals = await Promise.all(
      [sharedDoc.id, "nosuchdoc0000"].map((parentId) => forkDocAs({ actorEmail: reader.email, parentId })),
    );
    expect(refusals[0]).toMatchObject({ ok: false, code: "forbidden", message: expect.stringContaining("create docs") });
    expect(refusals[1]).toEqual(refusals[0]);
  });

  test("two forks of one doc at once both succeed, at slugs of their own", async ({ sharedDoc }) => {
    const results = await Promise.all([
      forkDocAs({ actorEmail: ADMIN_EMAIL, parentId: sharedDoc.id }),
      forkDocAs({ actorEmail: ADMIN_EMAIL, parentId: sharedDoc.id }),
    ]);
    results.forEach(keep);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    const slugs = results.map((r) => (r as Forked).slug).sort();
    expect(slugs).toEqual([`${sharedDoc.slug}-2`, `${sharedDoc.slug}-3`]);
  });

  test("a fork takes its parent's chip style, and its reading view shows it before any edit", async ({ page, secondUser }) => {
    const { user: mentioned } = await secondUser({ role: "AUTHOR" });
    const parent = await createTestDoc({
      authorEmail: ADMIN_EMAIL,
      visibility: "SHARED",
      body: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Ask " },
              { type: "entityChip", attrs: { kind: "mention", iid: "i1", data: { userId: mentioned.id } } },
              { type: "text", text: " about it." },
            ],
          },
        ],
      },
      chipStyles: { mention: { form: "handle" } },
    });
    try {
      const fork = keep(await forkDocAs({ actorEmail: ADMIN_EMAIL, parentId: parent.id, visibility: "SHARED" })) as Forked;
      expect(fork).toMatchObject({ ok: true });
      const facts = await getTestForkFacts(fork.id);
      // In the seed, so every later replay holds it, and on the row, which no store has written yet.
      expect(facts.chipStylesInYdoc).toMatchObject({ mention: { form: "handle" } });
      expect(facts.chipStylesInRow).toMatchObject({ mention: { form: "handle" } });
      // The cached body is labelled in that style: what search and the static render read.
      expect(await getDocSearchText(fork.id)).toBe(`Ask @${mentioned.slug} about it.`);

      // Nobody has opened the fork's editor: the first paint, then the live view once it has synced.
      await page.goto(`/doc/${fork.slug}`);
      await expect(page.locator("a.entity-chip").filter({ visible: true })).toHaveText([`@${mentioned.slug}`]);
      await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
      await expect(bodyEditor(page).locator(".entity-chip")).toHaveText([`@${mentioned.slug}`]);
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(parent.id);
    }
  });
});

test.describe("a doc's family (docs/FORKS.md \"A doc's family\")", () => {
  test("a fork names its parent and a parent its forks, naming none the viewer can't read, with the diffs each may see", async ({
    page,
    sharedDoc,
    secondUser,
  }) => {
    const { user: other, page: otherPage } = await secondUser({ role: "AUTHOR" });
    const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });
    const parent = sharedDoc;
    const made: string[] = [];
    try {
      // One fork every reader can read, and one that is its forker's alone.
      const open = await mustFork({ actorEmail: ADMIN_EMAIL, parentId: parent.id, visibility: "SHARED" });
      made.push(open.id);
      const hidden = await mustFork({ actorEmail: other.email, parentId: parent.id, visibility: "PRIVATE" });
      made.push(hidden.id);
      const point = await tailOf(parent);
      const [openFirst] = await getDocYdocUpdateIds(open.id);
      const [hiddenFirst] = await getDocYdocUpdateIds(hidden.id);
      const P = parent.id;

      // The parent, as its editor: the PRIVATE fork isn't theirs to read,
      // an ADMIN included, and goes unnamed and uncounted.
      await page.goto(`/doc/${parent.slug}`);
      await expect(family(page).locator('[data-kind="forks"]')).toContainText("Forks:");
      await expect(family(page)).toContainText("(diff: parent vs. fork, parent, fork)");
      await expect(family(page).locator('[data-kind="forked-from"]')).toHaveCount(0);
      expect(await familyHrefs(page)).toEqual([`/doc/${open.slug}`, `/diff/${P}/${open.id}`, `/diff/${P}@${point}/${P}`, `/diff/${open.id}@${openFirst}/${open.id}`]);
      await expect(family(page)).not.toContainText("more");

      // The SHARED fork, as someone who edits both docs.
      await page.goto(`/doc/${open.slug}`);
      await expect(family(page).locator('[data-kind="forked-from"]')).toContainText(`Forked from: ${parent.title}`);
      expect(await familyHrefs(page)).toEqual([`/doc/${parent.slug}`, `/diff/${P}/${open.id}`, `/diff/${P}@${point}/${P}`, `/diff/${open.id}@${openFirst}/${open.id}`]);

      // The parent, as an AUTHOR who edits neither it nor the SHARED fork:
      // both forks, newest first. Their own carries its history's two diffs,
      // the parent's by the fork-point exception; the other only how the two
      // docs differ now.
      await otherPage.goto(`/doc/${parent.slug}`);
      expect(await familyHrefs(otherPage)).toEqual([
        `/doc/${hidden.slug}`,
        `/diff/${P}/${hidden.id}`,
        `/diff/${P}@${point}/${P}`,
        `/diff/${hidden.id}@${hiddenFirst}/${hidden.id}`,
        `/doc/${open.slug}`,
        `/diff/${P}/${open.id}`,
      ]);
      // Their own fork, from its side.
      await otherPage.goto(`/doc/${hidden.slug}`);
      expect(await familyHrefs(otherPage)).toEqual([
        `/doc/${parent.slug}`,
        `/diff/${P}/${hidden.id}`,
        `/diff/${P}@${point}/${P}`,
        `/diff/${hidden.id}@${hiddenFirst}/${hidden.id}`,
      ]);

      // A reader with no doc's history: the docs, and how they differ now.
      await readerPage.goto(`/doc/${open.slug}`);
      expect(await familyHrefs(readerPage)).toEqual([`/doc/${parent.slug}`, `/diff/${P}/${open.id}`]);
      await readerPage.goto(`/doc/${parent.slug}`);
      expect(await familyHrefs(readerPage)).toEqual([`/doc/${open.slug}`, `/diff/${P}/${open.id}`]);
    } finally {
      await otherPage.goto("about:blank").catch(() => {});
      await readerPage.goto("about:blank").catch(() => {});
      for (const id of made) await deleteTestDoc(id);
    }
  });

  test("a parent the viewer can't read is held back but still said, and what the fork changed is still served", async ({ page, secondUser }) => {
    const { user: owner } = await secondUser({ role: "AUTHOR" });
    const privateParent = await createTestDoc({ authorEmail: owner.email, visibility: "PRIVATE", bodyText: "Not for everyone." });
    const goneParent = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Soon deleted." });
    const made: string[] = [];
    try {
      // A SHARED fork of a PRIVATE doc, which only its byline can make.
      const ofPrivate = await mustFork({ actorEmail: owner.email, parentId: privateParent.id, visibility: "SHARED" });
      made.push(ofPrivate.id);
      const ofGone = await mustFork({ actorEmail: ADMIN_EMAIL, parentId: goneParent.id, visibility: "SHARED" });
      made.push(ofGone.id);
      await softDeleteTestDoc(goneParent.id);

      for (const fork of [ofPrivate, ofGone]) {
        const [first] = await getDocYdocUpdateIds(fork.id);
        await page.goto(`/doc/${fork.slug}`);
        await expect(family(page).locator('[data-kind="forked-from"]')).toContainText("Forked from: a doc you can't read");
        // No link to the parent. The one diff is read off the fork alone, so it stays.
        expect(await familyHrefs(page)).toEqual([`/diff/${fork.id}@${first}/${fork.id}`]);
        await family(page).getByRole("link", { name: "fork", exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/diff/${fork.id}@${first}/${fork.id}$`));
        const island = await done(page);
        await expect(island.locator('[data-kind="no-differences"]')).toBeVisible();
      }
      // And the pair with the parent is refused as any unreadable or deleted side is.
      expect((await page.goto(`/diff/${goneParent.id}/${ofGone.id}`))?.status()).toBe(404);
      await page.goto(`/diff/${privateParent.id}/${ofPrivate.id}`);
      await expect(page.getByRole("heading", { name: "Forbidden" })).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      for (const id of made) await deleteTestDoc(id);
      await deleteTestDoc(privateParent.id);
      await deleteTestDoc(goneParent.id);
    }
  });
});

test.describe("the fork-point exception (docs/FORKS.md \"Who may see a doc's history\")", () => {
  test("a fork's editor who can't edit its parent sees what the parent changed since, no other version of it, and not once the fork is deleted", async ({
    sharedDoc,
    draftDoc,
    secondUser,
  }) => {
    const { user: forker, page } = await secondUser({ role: "AUTHOR" });
    const parent = sharedDoc;
    const [first] = await getDocYdocUpdateIds(parent.id);
    const [foreign] = await getDocYdocUpdateIds(draftDoc.id);
    const point = await appendTestDocParagraph({ docId: parent.id, text: FIRST });
    const fork = await mustFork({ actorEmail: forker.email, parentId: parent.id, visibility: "PRIVATE" });
    try {
      expect(await getTestForkFacts(fork.id)).toMatchObject({ forkedFromUpdateId: point });
      // The parent's author goes on writing.
      await appendTestDocParagraph({ docId: parent.id, text: SECOND });
      const forbidden = page.getByRole("heading", { name: "Forbidden" });

      // The parent at the fork point is the fork's first state, which its editor already holds.
      await gotoOk(page, `/diff/${parent.id}@${point}/${parent.id}`);
      const island = await done(page);
      await expect(island.locator('[data-kind="added"] [data-side="new"]')).toHaveText(SECOND);
      await expect(island.locator('[data-kind="deleted"], [data-kind="changed"]')).toHaveCount(0);
      // The header links to the parent as it is now: its reading view honours ?at= for its editors alone.
      await expect(page.locator("main").getByRole("link", { name: parent.title }).first()).toHaveAttribute("href", `/doc/${parent.slug}`);

      // Any other version of the parent stays its editors', whatever the id.
      for (const version of [first, foreign, MAX_UPDATE_ID]) {
        expect((await page.goto(`/diff/${parent.id}@${version}/${parent.id}`))?.status()).toBe(200);
        await expect(forbidden).toBeVisible();
        await expect(page.locator("[data-state]")).toHaveCount(0);
      }
      // The exception is for diffs alone: not the parent's replay, nor forking it at a version.
      expect((await page.request.get(`/api/doc/${parent.id}/replay`)).status()).toBe(403);
      expect(await forkDocAs({ actorEmail: forker.email, parentId: parent.id, revision: point })).toMatchObject({ ok: false, code: "forbidden" });

      // A deleted fork gives nothing.
      await softDeleteTestDoc(fork.id, forker.email);
      expect((await page.goto(`/diff/${parent.id}@${point}/${parent.id}`))?.status()).toBe(200);
      await expect(forbidden).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      await deleteTestDoc(fork.id);
    }
  });

  test("the empty paragraph the editor appends to a fork that ends in a heading isn't what the fork changed", async ({ page }) => {
    const parent = await createTestDoc({
      authorEmail: ADMIN_EMAIL,
      visibility: "SHARED",
      body: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: QUOTED_BODY }] },
          { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "A heading the doc ends on" }] },
        ],
      },
    });
    let forkId: string | null = null;
    try {
      const fork = await mustFork({ actorEmail: ADMIN_EMAIL, parentId: parent.id, visibility: "SHARED" });
      forkId = fork.id;
      const [first] = await getDocYdocUpdateIds(fork.id);
      // StarterKit's TrailingNode appends the paragraph when the editor opens
      // the fork, as an update of its own, credited to whoever opened it.
      await page.goto(fork.path);
      await waitForDocCollabReady(page);
      await expect.poll(() => countDocYdocUpdates(fork.id), { timeout: 15_000 }).toBeGreaterThan(1);
      await page.goto("about:blank");

      await gotoOk(page, `/diff/${fork.id}@${first}/${fork.id}`);
      const island = await done(page);
      await expect(island.locator('[data-kind="no-differences"]')).toBeVisible();
    } finally {
      await page.goto("about:blank").catch(() => {});
      if (forkId) await deleteTestDoc(forkId);
      await deleteTestDoc(parent.id);
    }
  });
});
