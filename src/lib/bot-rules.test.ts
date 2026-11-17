import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, Role } from "@/generated/prisma/enums";
import { AGENTS, AGENT_BOT_ROLE, AGENT_KEYS, ROLES_BY_RANK, agentBotName, botRoleRefusal, botRolesFor, outranks, parseAgent, tokenRefusal, tokenRefusalOf } from "./bot-rules";

// docs/MCP.md §21, "Whose account" — a bot's rules, as functions of its row,
// its person's and its token's issuer's.

const person = { id: "alice", role: "AUTHOR" as const, worksForUserId: null, mcpAllowed: true };
const bot = (role: Role, worksForUserId = "alice") => ({ id: "bot", role, worksForUserId, mcpAllowed: true });
const issuer = (id: string, role: Role, mcpAllowed = true) => ({ id, role, mcpAllowed });

test("the ranking is the enum's declaration order, every role in it", () => {
  assert.deepEqual([...ROLES_BY_RANK], Object.values(Role));
  assert.equal(outranks("ADMIN", "EDITOR"), true);
  assert.equal(outranks("AUTHOR", "AUTHOR"), false);
  assert.equal(outranks("COMMENTER", "AUTHORIZED"), false);
});

test("a bot may rank as high as its person, never higher, and a COMMENTER has none", () => {
  assert.equal(botRoleRefusal("AUTHOR", "AUTHOR"), null);
  assert.equal(botRoleRefusal("AUTHORIZED", "ADMIN"), null);
  assert.match(botRoleRefusal("EDITOR", "AUTHOR")!, /rank above/);
  assert.match(botRoleRefusal("COMMENTER", "COMMENTER")!, /COMMENTER can't have a bot/);
  assert.deepEqual(botRolesFor("AUTHOR"), ["AUTHOR", "AUTHORIZED", "COMMENTER"]);
  assert.deepEqual(botRolesFor("COMMENTER"), []);
});

test("a person's token is accepted only when the person issued it", () => {
  assert.equal(tokenRefusal(person, issuer("alice", "AUTHOR")), null);
  assert.match(tokenRefusal(person, issuer("bob", "ADMIN"))!, /issued by that person/);
});

test("a bot's token is accepted only when its person issued it, the bot itself included", () => {
  assert.equal(tokenRefusal(bot("AUTHOR"), issuer("alice", "AUTHOR")), null);
  assert.match(tokenRefusal(bot("AUTHOR"), issuer("bob", "ADMIN"))!, /person it works for/);
  assert.match(tokenRefusal(bot("AUTHOR"), issuer("bot", "AUTHOR"))!, /person it works for/);
});

test("a bot's token is refused while its person ranks below it or is a COMMENTER", () => {
  assert.match(tokenRefusal(bot("AUTHOR"), issuer("alice", "AUTHORIZED"))!, /rank above/);
  assert.match(tokenRefusal(bot("COMMENTER"), issuer("alice", "COMMENTER"))!, /COMMENTER/);
  assert.equal(tokenRefusal(bot("AUTHORIZED"), issuer("alice", "EDITOR")), null);
});

test("a token is refused while connections are turned off for its account or its issuer", () => {
  // A person's own token: the account is its issuer.
  const off = tokenRefusalOf({ ...person, mcpAllowed: false }, issuer("alice", "AUTHOR", false));
  assert.equal(off?.reason, "issuer-off");
  assert.match(off!.message, /turned connections off for this account/);

  // Off for a person stops every bot of theirs, since they issue those.
  const personOff = tokenRefusalOf(bot("AUTHOR"), issuer("alice", "AUTHOR", false));
  assert.equal(personOff?.reason, "issuer-off");
  assert.match(personOff!.message, /the person this bot works for/);

  // Off for a bot stops that bot alone.
  const botOff = tokenRefusalOf({ ...bot("AUTHOR"), mcpAllowed: false }, issuer("alice", "AUTHOR"));
  assert.equal(botOff?.reason, "account-off");
  assert.match(botOff!.message, /turned connections off for this bot/);
  assert.equal(tokenRefusal(bot("AUTHOR"), issuer("alice", "AUTHOR")), null);
});

test("each refusal gives its reason, the wrong issuer before anything else", () => {
  assert.equal(tokenRefusalOf(bot("AUTHOR"), issuer("bob", "ADMIN", false))?.reason, "issuer");
  assert.equal(tokenRefusalOf(person, issuer("bob", "ADMIN"))?.reason, "issuer");
  assert.equal(tokenRefusalOf(bot("EDITOR"), issuer("alice", "AUTHOR"))?.reason, "outranks");
  assert.equal(tokenRefusalOf(bot("COMMENTER"), issuer("alice", "COMMENTER"))?.reason, "commenter");
  // The flag is read before the rank, so a bot that is both is said to be turned off.
  assert.equal(tokenRefusalOf({ ...bot("EDITOR"), mcpAllowed: false }, issuer("alice", "AUTHOR"))?.reason, "account-off");
});

test("each agent's name and initials, every agent in the table", () => {
  assert.deepEqual([...AGENT_KEYS], Object.values(Agent));
  const table = AGENT_KEYS.map((agent) => [agent, AGENTS[agent].name, AGENTS[agent].initials]);
  assert.deepEqual(table, [
    ["CLAUDE", "Claude", "CLD"],
    ["CHATGPT", "ChatGPT", "GPT"],
    ["ANTIGRAVITY", "Antigravity", "AGV"],
  ]);
});

test("an agent is parsed from its key alone", () => {
  assert.equal(parseAgent("CHATGPT"), "CHATGPT");
  for (const value of ["", "claude", "GEMINI", "toString", "__proto__", null, undefined, 3, { agent: "CLAUDE" }]) {
    assert.equal(parseAgent(value), null);
  }
});

test("a bot made at Approve is named for its agent and its person's initials", () => {
  assert.equal(agentBotName("CLAUDE", "LB"), "Claude (LB)");
  assert.equal(agentBotName("CHATGPT", " AB "), "ChatGPT (AB)");
  assert.equal(agentBotName("ANTIGRAVITY", "X"), "Antigravity (X)");
  assert.equal(agentBotName("CLAUDE", "  "), "Claude");
});

test("a bot made at Approve is an AUTHOR, so an AUTHOR or above may have one", () => {
  assert.equal(AGENT_BOT_ROLE, "AUTHOR");
  const may = ROLES_BY_RANK.filter((role) => botRoleRefusal(AGENT_BOT_ROLE, role) === null);
  assert.deepEqual(may, ["ADMIN", "EDITOR", "AUTHOR"]);
});
