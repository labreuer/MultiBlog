// /users' bot controls (docs/MCP.md §21, "Whose account"): the New bot panel,
// which offers only the people a bot may work for and only the roles it may
// have under the one chosen; and the Works for column, which moves a bot only
// after a Yes, since the move stops the tokens its previous person issued.
// The rules beneath both are e2e/mcp-bots.spec.ts's; this drives the UI once.
import { test, expect } from "./fixtures";
import { createTestApiToken, createTestBot, createTestUser, deleteTestUser, getTestBotFacts, uniqueEmail } from "./db";
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
