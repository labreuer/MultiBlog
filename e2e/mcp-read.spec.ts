import { test, expect, QUOTED_BODY, QUOTED_TEXT, QUOTE_FROM, QUOTE_TO } from "./fixtures";
import {
  ADMIN_EMAIL,
  appendTestDocParagraph,
  createComment,
  createTestAnchoredLink,
  createTestAnnotation,
  createTestDoc,
  createTestFile,
  createTestTag,
  createTestUser,
  deleteTestAnchoredLink,
  deleteTestDoc,
  deleteTestFile,
  deleteTestTag,
  deleteTestUser,
  renameTestTagSlug,
  restoreTestUser,
  softDeleteTestUser,
  tagWithTestTag,
  uniqueEmail,
  uniqueTitle,
} from "./db";
import { callTool, createAgent, mcpRequest } from "./mcp";
import { readTar } from "../src/lib/tar";

// docs/MCP.md, phase 1 (§18): tokens, the endpoint, and every read — driven
// from below the UI through Playwright's `request` fixture, as a machine
// client drives it. What is asserted is what the model reads: each result's
// structured form, its one handle per object, and its size, held to a budget
// so a field added later has to earn its place (§4).

const heading = (level: number, text: string) => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });
const para = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

test("a token authenticates, names its actor and issuer, and lists only what its scopes and client allow", async ({ request }) => {
  expect((await mcpRequest(request, null, "tools/list")).status).toBe(401);
  expect((await mcpRequest(request, "mb_not-a-real-token", "tools/list")).status).toBe(401);

  const reader = await createAgent(request, { scopes: ["READ"], client: "OTHER" });
  const writer = await createAgent(request, { scopes: ["READ", "WRITE"], client: "CLAUDE_CODE" });
  try {
    const init = await mcpRequest(request, reader.secret, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    const instructions = String(init.body.result?.instructions);
    expect(instructions).toContain(`You act as ${reader.user.name}`);
    expect(instructions).toContain("issued by E2E Admin");
    // Claude Code cuts the instructions at 2,048 characters (§5).
    expect(instructions.length).toBeLessThanOrEqual(2048);
    expect(instructions).not.toContain("Writing:");

    const readerTools = (await mcpRequest(request, reader.secret, "tools/list")).body.result?.tools as {
      name: string;
      _meta: Record<string, unknown>;
      annotations: Record<string, unknown>;
    }[];
    expect(readerTools.map((t) => t.name)).toEqual(["search", "read", "find_users", "find_tags", "download_url"]);
    const read = readerTools.find((t) => t.name === "read")!;
    expect(read._meta["anthropic/alwaysLoad"]).toBe(true);
    expect(read._meta["anthropic/maxResultSizeChars"]).toBe(200000);
    expect(read.annotations.readOnlyHint).toBe(true);
    expect(read.annotations.openWorldHint).toBe(false);

    const writerInit = await mcpRequest(request, writer.secret, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    expect(String(writerInit.body.result?.instructions)).toContain("Writing:");
    expect(String(writerInit.body.result?.instructions).length).toBeLessThanOrEqual(2048);
    const writerTools = ((await mcpRequest(request, writer.secret, "tools/list")).body.result?.tools as { name: string }[]).map((t) => t.name);
    expect(writerTools).toContain("upload_url");

    // A tool the token doesn't list is refused as a tool, not run.
    const refused = await reader.call("upload_url", { kind: "doc" });
    expect(refused.isError).toBe(true);
    expect(refused.error.code).toBe("invalid");
  } finally {
    await reader.dispose();
    await writer.dispose();
  }
});

test("a deleted account's token and its grants stop working, and restoring the account brings neither back", async ({ request }) => {
  const agent = await createAgent(request);
  const file = await createTestFile({ ownerEmail: agent.user.email });
  try {
    expect((await agent.call("search", { q: "anything", exact: true })).isError).toBe(false);
    const grant = await agent.call("download_url", { file: `/pdf/${file.slug}` });
    expect(grant.isError).toBe(false);
    const url = String(grant.result.url);
    expect((await request.get(url)).status()).toBe(200);

    await softDeleteTestUser(agent.user.email, ADMIN_EMAIL);
    expect((await mcpRequest(request, agent.secret, "tools/list")).status).toBe(401);
    expect((await request.get(url)).status()).toBe(401);

    await restoreTestUser(agent.user.email);
    expect((await mcpRequest(request, agent.secret, "tools/list")).status).toBe(401);
    expect((await request.get(url)).status()).toBe(401);
  } finally {
    await deleteTestFile(file.id);
    await agent.dispose();
  }
});

test("search: a strict parse, one handle per hit, sizes, exact, authors and tags", async ({ request }) => {
  const agent = await createAgent(request, { scopes: ["READ"] });
  const word = `zygomorph${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 6)}`;
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: `A paragraph mentioning ${word} once.` });
  const tag = await createTestTag({ creatorEmail: ADMIN_EMAIL });
  try {
    await tagWithTestTag({ tagId: tag.id, target: { kind: "doc", id: doc.id }, taggerEmail: ADMIN_EMAIL });

    const found = await agent.call("search", { q: word, kinds: ["docs"], exact: true });
    expect(found.isError).toBe(false);
    const section = (found.result.sections as { kind: string; total: number; hits: Record<string, unknown>[] }[])[0];
    expect(section.total).toBe(1);
    const hit = section.hits[0];
    expect(hit.url).toBe(`/doc/${doc.slug}`);
    expect(hit).not.toHaveProperty("id");
    expect(hit.chars).toBeGreaterThan(0);
    expect(hit.byline).toBe("E2E Admin");
    expect(String(hit.snippet)).toContain(`**${word}**`);
    // One hit, lean: well under what the page's own hit object costs.
    expect(found.size).toBeLessThan(700);

    // What the page's parse would quietly change, refused instead.
    expect((await agent.call("search", { q: word, kinds: ["doc"] })).error.code).toBe("invalid");
    expect((await agent.call("search", { q: word, created_from: "2026-02-30" })).error.code).toBe("invalid");
    expect((await agent.call("search", { q: word, tz: "Mars/Olympus" })).error.code).toBe("invalid");
    expect((await agent.call("search", { q: word, extra: 1 })).error.code).toBe("invalid");
    const unknown = await agent.call("search", { q: word, authors: ["nobody-at-all-here"] });
    expect(unknown.error.code).toBe("unknown_author");
    expect(unknown.error.slugs).toEqual(["nobody-at-all-here"]);

    // An author filter leaves out the kinds that name no author, and says so.
    const byAdmin = await agent.call("search", { q: word, authors: ["e2e-admin"] });
    expect(byAdmin.isError).toBe(false);
    expect(byAdmin.result.withoutAuthors).toEqual(expect.arrayContaining(["pdfs", "comments"]));

    // Listing by tag: no q, what carries the term.
    const tagged = await agent.call("search", { tags: [tag.slug], kinds: ["docs"] });
    expect((tagged.result.sections as { hits: { url: string }[] }[])[0].hits.map((h) => h.url)).toEqual([`/doc/${doc.slug}`]);

    // A miss with exact stays a miss; nothing is corrected behind the reader's back.
    const misspelt = await agent.call("search", { q: `${word}x`, kinds: ["docs"], exact: true });
    expect((misspelt.result.sections as { total: number }[])[0].total).toBe(0);
    expect(misspelt.result.corrected).toBeUndefined();
  } finally {
    await deleteTestTag(tag.id);
    await deleteTestDoc(doc.id);
    await agent.dispose();
  }
});

