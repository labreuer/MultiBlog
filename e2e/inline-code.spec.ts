import type { Page } from "@playwright/test";
import {
  test,
  expect,
  annotationEditor,
  bodyEditor,
  selectTextInBody,
  waitForDocCollabReady,
  freshGotoComment,
} from "./fixtures";
import {
  ADMIN_EMAIL,
  addTestDocAuthor,
  createComment,
  createTestDoc,
  deleteTestDoc,
  getCommentFacts,
  getDocMarkFacts,
  getUserIdByEmail,
} from "./db";
import { createAgent } from "./mcp";

// docs/TIPTAP.md "Inline code takes other marks" — inline code carries any
// other mark: bold on all or part of it, the author mark of whoever typed it,
// and an annotation's mark over a passage it is in. And every Markdown export
// keeps the other marks' delimiters outside the backticks, so a round trip
// through the comment edit box or an MCP read and edit leaves the code as it
// was.

const code = { type: "code" };
const t = (text: string, ...marks: object[]) => ({ type: "text", text, ...(marks.length ? { marks } : {}) });
const p = (...content: object[]) => ({ type: "paragraph", content });
// Bold code, nested either way: the editor puts <strong> outside <code>, and
// @tiptap/static-renderer, which draws a comment, puts it inside.
const BOLD_CODE = "strong code, code strong";

/** Selects the whole of the body paragraph that starts with `start`, across its text nodes. */
async function selectParagraph(page: Page, start: string): Promise<void> {
  await page.evaluate((text) => {
    const root = document.querySelector<HTMLElement>('[aria-label="Post body"]');
    if (!root) throw new Error("No body editor.");
    // Focus first, then select: selectTextIn in fixtures.ts says why.
    root.focus({ preventScroll: true });
    const paragraph = [...root.querySelectorAll("p")].find((node) => node.textContent?.startsWith(text));
    if (!paragraph) throw new Error(`No paragraph starting ${JSON.stringify(text)}.`);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    if (!selection) throw new Error("No selection available.");
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, start);
}

test("bold goes on part of a code span in the editor, and the doc's Markdown keeps it outside the backticks", async ({
  page,
  request,
}) => {
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, body: { type: "doc", content: [p(t("Run "), t("wf_1234", code), t(" now."))] } });
  const agent = await createAgent(request);
  await addTestDocAuthor(doc.id, agent.user.email);
  try {
    await page.goto(`/doc/${doc.id}/edit`);
    await waitForDocCollabReady(page);
    await selectTextInBody(page, "wf");
    await page.keyboard.press("ControlOrMeta+b");
    const body = bodyEditor(page);
    await expect(body.locator(BOLD_CODE)).toHaveText("wf");
    await expect(body.locator("code")).toHaveText(["wf", "_1234"]);

    const url = `/doc/${doc.slug}`;
    const markdown = async () => String((await agent.call("read", { url })).result.markdown);
    await expect.poll(markdown, { timeout: 15_000 }).toBe("Run **`wf`**`_1234` now.");

    // An edit written from that Markdown, as Claude writes one, leaves the code as it was.
    const edited = await agent.call("edit_doc", { url, edits: [{ old: "Run **`wf`**`_1234` now.", new: "Run **`wf`**`_1234` later." }] });
    expect(edited.isError, JSON.stringify(edited.error)).toBe(false);
    await expect(body).toContainText("later.");
    await expect(body.locator(BOLD_CODE)).toHaveText("wf");
    await expect(body.locator("code")).toHaveText(["wf", "_1234"]);
    expect(await markdown()).toBe("Run **`wf`**`_1234` later.");
  } finally {
    await deleteTestDoc(doc.id);
    await agent.dispose();
  }
});

test("code typed in the editor carries its typist's author mark", async ({ page, draftDoc }) => {
  const admin = (await getUserIdByEmail(ADMIN_EMAIL))!;
  await page.goto(`/doc/${draftDoc.id}/edit`);
  await waitForDocCollabReady(page);
  await bodyEditor(page).click();
  await page.keyboard.press("End");
  // The closing backtick is TipTap's input rule for inline code.
  await page.keyboard.type(" Run `npm` now.");
  await expect(bodyEditor(page).locator(`code .author-highlight[data-author-id="${admin}"]`)).toHaveText("npm");
  await expect.poll(async () => (await getDocMarkFacts(draftDoc.id)).authors[ADMIN_EMAIL], { timeout: 15_000 }).toContain(
    "Run npm now.",
  );
});

test("an annotation made in the editor over a passage with code covers the code", async ({ page }) => {
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    body: { type: "doc", content: [p(t("Run "), t("wf_1234", code), t(" first.")), p(t("Another paragraph."))] },
  });
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/doc/${doc.id}/edit`);
    await waitForDocCollabReady(page);
    await selectParagraph(page, "Run ");
    await page.locator("[data-testid='annotate-marker']").click();
    await annotationEditor(page).click();
    await page.keyboard.type("A note on the whole sentence.");
    await page.getByTestId("annotation-popup").getByRole("button", { name: "Post annotation" }).click();

    // The mark's text, read in document order: a hole over the code would read "Run  first.".
    await expect
      .poll(async () => Object.values((await getDocMarkFacts(doc.id)).annotations), { timeout: 15_000 })
      .toEqual(["Run wf_1234 first."]);
  } finally {
    await deleteTestDoc(doc.id);
  }
});

test("a comment's Markdown edit box shows part-bold code as it was written, and saving it keeps the code", async ({
  publishedPost,
  secondUser,
}) => {
  // Its own commenter, so its two edits spend its own edit limit rather than the shared admin's.
  const { user, page } = await secondUser();
  const original = "E2E a comment about code.";
  const written = "Run **`wf`**`_1234` first.";
  const { id } = await createComment({
    postId: publishedPost.id,
    anchoredEventId: publishedPost.eventId!,
    email: user.email,
    displayName: "Code Commenter",
    body: original,
    status: "APPROVED",
  });

  await freshGotoComment(page, publishedPost.path, id);
  const own = page.locator(`[data-comment-id="${id}"]`);
  const editBox = own.getByRole("textbox", { name: "Edit comment" });
  await own.getByRole("button", { name: "Edit" }).click();
  await editBox.fill(written);
  await own.getByRole("button", { name: "Save" }).click();
  await expect(editBox).toHaveCount(0);
  await expect(own.locator(BOLD_CODE)).toHaveText("wf");

  // The box shows the stored body as Markdown: the same text, bold outside the backticks.
  await own.getByRole("button", { name: "Edit" }).click();
  await expect(editBox).toHaveValue(written);
  await editBox.fill(written.replace("first", "last"));
  await own.getByRole("button", { name: "Save" }).click();
  await expect(editBox).toHaveCount(0);
  await expect(own.locator(BOLD_CODE)).toHaveText("wf");
  expect((await getCommentFacts(id))?.revisions.map((r) => r.bodyText)).toEqual([
    original,
    "Run wf_1234 first.",
    "Run wf_1234 last.",
  ]);
});
