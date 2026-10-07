// Issues an API token for the MCP server (docs/MCP.md §3), revokes one, or
// lists an account's.
//
// Usage:
//   npx tsx scripts/create-api-token.ts --email=<account> --issued-by=<email> --name=<label>
//       --scopes=read,write[,manage] [--client=claude-code|claude-ai|other] [--expires-days=N]
//       [--write-to=<path>]
//   npx tsx scripts/create-api-token.ts --list --email=<account>
//   npx tsx scripts/create-api-token.ts --revoke=<token id>
//
// The secret is printed once — or, with --write-to, written to that file with
// mode 0600 and not printed at all, which is how a Claude Code headersHelper
// reads it (docs/MCP.md §5: ~/.config/multiblog/<server>.token). Only its
// SHA-256 is stored, so a lost secret is replaced, never recovered.
//
// **The issuer is part of the token**: for your own token, yourself; for a
// bot account's, the person it works for. It decides who else a `write` call
// may put on a new doc's byline or a file's owner list.
//
// **--client decides which tools the token lists.** Only a `claude-code`
// token lists the three tools that force a prompt (edit_link, edit_file,
// manage), since Claude Code is the one client documented to honor the flag;
// it defaults to `other`.
//
// No @example.com restriction: this operates on real accounts on purpose, the
// scope of create-admin.ts and set-user-password.ts. The soft-delete-aware
// client, so a deleted account can neither hold nor issue a token.

import "dotenv/config";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { prisma } from "../src/lib/prisma";
import { issueApiToken } from "../src/lib/api/tokens";
import type { ApiScope, ApiTokenClient } from "../src/generated/prisma/enums";

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(
    "Usage: npx tsx scripts/create-api-token.ts --email=<account> --issued-by=<email> --name=<label> --scopes=read,write[,manage]\n" +
      "         [--client=claude-code|claude-ai|other] [--expires-days=N] [--write-to=<path>]\n" +
      "       npx tsx scripts/create-api-token.ts --list --email=<account>\n" +
      "       npx tsx scripts/create-api-token.ts --revoke=<token id>",
  );
  return process.exit(1);
}

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const SCOPES: Record<string, ApiScope> = { read: "READ", write: "WRITE", manage: "MANAGE" };
const CLIENTS: Record<string, ApiTokenClient> = { "claude-code": "CLAUDE_CODE", "claude-ai": "CLAUDE_AI", other: "OTHER" };

async function account(email: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true, name: true, role: true } });
  if (!user) usage(`No live account has the email ${email}.`);
  return user;
}

async function main() {
  const revoke = flag("revoke");
  if (revoke) {
    const result = await prisma.apiToken.updateMany({ where: { id: revoke, revokedAt: null }, data: { revokedAt: new Date() } });
    console.log(result.count === 1 ? `Revoked ${revoke}.` : `No live token has the id ${revoke}.`);
    return;
  }

  const email = flag("email") ?? usage("--email is required.");
  const user = await account(email);

  if (process.argv.includes("--list")) {
    const tokens = await prisma.apiToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, prefix: true, scopes: true, client: true, expiresAt: true, revokedAt: true, lastUsedAt: true },
    });
    for (const t of tokens) {
      const state = t.revokedAt ? "revoked" : t.expiresAt && t.expiresAt <= new Date() ? "expired" : "live";
      console.log(
        `${t.id}  ${t.prefix}…  ${state}  ${t.client}  ${t.scopes.join(",")}  ${t.name}  last used ${t.lastUsedAt?.toISOString() ?? "never"}`,
      );
    }
    if (tokens.length === 0) console.log(`${email} has no tokens.`);
    return;
  }

  const issuer = await account(flag("issued-by") ?? usage("--issued-by is required: the person this token works for."));
  const name = flag("name") ?? usage("--name is required.");
  const scopes = (flag("scopes") ?? usage("--scopes is required.")).split(",").map((s) => {
    const scope = SCOPES[s.trim().toLowerCase()];
    return scope ?? usage(`Unknown scope ${s}.`);
  });
  const client = CLIENTS[(flag("client") ?? "other").toLowerCase()] ?? usage("Unknown --client.");
  const days = flag("expires-days");
  const expiresAt = days ? new Date(Date.now() + Number(days) * 86_400_000) : null;
  if (days && !(Number(days) > 0)) usage("--expires-days is a positive number.");

  const { secret, id } = await issueApiToken({ userId: user.id, issuerId: issuer.id, name, scopes, client, expiresAt });
  console.log(
    `Issued ${id} for ${user.email} (${user.role}), issued by ${issuer.email}: ${scopes.join(", ")}, client ${client}` +
      (expiresAt ? `, expires ${expiresAt.toISOString()}` : ", no expiry") +
      ".",
  );
  const writeTo = flag("write-to");
  if (writeTo) {
    await mkdir(dirname(writeTo), { recursive: true, mode: 0o700 });
    await writeFile(writeTo, `${secret}\n`, { mode: 0o600 });
    await chmod(writeTo, 0o600);
    console.log(`The secret is in ${writeTo} (mode 0600); it is shown nowhere else.`);
  } else {
    console.log(`Secret (shown once): ${secret}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
