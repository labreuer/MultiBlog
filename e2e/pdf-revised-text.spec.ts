import { test, expect, signIn, gotoOk, annotationEditor } from "./fixtures";
import {
  ADMIN_EMAIL,
  createTestApiToken,
  createTestFile,
  deleteTestFile,
  getFileAnchorMoves,
  getFileAnchorRows,
  getFileVersionFacts,
  noteActAs,
  type TestAnchorRow,
  type TestFile,
} from "./db";
import { callTool, createAgent } from "./mcp";
import { expectAddress, expectSheetText, selectPhrase, token, waitForViewer, type Page } from "./pdf-version-helpers";
import { buildTestPdf, type TestPageLabelRange } from "../scripts/make-test-pdf";

// docs/PDF.md §13 — a revised text: uploaded as one, it has no page map, so
// nothing is carried. Every note stays on the version it was made on, a link
// written against that version opens it, and each author moves their own
// notes one at a time from their worklist on the latest's page.
//
// The first draft, and its revision reflowed onto three sheets with one
// passage rewritten and one cut:
//
//   first draft   1: opening, perception, ground, conclusion     2: second, digression, attention, closing
//   revision      1: opening, perception     2: ground, conclusion (rewritten)     3: second, attention, closing
//
// The notes on the first draft, and what becomes of each:
//
//   closing ("future of meaning")            its author's   found once, with the same words around it: accepted
//   attention ("shared attention")           a bot's        found once, the line before it cut: a proposal, accepted by the bot's person
//   conclusion ("too little evidence")       its author's   rewritten: no suggestion, placed by hand
//   digression ("digression about weather")  its author's   cut: no suggestion, marked as staying
//   perception ("bare receipt")              another's      not in that author's worklist at all
//   ground ("prepares the ground")           a private draft   in its author's worklist, and moved as a draft
//   second ("second sheet continues")        a part of the link open in the author's tray   moved, and the tray reloads it

const LABELS: TestPageLabelRange[] = [{ from: 1, style: "D" }];

const opening = (tag: string) => [`The first draft opens with a claim ${tag}.`, "Perception is never the bare receipt of what is given."];
const ground = "The second paragraph prepares the ground for the argument.";
const second = (tag: string) => `A second sheet continues the draft ${tag}.`;
const attention = "The middle passage on shared attention stays as it was.";
const closing = "A closing remark about the future of meaning survives.";

const firstDraft = (tag: string): string[][] => [
  [...opening(tag), ground, "Its conclusion is stated here with too little evidence."],
  [second(tag), "This digression about weather was cut from the revision.", attention, closing],
];
const revision = (tag: string): string[][] => [opening(tag), [ground, "Its conclusion is now argued from three recorded cases."], [second(tag), attention, closing]];
const revisionPdf = (tag: string): Buffer => Buffer.from(buildTestPdf(revision(tag), { pageLabels: LABELS }));

/** Opens a link from another page, so the page for the latest loads first and the viewer reads the fragment on arrival. */
async function follow(page: Page, address: string) {
  await gotoOk(page, "/files");
  await page.goto(address);
}

