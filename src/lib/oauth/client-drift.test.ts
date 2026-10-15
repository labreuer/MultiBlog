import { test } from "node:test";
import assert from "node:assert/strict";
import { documentDrift, type DriftFinding, type FetchedDocument } from "./client-drift";
import { CLAUDE_AI_METADATA, CLAUDE_CODE_METADATA, PINNED_CLIENTS } from "./pinned-clients";

// docs/MCP.md §21, "Which clients" — the drift check's comparison: what is a
// warning, what is a note, and what isn't the document at all.

function answered(body: unknown, status = 200, headers: { location?: string; cfMitigated?: string } = {}): FetchedDocument {
  return {
    kind: "answered",
    status,
    location: headers.location ?? null,
    cfMitigated: headers.cfMitigated ?? null,
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function levels(findings: DriftFinding[]): string[] {
  return findings.map((finding) => finding.level);
}

test("each pin agrees with itself, whatever the order of its lists", () => {
  for (const { document } of PINNED_CLIENTS) assert.deepEqual(documentDrift(document, answered(document)), []);
  const reordered = { ...CLAUDE_CODE_METADATA, redirect_uris: [...CLAUDE_CODE_METADATA.redirect_uris].reverse() };
  assert.deepEqual(documentDrift(CLAUDE_CODE_METADATA, answered(reordered)), []);
});

test("a difference in a field the server acts on is a warning", () => {
  for (const changed of [
    { redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"] },
    { token_endpoint_auth_method: "private_key_jwt" },
    { grant_types: ["authorization_code"] },
    { response_types: ["code", "token"] },
    { client_id: "https://claude.ai/oauth/elsewhere" },
  ]) {
    const findings = documentDrift(CLAUDE_AI_METADATA, answered({ ...CLAUDE_AI_METADATA, ...changed }));
    assert.deepEqual(levels(findings), ["warning"], JSON.stringify(changed));
  }
  const without: Record<string, unknown> = { ...CLAUDE_AI_METADATA };
  delete without.redirect_uris;
  assert.deepEqual(levels(documentDrift(CLAUDE_AI_METADATA, answered(without))), ["warning"]);
});

test("a key appearing is a warning: the client may have become a confidential one", () => {
  for (const key of [{ jwks_uri: "https://claude.ai/.well-known/jwks.json" }, { jwks: { keys: [] } }]) {
    const findings = documentDrift(CLAUDE_AI_METADATA, answered({ ...CLAUDE_AI_METADATA, ...key }));
    assert.deepEqual(levels(findings), ["warning"], JSON.stringify(key));
    assert.match(findings[0].message, /confidential/);
  }
});

test("a difference anywhere else is a note, after every warning", () => {
  const findings = documentDrift(
    CLAUDE_AI_METADATA,
    answered({ ...CLAUDE_AI_METADATA, client_name: "Claude by Anthropic", logo_uri: "https://claude.ai/logo.png", grant_types: ["authorization_code"] }),
  );
  assert.deepEqual(levels(findings), ["warning", "note", "note"]);
  assert.match(findings[1].message, /^client_name /);
  assert.match(findings[2].message, /^logo_uri /);
});

test("an answer that isn't the document is a warning, a redirect included, and one that can't be had is a note", () => {
  assert.deepEqual(levels(documentDrift(CLAUDE_AI_METADATA, answered("Not found", 404))), ["warning"]);
  assert.deepEqual(levels(documentDrift(CLAUDE_AI_METADATA, answered("<html>", 200))), ["warning"]);
  assert.deepEqual(levels(documentDrift(CLAUDE_AI_METADATA, answered([CLAUDE_AI_METADATA], 200))), ["warning"]);
  const moved = documentDrift(CLAUDE_AI_METADATA, answered("", 301, { location: "https://claude.com/oauth/mcp-oauth-client-metadata" }));
  assert.deepEqual(levels(moved), ["warning"]);
  assert.match(moved[0].message, /claude\.com/);

  assert.deepEqual(levels(documentDrift(CLAUDE_AI_METADATA, answered("<html>", 403, { cfMitigated: "challenge" }))), ["note"]);
  // A 403 that isn't Cloudflare's challenge is an answer.
  assert.deepEqual(levels(documentDrift(CLAUDE_AI_METADATA, answered("Forbidden", 403))), ["warning"]);
  assert.deepEqual(levels(documentDrift(CLAUDE_AI_METADATA, { kind: "unreachable", reason: "timed out" })), ["note"]);
});