test("reading a doc: whole, its outline, a section, blocks, around a quote, text, and what changed since", async ({ request }) => {
  const agent = await createAgent(request, { scopes: ["READ"] });
  const repeated = "The same sentence appears twice in this doc.";
  const short = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    body: {
      type: "doc",
      content: [
        heading(2, "Luke"),
        para("What did Barfield mean by participation?"),
        heading(2, "Claude"),
        para(`Barfield distinguished “original” from final participation. ${repeated}`),
        heading(3, "Idolatry"),
        para(repeated),
      ],
    },
  });
  const filler = "Filler words that make a long doc long, sentence after sentence, for the outline. ".repeat(20);
  const long = await createTestDoc({
    authorEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    body: {
      type: "doc",
      content: Array.from({ length: 30 }, (_, i) => [heading(2, `Part ${i + 1}`), para(filler)]).flat(),
    },
  });
  try {
    const whole = await agent.call("read", { url: `/doc/${short.slug}` });
    expect(whole.result.kind).toBe("doc");
    expect(whole.result.id).toBe(short.id);
    expect(whole.result.byline).toBe("E2E Admin");
    expect(whole.result.blocks).toBe(6);
    expect(String(whole.result.markdown)).toContain("## Luke");
    const version = String(whole.result.version);
    expect(version).toMatch(/^\d+$/);

    const outline = await agent.call("read", { url: `/doc/${long.slug}` });
    expect(outline.result).not.toHaveProperty("markdown");
    const entries = (outline.result.outline as { entries: { block: number; chars: number }[] }).entries;
    expect(entries).toHaveLength(30);
    expect(entries[1].block).toBe(3);
    expect(entries[0].chars).toBeGreaterThan(1600);
    // The outline costs a fraction of the doc it describes.
    expect(outline.size).toBeLessThan(4000);

    const section = await agent.call("read", { url: `/doc/${short.slug}`, section: "Claude" });
    expect(section.result).toMatchObject({ kind: "doc-blocks", from: 3, to: 6, version });
    const ambiguous = await agent.call("read", { url: `/doc/${short.slug}`, section: "Missing" });
    expect(ambiguous.error.code).toBe("not_found");

    const blocks = await agent.call("read", { url: `/doc/${short.slug}`, from: 2, to: 2, format: "text" });
    expect(blocks.result.text).toBe("What did Barfield mean by participation?");

    // Straight quotes typed against the doc's curly ones.
    const around = await agent.call("read", { url: `/doc/${short.slug}`, around: 'distinguished "original" from', context: 0 });
    expect(around.result).toMatchObject({ kind: "doc-around", total: 1 });
    expect((around.result.occurrences as { in: string; heading: string }[])[0]).toMatchObject({ in: "4", heading: "Claude" });
    const twice = await agent.call("read", { url: `/doc/${short.slug}`, around: repeated });
    expect(twice.result.total).toBe(2);
    const miss = await agent.call("read", { url: `/doc/${short.slug}`, around: "Barfield distinguished original from initial participation" });
    expect(miss.error.code).toBe("no_match");
    expect((miss.error.nearMisses as { text: string }[]).length).toBeGreaterThan(0);

    const added = "A sentence added after the first read.";
    await appendTestDocParagraph({ docId: short.id, text: added, authorEmail: ADMIN_EMAIL });
    const since = await agent.call("read", { url: `/doc/${short.slug}`, since: version });
    expect(since.result).toMatchObject({ kind: "doc-changes", since: version });
    expect(since.result.changes).toEqual([{ block: 7, heading: "Idolatry", added, by: "E2E Admin" }]);
    expect((await agent.call("read", { url: `/doc/${short.slug}`, since: "1" })).error.code).toBe("invalid");

    expect((await agent.call("read", { url: "/doc/no-such-doc-anywhere" })).error.code).toBe("not_found");
    expect((await agent.call("read", { url: "/search?q=x" })).error.code).toBe("invalid");
  } finally {
    await deleteTestDoc(short.id);
    await deleteTestDoc(long.id);
    await agent.dispose();
  }
});

