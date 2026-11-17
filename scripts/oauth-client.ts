// Registers an OAuth client by hand, lists the clients this server knows, or
// revokes one (docs/MCP.md §21, "Which clients").
//
// Usage:
//   npx tsx scripts/oauth-client.ts --name=<name> --redirect-uri=<uri> [--redirect-uri=<uri> …]
//       --kind=claude-ai|chatgpt|other [--agent=claude|chatgpt|antigravity]
//   npx tsx scripts/oauth-client.ts --list
//   npx tsx scripts/oauth-client.ts --revoke=<client_id>
//
// **Three uses.** `--kind=claude-ai` is claude.ai's fallback: its connector
// dialog's "Use your own OAuth client" takes the client_id printed here, with
// the secret left blank, which keeps claude.ai connecting should its published
// identity stop matching the pin (scripts/check-oauth-clients.ts says when).
// Its redirect URI is claude.ai's callback, https://claude.ai/api/mcp/auth_callback,
// and a new connection through it replaces the bot's last one, as the pinned
// identity's does. `--kind=chatgpt` is ChatGPT's fallback in the same way: its
// connector's advanced OAuth settings take a user-defined client's id, with the
// secret left blank and token authentication set to none, and its redirect URI
// is https://chatgpt.com/connector_platform_oauth_redirect. `--kind=other` is
// anything else a person wants to connect, such as the MCP Inspector while
// testing.
//
// **`--agent` is the AI agent the client is** ("Which agent a client is"): the
// consent page puts the person's bot for that agent first, and makes one at
// Approve for an AUTHOR or above who has none. Left out, it follows the kind:
// a `claude-ai` client is Claude's and a `chatgpt` one ChatGPT's, and an
// `other` is no agent's, for which no bot is made. So `--agent` is how a
// fallback for Google Antigravity or Claude Code, each an `other`, gets its
// agent. One that contradicts the kind is refused, `--kind=claude-ai
// --agent=chatgpt` say.
//
// **Every client is public**: there is no secret to print, and PKCE is the
// proof on each code. A redirect URI is refused unless it is absolute, has no
// fragment, and is https, or plain http to a loopback address, matched there
// on any port (src/lib/oauth/authorize-request.ts's `redirectUriRefusal`).
//
// **Revoking a client revokes its connections**, in the same transaction. The
// pinned identities are listed beside the
// rows and can't be revoked: they are constants in the code
// (src/lib/oauth/pinned-clients.ts).

import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import { registerClient, revokeClient } from "../src/lib/oauth/clients";
import { PINNED_CLIENTS, defaultAgentOf } from "../src/lib/oauth/pinned-clients";

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(
    "Usage: npx tsx scripts/oauth-client.ts --name=<name> --redirect-uri=<uri> [--redirect-uri=<uri> …] --kind=claude-ai|chatgpt|other\n" +
      "           [--agent=claude|chatgpt|antigravity]\n" +
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

const KINDS = { "claude-ai": "CLAUDE_AI", chatgpt: "CHATGPT", other: "OTHER" } as const;
const AGENT_FLAGS = { claude: "CLAUDE", chatgpt: "CHATGPT", antigravity: "ANTIGRAVITY" } as const;

/** An agent as --list shows it: its flag's spelling, or a dash for a client that is no agent's. */
function agentLabel(agent: string | null): string {
  return agent === null ? "agent -" : `agent ${agent.toLowerCase()}`;
}

async function main() {
  const revoke = flag("revoke");
  if (revoke) {
    if (PINNED_CLIENTS.some(({ document }) => document.client_id === revoke)) usage(`${revoke} is pinned in the code, and can't be revoked.`);
    const revoked = await revokeClient(revoke);
    console.log(revoked ? `Revoked ${revoke}, and ${revoked.connections} connection(s) made through it.` : `No live client has the id ${revoke}.`);
    return;
  }

  if (process.argv.includes("--list")) {
    for (const { document, kind, agent } of PINNED_CLIENTS) {
      console.log(`${document.client_id}  pinned  ${kind}  ${agentLabel(agent)}  ${document.client_name}  ${document.redirect_uris.join(" ")}`);
    }
    const rows = await prisma.oauthClient.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, redirectUris: true, client: true, agent: true, createdAt: true, revokedAt: true },
    });
    const live = await prisma.apiToken.groupBy({
      by: ["oauthClientId"],
      where: { oauthClientId: { in: rows.map((row) => row.id) }, revokedAt: null },
      _count: { _all: true },
    });
    const connections = new Map(live.map((group) => [group.oauthClientId, group._count._all]));
    for (const row of rows) {
      const state = row.revokedAt ? `revoked ${row.revokedAt.toISOString()}` : `live, ${connections.get(row.id) ?? 0} unrevoked connection(s)`;
      console.log(
        `${row.id}  ${state}  ${row.client}  ${agentLabel(row.agent)}  ${row.name}  ${row.redirectUris.join(" ")}  registered ${row.createdAt.toISOString()}`,
      );
    }
    if (rows.length === 0) console.log("No client is registered by hand.");
    return;
  }

  const name = flag("name") ?? usage("--name is required: the consent page shows it.");
  const redirectUris = flags("redirect-uri");
  if (redirectUris.length === 0) usage("--redirect-uri is required, once for each URI.");
  const kindFlag = flag("kind") ?? usage("--kind is required: claude-ai, chatgpt or other.");
  const kind = KINDS[kindFlag.toLowerCase() as keyof typeof KINDS] ?? usage(`Unknown --kind ${kindFlag}.`);
  const agentFlag = flag("agent");
  const agent = agentFlag === undefined ? undefined : (AGENT_FLAGS[agentFlag.toLowerCase() as keyof typeof AGENT_FLAGS] ?? usage(`Unknown --agent ${agentFlag}.`));

  let clientId: string;
  try {
    clientId = await registerClient({ name, redirectUris, kind, agent });
  } catch (err) {
    // registerClient's refusals are written for whoever runs this.
    if (err instanceof Error && err.name === "Error") {
      console.error(`Refused: ${err.message}`);
      return process.exit(1);
    }
    throw err;
  }
  console.log(`Registered "${name}" (${kind}, ${agentLabel(agent ?? defaultAgentOf(kind))}): client_id ${clientId}`);
  console.log(`Redirect URIs: ${redirectUris.join(" ")}`);
  console.log("It has no secret: every client here is public, and PKCE is the proof on each code.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
