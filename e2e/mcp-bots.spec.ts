import { test, expect } from "./fixtures";
import {
  ADMIN_EMAIL,
  createTestApiToken,
  createTestBot,
  createTestUser,
  deleteTestUser,
  getTestAccountFacts,
  moveTestBot,
  orphanTestBot,
  repointTestBot,
  requireTestInvitable,
  restoreTestUser,
  setTestBotAgent,
  setTestMcpAllowed,
  setTestPasswordHashInSql,
  setTestUserRole,
  setTestUserRoleAsAdmin,
  softDeleteTestUser,
} from "./db";
import { mcpRequest } from "./mcp";
import { uniqueEmail } from "./naming";

// docs/MCP.md §21, "Whose account" — a bot works for one person, who issues
// every token it holds; it never outranks them, and a COMMENTER has none.
// §3's check enforces that on every call, the issuing of a token refuses one
// the check would, and /users' rules (src/lib/bots.ts, which the fixtures
// call as the suite's admin) refuse to make a person work for anyone or to
// invite a bot.
//
// "A bot's agent" and "Connections turned off for an account": a person has
// one live bot per agent, which four of /users' writes can meet and each
// refuses by naming the bot that holds it; and a token is refused while an
// ADMIN has connections turned off for its account or its issuer. **Every
// bot with an agent here works for a person the test made**, never the
// suite's admin, whose bots every worker shares (e2e/README.md).

/** A token's answer to `tools/list`: 200 while §3's check accepts it, 401 once it doesn't. */
async function listStatus(request: Parameters<typeof mcpRequest>[0], secret: string): Promise<number> {
  return (await mcpRequest(request, secret, "tools/list")).status;
}

test("a token for a bot, issued by someone it doesn't work for, is refused at issue and at a call", async ({ request }) => {
  const personEmail = uniqueEmail("bot-person");
  await createTestUser({ email: personEmail, role: "AUTHOR" });
  const bot = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: personEmail });
  try {
    await expect(createTestApiToken({ email: bot.email, issuerEmail: ADMIN_EMAIL, scopes: ["READ"] })).rejects.toThrow(/person it works for/);
    await expect(createTestApiToken({ email: bot.email, issuerEmail: bot.email, scopes: ["READ"] })).rejects.toThrow(/person it works for/);
    // A person's own token is the person's to issue, too.
    await expect(createTestApiToken({ email: personEmail, issuerEmail: ADMIN_EMAIL, scopes: ["READ"] })).rejects.toThrow(/issued by that person/);

    const { secret } = await createTestApiToken({ email: bot.email, issuerEmail: personEmail, scopes: ["READ"] });
    expect(await listStatus(request, secret)).toBe(200);
    // A bare UPDATE revokes nothing, so it is the check that refuses the token
    // its new person didn't issue, and accepts it again once pointed back.
    await repointTestBot(bot.email, ADMIN_EMAIL);
    expect(await listStatus(request, secret)).toBe(401);
    await repointTestBot(bot.email, personEmail);
    expect(await listStatus(request, secret)).toBe(200);
  } finally {
    await deleteTestUser(bot.email);
    await deleteTestUser(personEmail);
  }
});

test("a bot's token is refused once its person is demoted below it, or to COMMENTER", async ({ request }) => {
  const personEmail = uniqueEmail("bot-person");
  await createTestUser({ email: personEmail, role: "EDITOR" });
  const bot = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: personEmail, role: "AUTHOR" });
  try {
    const { secret } = await createTestApiToken({ email: bot.email, issuerEmail: personEmail, scopes: ["READ"] });
    expect(await listStatus(request, secret)).toBe(200);
    await setTestUserRole(personEmail, "AUTHORIZED");
    expect(await listStatus(request, secret)).toBe(401);
    await setTestUserRole(personEmail, "AUTHOR");
    expect(await listStatus(request, secret)).toBe(200);
    // A COMMENTER has no bot, whatever its role.
    await setTestUserRoleAsAdmin(bot.email, "COMMENTER");
    await setTestUserRole(personEmail, "COMMENTER");
    expect(await listStatus(request, secret)).toBe(401);
  } finally {
    await deleteTestUser(bot.email);
    await deleteTestUser(personEmail);
  }
});

