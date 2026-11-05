import type { JSONContent } from "@tiptap/core";
import { test, expect, annotationEditor, bodyEditor, waitForDocCollabReady } from "./fixtures";
import {
  ADMIN_EMAIL,
  createTestDoc,
  createTestPost,
  deleteTestDoc,
  deleteTestPost,
  getPostContentText,
  getUserIdByEmail,
  restoreTestUser,
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
  await page.getByRole("button", { name: "Post annotation" }).click();
  await expect(composer).toHaveCount(0);

  // The posted card: a link to the person, in whichever copy of the body is
  // showing (the server's, then the read-only editor over it). The doc's own
  // body holds no chip, so these are the note's.
  const posted = page.locator("[data-comment-id]").filter({ hasText: "about this." });
  const cardChip = posted.locator("a.entity-chip").filter({ visible: true });
  await expect(cardChip).toHaveText([`@${author.name}`]);
  await expect(cardChip).toHaveAttribute("href", `/authors/${author.slug}`);
  await expect(posted).toContainText(`Ask @${author.name} about this.`);

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
