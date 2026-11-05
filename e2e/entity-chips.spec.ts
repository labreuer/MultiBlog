import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { JSONContent } from "@tiptap/core";
import type { Locator } from "@playwright/test";
import { test, expect, annotationEditor, bodyEditor, openDashboardCard, selectChipInBody, waitForDocCollabReady } from "./fixtures";
import {
  ADMIN_EMAIL,
  annotationSearchHolds,
  createTestDoc,
  createTestPost,
  deleteTestDoc,
  deleteTestPost,
  getAnnotationStates,
  getDocChipIids,
  getDocSearchText,
  getDocState,
  getMentionSources,
  getPostContentText,
  getUserIdByEmail,
  restoreTestUser,
  setAnchorChipLabels,
  softDeleteTestUser,
} from "./db";

// Entity chips (docs/ENTITY_CHIPS.md): an inline node that holds only which
// person it stands for, its label computed wherever it is shown. Nothing in
// the first three tests seed a doc with the node and check what every surface
// then draws; the last two type "@", in the doc editor and in a note.

const mention = (iid: string, userId: string): JSONContent => ({
  type: "entityChip",
  attrs: { kind: "mention", iid, data: { userId } },
});
const text = (value: string): JSONContent => ({ type: "text", text: value });
const bodyOf = (...content: JSONContent[]): JSONContent => ({ type: "doc", content: [{ type: "paragraph", content }] });

async function adminId(): Promise<string> {
  const id = await getUserIdByEmail(ADMIN_EMAIL);
  if (!id) throw new Error("The e2e admin doesn't exist.");
  return id;
}

test("a mention shows its computed label in the static body, the live reading view and the editor", async ({ page, secondUser }) => {
  const { user: author } = await secondUser({ role: "AUTHOR" });
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    body: bodyOf(text("Ask "), mention("i1", await adminId()), text(" and "), mention("i2", author.id), text(".")),
  });
  try {
    await page.goto(`/doc/${doc.slug}`);
    // The static body first, then the live editor that replaces it: one
    // visible copy at a time, and the same labels in both.
    const chips = page.locator("a.entity-chip").filter({ visible: true });
    await expect(chips).toHaveText(["@E2E Admin", `@${author.name}`]);
    await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    await expect(bodyEditor(page).locator("a.entity-chip")).toHaveText(["@E2E Admin", `@${author.name}`]);
    await expect(bodyEditor(page).locator("a.entity-chip").nth(1)).toHaveAttribute("href", `/authors/${author.slug}`);
    await expect(bodyEditor(page)).toContainText(`Ask @E2E Admin and @${author.name}.`);

    // The editor: the same labels, fetched for this doc, on spans rather than links.
    await page.goto(`/doc/${doc.id}/edit`);
    await waitForDocCollabReady(page);
    const editorChips = bodyEditor(page).locator("span.entity-chip");
    await expect(editorChips).toHaveText(["@E2E Admin", `@${author.name}`]);

    // A chip is one character to the caret. The doc is "Ask ", chip, " and ",
    // chip, ".": positions 1 to 13, the second chip between 11 and 12. Each
    // key is followed by a wait for the editor's own selection, which trails
    // the DOM's by a `selectionchange`.
    const caret = () =>
      page.evaluate(
        () => (document.querySelectorAll(".tiptap")[1] as unknown as { editor: { state: { selection: { from: number } } } }).editor.state.selection.from,
      );
    await bodyEditor(page).click();
    await page.keyboard.press("Control+End");
    await expect.poll(caret).toBe(13);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(caret).toBe(12);
    // One press steps over the whole chip, each way.
    await page.keyboard.press("ArrowLeft");
    await expect.poll(caret).toBe(11);
    await page.keyboard.press("ArrowRight");
    await expect.poll(caret).toBe(12);
    // And one Backspace removes it whole, leaving the first untouched.
    await page.keyboard.press("Backspace");
    await expect(editorChips).toHaveText(["@E2E Admin"]);
    await expect(bodyEditor(page)).toContainText("Ask @E2E Admin and .");
  } finally {
    await page.goto("about:blank");
    await deleteTestDoc(doc.id);
  }
});

test("a deleted account's mention is struck through and unlinked, and restoring the account clears that", async ({
  page,
  secondUser,
}) => {
  const { user: author } = await secondUser({ role: "AUTHOR" });
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    body: bodyOf(text("Thanks to "), mention("i1", author.id), text(" and "), mention("i2", "no-such-user"), text(".")),
  });
  try {
    await softDeleteTestUser(author.email, ADMIN_EMAIL);
    await page.goto(`/doc/${doc.slug}`);
    const chips = page.locator(".entity-chip").filter({ visible: true });
    await expect(chips).toHaveText([`@${author.name}`, "unknown person"]);
    await expect(chips.nth(0)).toHaveAttribute("data-status", "deleted");
    await expect(chips.nth(0)).not.toHaveAttribute("href");
    await expect(chips.nth(1)).toHaveAttribute("data-status", "unknown");

    // Nothing about the deletion was stored in the doc, so nothing has to be undone in it.
    await restoreTestUser(author.email);
    await page.reload();
    await expect(chips.nth(0)).toHaveAttribute("data-status", "live");
    await expect(chips.nth(0)).toHaveAttribute("href", `/authors/${author.slug}`);
  } finally {
    await page.goto("about:blank");
    await deleteTestDoc(doc.id);
  }
});

