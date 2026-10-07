import { test, expect, bodyEditor, waitForDocCollabReady } from "./fixtures";
import {
  ADMIN_EMAIL,
  addTestDocAuthor,
  createTestAnnotation,
  createTestDoc,
  deleteTestDoc,
  getDocMarkFacts,
  getUserIdByEmail,
  setTestDocRecord,
} from "./db";
import { createAgent } from "./mcp";

// docs/MCP.md, phase 2 (§18): docs written through the MCP server — created
// PRIVATE in one transaction with the actor's marks and byline, and edited
// by targeted edits whose surviving words keep their marks, whose notes follow
// the words they cover, and whose write-back leaves the blocks it didn't touch
// alone for anyone typing in them.

type Run = { text: string; author?: string; note?: string };
const p = (...runs: (string | Run)[]) => ({
  type: "paragraph",
  content: runs.map((run) => {
    const r = typeof run === "string" ? { text: run } : run;
    return {
      type: "text",
      text: r.text,
      marks: [
        ...(r.author ? [{ type: "authorHighlight", attrs: { authorId: r.author } }] : []),
        ...(r.note ? [{ type: "annotation", attrs: { id: r.note } }] : []),
      ],
    };
  }),
});

test("create_doc: PRIVATE, the actor's text and byline, the title from the leading heading, and a repeat refused", async ({ request }) => {
  const agent = await createAgent(request);
  const created: string[] = [];
  try {
    const markdown = "# A research summary\n\n> What did Barfield mean?\n\nHe meant **participation**.";
    const first = await agent.call("create_doc", { markdown });
    expect(first.isError).toBe(false);
    created.push(String(first.result.id));
    expect(first.result).toMatchObject({ title: "A research summary", visibility: "PRIVATE", byline: `${agent.user.name}, E2E Admin` });
    expect(String(first.result.version)).toMatch(/^\d+$/);

    const facts = await getDocMarkFacts(String(first.result.id));
    expect(facts.title).toBe("A research summary");
    expect(facts.authors[agent.user.email]).toBe(facts.text.replace(/\n/g, ""));
    expect(facts.clients).toEqual([agent.user.email]);

    const read = await agent.call("read", { url: String(first.result.url) });
    expect(read.result.markdown).toBe("> What did Barfield mean?\n\nHe meant **participation**.");

    const again = await agent.call("create_doc", { markdown });
    expect(again.error.code).toBe("already_done");
    expect((again.error.result as { id: string }).id).toBe(first.result.id);
    const onPurpose = await agent.call("create_doc", { markdown, idempotencyKey: "second copy" });
    expect(onPurpose.isError).toBe(false);
    created.push(String(onPurpose.result.id));
    expect(onPurpose.result.id).not.toBe(first.result.id);

    const issuerOnly = await agent.call("create_doc", { markdown: "Just for the issuer.", title: "Issuer's", issuerOnly: true });
    created.push(String(issuerOnly.result.id));
    expect(issuerOnly.result.byline).toBe("E2E Admin");

    // A Markdown body through upload_url and curl, as a local draft goes up.
    const upload = await agent.call("upload_url", { kind: "doc" });
    const posted = await request.post(`${upload.result.url}&title=${encodeURIComponent("From a file")}`, {
      data: Buffer.from("A draft refined in a local file."),
      headers: { "Content-Type": "text/markdown" },
    });
    expect(posted.status()).toBe(201);
    const fromFile = await posted.json();
    created.push(fromFile.id);
    expect(fromFile).toMatchObject({ title: "From a file", visibility: "PRIVATE" });
  } finally {
    for (const id of created) await deleteTestDoc(id);
    await agent.dispose();
  }
});

