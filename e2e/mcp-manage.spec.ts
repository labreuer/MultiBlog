import { test, expect } from "./fixtures";
import {
  ADMIN_EMAIL,
  addTestDocAuthor,
  createTestAnnotation,
  createTestDoc,
  createTestFile,
  createTestPost,
  deleteTestDoc,
  deleteTestFile,
  deleteTestPost,
  deleteTestTag,
  getDocAuthorEmails,
  getUserIdByEmail,
  setTestFileOwners,
} from "./db";
import { createAgent, mcpRequest } from "./mcp";
import { uniqueTitle } from "./naming";

// docs/MCP.md §3, §15: `manage`, the scope that changes who can see a thing
// or takes it away. Listed only to a MANAGE token on a client that can be
// made to prompt for every call; and a byline change that would take a
// PRIVATE doc away from someone is refused unless the call says it means it.

test("manage is listed only with the manage scope, and only to a client that prompts for it", async ({ request }) => {
  const writer = await createAgent(request, { scopes: ["READ", "WRITE"] });
  const manager = await createAgent(request, { scopes: ["READ", "WRITE", "MANAGE"] });
  const web = await createAgent(request, { scopes: ["READ", "WRITE", "MANAGE"], client: "CLAUDE_AI" });
  try {
    const names = async (secret: string) =>
      ((await mcpRequest(request, secret, "tools/list")).body.result?.tools as { name: string; _meta: Record<string, unknown> }[]) ?? [];
    expect((await names(writer.secret)).map((t) => t.name)).not.toContain("manage");
    const listed = (await names(manager.secret)).find((t) => t.name === "manage");
    expect(listed?._meta["anthropic/requiresUserInteraction"]).toBe(true);
    expect((await names(web.secret)).map((t) => t.name)).not.toContain("manage");
  } finally {
    await writer.dispose();
    await manager.dispose();
    await web.dispose();
  }
});

test("manage a doc: visibility, slug, byline with its removal guard, record, delete and restore", async ({ request }) => {
  const agent = await createAgent(request, { scopes: ["READ", "WRITE", "MANAGE"] });
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: "A doc to manage." });
  await addTestDocAuthor(doc.id, agent.user.email);
  try {
    const url = `/doc/${doc.slug}`;
    const shared = await agent.call("manage", { target: url, visibility: "SHARED" });
    expect(shared.isError, JSON.stringify(shared.error)).toBe(false);
    expect(shared.result).toMatchObject({ changed: ["visibility"], visibility: "SHARED" });

    const renamed = await agent.call("manage", { target: url, slug: `${doc.slug}-renamed` });
    expect(renamed.result.url).toBe(`/doc/${doc.slug}-renamed`);
    // The old slug still reaches it.
    expect((await agent.call("read", { url })).result.url).toBe(`/doc/${doc.slug}-renamed`);

    const adminId = (await getUserIdByEmail(ADMIN_EMAIL))!;
    const agentId = agent.user.id;
    const reordered = await agent.call("manage", { target: url, byline: [agentId, adminId] });
    expect(reordered.result.byline).toBe(`${agent.user.name}, E2E Admin`);
    expect(await getDocAuthorEmails(doc.id)).toEqual([agent.user.email, ADMIN_EMAIL]);

    const dropping = await agent.call("manage", { target: url, byline: [agentId] });
    expect(dropping.error.code).toBe("invalid");
    expect(dropping.error.removing).toEqual([adminId]);
    expect(await getDocAuthorEmails(doc.id)).toEqual([agent.user.email, ADMIN_EMAIL]);

    const record = await agent.call("manage", { target: url, record: true });
    expect(record.result.record).toBe(true);
    expect((await agent.call("edit_doc", { url, edits: [{ append: "More." }] })).error.code).toBe("read_only");
    await agent.call("manage", { target: url, record: false });

    const deleted = await agent.call("manage", { target: url, delete: true });
    expect(deleted.result.deleted).toBe(true);
    expect((await agent.call("read", { url })).error.code).toBe("not_found");
    const restored = await agent.call("manage", { target: url, restore: true });
    expect(restored.result).toMatchObject({ changed: ["restored"], visibility: "SHARED" });
    expect((await agent.call("read", { url })).isError).toBe(false);

    expect((await agent.call("manage", { target: url })).error.code).toBe("invalid");
    expect((await agent.call("manage", { target: url, delete: true, restore: true })).error.code).toBe("invalid");
  } finally {
    await deleteTestDoc(doc.id);
    await agent.dispose();
  }
});