test("reading a PDF: the file with its labels and outline, pages, around a quote, and a fragment link as its passage", async ({ request }) => {
  const agent = await createAgent(request, { scopes: ["READ"] });
  const file = await createTestFile({
    ownerEmail: ADMIN_EMAIL,
    visibility: "SHARED",
    pages: [["Front matter page."], ["The first chapter opens here.", "Distinctive phrase: xylophone marmalade."], ["Second chapter text."]],
    pageLabels: [{ from: 1, style: "r" }, { from: 2, style: "D" }],
    outline: [{ title: "Chapter one", page: 2 }, { title: "Chapter two", page: 3 }],
  });
  try {
    const meta = await agent.call("read", { url: `/pdf/${file.slug}` });
    expect(meta.result).toMatchObject({ kind: "pdf", id: file.id, pages: 3 });
    expect(meta.result.labels).toEqual([
      { sheets: "1", labels: "i" },
      { sheets: "2-3", labels: "1-2" },
    ]);
    expect((meta.result.outline as { entries: unknown[] }).entries).toEqual([
      { depth: 1, title: "Chapter one", page: 2, label: "1", pages: 1 },
      { depth: 1, title: "Chapter two", page: 3, label: "2", pages: 1 },
    ]);

    const page = await agent.call("read", { url: `/pdf/${file.slug}#page=2` });
    expect((page.result.pages as { page: number; label: string; text: string }[])[0]).toMatchObject({ page: 2, label: "1" });
    const byLabel = await agent.call("read", { url: `/pdf/${file.slug}`, label: "2" });
    expect((byLabel.result.pages as { page: number }[]).map((p) => p.page)).toEqual([3]);
    const entry = await agent.call("read", { url: `/pdf/${file.slug}`, entry: "Chapter two" });
    expect((entry.result.pages as { text: string }[])[0].text).toContain("Second chapter");

    const around = await agent.call("read", { url: `/pdf/${file.slug}`, around: "xylophone marmalade" });
    expect(around.result).toMatchObject({ kind: "pdf-around", total: 1 });
    expect((around.result.occurrences as { page: number; text: string }[])[0]).toMatchObject({ page: 2, text: "xylophone marmalade" });

    const passage = await agent.call("read", { url: `/pdf/${file.slug}#page=2&text=xylophone%20marmalade` });
    expect(passage.result.kind).toBe("pdf-passages");
    expect((passage.result.passages as { text: string; before: string }[])[0]).toMatchObject({ text: "xylophone marmalade" });
    const missed = await agent.call("read", { url: `/pdf/${file.slug}#page=3&text=xylophone%20marmalade` });
    expect(missed.error.code).toBe("no_match");
    expect(missed.error.foundOnPage).toBe(2);
  } finally {
    await deleteTestFile(file.id);
    await agent.dispose();
  }
});

