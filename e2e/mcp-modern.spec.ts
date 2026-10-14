import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { test, expect } from "./fixtures";
import { ADMIN_EMAIL, createTestDoc, deleteTestDoc } from "./db";
import { createAgent, mcpRequest } from "./mcp";

// docs/MCP.md §21, "Moving to SDK v2" — the 2026-07-28 leg, which claude.ai
// opens in, driven by the SDK's own client. Every other MCP spec drives the
// 2025-era leg through e2e/mcp.ts, so between them one endpoint is shown
// serving both eras with the same token.

test("a 2026-07-28 client discovers, lists and calls, and is told to cache nothing it could share", async ({ request, baseURL }) => {
  const agent = await createAgent(request, { scopes: ["READ"], client: "OTHER" });
  const doc = await createTestDoc({ authorEmail: ADMIN_EMAIL, visibility: "SHARED", bodyText: "A paragraph for the modern leg." });
  // Pinned: left to its default, the client negotiates the 2025 protocol
  // and this spec would pass while testing the old leg.
  const client = new Client({ name: "e2e", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const transport = new StreamableHTTPClientTransport(new URL("/api/mcp", baseURL), {
    requestInit: { headers: { Authorization: `Bearer ${agent.secret}` } },
  });
  try {
    await client.connect(transport);
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");

    // server/discover brings the instructions initialize does for the same
    // token, which e2e/mcp-read.spec.ts checks name the actor and the issuer.
    const init = await mcpRequest(request, agent.secret, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    expect(client.getInstructions()).toContain(`You act as ${agent.user.name}`);
    expect(client.getInstructions()).toBe(init.body.result?.instructions);

    // Both answers are per token, so neither may be cached for anyone else.
    expect(client.getDiscoverResult()).toMatchObject({ ttlMs: 0, cacheScope: "private" });
    const listed = await client.listTools();
    expect(listed).toMatchObject({ ttlMs: 0, cacheScope: "private" });
    expect(listed.tools.map((t) => t.name)).toEqual(["search", "read", "find_users", "find_tags", "download_url"]);

    // Called after the list, so the client holds the result to read's
    // outputSchema, as a v2 client does once it has listed the tools.
    const read = await client.callTool({ name: "read", arguments: { url: `/doc/${doc.slug}` } });
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent).toMatchObject({ kind: "doc", id: doc.id });

    // A refusal carries text and no structuredContent, which the client
    // accepts from a tool that declares an outputSchema.
    const refused = await client.callTool({ name: "read", arguments: { url: "/doc/no-such-doc-anywhere" } });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toBeUndefined();
    expect(JSON.parse((refused.content as { text: string }[])[0].text).code).toBe("not_found");
  } finally {
    await client.close();
    await deleteTestDoc(doc.id);
    await agent.dispose();
  }
});