test("publishing turns each chip into its label as linked text, and the post page renders", async ({ page }) => {
  const post = await createTestPost({
    authorEmail: ADMIN_EMAIL,
    publish: true,
    body: bodyOf(text("Written with "), mention("i1", await adminId()), text(", not "), mention("i2", "no-such-user"), text(".")),
  });
  try {
    expect(await getPostContentText(post.id)).toBe("Written with @E2E Admin, not unknown person.");
    // The post is indexed as mentioning the person, from its link's `chip`
    // attribute; the id that names nobody has no row. Other tests mention
    // the shared admin too, so this looks for the post among them.
    expect(await getMentionSources(await adminId())).toContain(`post:${post.id}`);
    expect(await getMentionSources("no-such-user")).toEqual([]);

    // The post-side schema has no chip node and its renderer throws on one,
    // so the page answering at all is the conversion having run.
    const response = await page.goto(post.path!);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("link", { name: "@E2E Admin", exact: true }).filter({ visible: true })).toHaveAttribute(
      "href",
      "/authors/e2e-admin",
    );
    // A target that resolves to nothing is struck through, as in the doc.
    await expect(page.locator("s", { hasText: "unknown person" }).filter({ visible: true })).toBeVisible();
  } finally {
    await page.goto("about:blank");
    await deleteTestPost(post.id);
  }
});

test("typing @ lists who may be mentioned, and picking one inserts a chip that is labelled as it lands", async ({
  page,
  draftDoc,
  secondUser,
}) => {
  const { user: author } = await secondUser({ role: "AUTHOR" });
  const { user: reader } = await secondUser({ role: "AUTHORIZED" });

  await page.goto(`/doc/${draftDoc.id}/edit`);
  await waitForDocCollabReady(page);
  await bodyEditor(page).click();

  // An "@" inside a word is an email address, not a mention.
  await page.keyboard.type("Write to someone@example.com, or ask ");
  const menu = page.getByRole("listbox", { name: "People" });
  await expect(menu).toHaveCount(0);

  // After a space it opens the menu, filtered as the name is typed. The doc
  // is PRIVATE and this author isn't on its byline, and the row says so.
  // Only the name's last word, which is the unique part of a fixture's name:
  // the whole of it is longer than anything the menu takes for a name.
  await page.keyboard.type(`@${author.name.split(" ").at(-1)}`);
  const row = menu.getByRole("option", { name: author.name });
  await expect(row).toBeVisible();
  await expect(row).toContainText("can't read this doc");
  await page.keyboard.press("Enter");

  const chips = bodyEditor(page).locator("span.entity-chip");
  await expect(chips).toHaveText([`@${author.name}`]);
  await expect(chips).toHaveAttribute("data-status", "live");
  await expect(menu).toHaveCount(0);
  // The query is gone, replaced by the chip and a space to go on typing after.
  await page.keyboard.type("today.");
  await expect(bodyEditor(page)).toContainText(`ask @${author.name} today.`);

  // Someone below AUTHOR isn't offered, whatever is typed.
  await page.keyboard.type(` @${reader.name.split(" ").at(-1)}`);
  await expect(menu).toHaveCount(0);

  // What was stored is the person, so a fresh load labels the chip from the server.
  await page.reload();
  await waitForDocCollabReady(page);
  await expect(bodyEditor(page).locator("span.entity-chip")).toHaveText([`@${author.name}`]);

  // The doc's cache carries the label beside the person, which is what
  // full-text search reads: the doc is found by the name of someone it
  // mentions, though its text never held that name.
  await expect.poll(() => getDocSearchText(draftDoc.id), { timeout: 15_000 }).toContain(`ask @${author.name} today.`);
  // And the mention index has the doc, written by the same store.
  expect(await getMentionSources(author.id)).toEqual([`doc:${draftDoc.id}`]);
  await page.goto(`/search?q=${encodeURIComponent(author.name)}`);
  await expect(page.getByRole("link", { name: draftDoc.title }).first()).toBeVisible();
});