test("annotation threads: on a doc, filtered, at /annotations, and one alone by id and by its card", async ({ request, sharedDoc }) => {
  const agent = await createAgent(request, { scopes: ["READ"] });
  const otherEmail = uniqueEmail("mcp-other");
  await createTestUser({ email: otherEmail, name: "E2E Other Writer", role: "AUTHOR" });
  const anchored = await createTestAnnotation({
    docId: sharedDoc.id,
    authorEmail: ADMIN_EMAIL,
    bodyText: "A note on the fox.",
    anchor: { from: QUOTE_FROM, to: QUOTE_TO, quotedText: QUOTED_TEXT },
  });
  const whole = await createTestAnnotation({ docId: sharedDoc.id, authorEmail: otherEmail, bodyText: "A note on the whole doc." });
  const draft = await createTestAnnotation({ docId: sharedDoc.id, authorEmail: ADMIN_EMAIL, bodyText: "Private.", draft: true });
  try {
    const read = await agent.call("read", { url: `/doc/${sharedDoc.slug}`, include: ["annotations"] });
    const threads = read.result.threads as { total: number; groups: { threads: { id: string; passage?: { text: string } }[] }[] };
    expect(threads.total).toBe(2);
    const ids = threads.groups.flatMap((g) => g.threads.map((t) => t.id));
    // The doc's order: the anchored one first, the whole-doc note after; the draft nowhere.
    expect(ids).toEqual([anchored.id, whole.id]);
    expect(threads.groups[0].threads[0].passage?.text).toBe(QUOTED_TEXT);

    const byAdmin = await agent.call("read", { url: `/doc/${sharedDoc.slug}`, include: ["annotations"], threads: { by: ["e2e-admin"] } });
    expect((byAdmin.result.threads as { total: number }).total).toBe(1);
    const awaiting = await agent.call("read", { url: `/doc/${sharedDoc.slug}`, include: ["annotations"], threads: { awaiting: true } });
    expect((awaiting.result.threads as { total: number }).total).toBe(2);
    const typo = await agent.call("read", { url: `/doc/${sharedDoc.slug}`, include: ["annotations"], threads: { by: ["e2e-admn"] } });
    expect(typo.error.code).toBe("unknown_author");

    const everywhere = await agent.call("read", { url: "/annotations", threads: { by: ["e2e-admin"] } });
    const containers = everywhere.result.containers as { url: string }[];
    expect(containers.map((c) => c.url)).toContain(`/doc/${sharedDoc.slug}`);

    const alone = await agent.call("read", { url: anchored.id });
    expect(alone.result).toMatchObject({ kind: "thread", id: anchored.id, by: "E2E Admin", body: "A note on the fox." });
    const card = String(alone.result.card);
    expect(card.startsWith(`/doc/${sharedDoc.slug}#e2e-admin-`)).toBe(true);
    const byCard = await agent.call("read", { url: card });
    expect(byCard.result.id).toBe(anchored.id);

    expect((await agent.call("read", { url: draft.id })).error.code).toBe("not_found");
  } finally {
    await deleteTestUser(otherEmail);
    await agent.dispose();
  }
});

