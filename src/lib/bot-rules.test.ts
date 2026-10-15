import { test } from "node:test";
import assert from "node:assert/strict";
import { Role } from "@/generated/prisma/enums";
import { ROLES_BY_RANK, botRoleRefusal, botRolesFor, outranks, tokenRefusal } from "./bot-rules";

// docs/MCP.md §21, "Whose account" — a bot's rules, as functions of its row,
// its person's and its token's issuer's.

const person = { id: "alice", role: "AUTHOR" as const, worksForUserId: null };
const bot = (role: Role, worksForUserId = "alice") => ({ id: "bot", role, worksForUserId });

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
  assert.equal(tokenRefusal(person, { id: "alice", role: "AUTHOR" }), null);
  assert.match(tokenRefusal(person, { id: "bob", role: "ADMIN" })!, /issued by that person/);
});

test("a bot's token is accepted only when its person issued it, the bot itself included", () => {
  assert.equal(tokenRefusal(bot("AUTHOR"), { id: "alice", role: "AUTHOR" }), null);
  assert.match(tokenRefusal(bot("AUTHOR"), { id: "bob", role: "ADMIN" })!, /person it works for/);
  assert.match(tokenRefusal(bot("AUTHOR"), { id: "bot", role: "AUTHOR" })!, /person it works for/);
});

test("a bot's token is refused while its person ranks below it or is a COMMENTER", () => {
  assert.match(tokenRefusal(bot("AUTHOR"), { id: "alice", role: "AUTHORIZED" })!, /rank above/);
  assert.match(tokenRefusal(bot("COMMENTER"), { id: "alice", role: "COMMENTER" })!, /COMMENTER/);
  assert.equal(tokenRefusal(bot("AUTHORIZED"), { id: "alice", role: "EDITOR" }), null);
});
