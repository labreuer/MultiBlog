import { test, expect, bodyEditor, waitForDocCollabReady } from "./fixtures";
import {
  ADMIN_EMAIL,
  addTestDocAuthor,
  createTestAnnotation,
  createTestBot,
  createTestDoc,
  createTestUser,
  deleteTestDoc,
  deleteTestUser,
  getAnnotationStates,
  getDocMarkFacts,
  getDocSearchText,
  getMentionSources,
  getUserIdByEmail,
  setTestDocRecord,
  uniqueEmail,
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
    expect(first.size).toBeLessThan(300);

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

    // A Markdown body through upload and curl, as a local draft goes up.
    const upload = await agent.call("upload", { kind: "doc" });
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
    expect(edited.size).toBeLessThan(500);
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

test("inline code carries the author mark, takes a link or bold, and leaves an edit elsewhere free to land", async ({ request }) => {
  const agent = await createAgent(request);
  let created: string | null = null;
  try {
    const markdown = "Run [`wf_1`](https://example.com/) first.\n\nA plain sentence.";
    const doc = await agent.call("create_doc", { markdown });
    expect(doc.isError, JSON.stringify(doc.error)).toBe(false);
    created = String(doc.result.id);
    expect((await getDocMarkFacts(created)).authors[agent.user.email]).toBe("Run wf_1 first.A plain sentence.");

    const url = String(doc.result.url);
    const edited = await agent.call("edit_doc", { url, edits: [{ old: "A plain sentence.", new: "A **`bold`** sentence." }] });
    expect(edited.isError, JSON.stringify(edited.error)).toBe(false);
    expect(edited.result.changed).toBe("2");
    const read = await agent.call("read", { url });
    expect(read.result.markdown).toBe("Run [`wf_1`](https://example.com/) first.\n\nA **`bold`** sentence.");
  } finally {
    if (created) await deleteTestDoc(created);
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

// docs/ENTITY_CHIPS.md, MCP item 7 — create_doc speaks the Markdown a read
// writes, mentions by handle, so a doc moves between instances with them.
test("create_doc writes a mention from its Markdown, and refuses one that names nobody", async ({ request }) => {
  const agent = await createAgent(request);
  const adaEmail = uniqueEmail("mcp-create-ada");
  const ada = await createTestUser({ email: adaEmail, name: `Ada ${adaEmail.split("@")[0]}`, role: "AUTHOR" });
  const adaMd = `[@${ada.name}](/authors/${ada.slug})`;
  const created: string[] = [];
  try {
    const refused = await agent.call("create_doc", { markdown: "# Notes\n\nAsk [@Nobody](/authors/no-such-handle-e2e)." });
    expect(refused.error).toMatchObject({ code: "unknown_chip", handles: ["no-such-handle-e2e"] });

    // The label in the Markdown is whatever the writer typed; the handle is what is read.
    const made = await agent.call("create_doc", {
      markdown: `# Review notes for [@Somebody](/authors/${ada.slug})\n\nReviewed by [@An Old Name](/authors/${ada.slug}) last week.`,
    });
    expect(made.isError, JSON.stringify(made.error)).toBe(false);
    created.push(String(made.result.id));
    // A title is plain text, and reads as the heading did.
    expect(made.result).toMatchObject({ title: "Review notes for @Somebody" });
    await expect.poll(() => getMentionSources(ada.id)).toEqual([`doc:${made.result.id}`]);

    const read = await agent.call("read", { url: String(made.result.url) });
    expect(read.result.markdown).toBe(`Reviewed by ${adaMd} last week.`);
    // Found by the name from the moment it exists: the cache was written with its label.
    expect(await getDocSearchText(String(made.result.id))).toBe(`Reviewed by @${ada.name} last week.`);

    // And by who it mentions, whatever they are called (docs/MENTIONS.md, "Search").
    const mentioning = await agent.call("search", { mentions: [ada.slug], kinds: ["docs"] });
    expect(mentioning.isError, JSON.stringify(mentioning.error)).toBe(false);
    expect(JSON.stringify(mentioning.result.sections)).toContain(String(made.result.url));
    const nobody = await agent.call("search", { mentions: ["no-such-handle-e2e"], kinds: ["docs"] });
    expect((nobody.result.sections as { total: number }[])[0].total).toBe(0);
  } finally {
    for (const id of created) await deleteTestDoc(id);
    await deleteTestUser(adaEmail);
    await agent.dispose();
  }
});

// docs/ENTITY_CHIPS.md, MCP items 2, 5 and 6 — an edit where the doc holds a
// mention: written back as Markdown it stays the same mention, a new one is
// resolved under the rule the menu lists by, and nothing is removed silently.
test("edit_doc keeps a mention it writes back, adds one by handle, and refuses or reports the rest", async ({ request }) => {
  const agent = await createAgent(request);
  const adaEmail = uniqueEmail("mcp-ada");
  const graceEmail = uniqueEmail("mcp-grace");
  const readerEmail = uniqueEmail("mcp-reader");
  const ada = await createTestUser({ email: adaEmail, name: `Ada ${adaEmail.split("@")[0]}`, role: "AUTHOR" });
  const grace = await createTestUser({ email: graceEmail, name: `Grace ${graceEmail.split("@")[0]}`, role: "AUTHOR" });
  const reader = await createTestUser({ email: readerEmail, name: `Reader ${readerEmail.split("@")[0]}`, role: "AUTHORIZED" });
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    body: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "The engine was reviewed by " },
            { type: "entityChip", attrs: { kind: "mention", iid: "m1", data: { userId: ada.id } } },
            { type: "text", text: " last week." },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "A second paragraph." }] },
      ],
    },
  });
  await addTestDocAuthor(doc.id, agent.user.email);
  const url = `/doc/${doc.slug}`;
  const adaMd = `[@${ada.name}](/authors/${ada.slug})`;
  const graceMd = `[@${grace.name}](/authors/${grace.slug})`;
  try {
    // Rewritten around the mention, which is written as the read showed it.
    const kept = await agent.call("edit_doc", {
      url,
      edits: [{ old: `reviewed by @${ada.name} last week`, new: `reviewed and signed off by ${adaMd} last month` }],
    });
    expect(kept.isError, JSON.stringify(kept.error)).toBe(false);
    expect(kept.result.mentionsRemoved).toBeUndefined();
    expect(kept.result.mentionsAdded).toBeUndefined();
    let read = await agent.call("read", { url });
    expect(String(read.result.markdown)).toContain(`reviewed and signed off by ${adaMd} last month.`);
    // The same chip, not a new one: the index row is the one it had.
    expect(await getMentionSources(ada.id)).toEqual([`doc:${doc.id}`]);

    // The name in plain words where the mention was is refused, with how to say either thing.
    const asText = await agent.call("edit_doc", {
      url,
      edits: [{ old: `signed off by @${ada.name} last month`, new: `signed off by ${ada.name} last month` }],
    });
    expect(asText.error).toMatchObject({ code: "chip_as_text", labels: [`@${ada.name}`] });

    // A new mention, by handle, of someone the agent may mention.
    const added = await agent.call("edit_doc", { url, edits: [{ old: "A second paragraph.", new: `A second paragraph, for ${graceMd}.` }] });
    expect(added.isError, JSON.stringify(added.error)).toBe(false);
    expect(added.result).toMatchObject({ mentionsAdded: 1 });
    await expect.poll(() => getMentionSources(grace.id)).toEqual([`doc:${doc.id}`]);

    // Not of someone the menu wouldn't list, nor of a handle nobody has.
    const refused = await agent.call("edit_doc", {
      url,
      edits: [{ append: `Thanks to [@${reader.name}](/authors/${reader.slug}).` }],
    });
    expect(refused.error).toMatchObject({ code: "unknown_chip", handles: [reader.slug] });
    const nobody = await agent.call("edit_doc", { url, edits: [{ append: "Thanks to [@Nobody](/authors/no-such-handle-e2e)." }] });
    expect(nobody.error).toMatchObject({ code: "unknown_chip", handles: ["no-such-handle-e2e"] });
    // An escaped @ is a link, whoever it points at.
    const link = await agent.call("edit_doc", { url, edits: [{ append: `See [\\@${reader.name}](/authors/${reader.slug}).` }] });
    expect(link.isError, JSON.stringify(link.error)).toBe(false);
    expect(link.result.mentionsAdded).toBeUndefined();

    // Leaving a mention out removes it, and the answer says which.
    const removed = await agent.call("edit_doc", {
      url,
      edits: [{ old: `reviewed and signed off by @${ada.name} last month`, new: "reviewed last month" }],
    });
    expect(removed.isError, JSON.stringify(removed.error)).toBe(false);
    expect(removed.result).toMatchObject({ mentionsRemoved: [`@${ada.name}`] });
    await expect.poll(() => getMentionSources(ada.id)).toEqual([]);

    read = await agent.call("read", { url });
    const markdown = String(read.result.markdown);
    expect(markdown).toContain("The engine was reviewed last month.");
    expect(markdown).toContain(`A second paragraph, for ${graceMd}.`);
    expect(markdown).toContain(`See [\\@${reader.name}](/authors/${reader.slug}).`);
  } finally {
    await deleteTestDoc(doc.id);
    for (const email of [adaEmail, graceEmail, readerEmail]) await deleteTestUser(email);
    await agent.dispose();
  }
});