test("a link reads as its parts, and a doc lists the links into it", async ({ request, sharedDoc }) => {
  const agent = await createAgent(request, { scopes: ["READ"] });
  const link = await createTestAnchoredLink({
    creatorEmail: ADMIN_EMAIL,
    parts: [{ docId: sharedDoc.id, from: QUOTE_FROM, to: QUOTE_TO }],
    name: "The fox",
  });
  try {
    const read = await agent.call("read", { url: `/link/${link.id}` });
    expect(read.result).toMatchObject({ kind: "link", name: "The fox", by: "E2E Admin" });
    const group = (read.result.groups as { target: string; kind: string; parts: Record<string, unknown>[] }[])[0];
    expect(group).toMatchObject({ target: `/doc/${sharedDoc.slug}`, kind: "doc" });
    expect(group.parts[0]).toMatchObject({ quote: QUOTED_TEXT, blocks: "1" });

    const into = await agent.call("read", { url: `/doc/${sharedDoc.slug}`, include: ["links"] });
    expect((into.result.links as { parts: Record<string, unknown>[] }).parts[0]).toMatchObject({
      link: `/link/${link.id}`,
      name: "The fox",
      quote: QUOTED_TEXT,
    });
    expect((await agent.call("read", { url: "/link/cnosuchlinkatallhere000" })).error.code).toBe("not_found");
  } finally {
    await deleteTestAnchoredLink(link.id);
    await agent.dispose();
  }
});

test("a post, its comments, and a comment with its history", async ({ request, publishedPost }) => {
  const agent = await createAgent(request, { scopes: ["READ"] });
  const comment = await createComment({
    postId: publishedPost.id,
    anchoredEventId: publishedPost.eventId!,
    email: uniqueEmail("mcp-commenter"),
    displayName: "Jane Commenter",
    body: "A public comment.",
    status: "APPROVED",
  });
  try {
    const post = await agent.call("read", { url: publishedPost.path, include: ["comments"] });
    expect(post.result).toMatchObject({ kind: "post", url: publishedPost.path, status: "published", byline: "E2E Admin" });
    // A post's byline grants nothing over its doc, and an AUTHOR who isn't on
    // a PRIVATE doc's byline can't read it, so it isn't named.
    expect(post.result).not.toHaveProperty("doc");
    const threads = post.result.comments as { comments: { url: string; by: string; body: string }[] }[];
    const listed = threads.flatMap((t) => t.comments);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ by: "Jane Commenter", body: "A public comment." });

    const one = await agent.call("read", { url: listed[0].url, history: true });
    expect(one.result).toMatchObject({ kind: "comment", id: comment.id, by: "Jane Commenter" });
    expect((one.result.history as unknown[]).length).toBe(1);
  } finally {
    await agent.dispose();
  }
});

test("a tag reads with what carries it, and keeps reading under a past slug", async ({ request, sharedDoc }) => {
  const agent = await createAgent(request, { scopes: ["READ"] });
  const tag = await createTestTag({ creatorEmail: ADMIN_EMAIL, description: "For the MCP spec." });
  try {
    await tagWithTestTag({ tagId: tag.id, target: { kind: "doc", id: sharedDoc.id }, taggerEmail: ADMIN_EMAIL });
    const read = await agent.call("read", { url: `/tag/${tag.slug}` });
    expect(read.result).toMatchObject({ kind: "tag", name: tag.name, description: "For the MCP spec." });
    const docs = (read.result.sections as { kind: string; hits: { url: string }[] }[]).find((s) => s.kind === "docs")!;
    expect(docs.hits.map((h) => h.url)).toContain(`/doc/${sharedDoc.slug}`);

    const renamed = await renameTestTagSlug(tag.id, `${tag.slug}-renamed`);
    const followed = await agent.call("read", { url: `/tag/${tag.slug}` });
    expect(followed.result).toMatchObject({ kind: "tag", url: `/tag/${renamed}` });
    const found = await agent.call("find_tags", { query: tag.name.slice(4) });
    expect((found.result.tags as { slug: string }[]).map((t) => t.slug)).toContain(renamed);
  } finally {
    await deleteTestTag(tag.id);
    await agent.dispose();
  }
});