test("a mention typed into a note is labelled in the composer, on the posted card and in its edit session", async ({
  page,
  sharedDoc,
  secondUser,
}) => {
  const { user: author } = await secondUser({ role: "AUTHOR" });
  const { page: readerPage } = await secondUser({ role: "AUTHORIZED" });
  const lastName = author.name.split(" ").at(-1);

  await page.goto(`/doc/${sharedDoc.slug}`);
  await page.getByRole("button", { name: "Write an annotation..." }).click();
  const composer = annotationEditor(page);
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await composer.click();

  // The same menu as the doc editor's, listing for the note's own doc.
  await page.keyboard.type(`Ask @${lastName}`);
  const menu = page.getByRole("listbox", { name: "People" });
  await expect(menu.getByRole("option", { name: author.name })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(composer.locator("span.entity-chip")).toHaveText([`@${author.name}`]);
  await page.keyboard.type("about this.");
  // A draft is a private note, however long it sits: its text reaches the
  // cache as it is typed, and it mentions nobody until it is posted.
  await expect
    .poll(async () => (await getAnnotationStates(sharedDoc.id)).map((annotation) => annotation.bodyText), { timeout: 15_000 })
    .toEqual([`Ask @${author.name} about this.`]);
  expect(await getMentionSources(author.id)).toEqual([]);
  await page.getByRole("button", { name: "Post annotation" }).click();
  await expect(composer).toHaveCount(0);
  const [{ id: noteId }] = await getAnnotationStates(sharedDoc.id);
  await expect.poll(() => getMentionSources(author.id)).toEqual([`annotation:${noteId}`]);

  // The posted card: a link to the person, in whichever copy of the body is
  // showing (the server's, then the read-only editor over it). The doc's own
  // body holds no chip, so these are the note's.
  const posted = page.locator("[data-comment-id]").filter({ hasText: "about this." });
  const cardChip = posted.locator("a.entity-chip").filter({ visible: true });
  await expect(cardChip).toHaveText([`@${author.name}`]);
  await expect(cardChip).toHaveAttribute("href", `/authors/${author.slug}`);
  await expect(posted).toContainText(`Ask @${author.name} about this.`);
  // And as stored text, which the RAISED email, /annotations and search read:
  // the label is in it, where a chip would otherwise leave a gap.
  await expect
    .poll(async () => (await getAnnotationStates(sharedDoc.id)).map((annotation) => annotation.bodyText))
    .toEqual([`Ask @${author.name} about this.`]);

  // A collapsed card's one-line excerpt is text too.
  await posted.getByRole("button", { name: "Collapse annotation" }).click();
  await expect(posted).toContainText(`Ask @${author.name} about this.`);
  await expect(posted.locator("a.entity-chip")).toHaveCount(0);
  await posted.getByRole("button", { name: "Expand annotation" }).click();

  // A fresh load labels it from the server, for a reader as for its writer.
  await page.reload();
  await expect(cardChip).toHaveText([`@${author.name}`]);
  await readerPage.goto(`/doc/${sharedDoc.slug}`);
  const readerCard = readerPage.locator("[data-comment-id]").filter({ hasText: "about this." });
  await expect(readerCard.locator("a.entity-chip").filter({ visible: true })).toHaveText([`@${author.name}`]);

  // The edit session shows the same label, and so does the card after it.
  await posted.getByRole("button", { name: "Edit", exact: true }).click();
  const session = annotationEditor(page);
  await expect(session.locator("span.entity-chip")).toHaveText([`@${author.name}`]);
  await posted.getByRole("button", { name: "Cancel" }).click();
  await expect(session).toHaveCount(0);
  await expect(cardChip).toHaveText([`@${author.name}`]);

  // Below AUTHOR nobody is listed, so a reader's own note opens no menu.
  await readerPage.getByRole("button", { name: "Write an annotation..." }).click();
  const readerComposer = annotationEditor(readerPage);
  await expect(readerComposer).toBeVisible({ timeout: 15_000 });
  await readerComposer.click();
  await readerPage.keyboard.type(`Ask @${lastName}`);
  await expect(readerComposer).toContainText(`Ask @${lastName}`);
  await expect(readerPage.getByRole("listbox", { name: "People" })).toHaveCount(0);
});

test("a rename reaches a doc nobody has open, and a note's stored text, without touching either's date", async ({
  page,
  sharedDoc,
  secondUser,
}) => {
  const { user: author, page: authorPage } = await secondUser({ role: "AUTHOR" });
  const lastName = author.name.split(" ").at(-1);
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    body: bodyOf(text("Reviewed by "), mention("i1", author.id), text(".")),
  });
  try {
    // A note that mentions them too, posted the ordinary way.
    await page.goto(`/doc/${sharedDoc.slug}`);
    await page.getByRole("button", { name: "Write an annotation..." }).click();
    const composer = annotationEditor(page);
    await expect(composer).toBeVisible({ timeout: 15_000 });
    await composer.click();
    await page.keyboard.type(`Thanks @${lastName}`);
    await expect(page.getByRole("listbox", { name: "People" }).getByRole("option", { name: author.name })).toBeVisible();
    await page.keyboard.press("Enter");
    await page.keyboard.type("for this.");
    await page.getByRole("button", { name: "Post annotation" }).click();
    await expect(composer).toHaveCount(0);
    const noteText = async () => (await getAnnotationStates(sharedDoc.id)).map((annotation) => annotation.bodyText);
    await expect.poll(noteText).toEqual([`Thanks @${author.name} for this.`]);

    expect(await getDocSearchText(doc.id)).toBe(`Reviewed by @${author.name}.`);
    const before = await getDocState(doc.id);

    // The person renames themselves. Nobody opens the doc or the note.
    const renamed = `Renamed ${lastName}`;
    await authorPage.goto("/dashboard");
    await openDashboardCard(authorPage, "Settings");
    await authorPage.getByLabel("Name").fill(renamed);
    await authorPage.getByRole("button", { name: "Save" }).click();
    await expect(authorPage.getByText("Saved.")).toBeVisible();

    // Both stored texts follow, which is what search and the RAISED email read.
    await expect.poll(() => getDocSearchText(doc.id), { timeout: 15_000 }).toBe(`Reviewed by @${renamed}.`);
    await expect.poll(noteText, { timeout: 15_000 }).toEqual([`Thanks @${renamed} for this.`]);
    await page.goto(`/search?q=${encodeURIComponent(renamed)}`);
    await expect(page.getByRole("link", { name: doc.title }).first()).toBeVisible();

    // A rename is not an edit: the doc's date and its last editor are where they were.
    const after = await getDocState(doc.id);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.updatedByEmail).toBe(before?.updatedByEmail);

    // The surfaces that compute labels never held the old one.
    await page.goto(`/doc/${doc.slug}`);
    await expect(page.locator("a.entity-chip").filter({ visible: true })).toHaveText([`@${renamed}`]);
  } finally {
    await page.goto("about:blank");
    await deleteTestDoc(doc.id);
  }
});

