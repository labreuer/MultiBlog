import { test, expect } from "./fixtures";
import { ADMIN_EMAIL, addTestDocAuthor, createTestDoc, deleteTestDoc, getDocAuthorEmails, getUserIdByEmail } from "./db";
import { createAgent, mcpRequest } from "./mcp";

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
