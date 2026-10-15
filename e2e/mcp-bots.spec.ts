import { test, expect } from "./fixtures";
import {
  ADMIN_EMAIL,
  createTestApiToken,
  createTestBot,
  createTestUser,
  deleteTestUser,
  moveTestBot,
  repointTestBot,
  requireTestInvitable,
  restoreTestUser,
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