/**
 * `chip`, if annotation `id`'s highlight covers it. The highlight is a
 * decoration, which ProseMirror puts on the chip's own element or on a
 * wrapper around it, so either counts.
 */
const paintedBy = (chip: Locator, id: string) =>
  chip.locator(`xpath=ancestor-or-self::*[contains(concat(" ", @data-annotation-ids, " "), " ${id} ")]`);

// docs/ENTITY_CHIPS.md, step 1, item 11 — anchors. A stored quote holds
// U+FFFC where a chip is; the anchor's chip record says which chip, so the
// quote can be shown with its label, the passage is re-found by who it names,
// and one chip can be annotated by itself.
test("a reading-view note on a passage with a mention keeps its chip's record, shows its label, and follows a rename", async ({
  page,
  secondUser,
}) => {
  const { user: author, page: authorPage } = await secondUser({ role: "AUTHOR" });
  const lastName = author.name.split(" ").at(-1);
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    body: bodyOf(text("The engine was reviewed by "), mention("m1", author.id), text(" last week, and by "), mention("m2", author.id), text(" again.")),
  });
  const CHIP = "￼";
  try {
    await page.goto(`/doc/${doc.slug}`);
    await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    await expect(bodyEditor(page).locator("a.entity-chip")).toHaveText([`@${author.name}`, `@${author.name}`]);

    // "reviewed by <mention>": text, then a chip at the passage's end.
    await selectChipInBody(page, { chip: 0, from: "reviewed by " });
    const popup = page.getByTestId("annotation-popup");
    await popup.getByRole("button", { name: "Annotate" }).click();
    // What the writer is shown is the label, never the placeholder a quote stores.
    await expect(popup).toContainText(`Annotating: “reviewed by @${author.name}”`);
    await annotationEditor(page).click();
    await page.keyboard.type("Which review was this?");
    await popup.getByRole("button", { name: "Post annotation" }).click();

    const note = async () => (await getAnnotationStates(doc.id)).find((a) => a.bodyText === "Which review was this?");
    await expect.poll(async () => (await note())?.status, { timeout: 15_000 }).toBe("LIVE");
    expect(await note()).toMatchObject({
      marked: false,
      quotedText: `reviewed by ${CHIP}`,
      quoteMatchesAtStamp: true,
      anchorChips: [{ at: 12, kind: "mention", iid: "m1", data: { userId: author.id }, label: `@${author.name}` }],
    });
    const noteId = (await note())!.id;

    // The card's quote, the highlight over text and chip together, and the stored quote where no ydoc is open.
    const card = page.locator(`[data-thread-id="${noteId}"]`).filter({ visible: true });
    await expect(card).toContainText(`reviewed by @${author.name}`);
    const chips = bodyEditor(page).locator(".entity-chip");
    await expect(paintedBy(chips.first(), noteId)).toHaveCount(1);
    await expect(paintedBy(chips.nth(1), noteId)).toHaveCount(0);
    await page.goto("/annotations");
    await expect(page.getByText(`reviewed by @${author.name}`).first()).toBeVisible();
    // And the note is found by the name in its passage, which its own words don't hold.
    expect(await annotationSearchHolds(noteId, lastName!)).toBe(true);

    // The second mention, alone: a passage with no words, anchored by its instance.
    await page.goto(`/doc/${doc.slug}`);
    await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    await selectChipInBody(page, { chip: 1 });
    await popup.getByRole("button", { name: "Annotate" }).click();
    await expect(popup).toContainText(`Annotating: “@${author.name}”`);
    await annotationEditor(page).click();
    await page.keyboard.type("This one, specifically.");
    await popup.getByRole("button", { name: "Post annotation" }).click();
    const lone = async () => (await getAnnotationStates(doc.id)).find((a) => a.bodyText === "This one, specifically.");
    await expect.poll(async () => (await lone())?.status, { timeout: 15_000 }).toBe("LIVE");
    expect(await lone()).toMatchObject({
      quotedText: CHIP,
      quoteMatchesAtStamp: true,
      anchorChips: [{ at: 0, kind: "mention", iid: "m2", data: { userId: author.id } }],
    });
    const loneId = (await lone())!.id;
    // Its highlight is on the second mention and not the first, which reads exactly the same.
    await expect(paintedBy(chips.nth(1), loneId)).toHaveCount(1);
    await expect(paintedBy(chips.first(), loneId)).toHaveCount(0);

    // The person renames themselves: no anchor moves, and each record's label follows.
    const renamed = `Renamed ${lastName}`;
    await authorPage.goto("/dashboard");
    await openDashboardCard(authorPage, "Settings");
    await authorPage.getByLabel("Name").fill(renamed);
    await authorPage.getByRole("button", { name: "Save" }).click();
    await expect(authorPage.getByText("Saved.")).toBeVisible();
    await expect
      .poll(async () => ((await note())?.anchorChips as { label: string }[] | null)?.[0]?.label, { timeout: 15_000 })
      .toBe(`@${renamed}`);
    expect(await note()).toMatchObject({ quotedText: `reviewed by ${CHIP}`, quoteMatchesAtStamp: true });
    await page.goto("/annotations");
    await expect(page.getByText(`reviewed by @${renamed}`).first()).toBeVisible();
    await page.goto(`/doc/${doc.slug}`);
    await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    await expect(page.locator(`[data-thread-id="${noteId}"]`).filter({ visible: true })).toContainText(`reviewed by @${renamed}`);
    await expect(chips).toHaveText([`@${renamed}`, `@${renamed}`]);
    await expect(paintedBy(chips.first(), noteId)).toHaveCount(1);
    await expect(paintedBy(chips.nth(1), loneId)).toHaveCount(1);
  } finally {
    await page.goto("about:blank");
    await deleteTestDoc(doc.id);
  }
});