test("edit_doc: surviving words keep their author and their note, new words are the actor's, and the touched note is named", async ({ request }) => {
  const agent = await createAgent(request);
  const luke = (await getUserIdByEmail(ADMIN_EMAIL))!;
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    body: {
      type: "doc",
      content: [
        p({ text: "An opening paragraph nobody edits.", author: luke }),
        p({ text: "Before the claim. ", author: luke }, { text: "The claim is strong", author: luke, note: "editor-note" }, { text: " after it.", author: luke }),
      ],
    },
  });
  await addTestDocAuthor(doc.id, agent.user.email);
  const column = await createTestAnnotation({
    docId: doc.id,
    authorEmail: ADMIN_EMAIL,
    bodyText: "A reader's note.",
    anchor: { from: 2, to: 9, quotedText: "opening" },
  });
  try {
    const before = await agent.call("read", { url: `/doc/${doc.slug}`, format: "text" });
    const version = String(before.result.version);

    const edited = await agent.call("edit_doc", {
      url: `/doc/${doc.slug}`,
      version,
      edits: [
        { old: "strong", new: "weak" },
        { old: { start: "An opening", end: "edits." }, new: "A first paragraph nobody edits." },
      ],
    });
    expect(edited.isError, JSON.stringify(edited.error)).toBe(false);
    expect(String(edited.result.version)).toMatch(/^\d+$/);
    expect(edited.result.changed).toBe("1-2");
    // The reader's note quoted "opening", which the edit rewrote.
    expect(edited.result.touched).toMatchObject({ annotations: expect.arrayContaining([{ id: column.id, resolves: false }]) });

    const facts = await getDocMarkFacts(doc.id);
    expect(facts.text).toBe("A first paragraph nobody edits.\nBefore the claim. The claim is weak after it.");
    // The editor's note followed the word that replaced its last one.
    expect(facts.annotations["editor-note"]).toBe("The claim is weak");
    // "An opening" became "A first": both words are the agent's, as "weak" is.
    expect(facts.authors[agent.user.email]).toBe("Afirstweak");
    expect(facts.authors[ADMIN_EMAIL]).toContain("Before the claim. The claim is ");

    // Checking the result is a ranged read of the blocks it changed.
    const check = await agent.call("read", { url: `/doc/${doc.slug}`, from: 2, to: 2, format: "text" });
    expect(check.result.text).toBe("Before the claim. The claim is weak after it.");

    const since = await agent.call("read", { url: `/doc/${doc.slug}`, since: version });
    expect((since.result.changes as { diff: string; by: string }[])[1]).toMatchObject({
      diff: "Before the claim. The claim is [-strong-]{+weak+} after it.",
      by: agent.user.name,
    });
  } finally {
    await deleteTestDoc(doc.id);
    await agent.dispose();
  }
});

test("edit_doc lands in an open editor while its writer types elsewhere, and a revert puts the edit back", async ({ request, page }) => {
  const agent = await createAgent(request);
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    bodyText: "The first paragraph, which the agent edits.\n\nThe second paragraph, where a person types.",
  });
  await addTestDocAuthor(doc.id, agent.user.email);
  try {
    await page.goto(`/doc/${doc.id}/edit`);
    await waitForDocCollabReady(page);
    const second = bodyEditor(page).getByText("The second paragraph, where a person types.");
    await second.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Typed while the edit happened.");

    const edited = await agent.call("edit_doc", {
      url: `/doc/${doc.slug}`,
      edits: [{ old: "which the agent edits", new: "which the agent has edited" }],
    });
    expect(edited.isError, JSON.stringify(edited.error)).toBe(false);
    await expect(bodyEditor(page)).toContainText("which the agent has edited");
    await page.keyboard.type(" And after it.");
    await expect(bodyEditor(page)).toContainText("Typed while the edit happened. And after it.");

    const plan = await agent.call("edit_doc", { url: `/doc/${doc.slug}`, revert: String(edited.result.version), dryRun: true });
    expect(plan.result.hunks).toEqual([
      { hunk: 1, diff: "The first paragraph, which the agent [-edits.-]{+has edited.+}" },
    ]);
    const reverted = await agent.call("edit_doc", { url: `/doc/${doc.slug}`, revert: String(edited.result.version) });
    expect(reverted.result.reverted).toEqual([1]);
    await expect(bodyEditor(page)).toContainText("The first paragraph, which the agent edits.");
    await expect(bodyEditor(page)).toContainText("Typed while the edit happened. And after it.");
  } finally {
    await page.goto("about:blank").catch(() => {});
    await deleteTestDoc(doc.id);
    await agent.dispose();
  }
});

test("edit_doc refuses what it should: a missing or repeated passage, a record, a doc it may only read", async ({ request }) => {
  const agent = await createAgent(request);
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: "Twice said. Once more.\n\nTwice said. The end." });
  await addTestDocAuthor(doc.id, agent.user.email);
  const shared = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Readable, not editable." });
  const hidden = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: "Private to the admin." });
  try {
    const url = `/doc/${doc.slug}`;
    const missing = await agent.call("edit_doc", { url, edits: [{ old: "Once mroe", new: "x" }] });
    expect(missing.error.code).toBe("no_match");
    expect((missing.error.nearMisses as { text: string }[])[0].text).toContain("Once more");
    const twice = await agent.call("edit_doc", { url, edits: [{ old: "Twice said.", new: "x" }] });
    expect(twice.error).toMatchObject({ code: "ambiguous", total: 2 });
    const noVersion = await agent.call("edit_doc", { url, edits: [{ old: { start: "Once", end: "more." }, new: "x" }] });
    expect(noVersion.error.code).toBe("invalid");
    expect((await agent.call("edit_doc", { url: `/doc/${shared.slug}`, edits: [{ append: "x" }] })).error.code).toBe("forbidden");
    expect((await agent.call("edit_doc", { url: `/doc/${hidden.slug}`, edits: [{ append: "x" }] })).error.code).toBe("not_found");
    await setTestDocRecord(doc.id, true);
    expect((await agent.call("edit_doc", { url, edits: [{ append: "x" }] })).error.code).toBe("read_only");
  } finally {
    await deleteTestDoc(doc.id);
    await deleteTestDoc(shared.id);
    await deleteTestDoc(hidden.id);
    await agent.dispose();
  }
});
