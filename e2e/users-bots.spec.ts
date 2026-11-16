// /users' bot controls (docs/MCP.md §21, "Whose account"): the New bot panel,
// which offers only the people a bot may work for and only the roles it may
// have under the one chosen; and the Works for column, which moves a bot only
// after a Yes, since the move stops the tokens its previous person issued.
// And the two columns beside it: Agent, the agent a bot is for ("A bot's
// agent"), and MCP, which turns connections off for an account.
// The rules beneath them are e2e/mcp-bots.spec.ts's; this drives the UI once.
import { test, expect } from "./fixtures";
import {
  createTestApiToken,
  createTestBot,
  createTestUser,
  deleteTestUser,
  getTestAccountFacts,
  getTestBotFacts,
  orphanTestBot,
  softDeleteTestUser,
  uniqueEmail,
} from "./db";
import { mcpRequest } from "./mcp";

const rand = () => Math.random().toString(36).slice(2, 8);

/** A person as the panel and the column list them (UsersTable's `personLabel`). */
const label = (name: string, email: string) => `${name} (${email})`;

test("New bot makes a bot working for the chosen person, offering only who it may work for and what it may be", async ({ page }) => {
  const personEmail = uniqueEmail("panel-person");
  const personName = `E2E Panel Person ${rand()}`;
  const commenterEmail = uniqueEmail("panel-commenter");
  await createTestUser({ email: personEmail, name: personName, role: "AUTHORIZED" });
  await createTestUser({ email: commenterEmail, name: `E2E Panel Commenter ${rand()}`, role: "COMMENTER" });
  const botName = `E2E Panel Bot ${rand()}`;
  let botEmail: string | null = null;
  try {
    await page.goto(`/users?q=${encodeURIComponent(personEmail)}`);
    await page.getByText("+ New bot").click();
    const panel = page.locator("details", { hasText: "+ New bot" });
    const worksFor = panel.getByRole("combobox", { name: "Works for" });
    const role = panel.getByRole("combobox", { name: "Role" });

    // A COMMENTER has no bot, so isn't offered.
    await expect(worksFor.locator("option", { hasText: personEmail })).toHaveCount(1);
    await expect(worksFor.locator("option", { hasText: commenterEmail })).toHaveCount(0);
    await expect(role).toBeDisabled();

    await panel.getByRole("textbox", { name: "Name" }).fill(botName);
    await worksFor.selectOption({ label: label(personName, personEmail) });
    // An AUTHORIZED person's bot ranks no higher, and starts as high as it may.
    await expect(role.locator("option")).toHaveText(["AUTHORIZED", "COMMENTER"]);
    await expect(role).toHaveValue("AUTHORIZED");
    await panel.getByRole("button", { name: "Make bot" }).click();

    const made = panel.getByText(/^Made /);
    await expect(made).toContainText(`working for ${label(personName, personEmail)}`);
    botEmail = /\((e2e-[^)]+@multiblog\.invalid)\)/.exec((await made.textContent()) ?? "")?.[1] ?? null;
    expect(botEmail, "the bot's address is made from its slug").toBeTruthy();
    expect(await getTestBotFacts(botEmail!)).toEqual({ worksForEmail: personEmail, role: "AUTHORIZED", hasPassword: false });
  } finally {
    if (botEmail) await deleteTestUser(botEmail);
    await deleteTestUser(commenterEmail);
    await deleteTestUser(personEmail);
  }
});

