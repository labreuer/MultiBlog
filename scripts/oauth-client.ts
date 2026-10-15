// Registers an OAuth client by hand, lists the clients this server knows, or
// revokes one (docs/MCP.md §21, "Which clients").
//
// Usage:
//   npx tsx scripts/oauth-client.ts --name=<name> --redirect-uri=<uri> [--redirect-uri=<uri> …]
//       --kind=claude-ai|other
//   npx tsx scripts/oauth-client.ts --list
//   npx tsx scripts/oauth-client.ts --revoke=<client_id>
//
// **Two uses.** `--kind=claude-ai` is claude.ai's fallback: its connector
// dialog's "Use your own OAuth client" takes the client_id printed here, with
// the secret left blank, which keeps claude.ai connecting should its published
// identity stop matching the pin (scripts/check-oauth-clients.ts says when).
// Its redirect URI is claude.ai's callback, https://claude.ai/api/mcp/auth_callback,
// and a new connection through it replaces the bot's last one, as the pinned
// identity's does. `--kind=other` is anything else a person wants to connect,
// such as the MCP Inspector while testing.
//
// **Every client is public**: there is no secret to print, and PKCE is the
// proof on each code. A redirect URI is refused unless it is absolute, has no
// fragment, and is https, or plain http to a loopback address, matched there
// on any port (src/lib/oauth/authorize-request.ts's `redirectUriRefusal`).
//
// **Revoking a client revokes its connections**, in the same transaction. The
// two pinned identities, Claude's and Claude Code's, are listed beside the
// rows and can't be revoked: they are constants in the code
// (src/lib/oauth/pinned-clients.ts).

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { registerClient, revokeClient } from "../src/lib/oauth/clients";
import { PINNED_CLIENTS } from "../src/lib/oauth/pinned-clients";

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(
    "Usage: npx tsx scripts/oauth-client.ts --name=<name> --redirect-uri=<uri> [--redirect-uri=<uri> …] --kind=claude-ai|other\n" +
      "       npx tsx scripts/oauth-client.ts --list\n" +
      "       npx tsx scripts/oauth-client.ts --revoke=<client_id>",
  );
  return process.exit(1);
}

function flags(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
}

function flag(name: string): string | undefined {
  return flags(name)[0];
}

const KINDS = { "claude-ai": "CLAUDE_AI", other: "OTHER" } as const;

async function main() {
  const revoke = flag("revoke");
  if (revoke) {
    if (PINNED_CLIENTS.some(({ document }) => document.client_id === revoke)) usage(`${revoke} is pinned in the code, and can't be revoked.`);
    const revoked = await revokeClient(revoke);
    console.log(revoked ? `Revoked ${revoke}, and ${revoked.connections} connection(s) made through it.` : `No live client has the id ${revoke}.`);
    return;
  }

  if (process.argv.includes("--list")) {
    for (const { document, kind } of PINNED_CLIENTS) {
      console.log(`${document.client_id}  pinned  ${kind}  ${document.client_name}  ${document.redirect_uris.join(" ")}`);
    }
    const rows = await prisma.oauthClient.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, redirectUris: true, client: true, createdAt: true, revokedAt: true },
    });
    const live = await prisma.apiToken.groupBy({
      by: ["oauthClientId"],
      where: { oauthClientId: { in: rows.map((row) => row.id) }, revokedAt: null },
      _count: { _all: true },
    });
    const connections = new Map(live.map((group) => [group.oauthClientId, group._count._all]));
    for (const row of rows) {
      const state = row.revokedAt ? `revoked ${row.revokedAt.toISOString()}` : `live, ${connections.get(row.id) ?? 0} unrevoked connection(s)`;
      console.log(`${row.id}  ${state}  ${row.client}  ${row.name}  ${row.redirectUris.join(" ")}  registered ${row.createdAt.toISOString()}`);
    }
    if (rows.length === 0) console.log("No client is registered by hand.");
    return;
  }

  const name = flag("name") ?? usage("--name is required: the consent page shows it.");
  const redirectUris = flags("redirect-uri");
  if (redirectUris.length === 0) usage("--redirect-uri is required, once for each URI.");
  const kindFlag = flag("kind") ?? usage("--kind is required: claude-ai or other.");
  const kind = KINDS[kindFlag.toLowerCase() as keyof typeof KINDS] ?? usage(`Unknown --kind ${kindFlag}.`);

  let clientId: string;
  try {
    clientId = await registerClient({ name, redirectUris, kind });
  } catch (err) {
    // registerClient's refusals are written for whoever runs this.
    if (err instanceof Error && err.name === "Error") {
      console.error(`Refused: ${err.message}`);
      return process.exit(1);
    }
    throw err;
  }
  console.log(`Registered "${name}" (${kind}): client_id ${clientId}`);
  console.log(`Redirect URIs: ${redirectUris.join(" ")}`);
  console.log("It has no secret: every client here is public, and PKCE is the proof on each code.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