test.describe("a revised text", () => {
  test("its notes stay on the version they were made on, and each author moves their own", async ({ page, request, secondUser }) => {
    test.setTimeout(300_000);
    const tag = token();
    const file: TestFile = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED", pages: firstDraft(tag), pageLabels: LABELS });
    const at = `/pdf/${file.slug}`;
    const banner = page.getByTestId("pdf-version-banner");
    // The author, another writer, and a bot that works for the author.
    const one = await secondUser({ role: "AUTHOR" });
    const two = await secondUser({ role: "AUTHOR" });
    const bot = await createAgent(request, { issuerEmail: one.user.email });
    const speaksAs = async (email: string) => {
      const { secret } = await createTestApiToken({ email, issuerEmail: email, scopes: ["READ", "WRITE"], client: "CLAUDE_CODE" });
      return async (name: string, args: Record<string, unknown>) => {
        const answer = await callTool(request, secret, name, args);
        expect(answer.isError, JSON.stringify(answer.error)).toBe(false);
        return answer.result;
      };
    };
    const toSheet = async (reader: Page, sheet: number) => {
      await reader.locator(`.pdfViewer .page[data-page-number='${sheet}']`).scrollIntoViewIfNeeded();
      await expect(reader.locator(`.pdfViewer .page[data-page-number='${sheet}'] .textLayer`)).toBeAttached({ timeout: 30_000 });
    };
    const rowOf = (rows: TestAnchorRow[], id: string) => {
      const row = rows.find((candidate) => candidate.id === id);
      expect(row, `anchor ${id}`).toBeTruthy();
      return row!;
    };
    const card = (reader: Page, id: string) => reader.locator(`[data-margin-note-id="${id}"]`);
    // Every card as a plain list. Beside the text, a card sits level with its passage, and one near the top of the sheet lies under the pane's own tabs.
    const listCards = (reader: Page) => reader.getByRole("button", { name: /^Show all \d+$/ }).click();
    try {
      const asOne = await speaksAs(one.user.email);
      const asTwo = await speaksAs(two.user.email);
      const note = async (as: Awaited<ReturnType<typeof speaksAs>>, body: string, quote: string) => String((await as("add_note", { on: at, body, quote })).id);

      // ---- on the first draft ------------------------------------------------
      const survives = await note(asOne, `On what survives ${tag}.`, "future of meaning");
      const rewritten = await note(asOne, `On the conclusion ${tag}.`, "too little evidence");
      const cut = await note(asOne, `On the digression ${tag}.`, "digression about weather");
      const others = await note(asTwo, `Another writer's note ${tag}.`, "bare receipt");
      const posted = await bot.call("add_note", { on: at, body: `The bot's note ${tag}.`, quote: "shared attention" });
      expect(posted.isError, JSON.stringify(posted.error)).toBe(false);
      const botNote = String(posted.result.id);
      // A draft kept private, and a passage in a link its creator has not minted: both are their writer's alone.
      await gotoOk(one.page, at);
      await waitForViewer(one.page);
      await selectPhrase(one.page, 1, "prepares the ground");
      await one.page.getByRole("button", { name: "Annotate" }).click();
      await annotationEditor(one.page).click();
      await annotationEditor(one.page).pressSequentially(`A private thought ${tag}.`);
      await one.page.getByRole("combobox", { name: "Annotation visibility" }).selectOption("private");
      await one.page.getByRole("button", { name: "Save" }).click();
      await expect(one.page.getByRole("button", { name: "Write an annotation..." })).toBeVisible({ timeout: 15_000 });
      await toSheet(one.page, 2);
      await expectSheetText(one.page, "second sheet continues", 2);
      await selectPhrase(one.page, 2, "second sheet continues");
      await one.page.getByRole("button", { name: "Add to link" }).click();
      await expect(one.page.getByTestId("anchored-link-tray")).toContainText("1 passage", { timeout: 15_000 });
      const made = await getFileAnchorRows(file.id);
      const draft = made.find((row) => row.kind === "annotation" && row.quotedText === "prepares the ground")!.id;
      const openPart = made.find((row) => row.kind === "link-part")!.id;
      const bodies = [`On what survives ${tag}.`, `On the conclusion ${tag}.`, `On the digression ${tag}.`, `Another writer's note ${tag}.`, `The bot's note ${tag}.`];

      // ---- the revision, uploaded as a revised text and promoted --------------
      await signIn(page, ADMIN_EMAIL);
      await gotoOk(page, at);
      await waitForViewer(page);
      await page.getByRole("tab", { name: "Metadata" }).click();
      const chooser = page.waitForEvent("filechooser");
      await page.getByTestId("pdf-upload-revised-text").click();
      await (await chooser).setFiles({ name: "revision.pdf", mimeType: "application/pdf", buffer: revisionPdf(tag) });
      await expect(page).toHaveURL(new RegExp(`${at}/v/2$`), { timeout: 90_000 });
      await waitForViewer(page);
      // Its pages are not matched with the first draft's, so its promotion has no carry to offer.
      await expect(banner.getByTestId("pdf-candidate-no-map")).toBeVisible();
      await expect(banner.getByTestId("pdf-candidate-promote-carry")).toHaveCount(0);
      await banner.getByRole("button", { name: "Promote version 2" }).click();
      await expect(page.locator("[data-pdf-viewer]")).toContainText(`${file.title}, version 2 (the latest)`, { timeout: 60_000 });
      const versions = await getFileVersionFacts(file.id);
      expect(versions.map(({ number, state, pageMap }) => ({ number, state, pageMap }))).toEqual([
        { number: 1, state: "earlier", pageMap: null },
        { number: 2, state: "latest", pageMap: null },
      ]);

      // ---- nothing moved --------------------------------------------------------
      const before = await getFileAnchorRows(file.id);
      expect(before.map((row) => row.versionNumber)).toEqual([1, 1, 1, 1, 1, 1, 1]);
      expect(await getFileAnchorMoves(file.id)).toEqual([]);
      // Every note is listed on the latest's page under version 1, and none is drawn on it.
      const listed = page.getByTestId("pdf-other-version-notes");
      await expect(listed).toContainText("On version 1", { timeout: 30_000 });
      for (const body of bodies) await expect(listed).toContainText(body);
      await expect(page.locator(".annoRect")).toHaveCount(0);

      // ---- a link written against version 1 opens version 1 --------------------
      // By sheet: no map carries it, so it opens the version it names.
      await follow(page, `${at}#sheet=2&text=shared+attention`);
      await expectAddress(page, `${at}/v/1#sheet=2&text=shared+attention`);
      await waitForViewer(page);
      await expectSheetText(page, `A second sheet continues the draft ${tag}`, 2);
      await expect(page.getByTestId("pdf-fragment-banner")).toContainText("shared attention", { timeout: 30_000 });
      // And by printed page: the first draft's page 2, though the revision prints a page 2 of its own.
      await follow(page, `${at}#p=2&text=future+of+meaning`);
      await expectAddress(page, `${at}/v/1#p=2&text=future+of+meaning`);
      await waitForViewer(page);
      await expect(page.getByTestId("pdf-fragment-banner")).toContainText("future of meaning", { timeout: 30_000 });

      // ---- nobody but its author is offered a note's move -----------------------
      // A manager of the file who wrote none of them has no worklist, and the list offers no move.
      await gotoOk(page, at);
      await waitForViewer(page);
      await expect(page.getByTestId("pdf-other-version-notes")).toContainText(`On what survives ${tag}.`, { timeout: 30_000 });
      await expect(page.getByTestId("pdf-worklist")).toHaveCount(0);
      await expect(page.getByTestId("pdf-worklist-accept")).toHaveCount(0);
      // Another writer's worklist holds their own note and none of the author's.
      await gotoOk(two.page, at);
      await waitForViewer(two.page);
      await expect(two.page.getByTestId("pdf-worklist").getByTestId("pdf-worklist-item")).toHaveCount(1, { timeout: 30_000 });
      await expect(two.page.getByTestId("pdf-worklist")).toContainText(`Another writer's note ${tag}.`);
      await expect(two.page.getByTestId("pdf-other-version-notes")).toContainText(`On what survives ${tag}.`);
      // And the act is refused to both, whatever they send: a move, a mark.
      for (const email of [two.user.email, ADMIN_EMAIL]) {
        expect(await noteActAs(email, { act: "move", kind: "annotation", id: survives, toVersionId: versions[1].id }), email).toMatchObject({ ok: false, code: "forbidden" });
        expect(await noteActAs(email, { act: "stays", kind: "annotation", id: survives, stays: true }), email).toMatchObject({ ok: false, code: "forbidden" });
      }
      expect(await getFileAnchorRows(file.id)).toEqual(before);
      expect(await getFileAnchorMoves(file.id)).toEqual([]);

      // ---- the author's worklist -------------------------------------------------
      await gotoOk(one.page, at);
      await waitForViewer(one.page);
      const worklist = one.page.getByTestId("pdf-worklist");
      const item = (id: string) => worklist.locator(`[data-testid="pdf-worklist-item"][data-note-id="${id}"]`);
      await expect(worklist.getByTestId("pdf-worklist-item")).toHaveCount(6, { timeout: 30_000 });
      // Under the version each is on, as the rest of the list of notes on other versions is.
      await expect(worklist).toContainText("On version 1");
      for (const id of [survives, rewritten, cut]) await expect(item(id)).toContainText("Note");
      // Their draft and the part of the link open in their tray are in it too.
      await expect(item(draft)).toContainText("Private note");
      await expect(item(openPart)).toContainText("Part of the link in your tray");
      // A bot's note is in the worklist of the person it works for.
      await expect(item(botNote)).toContainText(`written by ${bot.user.name}`);
      await expect(item(others)).toHaveCount(0);
      // Their own notes are listed once, in the worklist; the other writer's is in the rest of the list.
      await expect(one.page.getByTestId("pdf-other-version-notes")).toContainText(`Another writer's note ${tag}.`);
      await expect(one.page.getByTestId("pdf-other-version-notes").getByText(`On what survives ${tag}.`)).toHaveCount(1);
      // The same notes are a filter in /annotations.
      await gotoOk(one.page, "/annotations?earlier=mine");
      for (const body of [bodies[0], bodies[1], bodies[2], bodies[4]]) await expect(one.page.locator("main")).toContainText(body);
      await expect(one.page.locator("main")).not.toContainText(`Another writer's note ${tag}.`);
      await gotoOk(one.page, at);
      await waitForViewer(one.page);
      await expect(worklist.getByTestId("pdf-worklist-item")).toHaveCount(6, { timeout: 30_000 });

      // Where each would go is worked out when it is asked for, and asking stores nothing.
      await expect(worklist.getByTestId("pdf-worklist-suggestion")).toHaveCount(0);
      await worklist.getByTestId("pdf-worklist-open").click();
      await expect(item(survives)).toHaveAttribute("data-suggestion", "placed", { timeout: 60_000 });
      await expect(item(survives).getByTestId("pdf-worklist-suggestion")).toContainText("Found once in version 2, with the same words around it.");
      // The passage on the note's version beside the one on the latest.
      await expect(item(survives)).toContainText("“future of meaning”");
      await expect(item(survives).getByTestId("pdf-worklist-suggestion")).toContainText("“future of meaning”");
      await expect(item(survives).getByTestId("pdf-worklist-suggestion")).toContainText("p. 3");
      // The line before the bot's passage was cut, so the words around it differ: a proposal.
      await expect(item(botNote)).toHaveAttribute("data-suggestion", "proposal");
      await expect(item(botNote).getByTestId("pdf-worklist-suggestion")).toContainText("though not surely");
      // The rewritten and the cut passages have no place.
      for (const id of [rewritten, cut]) {
        await expect(item(id)).toHaveAttribute("data-suggestion", "none");
        await expect(item(id).getByTestId("pdf-worklist-no-suggestion")).toContainText("Its words were not found in version 2.");
        await expect(item(id).getByTestId("pdf-worklist-accept")).toHaveCount(0);
      }
      expect(await getFileAnchorRows(file.id)).toEqual(before);
      expect(await getFileAnchorMoves(file.id)).toEqual([]);

      // ---- a suggestion accepted ---------------------------------------------------
      await item(survives).getByTestId("pdf-worklist-accept").click();
      await expect(item(survives)).toHaveCount(0, { timeout: 30_000 });
      let rows = await getFileAnchorRows(file.id);
      expect(rowOf(rows, survives).versionNumber).toBe(2);
      expect(rowOf(rows, survives).quotedText).toBe("future of meaning");
      expect(JSON.parse(rowOf(rows, survives).row).pdf_target.pageIndex).toBe(2);
      let moves = await getFileAnchorMoves(file.id);
      expect(moves).toHaveLength(1);
      // One note's move is shown, belongs to no carry, and is its mover's.
      expect(moves[0]).toMatchObject({ anchorId: survives, fromNumber: 1, toNumber: 2, carryId: null, hidden: false, wasMarked: false, movedByEmail: one.user.email, fromQuotedText: "future of meaning" });
      // It is drawn on the latest, and its card says which version it was moved from.
      await toSheet(one.page, 3);
      await expect(one.page.locator(`.annoRect[data-anno-id="${survives}"]`).first()).toBeVisible({ timeout: 30_000 });
      await expect(card(one.page, survives).getByTestId("pdf-note-moved")).toContainText("Moved from version 1.");
      await expect(card(one.page, survives).getByTestId("pdf-note-moved")).not.toContainText(" by ");

      // The bot's note, moved by the person it works for: its card says who moved it.
      await item(botNote).getByTestId("pdf-worklist-accept").click();
      await expect(item(botNote)).toHaveCount(0, { timeout: 30_000 });
      rows = await getFileAnchorRows(file.id);
      expect(rowOf(rows, botNote).versionNumber).toBe(2);
      await expect(card(one.page, botNote).getByTestId("pdf-note-moved")).toContainText(`Moved from version 1 by ${one.user.name}.`, { timeout: 30_000 });

      // ---- a draft, and a part of the open link ----------------------------------------
      // A draft is moved as a draft: still private, on the latest.
      await expect(item(draft)).not.toHaveAttribute("data-suggestion", "none");
      await item(draft).getByTestId("pdf-worklist-accept").click();
      await expect(item(draft)).toHaveCount(0, { timeout: 30_000 });
      rows = await getFileAnchorRows(file.id);
      expect(rowOf(rows, draft).versionNumber).toBe(2);
      expect(JSON.parse(rowOf(rows, draft).row).status).toBe("DRAFT");
      // The part of the open link: the tray's store loads again, so the part is drawn on the latest's sheet at once.
      await expect(one.page.locator(".annoRectDraftLink")).toHaveCount(0);
      await item(openPart).getByTestId("pdf-worklist-accept").click();
      await expect(item(openPart)).toHaveCount(0, { timeout: 30_000 });
      rows = await getFileAnchorRows(file.id);
      expect(rowOf(rows, openPart)).toMatchObject({ versionNumber: 2, quotedText: "second sheet continues" });
      await toSheet(one.page, 3);
      await expect(one.page.locator(".annoRectDraftLink").first()).toBeVisible({ timeout: 30_000 });
      await expect(one.page.getByTestId("anchored-link-tray")).toContainText("1 passage");

      // ---- a note placed by hand ------------------------------------------------------
      await item(rewritten).getByTestId("pdf-worklist-place").click();
      await expect(one.page.getByTestId("pdf-placing-banner")).toContainText("too little evidence");
      await expect(item(rewritten).getByTestId("pdf-worklist-placing")).toBeVisible();
      await toSheet(one.page, 2);
      await expectSheetText(one.page, "three recorded cases", 2);
      await selectPhrase(one.page, 2, "three recorded cases");
      await one.page.getByTestId("pdf-place-note-here").click();
      await expect(item(rewritten)).toHaveCount(0, { timeout: 30_000 });
      await expect(one.page.getByTestId("pdf-placing-banner")).toHaveCount(0);
      rows = await getFileAnchorRows(file.id);
      // The quote is derived on the server, from the latest's own page text.
      expect(rowOf(rows, rewritten)).toMatchObject({ versionNumber: 2, quotedText: "three recorded cases" });
      expect(JSON.parse(rowOf(rows, rewritten).row).pdf_target.pageIndex).toBe(1);
      moves = await getFileAnchorMoves(file.id);
      expect(moves.find((move) => move.anchorId === rewritten)).toMatchObject({ fromNumber: 1, toNumber: 2, carryId: null, hidden: false, fromQuotedText: "too little evidence" });
      await expect(one.page.locator(`.annoRect[data-anno-id="${rewritten}"]`).first()).toBeVisible({ timeout: 30_000 });

      // ---- a note marked as staying ---------------------------------------------------
      await item(cut).getByTestId("pdf-worklist-stays").click();
      // It was the last of the worklist, which is gone with it.
      await expect(worklist).toHaveCount(0, { timeout: 30_000 });
      rows = await getFileAnchorRows(file.id);
      expect(rowOf(rows, cut)).toEqual(rowOf(before, cut));
      moves = await getFileAnchorMoves(file.id);
      expect(moves.find((move) => move.anchorId === cut)).toMatchObject({ fromNumber: 1, toNumber: null, carryId: null, hidden: false, wasMarked: false, movedByEmail: one.user.email });
      // It is listed under version 1 as any note there is, and its author is told of the mark.
      const kept = one.page.getByTestId("pdf-other-version-notes").locator(`[data-thread-id="${cut}"]`);
      await expect(kept.getByTestId("pdf-note-stays")).toContainText("You marked it as staying on version 1.");
      await gotoOk(one.page, "/annotations?earlier=mine");
      await expect(one.page.getByRole("heading", { name: "Annotations" })).toBeVisible();
      for (const body of bodies) await expect(one.page.locator("main")).not.toContainText(body);

      // ---- what another reader is shown -------------------------------------------------
      await gotoOk(two.page, at);
      await waitForViewer(two.page);
      await toSheet(two.page, 3);
      await expect(card(two.page, survives).getByTestId("pdf-note-moved")).toContainText("Moved from version 1.", { timeout: 30_000 });
      // The move is its author's to hide, and the mark its author's to know of.
      await expect(two.page.getByTestId("pdf-note-move-hide")).toHaveCount(0);
      const keptForTwo = two.page.getByTestId("pdf-other-version-notes").locator(`[data-thread-id="${cut}"]`);
      await expect(keptForTwo).toContainText(`On the digression ${tag}.`);
      await expect(keptForTwo.getByTestId("pdf-note-stays")).toHaveCount(0);
      // Version 1's page lists each moved note under version 2, as moved there.
      await gotoOk(two.page, `${at}/v/1`);
      await waitForViewer(two.page);
      const moved = two.page.getByTestId("pdf-other-version-notes");
      await expect(moved).toContainText("On version 2", { timeout: 30_000 });
      await expect(moved.locator(`[data-thread-id="${survives}"]`).getByTestId("pdf-note-moved-to")).toContainText("Moved to version 2.");
      await expect(moved.locator(`[data-thread-id="${botNote}"]`).getByTestId("pdf-note-moved-to")).toContainText(`Moved to version 2 by ${one.user.name}.`);
      await expect(two.page.locator(`.annoRect[data-anno-id="${survives}"]`)).toHaveCount(0);
      // The earlier version's banner says what a note's author can do with it.
      await expect(two.page.getByTestId("pdf-version-banner")).toContainText("Its author can move it to version 2 from that version's page, or mark it here as staying.");

      // ---- the author's own card on the earlier version's page ---------------------------
      await gotoOk(one.page, `${at}/v/1`);
      await waitForViewer(one.page);
      await listCards(one.page);
      await expect(card(one.page, cut).getByTestId("pdf-note-stays")).toContainText("You marked this note as staying on version 1.", { timeout: 30_000 });
      // Taking the mark off puts the note back in the worklist.
      await card(one.page, cut).getByTestId("pdf-note-unstay").click();
      await expect(card(one.page, cut).getByTestId("pdf-note-stay")).toBeVisible({ timeout: 30_000 });
      expect((await getFileAnchorMoves(file.id)).filter((move) => move.toNumber === null)).toEqual([]);
      // And it is marked again from the card, where a note made on this version can be marked as soon as it is posted.
      await card(one.page, cut).getByTestId("pdf-note-stay").click();
      await expect(card(one.page, cut).getByTestId("pdf-note-stays")).toBeVisible({ timeout: 30_000 });
      // Another writer's card offers neither.
      await expect(card(one.page, others).getByTestId("pdf-note-stay")).toHaveCount(0);

      // ---- its author hides a move, and shows it again ------------------------------------
      await gotoOk(one.page, at);
      await waitForViewer(one.page);
      await listCards(one.page);
      await card(one.page, survives).getByTestId("pdf-note-move-hide").click();
      await expect(card(one.page, survives).getByTestId("pdf-note-moved")).toHaveCount(0, { timeout: 30_000 });
      expect((await getFileAnchorMoves(file.id)).find((move) => move.anchorId === survives)?.hidden).toBe(true);
      // Hidden, it is on no card. Its author shows it again from the page of the version it left.
      await gotoOk(one.page, `${at}/v/1`);
      await waitForViewer(one.page);
      const left = one.page.getByTestId("pdf-other-version-notes").locator(`[data-thread-id="${survives}"]`);
      await expect(left.getByTestId("pdf-note-moved-to")).toHaveCount(0);
      await left.getByTestId("pdf-note-move-show").click();
      await expect(left.getByTestId("pdf-note-moved-to")).toContainText("Moved to version 2.", { timeout: 30_000 });

      // ---- forward only, and no mark on the latest ------------------------------------------
      expect(await noteActAs(one.user.email, { act: "move", kind: "annotation", id: survives, toVersionId: versions[0].id })).toMatchObject({ ok: false, code: "conflict" });
      expect(await noteActAs(one.user.email, { act: "stays", kind: "annotation", id: survives, stays: true })).toMatchObject({ ok: false, code: "conflict" });
      // A move of the marked note takes the mark off, and its row says the note was marked.
      expect(await noteActAs(one.user.email, { act: "move", kind: "annotation", id: cut, toVersionId: versions[1].id, target: JSON.parse(rowOf(rows, survives).row).pdf_target })).toEqual({ ok: true, moved: true });
      moves = await getFileAnchorMoves(file.id);
      expect(moves.filter((move) => move.anchorId === cut)).toEqual([expect.objectContaining({ fromNumber: 1, toNumber: 2, wasMarked: true, hidden: false })]);
    } finally {
      await deleteTestFile(file.id);
      await bot.dispose();
    }
  });
});
