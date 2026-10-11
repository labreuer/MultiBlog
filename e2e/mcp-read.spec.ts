import { test, expect } from "./fixtures";
import { ADMIN_EMAIL, createTestUser, deleteTestUser, restoreTestUser, softDeleteTestUser, uniqueEmail } from "./db";
import { callTool, createAgent, mcpRequest } from "./mcp";

// docs/MCP.md, phase 1 (§18): tokens, the endpoint, and every read — driven
// from below the UI through Playwright's `request` fixture, as a machine
// client drives it. What is asserted is what the model reads: each result's
// structured form, its one handle per object, and its size, held to a budget
// so a field added later has to earn its place (§4).

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
    expect(readerTools.map((t) => t.name)).toEqual(["find_users", "find_tags"]);
    const findUsers = readerTools.find((t) => t.name === "find_users")!;
    expect(findUsers.annotations.readOnlyHint).toBe(true);
    expect(findUsers.annotations.openWorldHint).toBe(false);

    const writerInit = await mcpRequest(request, writer.secret, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    expect(String(writerInit.body.result?.instructions)).toContain("Writing:");
    expect(String(writerInit.body.result?.instructions).length).toBeLessThanOrEqual(2048);

    // A tool the token doesn't list is refused as a tool, not run.
    const refused = await reader.call("upload_url", { kind: "doc" });
    expect(refused.isError).toBe(true);
    expect(refused.error.code).toBe("invalid");
  } finally {
    await reader.dispose();
    await writer.dispose();
  }
});

test("a deleted account's token stops working, and restoring the account doesn't bring it back", async ({ request }) => {
  const agent = await createAgent(request);
  try {
    expect((await agent.call("find_users", { query: "E2E Admin" })).isError).toBe(false);

    await softDeleteTestUser(agent.user.email, ADMIN_EMAIL);
    expect((await mcpRequest(request, agent.secret, "tools/list")).status).toBe(401);

    await restoreTestUser(agent.user.email);
    expect((await mcpRequest(request, agent.secret, "tools/list")).status).toBe(401);
  } finally {
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