test("add_note and edit_note write a mention from Markdown, and keep it through an edit", async ({ request }) => {
  const agent = await createAgent(request);
  const adaEmail = uniqueEmail("mcp-note-ada");
  const ada = await createTestUser({ email: adaEmail, name: `Ada ${adaEmail.split("@")[0]}`, role: "AUTHOR" });
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "A doc to leave a note on." });
  const adaMd = `[@${ada.name}](/authors/${ada.slug})`;
  try {
    const note = await agent.call("add_note", { on: `/doc/${doc.slug}`, body: `Could ${adaMd} check this?` });
    expect(note.isError, JSON.stringify(note.error)).toBe(false);
    await expect.poll(() => getMentionSources(ada.id)).toEqual([`annotation:${note.result.id}`]);
    let [row] = await getAnnotationStates(doc.id);
    expect(row.bodyText).toBe(`Could @${ada.name} check this?`);

    const edited = await agent.call("edit_note", { id: String(note.result.id), body: `Could ${adaMd} check this today?` });
    expect(edited.isError, JSON.stringify(edited.error)).toBe(false);
    [row] = await getAnnotationStates(doc.id);
    expect(row.bodyText).toBe(`Could @${ada.name} check this today?`);
    expect(await getMentionSources(ada.id)).toEqual([`annotation:${note.result.id}`]);

    // It reads back as it was written.
    const thread = await agent.call("read", { url: `/doc/${doc.slug}`, include: ["annotations"] });
    expect(JSON.stringify(thread.result.threads)).toContain(`Could ${adaMd} check this today?`);

    const asText = await agent.call("edit_note", { id: String(note.result.id), body: `Could ${ada.name} check this today?` });
    expect(asText.error).toMatchObject({ code: "chip_as_text" });
  } finally {
    await deleteTestDoc(doc.id);
    await deleteTestUser(adaEmail);
    await agent.dispose();
  }
});