test("manage refuses a doc its actor can only read, and hides one it can't", async ({ request }) => {
  const agent = await createAgent(request, { scopes: ["READ", "WRITE", "MANAGE"] });
  const shared = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Readable only." });
  const hidden = await createTestDoc({ authorEmail: ADMIN_EMAIL, bodyText: "Private to the admin." });
  try {
    expect((await agent.call("manage", { target: `/doc/${shared.slug}`, visibility: "PRIVATE" })).error.code).toBe("forbidden");
    expect((await agent.call("manage", { target: `/doc/${hidden.slug}`, visibility: "SHARED" })).error.code).toBe("not_found");
  } finally {
    await deleteTestDoc(shared.id);
    await deleteTestDoc(hidden.id);
    await agent.dispose();
  }
});

test("manage a file's owners, an annotation, a link, and a published post's tags", async ({ request }) => {
  const agent = await createAgent(request, { scopes: ["READ", "WRITE", "MANAGE"] });
  const file = await createTestFile({ ownerEmail: ADMIN_EMAIL, pages: [["A page to manage."]] });
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "Notes go here." });
  const draft = await createTestAnnotation({ docId: doc.id, authorEmail: ADMIN_EMAIL, bodyText: "Private thoughts.", draft: true });
  const published = await createTestPost({ authorEmail: agent.user.email, publish: true });
  const term = uniqueTitle("public term");
  let termSlug: string | null = null;
  try {
    // The admin's PRIVATE file is invisible to the agent until the admin adds it.
    expect((await agent.call("manage", { target: `/pdf/${file.slug}`, visibility: "SHARED" })).error.code).toBe("not_found");
    await setTestFileOwners(file.id, [ADMIN_EMAIL, agent.user.email]);
    const adminId = (await getUserIdByEmail(ADMIN_EMAIL))!;
    const reordered = await agent.call("manage", { target: `/pdf/${file.slug}`, owners: [agent.user.id, adminId] });
    expect(reordered.isError, JSON.stringify(reordered.error)).toBe(false);
    expect(reordered.result.owners).toBe(`${agent.user.name}, E2E Admin`);
    expect((await agent.call("manage", { target: file.id, owners: [agent.user.id] })).error.code).toBe("invalid");
    const renamed = await agent.call("manage", { target: file.id, slug: `${file.slug}-moved` });
    expect(renamed.result.url).toBe(`/pdf/${file.slug}-moved`);
    expect((await agent.call("manage", { target: file.id, record: true })).error.code).toBe("invalid");

    const note = await agent.call("annotate", { on: `/doc/${doc.slug}`, body: "Mine to take back." });
    const gone = await agent.call("manage", { target: String(note.result.id), delete: true });
    expect(gone.result).toMatchObject({ changed: ["deleted"] });
    expect((await agent.call("read", { url: String(note.result.id) })).error.code).toBe("not_found");
    expect((await agent.call("manage", { target: String(note.result.id), restore: true })).isError).toBe(false);
    // Another writer's DRAFT is theirs alone, here as everywhere.
    expect((await agent.call("manage", { target: draft.id, delete: true })).error.code).toBe("not_found");

    const minted = await agent.call("create_link", { links: [{ parts: [{ on: `/doc/${doc.slug}`, quote: "Notes go here" }] }] });
    const link = (minted.result.links as { url: string }[])[0].url;
    expect((await agent.call("manage", { target: link, delete: true })).result.changed).toEqual(["deleted"]);
    expect((await agent.call("read", { url: link })).error.code).toBe("not_found");
    expect((await agent.call("manage", { target: link, restore: true })).result.changed).toEqual(["restored"]);

    expect((await agent.call("tag", { target: published.path!, tags: [term] })).error.code).toBe("forbidden");
    const tagged = await agent.call("manage", { target: published.path!, tags: [term] });
    expect(tagged.isError, JSON.stringify(tagged.error)).toBe(false);
    expect(tagged.result).toMatchObject({ changed: ["tags"], tags: [{ name: term }] });
    termSlug = (tagged.result.tags as { slug: string }[])[0].slug;
    expect((await agent.call("manage", { target: published.path!, visibility: "SHARED" })).error.code).toBe("invalid");
  } finally {
    if (termSlug) await deleteTestTag(termSlug);
    await deleteTestPost(published.id);
    await deleteTestDoc(doc.id);
    await deleteTestFile(file.id);
    await agent.dispose();
  }
});