test("moving a bot revokes the tokens its previous person issued for it, and a move back revives none", async ({ request }) => {
  const firstEmail = uniqueEmail("bot-person");
  const secondEmail = uniqueEmail("bot-person");
  await createTestUser({ email: firstEmail, role: "AUTHOR" });
  await createTestUser({ email: secondEmail, role: "AUTHOR" });
  const bot = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: firstEmail });
  try {
    const first = await createTestApiToken({ email: bot.email, issuerEmail: firstEmail, scopes: ["READ"] });
    expect(await listStatus(request, first.secret)).toBe(200);

    expect(await moveTestBot(bot.email, secondEmail)).toEqual({ revoked: 1 });
    expect(await listStatus(request, first.secret)).toBe(401);
    const second = await createTestApiToken({ email: bot.email, issuerEmail: secondEmail, scopes: ["READ"] });
    expect(await listStatus(request, second.secret)).toBe(200);

    expect(await moveTestBot(bot.email, firstEmail)).toEqual({ revoked: 1 });
    expect(await listStatus(request, first.secret)).toBe(401);
    expect(await listStatus(request, second.secret)).toBe(401);
  } finally {
    await deleteTestUser(bot.email);
    await deleteTestUser(firstEmail);
    await deleteTestUser(secondEmail);
  }
});

test("deleting a person revokes the tokens they issued, and restoring them brings none back", async ({ request }) => {
  const personEmail = uniqueEmail("bot-person");
  await createTestUser({ email: personEmail, role: "AUTHOR" });
  const bot = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: personEmail });
  try {
    const { secret } = await createTestApiToken({ email: bot.email, issuerEmail: personEmail, scopes: ["READ"] });
    expect(await listStatus(request, secret)).toBe(200);
    await softDeleteTestUser(personEmail, ADMIN_EMAIL);
    expect(await listStatus(request, secret)).toBe(401);
    await restoreTestUser(personEmail);
    expect(await listStatus(request, secret)).toBe(401);
  } finally {
    await deleteTestUser(bot.email);
    await deleteTestUser(personEmail);
  }
});