test("Works for moves a bot only after a Yes, which stops the tokens its previous person issued", async ({ page, request }) => {
  const firstEmail = uniqueEmail("works-for-person");
  const firstName = `E2E First Person ${rand()}`;
  const secondEmail = uniqueEmail("works-for-person");
  const secondName = `E2E Second Person ${rand()}`;
  await createTestUser({ email: firstEmail, name: firstName, role: "AUTHOR" });
  await createTestUser({ email: secondEmail, name: secondName, role: "AUTHOR" });
  const bot = await createTestBot({ email: uniqueEmail("works-for-bot"), worksForEmail: firstEmail });
  const { secret } = await createTestApiToken({ email: bot.email, issuerEmail: firstEmail, scopes: ["READ"] });
  const listStatus = async () => (await mcpRequest(request, secret, "tools/list")).status;
  try {
    // ?cols= shows the defaultHidden columns without the picker (e2e/README.md).
    await page.goto(`/users?q=${encodeURIComponent(bot.email)}&cols=name,email,role,invite,worksFor`);
    const row = page.getByRole("row", { name: new RegExp(bot.email.replace(/[.+]/g, "\\$&")) });
    await expect(row).toBeVisible();

    // No invite for a bot, and no role above its person's.
    await expect(row.getByRole("button", { name: "Send invite" })).toBeDisabled();
    const roleSelect = row.getByRole("combobox").nth(0);
    await expect(roleSelect.locator("option")).toHaveText(["AUTHOR", "AUTHORIZED", "COMMENTER"]);

    const worksFor = row.getByRole("combobox").nth(1);
    await expect(worksFor.locator("option:checked")).toHaveText(label(firstName, firstEmail));

    // No undoes the choice and moves nothing.
    await worksFor.selectOption({ label: label(secondName, secondEmail) });
    await expect(row.getByText(`Move to ${label(secondName, secondEmail)}?`)).toBeVisible();
    await row.getByRole("button", { name: "No" }).click();
    await expect(worksFor.locator("option:checked")).toHaveText(label(firstName, firstEmail));
    expect((await getTestBotFacts(bot.email)).worksForEmail).toBe(firstEmail);
    expect(await listStatus()).toBe(200);

    await worksFor.selectOption({ label: label(secondName, secondEmail) });
    await row.getByRole("button", { name: "Yes" }).click();
    await expect(worksFor.locator("option:checked")).toHaveText(label(secondName, secondEmail));
    expect((await getTestBotFacts(bot.email)).worksForEmail).toBe(secondEmail);
    expect(await listStatus()).toBe(401);
  } finally {
    await deleteTestUser(bot.email);
    await deleteTestUser(firstEmail);
    await deleteTestUser(secondEmail);
  }
});

test("New bot's Agent gives a bot its agent and that agent's initials, and refuses a second for one person", async ({ page }) => {
  const personEmail = uniqueEmail("agent-person");
  const personName = `E2E Agent Person ${rand()}`;
  await createTestUser({ email: personEmail, name: personName, role: "AUTHOR" });
  const botName = `E2E Agent Bot ${rand()}`;
  let botEmail: string | null = null;
  try {
    await page.goto(`/users?q=${encodeURIComponent(personEmail)}`);
    await page.getByText("+ New bot").click();
    const panel = page.locator("details", { hasText: "+ New bot" });
    const agent = panel.getByRole("combobox", { name: "Agent" });
    await expect(agent.locator("option")).toHaveText(["none", "Claude", "ChatGPT", "Antigravity"]);
    await expect(agent).toHaveValue("");

    await panel.getByRole("textbox", { name: "Name" }).fill(botName);
    await panel.getByRole("combobox", { name: "Works for" }).selectOption({ label: label(personName, personEmail) });
    await agent.selectOption({ label: "ChatGPT" });
    await panel.getByRole("button", { name: "Make bot" }).click();

    const made = panel.getByText(/^Made /);
    await expect(made).toBeVisible();
    botEmail = /\((e2e-[^)]+@multiblog\.invalid)\)/.exec((await made.textContent()) ?? "")?.[1] ?? null;
    expect(botEmail, "the bot's address is made from its slug").toBeTruthy();
    // It keeps the name it was given, and its initials are its agent's.
    expect(await getTestAccountFacts(botEmail!)).toMatchObject({ agent: "CHATGPT", name: botName, initials: "GPT" });

    // A second bot for ChatGPT, for the same person, is refused by name.
    await panel.getByRole("textbox", { name: "Name" }).fill(`${botName} again`);
    await panel.getByRole("button", { name: "Make bot" }).click();
    await expect(panel.getByText(`That person already has a bot for ChatGPT: ${botName}`)).toBeVisible();
  } finally {
    if (botEmail) await deleteTestUser(botEmail);
    await deleteTestUser(personEmail);
  }
});