// docs/MENTIONS.md, "Who is listed" — the clauses about bots. The agent is a
// bot itself, working for the suite's admin, so "its own bots" are that
// person's.
test("a bot may mention itself and its person's bots, and another person's bot only where that bot takes part", async ({ request }) => {
  const agent = await createAgent(request);
  const adaEmail = uniqueEmail("mcp-bots-ada");
  const siblingEmail = uniqueEmail("mcp-bots-sibling");
  const otherEmail = uniqueEmail("mcp-bots-other");
  await createTestUser({ email: adaEmail, name: `Ada ${adaEmail.split("@")[0]}`, role: "AUTHOR" });
  const sibling = await createTestBot({ email: siblingEmail, worksForEmail: ADMIN_EMAIL, name: `Sibling ${siblingEmail.split("@")[0]}` });
  const other = await createTestBot({ email: otherEmail, worksForEmail: adaEmail, name: `Other ${otherEmail.split("@")[0]}` });
  const noted = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "A doc the other bot leaves a note on." });
  const bylined = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "A doc the other bot is an author of." });
  const neither = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "A doc the other bot has nothing to do with." });
  const md = (user: { name: string | null; slug: string }) => `[@${user.name}](/authors/${user.slug})`;
  const note = (doc: { slug: string }, body: string) => agent.call("add_note", { on: `/doc/${doc.slug}`, body });
  try {
    // Itself, and its person's other bot, anywhere.
    const own = await note(neither, `From ${md(agent.user)}, with ${md(sibling)}.`);
    expect(own.isError, JSON.stringify(own.error)).toBe(false);
    await expect.poll(() => getMentionSources(sibling.id)).toEqual([`annotation:${own.result.id}`]);

    // Another person's bot: nowhere yet.
    for (const doc of [noted, bylined, neither]) {
      const refused = await note(doc, `Ask ${md(other)}.`);
      expect(refused.error).toMatchObject({ code: "unknown_chip", handles: [other.slug] });
    }

    // Once it has written a note on a doc, or is on its byline, it can be mentioned there.
    await createTestAnnotation({ docId: noted.id, authorEmail: otherEmail, bodyText: "A note from the other bot." });
    await addTestDocAuthor(bylined.id, otherEmail);
    for (const doc of [noted, bylined]) {
      const allowed = await note(doc, `Ask ${md(other)}.`);
      expect(allowed.isError, JSON.stringify(allowed.error)).toBe(false);
    }
    const still = await note(neither, `Ask ${md(other)}.`);
    expect(still.error).toMatchObject({ code: "unknown_chip", handles: [other.slug] });
  } finally {
    for (const doc of [noted, bylined, neither]) await deleteTestDoc(doc.id);
    await agent.dispose();
    for (const email of [siblingEmail, otherEmail, adaEmail]) await deleteTestUser(email);
  }
});