test("a note whose mention has since left the doc still follows a rename, by what its record names", async ({ page, secondUser }) => {
  const { user: author, page: authorPage } = await secondUser({ role: "AUTHOR" });
  const lastName = author.name.split(" ").at(-1);
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    body: bodyOf(text("The engine was reviewed by "), mention("m1", author.id), text(" last week.")),
  });
  try {
    await page.goto(`/doc/${doc.slug}`);
    await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    await selectChipInBody(page, { chip: 0, from: "reviewed by " });
    const popup = page.getByTestId("annotation-popup");
    await popup.getByRole("button", { name: "Annotate" }).click();
    await annotationEditor(page).click();
    await page.keyboard.type("Which review was this?");
    await popup.getByRole("button", { name: "Post annotation" }).click();
    const note = async () => (await getAnnotationStates(doc.id)).find((a) => a.bodyText === "Which review was this?");
    await expect.poll(async () => (await note())?.status, { timeout: 15_000 }).toBe("LIVE");
    const label = async () => ((await note())?.anchorChips as { label: string }[] | null)?.[0]?.label;
    expect(await label()).toBe(`@${author.name}`);

    // The passage is rewritten and the mention goes with it. The note stays, detached.
    await page.goto(`/doc/${doc.slug}/edit`);
    await waitForDocCollabReady(page);
    await bodyEditor(page).click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Nothing was reviewed.");
    await expect.poll(() => getDocSearchText(doc.id), { timeout: 20_000 }).toBe("Nothing was reviewed.");
    // The doc no longer mentions them, so the index has nothing to lead a refresh here.
    await expect.poll(async () => (await getMentionSources(author.id)).filter((source) => source.includes(doc.id))).toEqual([]);
    expect(await label()).toBe(`@${author.name}`);

    const renamed = `Renamed ${lastName}`;
    await authorPage.goto("/dashboard");
    await openDashboardCard(authorPage, "Settings");
    await authorPage.getByLabel("Name").fill(renamed);
    await authorPage.getByRole("button", { name: "Save" }).click();
    await expect(authorPage.getByText("Saved.")).toBeVisible();

    // The record names them still, and is relabelled from that alone.
    await expect.poll(label, { timeout: 15_000 }).toBe(`@${renamed}`);
    await page.goto("/annotations");
    await expect(page.getByText(`reviewed by @${renamed}`).first()).toBeVisible();
  } finally {
    await page.goto("about:blank");
    await deleteTestDoc(doc.id);
  }
});