test("the Agent column changes a bot's agent, refusing one its person's other bot has, and MCP stops a bot's tokens until it is set again", async ({ page, request }) => {
  const personEmail = uniqueEmail("agent-person");
  await createTestUser({ email: personEmail, role: "AUTHOR" });
  const bot = await createTestBot({ email: uniqueEmail("agent-bot"), worksForEmail: personEmail, agent: "CLAUDE" });
  const other = await createTestBot({ email: uniqueEmail("agent-bot"), worksForEmail: personEmail, agent: "CHATGPT" });
  const orphan = await createTestBot({ email: uniqueEmail("agent-bot"), worksForEmail: personEmail, agent: "ANTIGRAVITY" });
  const { secret } = await createTestApiToken({ email: bot.email, issuerEmail: personEmail, scopes: ["READ"] });
  const listStatus = async () => (await mcpRequest(request, secret, "tools/list")).status;
  const rowOf = (email: string) => page.getByRole("row", { name: new RegExp(email.replace(/[.+]/g, "\\$&")) });
  try {
    await orphanTestBot(orphan.email);
    // ?cols= shows the defaultHidden columns without the picker (e2e/README.md).
    await page.goto(`/users?q=${encodeURIComponent("agent-bot")}&cols=email,invite,agent,mcpAllowed`);
    const row = rowOf(bot.email);
    const agent = row.getByRole("combobox");
    await expect(agent.locator("option")).toHaveText(["none", "Claude", "ChatGPT", "Antigravity"]);
    await expect(agent).toHaveValue("CLAUDE");

    // ChatGPT is its person's other bot's: refused by name, and nothing changes.
    await agent.selectOption("CHATGPT");
    await expect(row.getByText(`Its person already has a bot for ChatGPT: ${other.name}`)).toBeVisible();
    expect((await getTestAccountFacts(bot.email)).agent).toBe("CLAUDE");

    await agent.selectOption("ANTIGRAVITY");
    await expect.poll(async () => (await getTestAccountFacts(bot.email)).agent).toBe("ANTIGRAVITY");
    await agent.selectOption("");
    await expect.poll(async () => (await getTestAccountFacts(bot.email)).agent).toBeNull();
    // Its name and initials have cells of their own, and stay.
    expect(await getTestAccountFacts(bot.email)).toMatchObject({ name: bot.name, initials: "CLD" });

    // A deleted bot frees its agent, and restoring it once another holds that
    // agent is refused by name, in a sentence a production build still shows.
    await softDeleteTestUser(other.email, personEmail);
    await agent.selectOption("CHATGPT");
    await expect.poll(async () => (await getTestAccountFacts(bot.email)).agent).toBe("CHATGPT");
    await page.goto(`/users?q=${encodeURIComponent("agent-bot")}&cols=email,invite,agent,mcpAllowed&deleted=1`);
    await rowOf(other.email).getByRole("button", { name: "Restore user" }).click();
    await expect(page.getByText(`Its person already has a bot for ChatGPT: ${bot.name}`)).toBeVisible();
    await expect(page.getByText("Delete that one first, to restore this one.")).toBeVisible();
    expect((await getTestAccountFacts(other.email)).deleted).toBe(true);
    await agent.selectOption("");
    await expect.poll(async () => (await getTestAccountFacts(bot.email)).agent).toBeNull();
    await rowOf(other.email).getByRole("button", { name: "Restore user" }).click();
    await expect.poll(async () => (await getTestAccountFacts(other.email)).deleted).toBe(false);

    // An account with an agent and no person shows the agent as text, and is never invited.
    const orphanRow = rowOf(orphan.email);
    await expect(orphanRow.getByRole("combobox")).toHaveCount(0);
    await expect(orphanRow).toContainText("Antigravity");
    await expect(orphanRow.getByRole("button", { name: "Send invite" })).toBeDisabled();

    // MCP: cleared, the bot's token stops at its next call; set again, it works.
    // The row's first checkbox is its selection's.
    const mcp = row.getByRole("checkbox").last();
    await expect(mcp).toBeChecked();
    expect(await listStatus()).toBe(200);
    // click(), not uncheck(): the cell is a controlled input, which shows the
    // stored value and so changes only once the save has been read back.
    await mcp.click();
    await expect.poll(async () => (await getTestAccountFacts(bot.email)).mcpAllowed).toBe(false);
    expect(await listStatus()).toBe(401);
    await expect(mcp).not.toBeChecked();
    await mcp.click();
    await expect.poll(async () => (await getTestAccountFacts(bot.email)).mcpAllowed).toBe(true);
    await expect(mcp).toBeChecked();
    expect(await listStatus()).toBe(200);
  } finally {
    await deleteTestUser(orphan.email);
    await deleteTestUser(bot.email);
    await deleteTestUser(other.email);
    await deleteTestUser(personEmail);
  }
});