// docs/ENTITY_CHIPS.md, step 1, item 11 — an anchor's chip record, from the
// machine side: a note and a link on a passage holding a mention keep which
// mention, are shown with its label where only the stored quote is read, and
// stop resolving once the passage names someone else, though its stored text
// (a placeholder where the chip is) reads the same.
test("an anchor on a passage with a mention shows its label, and is lost when the mention becomes someone else's", async ({ request }) => {
  const agent = await createAgent(request);
  const adaEmail = uniqueEmail("mcp-anchor-ada");
  const graceEmail = uniqueEmail("mcp-anchor-grace");
  const ada = await createTestUser({ email: adaEmail, name: `Ada ${adaEmail.split("@")[0]}`, role: "AUTHOR" });
  const grace = await createTestUser({ email: graceEmail, name: `Grace ${graceEmail.split("@")[0]}`, role: "AUTHOR" });
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    body: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "The engine was reviewed by " },
            { type: "entityChip", attrs: { kind: "mention", iid: "m1", data: { userId: ada.id } } },
            { type: "text", text: " last week." },
          ],
        },
      ],
    },
  });
  await addTestDocAuthor(doc.id, agent.user.email);
  const url = `/doc/${doc.slug}`;
  try {
    const note = await agent.call("add_note", { on: url, body: "Which review?", quote: `reviewed by @${ada.name}` });
    expect(note.isError, JSON.stringify(note.error)).toBe(false);
    const [row] = await getAnnotationStates(doc.id);
    expect(row).toMatchObject({
      quotedText: "reviewed by ￼",
      anchorChips: [{ at: 12, kind: "mention", iid: "m1", data: { userId: ada.id }, label: `@${ada.name}` }],
    });
    const minted = await agent.call("create_link", { links: [{ parts: [{ on: url, quote: `reviewed by @${ada.name} last week` }] }] });
    expect(minted.isError, JSON.stringify(minted.error)).toBe(false);
    const link = (minted.result.links as { url: string }[])[0].url;
    const linkRead = await agent.call("read", { url: link });
    expect(JSON.stringify(linkRead.result)).toContain(`reviewed by @${ada.name} last week`);
    expect(JSON.stringify(linkRead.result)).not.toContain("￼");

    // The same words around a different person. Both anchors' text still reads the same.
    const swapped = await agent.call("edit_doc", {
      url,
      edits: [{ old: `reviewed by @${ada.name} last week`, new: `reviewed by [@${grace.name}](/authors/${grace.slug}) last week` }],
    });
    expect(swapped.isError, JSON.stringify(swapped.error)).toBe(false);
    expect(swapped.result).toMatchObject({
      mentionsRemoved: [`@${ada.name}`],
      mentionsAdded: 1,
      touched: { annotations: [{ id: note.result.id, resolves: false }], links: [{ link, resolves: false }] },
    });

    // Each keeps what it was about, by name, as a lost anchor does.
    const threads = await agent.call("read", { url, include: ["annotations"], format: "text" });
    expect(JSON.stringify(threads.result.threads)).toContain(`reviewed by @${ada.name}`);
    const linkAfter = await agent.call("read", { url: link });
    expect(JSON.stringify(linkAfter.result)).toContain(`reviewed by @${ada.name} last week`);
    expect(JSON.stringify(linkAfter.result)).toContain('"lost":true');
  } finally {
    await deleteTestDoc(doc.id);
    for (const email of [adaEmail, graceEmail]) await deleteTestUser(email);
    await agent.dispose();
  }
});