test("a card's quote is labelled by the body beside it, and a record left behind is something the integrity check reports", async ({
  page,
  secondUser,
}) => {
  const { user: author } = await secondUser({ role: "AUTHOR" });
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    body: bodyOf(text("The engine was reviewed by "), mention("m1", author.id), text(" last week.")),
  });
  const check = async () => {
    const { stdout } = await promisify(execFile)("npx", ["tsx", "scripts/integrity/check-annotation-anchors.ts", `--doc=${doc.id}`]);
    return stdout;
  };
  try {
    await page.goto(`/doc/${doc.slug}`);
    await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    await selectChipInBody(page, { chip: 0, from: "reviewed by " });
    const popup = page.getByTestId("annotation-popup");
    await popup.getByRole("button", { name: "Annotate" }).click();
    await annotationEditor(page).click();
    await page.keyboard.type("Which review was this?");
    await popup.getByRole("button", { name: "Post annotation" }).click();
    const note = async () => (await getAnnotationStates(doc.id)).find((a) => a.bodyText === "Which review was this?");
    await expect.poll(async () => (await note())?.status, { timeout: 15_000 }).toBe("LIVE");
    const noteId = (await note())!.id;
    expect(await check()).toContain("0 error(s), 0 warning(s)");

    // What a rename leaves until its refresh has run: the record holds the name as it was.
    await setAnchorChipLabels(noteId, "@Someone Before");
    await page.goto("/annotations");
    await expect(page.getByText("reviewed by @Someone Before").first()).toBeVisible();
    // The stale record is reported, by the chip it belongs to.
    const report = await check();
    expect(report).toContain("record-labels");
    expect(report).toContain(`m1 reads "@Someone Before" but its chip is "@${author.name}"`);

    // Beside the doc itself, the card says what the passage says.
    await page.goto(`/doc/${doc.slug}`);
    await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    const card = page.locator(`[data-thread-id="${noteId}"]`).filter({ visible: true });
    await expect(card).toContainText(`reviewed by @${author.name}`);
    await expect(card).not.toContainText("Someone Before");
  } finally {
    await page.goto("about:blank");
    await deleteTestDoc(doc.id);
  }
});

test("the doc editor annotates one mention by itself, though no mark can sit on it", async ({ page, secondUser }) => {
  const { user: author } = await secondUser({ role: "AUTHOR" });
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    body: bodyOf(text("Ask "), mention("m1", author.id), text(" or "), mention("m2", author.id), text(" about it.")),
  });
  try {
    await page.goto(`/doc/${doc.id}/edit`);
    await waitForDocCollabReady(page);
    await expect(bodyEditor(page).locator("span.entity-chip")).toHaveText([`@${author.name}`, `@${author.name}`]);

    await selectChipInBody(page, { chip: 1 });
    await page.getByTestId("annotate-marker").click();
    const popup = page.getByTestId("annotation-popup");
    await expect(popup).toContainText(`Annotating: “@${author.name}”`);
    await annotationEditor(page).click();
    await page.keyboard.type("The second of the two.");
    await popup.getByRole("button", { name: "Post annotation" }).click();

    // One mechanism still: no offsets and no quote, as for any editor annotation.
    // The record of its chip is the whole anchor.
    const note = async () => (await getAnnotationStates(doc.id)).find((a) => a.bodyText === "The second of the two.");
    await expect.poll(async () => (await note())?.status, { timeout: 15_000 }).toBe("LIVE");
    await expect
      .poll(async () => (await note())?.anchorChips, { timeout: 15_000 })
      .toMatchObject([{ at: 0, kind: "mention", iid: "m2", data: { userId: author.id }, label: `@${author.name}` }]);
    expect(await note()).toMatchObject({ marked: false, anchorFrom: null, quotedText: "" });
    const noteId = (await note())!.id;

    // The card says which passage, and the chip is painted: the second, not the first.
    const chips = bodyEditor(page).locator(".entity-chip");
    await expect(paintedBy(chips.nth(1), noteId)).toHaveCount(1);
    await expect(paintedBy(chips.first(), noteId)).toHaveCount(0);
    await expect(page.locator(`[data-thread-id="${noteId}"]`).filter({ visible: true })).toContainText(`@${author.name}`);

    // The reading view finds it the same way.
    await page.goto(`/doc/${doc.slug}`);
    await expect(page.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    await expect(paintedBy(chips.nth(1), noteId)).toHaveCount(1);
    await expect(page.locator(`[data-thread-id="${noteId}"]`).filter({ visible: true })).toContainText(`@${author.name}`);

    // Deleting the chip leaves the note with no passage, as a lost mark does.
    await page.goto(`/doc/${doc.id}/edit`);
    await waitForDocCollabReady(page);
    await selectChipInBody(page, { chip: 1 });
    await page.keyboard.press("Backspace");
    await expect(bodyEditor(page).locator("span.entity-chip")).toHaveCount(1);
    await expect(page.locator(`[data-annotation-ids~="${noteId}"]`)).toHaveCount(0);
  } finally {
    await page.goto("about:blank");
    await deleteTestDoc(doc.id);
  }
});

