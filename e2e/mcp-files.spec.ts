import { test, expect, gotoOk, annotationEditor, visibleText } from "./fixtures";
import { ADMIN_EMAIL, createTestFile, deleteTestFile, getFileAnnotationQuads, getUploadFacts } from "./db";
import { createAgent } from "./mcp";
import { uniqueTitle } from "./naming";
import { buildTestPdf } from "../scripts/make-test-pdf";

// docs/MCP.md §5, §8: a PDF uploaded through the MCP server's byte route —
// PRIVATE, owned by the actor and then the issuer, its labels stored with it,
// the same bytes coming back as the file already there — retitled with
// edit_file; and quads the server measures for a quote, held to within a
// point of what a real selection in Chromium gives for the same words
// (docs/PDF_QUADS.md, Appendix A: the fixture's worst edge was 0.82pt).

test("upload_url and curl: a PRIVATE file owned by the actor and the issuer; the same bytes again are that file", async ({ request }) => {
  const agent = await createAgent(request);
  const title = uniqueTitle("upload");
  const pdf = Buffer.from(
    buildTestPdf([[`${title} front matter.`], [`${title} the body begins.`]], { pageLabels: [{ from: 1, style: "r" }, { from: 2, style: "D" }] }),
  );
  const ids: string[] = [];
  const upload = async (query: string) => {
    const granted = await agent.call("upload_url", { kind: "file" });
    const res = await request.post(`${granted.result.url}&filename=paper.pdf${query}`, { data: pdf, headers: { "Content-Type": "application/pdf" } });
    return { status: res.status(), body: await res.json() };
  };
  try {
    const first = await upload(`&title=${encodeURIComponent(title)}`);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    ids.push(first.body.id);
    expect(first.body).toMatchObject({ title, url: expect.stringMatching(/^\/pdf\//) });
    expect(JSON.stringify(first.body).length).toBeLessThan(250);
    expect(await getUploadFacts(first.body.id)).toEqual({
      owners: [agent.user.email, ADMIN_EMAIL],
      creator: agent.user.email,
      visibility: "PRIVATE",
      pageLabels: ["i", "1"],
    });

    const read = await agent.call("read", { url: first.body.url });
    expect(read.result).toMatchObject({ kind: "pdf", pages: 2, labels: expect.any(Array) });

    // The same bytes, under another title: the file already there.
    const again = await upload(`&title=${encodeURIComponent(`${title} again`)}`);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, existing: true });

    const copy = await upload(`&duplicate=1`);
    expect(copy.status).toBe(201);
    ids.push(copy.body.id);
    expect(copy.body.id).not.toBe(first.body.id);
    const repeat = await upload(`&duplicate=1`);
    expect(repeat.body.code).toBe("already_done");

    const issuerOnly = await upload(`&duplicate=1&issuerOnly=1&title=${encodeURIComponent(`${title} theirs`)}`);
    ids.push(issuerOnly.body.id);
    expect((await getUploadFacts(issuerOnly.body.id))!.owners).toEqual([ADMIN_EMAIL]);

    const wrongKind = await request.post(`${(await agent.call("upload_url", { kind: "file" })).result.url}&filename=notes.txt`, {
      data: Buffer.from("plain text"),
    });
    expect(wrongKind.status()).toBe(415);

    const retitled = await agent.call("edit_file", { file: first.body.url, title: `${title} retitled` });
    expect(retitled.result).toMatchObject({ url: first.body.url, title: `${title} retitled` });
    expect((await agent.call("edit_file", { file: issuerOnly.body.id, title: "Not mine" })).error.code).toBe("not_found");
  } finally {
    for (const id of ids) await deleteTestFile(id);
    await agent.dispose();
  }
});

test("the server's quads for a quote land within a point of a Chromium selection of the same words", async ({ page, request }) => {
  const agent = await createAgent(request);
  const phrase = "brown fox jumps over";
  const file = await createTestFile({
    ownerEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    pages: [["The quick brown fox jumps over the lazy dog on page one.", "A second line to keep it honest."]],
  });
  try {
    await gotoOk(page, `/pdf/${file.slug}`);
    await page.waitForFunction(() => document.querySelector(".pdfViewer .page .textLayer span") !== null, undefined, { timeout: 30_000 });
    const found = await page.evaluate((needle) => {
      const layer = document.querySelector(`.pdfViewer .page[data-page-number="1"] .textLayer`);
      const walker = document.createTreeWalker(layer!, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const index = (node.textContent ?? "").indexOf(needle);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + needle.length);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        return true;
      }
      return false;
    }, phrase);
    expect(found).toBe(true);
    await page.mouse.up();
    await page.dispatchEvent("body", "pointerup");
    await page.getByRole("button", { name: "Annotate" }).click();
    const editor = annotationEditor(page);
    await editor.click();
    await editor.pressSequentially("From the browser.");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(visibleText(page, "From the browser.")).toBeVisible({ timeout: 15_000 });

    const posted = await agent.call("annotate", { on: `/pdf/${file.slug}`, body: "From the server.", quote: phrase });
    expect(posted.isError, JSON.stringify(posted.error)).toBe(false);

    const rows = await getFileAnnotationQuads(file.id);
    const browser = rows.find((r) => r.bodyText === "From the browser.")!;
    const server = rows.find((r) => r.bodyText === "From the server.")!;
    expect(server.quotedText).toBe(browser.quotedText);
    expect(server.quads).toHaveLength(browser.quads.length);
    const worst = Math.max(...server.quads.flatMap((quad, i) => quad.map((value, j) => Math.abs(value - browser.quads[i][j]))));
    expect(worst, `worst corner difference, in PDF points`).toBeLessThanOrEqual(1);
  } finally {
    await deleteTestFile(file.id);
    await agent.dispose();
  }
});