// docs/ENTITY_CHIPS.md, "Styling" — a doc's style, from the machine side:
// edit_doc sets it, a read says what is set and shows every mention in it,
// and what changed since a version names it.
test("edit_doc sets how a doc shows its mentions, and reads report and follow it", async ({ request }) => {
  const agent = await createAgent(request);
  const adaEmail = uniqueEmail("mcp-style-ada");
  const ada = await createTestUser({ email: adaEmail, name: `Ada ${adaEmail.split("@")[0]}`, role: "AUTHOR" });
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    body: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Reviewed by " },
            { type: "entityChip", attrs: { kind: "mention", iid: "m1", data: { userId: ada.id } } },
            { type: "text", text: "." },
          ],
        },
      ],
    },
  });
  await addTestDocAuthor(doc.id, agent.user.email);
  const url = `/doc/${doc.slug}`;
  try {
    const before = await agent.call("read", { url, format: "text" });
    expect(before.result.styles).toBeUndefined();
    expect(String(before.result.text)).toContain(`Reviewed by @${ada.name}.`);

    const styled = await agent.call("edit_doc", { url, settings: { mentions: { form: "handle" } } });
    expect(styled.isError, JSON.stringify(styled.error)).toBe(false);
    expect(styled.result).toMatchObject({ settings: "changed" });

    const after = await agent.call("read", { url, format: "text" });
    expect(after.result.styles).toEqual({ mentions: { form: "handle" } });
    expect(String(after.result.text)).toContain(`Reviewed by @${ada.slug}.`);
    // A quote of what is read now finds the mention, as one of the old label no longer does.
    const around = await agent.call("read", { url, around: `Reviewed by @${ada.slug}`, format: "text" });
    expect(around.result.total).toBe(1);
    // What search and every static render read follows.
    await expect.poll(() => getDocSearchText(doc.id), { timeout: 15_000 }).toBe(`Reviewed by @${ada.slug}.`);

    // The style is a change of its own in the history, beside the block that reads differently for it.
    const since = await agent.call("read", { url, since: String(before.result.version) });
    expect(since.result).toMatchObject({ settings: { was: null, now: { mentions: { form: "handle" } } }, changes: [{ block: 1 }] });

    // Setting what is already set changes nothing, and null puts the default back.
    // (Spelled another way: the very same call again is answered as a repeat, before it is looked at.)
    const again = await agent.call("edit_doc", { url, settings: { mentions: { form: "handle", at: null } } });
    expect(again.result).toMatchObject({ unchanged: true });
    const cleared = await agent.call("edit_doc", { url, settings: { mentions: null } });
    expect(cleared.result).toMatchObject({ settings: "changed" });
    expect((await agent.call("read", { url })).result.styles).toBeUndefined();
  } finally {
    await deleteTestDoc(doc.id);
    await deleteTestUser(adaEmail);
    await agent.dispose();
  }
});
