import { test } from "node:test";
import assert from "node:assert/strict";
import { ANTIGRAVITY_METADATA, CHATGPT_METADATA, CLAUDE_AI_METADATA, CLAUDE_CODE_METADATA, PINNED_CLIENTS, agentKindRefusal, defaultAgentOf } from "./pinned-clients";

// docs/MCP.md §21, "Which agent a client is" — each pinned identity's agent,
// and the agent a client registered by hand takes from its kind.

test("each pinned identity's kind and agent, every pin in the table", () => {
  const table = PINNED_CLIENTS.map(({ document, kind, agent }) => [document.client_id, kind, agent]);
  assert.deepEqual(table, [
    [CLAUDE_AI_METADATA.client_id, "CLAUDE_AI", "CLAUDE"],
    // The two disagree here: its connections are `other`, and its bot is Claude's.
    [CLAUDE_CODE_METADATA.client_id, "OTHER", "CLAUDE"],
    [CHATGPT_METADATA.client_id, "CHATGPT", "CHATGPT"],
    [ANTIGRAVITY_METADATA.client_id, "OTHER", "ANTIGRAVITY"],
  ]);
});

test("a client given no agent takes its kind's, and an other has none", () => {
  assert.equal(defaultAgentOf("CLAUDE_AI"), "CLAUDE");
  assert.equal(defaultAgentOf("CHATGPT"), "CHATGPT");
  assert.equal(defaultAgentOf("OTHER"), null);
});

test("an agent that contradicts the kind is refused, and an other takes any", () => {
  assert.equal(agentKindRefusal("CLAUDE_AI", "CLAUDE"), null);
  assert.equal(agentKindRefusal("CHATGPT", "CHATGPT"), null);
  assert.match(agentKindRefusal("CLAUDE_AI", "CHATGPT")!, /CLAUDE_AI client is CLAUDE's/);
  assert.match(agentKindRefusal("CHATGPT", "ANTIGRAVITY")!, /can't be ANTIGRAVITY's/);
  for (const agent of ["CLAUDE", "CHATGPT", "ANTIGRAVITY"] as const) assert.equal(agentKindRefusal("OTHER", agent), null);
  // Every pin holds to the rule it would be registered under.
  for (const { kind, agent } of PINNED_CLIENTS) assert.equal(agentKindRefusal(kind, agent), null);
});
