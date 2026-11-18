// Mints, prints again and revokes batches of join cards (docs/EMAIL.md §10,
// "Minting and printing"), on behalf of a named ADMIN, through the same
// functions the admin table will use (src/lib/join-codes/cards.ts).
//
// **The sheet holds live codes.** It is written to a directory outside the
// working tree, and should be deleted once the cards are printed: it can be
// written again from the database with --print, since a card's code is
// derived from its row under AUTH_SECRET rather than stored.
//
// Usage:
//   npx tsx scripts/join-codes/mint.ts --admin <email> --label "<label>" --count <n> --expires <date> [--line "<text>"] [--host <host>] [--out <dir>]
//   npx tsx scripts/join-codes/mint.ts --admin <email> --print <batch id> [--line "<text>"] [--host <host>] [--out <dir>]
//   npx tsx scripts/join-codes/mint.ts --admin <email> --revoke <batch id>[:<serial>]
//   npx tsx scripts/join-codes/mint.ts --list
//
// --expires takes an ISO date or date-time; a bare date means the end of that
// day, UTC. A claim confirmed after it is refused, so set it well past the
// event. --line is printed on every card under the site title. --host is what
// the QR and the card name, `<host>/join`; it defaults to APP_URL's host, and
// the QR always says https. --out defaults to ~/join-cards. Revoking a batch
// once its event is over is the clean-up: it nulls every pending claim's
// password hash, which expiry leaves.

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Prisma } from "../../src/generated/prisma/client";
import { prisma } from "../../src/lib/prisma";
import { SITE_TITLE } from "../../src/lib/site-config";
import { liveCardsForPrinting, mintJoinBatch, revokeJoinCards } from "../../src/lib/join-codes/cards";
import { renderCardSheet } from "../../src/lib/join-codes/sheet";
import { welcomePageReachesAuthors, WELCOME_PAGE_NAME } from "../../src/lib/front-page";
import { isAdmin } from "../../src/lib/role-checks";
import type { Actor } from "../../src/lib/actor";

const { values } = parseArgs({
  options: {
    admin: { type: "string" },
    label: { type: "string" },
    count: { type: "string" },
    expires: { type: "string" },
    line: { type: "string" },
    host: { type: "string" },
    out: { type: "string" },
    print: { type: "string" },
    revoke: { type: "string" },
    list: { type: "boolean" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function adminActor(email: string | undefined): Promise<Actor> {
  if (!email) fail("--admin <email> is required: the ADMIN the batch is minted, printed or revoked as.");
  const rows = await prisma.$queryRaw<{ id: string; role: string }[]>(Prisma.sql`
    SELECT id, role::text AS role FROM "user"
    WHERE lower(email) = lower(${email}) AND deleted_by_user_id IS NULL
  `);
  const row = rows[0];
  if (!row) fail(`No live account has the email ${email}.`);
  if (!isAdmin(row.role as Actor["role"])) fail(`${email} is ${row.role}, not ADMIN.`);
  return { userId: row.id, role: row.role as Actor["role"] };
}

function parseExpiry(text: string | undefined): Date {
  if (!text) fail("--expires <date> is required.");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T23:59:59.999Z`) : new Date(text);
  if (Number.isNaN(date.getTime())) fail(`Not a date: ${text}`);
  return date;
}

function cardHost(): string {
  if (values.host) return values.host;
  const appUrl = process.env.APP_URL;
  if (!appUrl) fail("--host is required when APP_URL is not set.");
  return new URL(appUrl).host;
}

function writeSheet(batchId: string, cards: { serial: number; code: string }[]): void {
  if (cards.length === 0) {
    console.log("No live cards to print.");
    return;
  }
  const dir = resolve(values.out ?? join(homedir(), "join-cards"));
  const fromTree = relative(process.cwd(), dir);
  if (!fromTree.startsWith("..") && !isAbsolute(fromTree)) {
    fail(`--out ${dir} is inside the working tree; the sheet holds live codes, so write it elsewhere.`);
  }
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `join-cards-${batchId}.html`);
  writeFileSync(file, renderCardSheet({ siteTitle: SITE_TITLE, host: cardHost(), line: values.line, cards }), {
    mode: 0o600,
  });
  console.log(`Wrote ${cards.length} card(s) to ${file}`);
  console.log("It holds live codes: delete it once the cards are printed.");
}

async function warnWithoutWelcomePage(): Promise<void> {
  if (!(await welcomePageReachesAuthors())) {
    console.warn(
      `Warning: no commons page "${WELCOME_PAGE_NAME}" is SHARED or PUBLIC, so /welcome will greet new accounts with a bare sentence.`,
    );
  }
}

async function main() {
  if (values.list) {
    const batches = await prisma.joinBatch.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        label: true,
        expiresAt: true,
        revokedAt: true,
        _count: { select: { codes: true } },
        codes: { where: { claimedAt: { not: null } }, select: { id: true } },
      },
    });
    for (const b of batches) {
      const state = b.revokedAt ? "revoked" : b.expiresAt <= new Date() ? "expired, not revoked" : "live";
      console.log(
        `${b.id}  ${b.label}  ${b.codes.length}/${b._count.codes} claimed  expires ${b.expiresAt.toISOString()}  ${state}`,
      );
    }
    return;
  }

  const actor = await adminActor(values.admin);

  if (values.revoke) {
    const [batchId, serialText] = values.revoke.split(":");
    const serial = serialText === undefined ? undefined : Number(serialText);
    if (serial !== undefined && !Number.isInteger(serial)) fail(`Not a serial: ${serialText}`);
    const ended = await revokeJoinCards(actor, batchId, serial);
    console.log(
      serial === undefined
        ? `Revoked batch ${batchId}; ${ended} unclaimed card(s) ended.`
        : ended
          ? `Revoked card ${serial} of batch ${batchId}.`
          : `Card ${serial} of batch ${batchId} was already claimed or revoked; nothing changed.`,
    );
    return;
  }

  if (values.print) {
    const { label, cards } = await liveCardsForPrinting(actor, values.print);
    console.log(`Batch ${values.print}: ${label}`);
    await warnWithoutWelcomePage();
    writeSheet(values.print, cards);
    return;
  }

  if (!values.label || !values.count) fail("--label and --count are required to mint (or use --print, --revoke or --list).");
  const host = cardHost();
  await warnWithoutWelcomePage();
  const { batchId, cards } = await mintJoinBatch(actor, {
    label: values.label,
    count: Number(values.count),
    expiresAt: parseExpiry(values.expires),
  });
  console.log(`Minted batch ${batchId}: ${cards.length} card(s) for https://${host}/join`);
  writeSheet(batchId, cards);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