// docs/MENTIONS.md, "Search" and "The dashboard" — finding what mentions a
// person: by identity, through the `mention` table, inside what the searcher
// may read.
test("what mentions a person is found by @handle in the search box and by mentions=me, and listed on their dashboard", async ({
  page,
  secondUser,
}) => {
  const { user: author, page: authorPage } = await secondUser({ role: "AUTHOR" });
  const word = `budgetword${Date.now()}`;
  const shared = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    body: bodyOf(text(`The ${word} was reviewed by `), mention("s1", author.id), text(".")),
  });
  // The admin's own, which the mentioned person can't read.
  const hidden = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "PRIVATE",
    body: bodyOf(text(`A private ${word} note about `), mention("p1", author.id), text(".")),
  });
  // The same word, and no mention of anyone.
  const plain = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: `Another ${word} altogether.` });
  const link = (on: typeof page, title: string) => on.getByRole("link", { name: title }).first();
  try {
    // A handle typed into the box is a filter, and the rest is the text searched for.
    await page.goto(`/search?q=${encodeURIComponent(`@${author.slug} ${word}`)}`);
    await expect(page.getByText(`Only what mentions @${author.slug}`)).toBeVisible();
    await expect(link(page, shared.title)).toBeVisible();
    await expect(link(page, hidden.title)).toBeVisible();
    await expect(link(page, plain.title)).toHaveCount(0);
    // Without the handle, the word alone finds all three.
    await page.goto(`/search?q=${word}`);
    await expect(link(page, plain.title)).toBeVisible();
    // A handle nobody has narrows to nothing, as a real person nobody mentioned would.
    await page.goto(`/search?q=${encodeURIComponent(`@no-such-handle-e2e ${word}`)}`);
    await expect(page.getByText("Only what mentions @no-such-handle-e2e")).toBeVisible();
    await expect(link(page, shared.title)).toHaveCount(0);

    // The person themselves: `me`, with no text, lists what mentions them, in what they can read.
    await authorPage.goto("/search?mentions=me");
    await expect(authorPage.getByRole("main").getByRole("searchbox", { name: "Search" })).toHaveValue("@me");
    await expect(authorPage.getByText("Only what mentions you")).toBeVisible();
    await expect(link(authorPage, shared.title)).toBeVisible();
    await expect(link(authorPage, hidden.title)).toHaveCount(0);

    // And their dashboard says so first, with the same rule.
    await authorPage.goto("/dashboard");
    const card = authorPage.locator("details").filter({ has: authorPage.getByRole("heading", { name: "Mentions of you" }) });
    await expect(card.getByRole("link", { name: shared.title })).toBeVisible();
    await expect(card.getByRole("link", { name: hidden.title })).toHaveCount(0);
    await card.getByRole("link", { name: "Mentions of you" }).click();
    await authorPage.waitForURL(/\/search\?mentions=me$/);
  } finally {
    await page.goto("about:blank");
    for (const doc of [shared, hidden, plain]) await deleteTestDoc(doc.id);
  }
});

// docs/ENTITY_CHIPS.md, step 1, item 3 — two chips sharing an instance id, a
// state no single tab makes but concurrent changes can leave. Every editor
// that receives it gives the later chip an id derived from its Yjs item, so
// two tabs repairing at once write the same value rather than one each.
test("two mentions left sharing an instance id are told apart again, the same way by every tab", async ({ page, context }) => {
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    body: bodyOf(text("Ask "), mention("dup", await adminId()), text(" or "), mention("dup", await adminId()), text(".")),
  });
  const other = await context.newPage();
  const iidsIn = (tab: typeof page) =>
    tab.evaluate(() => {
      const editor = (document.querySelectorAll(".tiptap")[1] as unknown as { editor: { getJSON(): JSONContent } }).editor;
      const found: string[] = [];
      const walk = (node: JSONContent) => {
        if (node.type === "entityChip") found.push(String(node.attrs?.iid));
        node.content?.forEach(walk);
      };
      walk(editor.getJSON());
      return found;
    });
  try {
    // Both at once, so each meets the shared id before hearing of the other's repair.
    await Promise.all([page.goto(`/doc/${doc.id}/edit`), other.goto(`/doc/${doc.id}/edit`)]);
    await Promise.all([waitForDocCollabReady(page), waitForDocCollabReady(other)]);

    const derived = expect.stringMatching(/^y[0-9a-z]+\.[0-9a-z]+$/);
    await expect.poll(() => iidsIn(page)).toEqual(["dup", derived]);
    await expect.poll(() => iidsIn(other)).toEqual(await iidsIn(page));
    // And it is what was stored: one value, not the last of several.
    await expect.poll(() => getDocChipIids(doc.id), { timeout: 15_000 }).toEqual(await iidsIn(page));
    await expect(bodyEditor(page).locator("span.entity-chip")).toHaveText(["@E2E Admin", "@E2E Admin"]);
  } finally {
    await other.close();
    await page.goto("about:blank");
    await deleteTestDoc(doc.id);
  }
});

