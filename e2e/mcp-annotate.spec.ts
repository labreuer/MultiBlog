import { test, expect } from "./fixtures";
import {
  ADMIN_EMAIL,
  createTestAnnotation,
  createTestDoc,
  createTestFile,
  deleteTestDoc,
  deleteTestFile,
  getAnnotationEditFacts,
  getAnnotationStates,
  getFileAnnotationFacts,
  getReplyAnchorFacts,
} from "./db";
import { createAgent } from "./mcp";

// docs/MCP.md §9: notes an agent posts through the MCP server — LIVE in one
// call, on the whole or anchored by quote (into a doc at the version read, a
// PDF page with server quads, or a parent's body), and rewritten with every
// version kept.

test("annotate a doc: on the whole, by quote at a version, a reply, a reply quoting its parent, and the refusals", async ({ request }) => {
  const agent = await createAgent(request);
  const doc = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    bodyText: "The fox jumps over the dog. The dog sleeps.\n\nA second paragraph about the dog.",
  });
  try {
    const read = await agent.call("read", { url: `/doc/${doc.slug}` });
    const version = String(read.result.version);

    const whole = await agent.call("annotate", { on: `/doc/${doc.slug}`, body: "A note on the whole doc." });
    expect(whole.isError, JSON.stringify(whole.error)).toBe(false);
    expect(String(whole.result.card)).toMatch(new RegExp(`^/doc/${doc.slug}#e2e-bot-`));
    expect(whole.result.passage).toBeUndefined();

    const quoted = await agent.call("annotate", { on: `/doc/${doc.slug}`, body: "Which fox?", quote: "The fox jumps", version });
    expect(quoted.isError, JSON.stringify(quoted.error)).toBe(false);
    expect(quoted.result).toMatchObject({ version, passage: { text: "The fox jumps" } });

    // A repeat of the same call is the same note, not a second one.
    const again = await agent.call("annotate", { on: `/doc/${doc.slug}`, body: "Which fox?", quote: "The fox jumps", version });
    expect(again.error).toMatchObject({ code: "already_done", result: { id: quoted.result.id } });

    const states = await getAnnotationStates(doc.id);
    const row = states.find((s) => s.id === quoted.result.id)!;
    expect(row).toMatchObject({ marked: false, quotedText: "The fox jumps", ydocUpdateId: version, quoteMatchesAtStamp: true });
    expect(states.find((s) => s.id === whole.result.id)).toMatchObject({ anchored: false, marked: false });

    const reply = await agent.call("annotate", { on: String(quoted.result.id), body: "The quick brown one." });
    expect(reply.result.replyTo).toBe(quoted.result.id);
    // By its card, as a person's link to it reads — unless two of this
    // writer's notes were opened within the same second, which share a card.
    const byCard = await agent.call("annotate", { on: String(quoted.result.card), body: "Or the lazy one." });
    if (quoted.result.card === whole.result.card) expect(byCard.error.code).toBe("ambiguous");
    else expect(byCard.result.replyTo).toBe(quoted.result.id);

    // The note reads back where a person sees it.
    const threads = await agent.call("read", { url: `/doc/${doc.slug}`, include: ["annotations"] });
    const listed = JSON.stringify(threads.result.threads);
    expect(listed).toContain("Which fox?");
    expect(listed).toContain("The quick brown one.");

    const missing = await agent.call("annotate", { on: `/doc/${doc.slug}`, body: "x", quote: "The cat jumps" });
    expect(missing.error.code).toBe("no_match");
    expect((missing.error.nearMisses as { text: string }[]).length).toBeGreaterThan(0);
    const twice = await agent.call("annotate", { on: `/doc/${doc.slug}`, body: "x", quote: "the dog" });
    expect(twice.error.code).toBe("ambiguous");
    const badVersion = await agent.call("annotate", { on: `/doc/${doc.slug}`, body: "x", quote: "The fox jumps", version: "1" });
    expect(badVersion.error.code).toBe("invalid");
  } finally {
    await deleteTestDoc(doc.id);
    await agent.dispose();
  }
});