test("download_url: a file's bytes and the export, through a grant and never the token", async ({ request }) => {
  const agent = await createAgent(request, { scopes: ["READ"] });
  const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, visibility: "SHARED" });
  const tag = await createTestTag({ creatorEmail: ADMIN_EMAIL });
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", title: uniqueTitle("export"), bodyText: QUOTED_BODY });
  try {
    await tagWithTestTag({ tagId: tag.id, target: { kind: "doc", id: doc.id }, taggerEmail: ADMIN_EMAIL });

    const download = await agent.call("download_url", { file: `/pdf/${file.slug}` });
    const bytes = await request.get(String(download.result.url));
    expect(bytes.status()).toBe(200);
    expect(bytes.headers()["content-type"]).toBe("application/pdf");
    expect((await bytes.body()).length).toBe(file.byteSize);
    // A grant opens its one route: the same grant on another file's route is refused.
    const elsewhere = String(download.result.url).replace(`/api/mcp/files/${file.id}`, "/api/mcp/files/cnotthisfile0000000000000");
    expect((await request.get(elsewhere)).status()).toBe(401);

    const exportUrl = String((await agent.call("download_url", { export: true })).result.url);
    const catalog = await request.get(`${exportUrl}&catalog=1&tags=${tag.slug}`);
    expect(catalog.status()).toBe(200);
    const entries = (await catalog.json()).docs as { id: string; slug: string; version: string; chars: number }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: doc.id, slug: doc.slug });
    expect(entries[0].version).toMatch(/^\d+$/);

    const tar = await request.get(`${exportUrl}&tags=${tag.slug}`);
    const files = readTar(new Uint8Array(await tar.body()));
    expect(files.get(`${doc.id}.md`)).toContain(QUOTED_BODY);
    expect(files.get(`${doc.id}.md`)).toContain(`id: ${doc.id}`);
    expect(JSON.parse(files.get("manifest.json")!).docs[0]).toMatchObject({ id: doc.id, tags: [tag.slug] });

    const listed = await request.post(exportUrl, { data: { docs: [`/doc/${doc.slug}`, "/doc/no-such-doc"] } });
    const listedFiles = readTar(new Uint8Array(await listed.body()));
    expect(JSON.parse(listedFiles.get("manifest.json")!).missing).toEqual(["/doc/no-such-doc"]);

    const badFilter = await request.get(`${exportUrl}&kinds=pdfs`);
    expect(badFilter.status()).toBe(400);
  } finally {
    await deleteTestTag(tag.id);
    await deleteTestDoc(doc.id);
    await deleteTestFile(file.id);
    await agent.dispose();
  }
});

test("find_users names byline-eligible accounts, and a nameless one only by its exact email", async ({ request }) => {
  const agent = await createAgent(request, { scopes: ["READ"] });
  const namelessEmail = uniqueEmail("mcp-nameless");
  await createTestUser({ email: namelessEmail, name: "", role: "AUTHOR" });
  try {
    const byName = await callTool(request, agent.secret, "find_users", { query: "E2E Admin" });
    expect((byName.result.users as { slug: string }[]).map((u) => u.slug)).toContain("e2e-admin");
    const byEmail = await agent.call("find_users", { email: namelessEmail });
    expect((byEmail.result.users as { id: string }[]).length).toBe(1);
    const bySlugFragment = await agent.call("find_users", { query: "mcp-nameless" });
    expect(bySlugFragment.result.users).toEqual([]);
  } finally {
    await deleteTestUser(namelessEmail);
    await agent.dispose();
  }
});