// docs/ENTITY_CHIPS.md, "Styling" — a doc's choice of how its chips are
// shown lives in the doc's own ydoc, so it reaches every open view at once
// and the store relabels what search reads.
test("a doc's mention style is set in its settings, relabels every open view at once, and is what search then reads", async ({
  page,
  context,
  secondUser,
}) => {
  const { user: author } = await secondUser({ role: "AUTHOR" });
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    body: bodyOf(text("Ask "), mention("i1", author.id), text(" about it.")),
  });
  const reading = await context.newPage();
  try {
    await page.goto(`/doc/${doc.id}/edit`);
    await waitForDocCollabReady(page);
    await reading.goto(`/doc/${doc.slug}`);
    await expect(reading.getByTestId("live-doc-synced")).toBeAttached({ timeout: 15_000 });
    const inEditor = bodyEditor(page).locator(".entity-chip");
    const inReading = bodyEditor(reading).locator(".entity-chip");
    await expect(inEditor).toHaveText([`@${author.name}`]);
    await expect(inReading).toHaveText([`@${author.name}`]);

    await page.locator("[data-doc-settings] > summary").click();
    const select = page.getByRole("combobox", { name: "How mentions are shown" });
    await expect(select).toHaveValue("name");
    await select.selectOption("handle");

    // Here at once, and in the other tab with no reload: the style is in the doc.
    await expect(inEditor).toHaveText([`@${author.slug}`]);
    await expect(inReading).toHaveText([`@${author.slug}`]);
    // The store that follows relabels the cache, which search and every static render read.
    await expect.poll(() => getDocSearchText(doc.id), { timeout: 15_000 }).toBe(`Ask @${author.slug} about it.`);

    // A fresh load starts in that style: the first paint, and the editor once it has synced.
    await reading.goto(`/doc/${doc.slug}`);
    await expect(reading.locator("a.entity-chip").filter({ visible: true })).toHaveText([`@${author.slug}`]);
    await page.reload();
    await waitForDocCollabReady(page);
    await expect(inEditor).toHaveText([`@${author.slug}`]);
    await page.locator("[data-doc-settings] > summary").click();
    await expect(select).toHaveValue("handle");

    // Back to the default, which is stored as no choice at all.
    await select.selectOption("name-plain");
    await expect(inEditor).toHaveText([author.name]);
    await select.selectOption("name");
    await expect(inEditor).toHaveText([`@${author.name}`]);
    await expect.poll(() => getDocSearchText(doc.id), { timeout: 15_000 }).toBe(`Ask @${author.name} about it.`);
  } finally {
    await reading.close();
    await page.goto("about:blank");
    await deleteTestDoc(doc.id);
  }
});

// docs/ENTITY_CHIPS.md, "Styling" — a post can be published in a style of its
// own: the doc as its writers like to read it, the post as readers should.
test("a post is published in its own mention style, and changing the style alone is something to republish", async ({
  page,
  secondUser,
}) => {
  const { user: author } = await secondUser({ role: "AUTHOR" });
  const post = await createTestPost({
    authorEmail: ADMIN_EMAIL,
    publish: true,
    body: bodyOf(text("Written with "), mention("i1", author.id), text(".")),
  });
  try {
    expect(await getPostContentText(post.id)).toBe(`Written with @${author.name}.`);

    await page.goto(`/post/${post.id}/edit`);
    await expect(page.getByLabel("Scrub through the doc's edit history")).toBeVisible({ timeout: 15_000 });
    // Live at this version already, so there is nothing to republish yet.
    const republish = page.getByRole("button", { name: "Republish", exact: true });
    await expect(republish).toBeDisabled();

    await page.locator("summary", { hasText: /^Settings$/ }).click();
    const select = page.getByRole("combobox", { name: "How mentions are shown in the post" });
    await expect(select).toHaveValue("doc");
    await select.selectOption("handle");
    // The same version now publishes differently.
    await expect(republish).toBeEnabled();
    await republish.click();
    await expect(page.getByText("Published.")).toBeVisible();
    expect(await getPostContentText(post.id)).toBe(`Written with @${author.slug}.`);

    // The doc itself is as it was: the style is the post's.
    expect(await getDocSearchText(post.docId)).toBe(`Written with @${author.name}.`);
    const response = await page.goto(post.path!);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("link", { name: `@${author.slug}`, exact: true }).filter({ visible: true })).toBeVisible();
  } finally {
    await page.goto("about:blank");
    await deleteTestPost(post.id);
  }
});