test("/users' rules: no person made to work for anyone, no bot for a COMMENTER or above its person, no invite to a bot", async () => {
  const personEmail = uniqueEmail("bot-person");
  const commenterEmail = uniqueEmail("bot-person");
  await createTestUser({ email: personEmail, role: "AUTHOR" });
  await createTestUser({ email: commenterEmail, role: "COMMENTER" });
  const bot = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: personEmail });
  const refusedEmail = uniqueEmail("bot");
  try {
    // An existing account is never made into a bot, and a person never works for anyone.
    await expect(moveTestBot(personEmail, ADMIN_EMAIL)).rejects.toThrow(/a person's, not a bot/);
    // A bot works only for someone with a password, who isn't a COMMENTER and doesn't rank below it.
    await expect(createTestBot({ email: refusedEmail, worksForEmail: bot.email })).rejects.toThrow(/account with a password/);
    await expect(createTestBot({ email: refusedEmail, worksForEmail: commenterEmail })).rejects.toThrow(/COMMENTER can't have a bot/);
    await expect(createTestBot({ email: refusedEmail, worksForEmail: personEmail, role: "EDITOR" })).rejects.toThrow(/rank above/);
    await expect(moveTestBot(bot.email, commenterEmail)).rejects.toThrow(/COMMENTER can't have a bot/);
    // Promoting a bot past its person is refused; demoting it never is.
    await expect(setTestUserRoleAsAdmin(bot.email, "EDITOR")).rejects.toThrow(/rank above/);
    await setTestUserRoleAsAdmin(bot.email, "AUTHORIZED");
    await setTestUserRoleAsAdmin(bot.email, "AUTHOR");

    await expect(requireTestInvitable(bot.email)).rejects.toThrow(/never invited/);
    await requireTestInvitable(personEmail);
  } finally {
    await deleteTestUser(refusedEmail);
    await deleteTestUser(bot.email);
    await deleteTestUser(commenterEmail);
    await deleteTestUser(personEmail);
  }
});

test("a person has one live bot per agent: making, changing, moving and restoring one are each refused, naming the bot that holds it", async () => {
  const personEmail = uniqueEmail("bot-person");
  const otherEmail = uniqueEmail("bot-person");
  await createTestUser({ email: personEmail, role: "AUTHOR" });
  await createTestUser({ email: otherEmail, role: "AUTHOR" });
  const claude = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: personEmail, agent: "CLAUDE" });
  const held = (lead: string, bot = claude) => new RegExp(`${lead} already has a bot for Claude: ${bot.name} \\(${bot.slug}\\)`);
  const refusedEmail = uniqueEmail("bot");
  const emails = [claude.email, refusedEmail];
  try {
    // Making a second bot for the agent; one for another agent, or for none, is made.
    await expect(createTestBot({ email: refusedEmail, worksForEmail: personEmail, agent: "CLAUDE" })).rejects.toThrow(held("That person"));
    const gpt = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: personEmail, agent: "CHATGPT" });
    const plain = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: personEmail });
    emails.push(gpt.email, plain.email);
    expect((await getTestAccountFacts(gpt.email)).agent).toBe("CHATGPT");
    expect((await getTestAccountFacts(plain.email)).agent).toBeNull();

    // Changing a bot's agent to one its person's other bot has.
    await expect(setTestBotAgent(gpt.email, "CLAUDE")).rejects.toThrow(held("Its person"));
    await expect(setTestBotAgent(plain.email, "CLAUDE")).rejects.toThrow(held("Its person"));
    await setTestBotAgent(plain.email, "ANTIGRAVITY");
    expect((await getTestAccountFacts(plain.email)).agent).toBe("ANTIGRAVITY");
    await setTestBotAgent(plain.email, null);
    expect((await getTestAccountFacts(plain.email)).agent).toBeNull();
    // Only a bot is for an agent.
    await expect(setTestBotAgent(personEmail, "CLAUDE")).rejects.toThrow(/a person's, not a bot/);
    expect((await getTestAccountFacts(personEmail)).agent).toBeNull();

    // Moving a bot keeps its agent, so not to a person with a bot of that agent.
    const theirs = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: otherEmail, agent: "CLAUDE" });
    emails.push(theirs.email);
    await expect(moveTestBot(theirs.email, personEmail)).rejects.toThrow(held("The person it would move to"));
    await moveTestBot(gpt.email, otherEmail);
    expect((await getTestAccountFacts(gpt.email)).agent).toBe("CHATGPT");

    // A deleted bot frees its agent, so its person can have a new one, and
    // restoring the old one is then refused until the new one is deleted.
    await softDeleteTestUser(claude.email, personEmail);
    const replacement = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: personEmail, agent: "CLAUDE" });
    emails.push(replacement.email);
    await expect(restoreTestUser(claude.email)).rejects.toThrow(held("Its person", replacement));
    await expect(restoreTestUser(claude.email)).rejects.toThrow(/Delete that one first, to restore this one/);
    expect((await getTestAccountFacts(claude.email)).deleted).toBe(true);
    await softDeleteTestUser(replacement.email, personEmail);
    await restoreTestUser(claude.email);
    expect((await getTestAccountFacts(claude.email)).deleted).toBe(false);
  } finally {
    for (const email of emails) await deleteTestUser(email);
    await deleteTestUser(otherEmail);
    await deleteTestUser(personEmail);
  }
});

test("a bot made with an agent has that agent's initials, one made without has its name's, and changing its agent changes neither", async () => {
  const personEmail = uniqueEmail("bot-person");
  await createTestUser({ email: personEmail, role: "AUTHOR" });
  const withAgent = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: personEmail, name: "E2E Quill Bot", agent: "CHATGPT" });
  const without = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: personEmail, name: "E2E Quill Bot" });
  try {
    expect(await getTestAccountFacts(withAgent.email)).toMatchObject({ agent: "CHATGPT", initials: "GPT", name: "E2E Quill Bot" });
    expect(await getTestAccountFacts(without.email)).toMatchObject({ agent: null, initials: "EB", name: "E2E Quill Bot" });

    await setTestBotAgent(withAgent.email, "ANTIGRAVITY");
    await setTestBotAgent(without.email, "CLAUDE");
    expect(await getTestAccountFacts(withAgent.email)).toMatchObject({ agent: "ANTIGRAVITY", initials: "GPT", name: "E2E Quill Bot" });
    expect(await getTestAccountFacts(without.email)).toMatchObject({ agent: "CLAUDE", initials: "EB", name: "E2E Quill Bot" });
  } finally {
    await deleteTestUser(withAgent.email);
    await deleteTestUser(without.email);
    await deleteTestUser(personEmail);
  }
});