test("a reply quoting its parent anchors inside the parent's body", async ({ request }) => {
  const agent = await createAgent(request);
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "A doc to discuss." });
  const parent = await createTestAnnotation({ docId: doc.id, authorEmail: ADMIN_EMAIL, bodyText: "Consider the second clause, then the first." });
  try {
    const reply = await agent.call("annotate", { on: parent.id, body: "Done.", quote: "the second clause" });
    expect(reply.isError, JSON.stringify(reply.error)).toBe(false);
    expect(reply.result.passage).toEqual({ text: "the second clause" });
    expect(await getReplyAnchorFacts(parent.id)).toEqual({ quotedText: "the second clause", textAtStamp: "the second clause" });
  } finally {
    await deleteTestDoc(doc.id);
    await agent.dispose();
  }
});

test("annotate a PDF: the quote is cut from the server's own page text, with quads, narrowed by page", async ({ request }) => {
  const agent = await createAgent(request);
  const file = await createTestFile({
    ownerEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    pages: [
      ["The first page speaks of participation.", "It says little else."],
      ["The second page speaks of participation too.", "And of original participation."],
    ],
  });
  try {
    const twice = await agent.call("annotate", { on: `/pdf/${file.slug}`, body: "x", quote: "speaks of participation" });
    expect(twice.error.code).toBe("ambiguous");

    const posted = await agent.call("annotate", { on: `/pdf/${file.slug}`, body: "Barfield's word.", quote: "speaks of participation", page: 2 });
    expect(posted.isError, JSON.stringify(posted.error)).toBe(false);
    expect(posted.result.passage).toMatchObject({ text: "speaks of participation", page: 2 });

    const [facts] = await getFileAnnotationFacts(file.id);
    expect(facts.pageIndex).toBe(1);
    expect(facts.quadCount).toBeGreaterThan(0);
    expect(facts.quotedText).toBe("speaks of participation");
    expect(facts.pageTextAtTarget!.slice(facts.position!.start, facts.position!.end)).toBe(facts.quotedText);

    const wrongPage = await agent.call("annotate", { on: `/pdf/${file.slug}`, body: "x", quote: "original participation", page: 1 });
    expect(wrongPage.error.code).toBe("no_match");
  } finally {
    await deleteTestFile(file.id);
    await agent.dispose();
  }
});

test("edit_annotation: a new version, its marks kept, nothing for an unchanged body, and only the writer", async ({ request }) => {
  const agent = await createAgent(request);
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Something to note." });
  const theirs = await createTestAnnotation({ docId: doc.id, authorEmail: ADMIN_EMAIL, bodyText: "The admin's note." });
  try {
    const posted = await agent.call("annotate", { on: `/doc/${doc.slug}`, body: "A first thought." });
    const id = String(posted.result.id);

    const edited = await agent.call("edit_annotation", { id, body: "A second thought, **better**." });
    expect(edited.isError, JSON.stringify(edited.error)).toBe(false);
    expect(edited.result.card).toBe(posted.result.card);
    const facts = await getAnnotationEditFacts(id);
    expect(facts).toMatchObject({ bodyText: "A second thought, better.", editingSince: null });
    expect(facts!.versions.map((v) => v.bodyText)).toEqual(["A first thought.", "A second thought, better."]);
    expect(facts!.editedAt).not.toBeNull();

    const read = await agent.call("read", { url: id });
    expect(read.result.body).toBe("A second thought, **better**.");

    const same = await agent.call("edit_annotation", { id, body: "A second thought, **better**." });
    expect(same.result.unchanged).toBe(true);
    expect((await getAnnotationEditFacts(id))!.versions).toHaveLength(2);

    expect((await agent.call("edit_annotation", { id: theirs.id, body: "Mine now." })).error.code).toBe("forbidden");
  } finally {
    await deleteTestDoc(doc.id);
    await agent.dispose();
  }
});
