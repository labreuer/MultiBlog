import { test } from "node:test";
import assert from "node:assert/strict";
import type { Agent, Role } from "@/generated/prisma/enums";
import { consentOffer, type Bot, type RefusedBot } from "./consent-offer";

// docs/MCP.md §21, "The consent page" — which bot comes first, when a new one
// is offered, and which bots are said to be another agent's.

const bot = (name: string, agent: Agent | null = null): Bot => ({ id: name, name, slug: name.toLowerCase(), agent });
const refused = (name: string, agent: Agent | null, reason: RefusedBot["reason"]): RefusedBot => ({ ...bot(name, agent), reason });
const person = (role: Role, mcpAllowed = true) => ({ role, adminInitials: "LB", mcpAllowed });
const names = (bots: readonly Bot[]) => bots.map((b) => b.name);

test("the person's bot for the client's agent comes first, and no new one is offered", () => {
  const offer = consentOffer(person("AUTHOR"), "CHATGPT", [bot("Alpha"), bot("Claude", "CLAUDE"), bot("GPT", "CHATGPT")], []);
  assert.deepEqual(names(offer.bots), ["GPT", "Alpha", "Claude"]);
  assert.equal(offer.newBot, null);
  // Another agent's bot gets a line; one with no agent says nothing of whose it is.
  assert.deepEqual(names(offer.otherAgents), ["Claude"]);
  assert.equal(offer.held, null);
});

test("with no bot for the agent, an AUTHOR or above is offered a new one, named for the agent and their initials", () => {
  for (const role of ["ADMIN", "EDITOR", "AUTHOR"] as const) {
    const offer = consentOffer(person(role), "CLAUDE", [bot("GPT", "CHATGPT")], []);
    assert.equal(offer.newBot, "Claude (LB)");
    assert.deepEqual(names(offer.bots), ["GPT"]);
    assert.deepEqual(names(offer.otherAgents), ["GPT"]);
  }
  assert.equal(consentOffer(person("AUTHOR"), "ANTIGRAVITY", [], []).newBot, "Antigravity (LB)");
});

test("an AUTHORIZED person, a COMMENTER and a person whose connections are off are offered no new bot", () => {
  assert.equal(consentOffer(person("AUTHORIZED"), "CLAUDE", [], []).newBot, null);
  assert.equal(consentOffer(person("COMMENTER"), "CLAUDE", [], []).newBot, null);
  assert.equal(consentOffer(person("ADMIN", false), "CLAUDE", [], []).newBot, null);
  // The rest holds for an AUTHORIZED person as for anyone: their bot first, and the line beside another's.
  const offer = consentOffer(person("AUTHORIZED"), "CLAUDE", [bot("GPT", "CHATGPT"), bot("Claude", "CLAUDE")], []);
  assert.deepEqual(names(offer.bots), ["Claude", "GPT"]);
  assert.deepEqual(names(offer.otherAgents), ["GPT"]);
});

test("a refused bot for the agent holds it, so no new one is offered beside it", () => {
  for (const reason of ["outranks", "account-off"] as const) {
    const offer = consentOffer(person("AUTHOR"), "CLAUDE", [bot("Alpha")], [refused("Claude", "CLAUDE", reason)]);
    assert.equal(offer.newBot, null);
    assert.equal(offer.held?.name, "Claude");
    assert.deepEqual(names(offer.bots), ["Alpha"]);
  }
  // A refused bot of another agent, or of none, holds nothing.
  const offer = consentOffer(person("AUTHOR"), "CLAUDE", [], [refused("GPT", "CHATGPT", "outranks"), refused("Alpha", null, "account-off")]);
  assert.equal(offer.newBot, "Claude (LB)");
  assert.equal(offer.held, null);
});

test("a client that is no agent's gets the bots as they are", () => {
  const bots = [bot("Alpha"), bot("Claude", "CLAUDE"), bot("GPT", "CHATGPT")];
  const offer = consentOffer(person("ADMIN"), null, bots, [refused("Other", "CLAUDE", "outranks")]);
  assert.deepEqual(names(offer.bots), ["Alpha", "Claude", "GPT"]);
  assert.deepEqual(offer, { bots, newBot: null, otherAgents: [], held: null });
});