test("an account with an agent takes no password and no invite, though its person is gone", async () => {
  const personEmail = uniqueEmail("bot-person");
  await createTestUser({ email: personEmail, role: "AUTHOR" });
  const bot = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: personEmail, agent: "CLAUDE" });
  const plain = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: personEmail });
  try {
    // While a bot works for someone, the bot's own CHECK refuses a password.
    await expect(setTestPasswordHashInSql(plain.email)).rejects.toThrow(/user_bot_has_no_password_check/);

    // Its person hard-deleted, it works for no one, and its agent's CHECK still does.
    await orphanTestBot(bot.email);
    await expect(setTestPasswordHashInSql(bot.email)).rejects.toThrow(/user_agent_has_no_password_check/);
    await expect(requireTestInvitable(bot.email)).rejects.toThrow(/An account for Claude is never invited/);
    expect((await getTestAccountFacts(bot.email)).invites).toBe(0);
    // And it is no longer a bot, so its agent can't be changed.
    await expect(setTestBotAgent(bot.email, "CHATGPT")).rejects.toThrow(/a person's, not a bot/);
  } finally {
    await deleteTestUser(plain.email);
    await deleteTestUser(bot.email);
    await deleteTestUser(personEmail);
  }
});

test("connections turned off for a person stop their token and their bots'; for a bot, that bot's alone; and turned on, the same tokens work", async ({ request }) => {
  const personEmail = uniqueEmail("bot-person");
  await createTestUser({ email: personEmail, role: "AUTHOR" });
  const bot = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: personEmail });
  const other = await createTestBot({ email: uniqueEmail("bot"), worksForEmail: personEmail });
  try {
    const own = await createTestApiToken({ email: personEmail, issuerEmail: personEmail, scopes: ["READ"] });
    const forBot = await createTestApiToken({ email: bot.email, issuerEmail: personEmail, scopes: ["READ"] });
    const forOther = await createTestApiToken({ email: other.email, issuerEmail: personEmail, scopes: ["READ"] });
    const statuses = async () => [await listStatus(request, own.secret), await listStatus(request, forBot.secret), await listStatus(request, forOther.secret)];
    expect(await statuses()).toEqual([200, 200, 200]);

    // Off for the person: their own token, and every bot's, since they issue those.
    await setTestMcpAllowed(personEmail, false);
    expect(await statuses()).toEqual([401, 401, 401]);
    // The issuing of a token refuses what the check would.
    await expect(createTestApiToken({ email: personEmail, issuerEmail: personEmail, scopes: ["READ"] })).rejects.toThrow(/turned connections off for this account/);
    await expect(createTestApiToken({ email: bot.email, issuerEmail: personEmail, scopes: ["READ"] })).rejects.toThrow(
      /turned connections off for the person this bot works for/,
    );
    // Nothing was revoked: turned on again, the same tokens work.
    await setTestMcpAllowed(personEmail, true);
    expect(await statuses()).toEqual([200, 200, 200]);

    // Off for one bot: that bot alone.
    await setTestMcpAllowed(bot.email, false);
    expect(await statuses()).toEqual([200, 401, 200]);
    await expect(createTestApiToken({ email: bot.email, issuerEmail: personEmail, scopes: ["READ"] })).rejects.toThrow(/turned connections off for this bot/);
    await setTestMcpAllowed(bot.email, true);
    expect(await statuses()).toEqual([200, 200, 200]);
  } finally {
    await deleteTestUser(bot.email);
    await deleteTestUser(other.email);
    await deleteTestUser(personEmail);
  }
});
