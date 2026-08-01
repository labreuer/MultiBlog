// Sets a user's password, and prints the exact command that reverses it.
//
// Usage:
//   npx tsx scripts/set-user-password.ts set    (--email=<email>|--id=<id>) <newPassword>
//   npx tsx scripts/set-user-password.ts restore (--email=<email>|--id=<id>) <bcryptHash>
//   npx tsx scripts/set-user-password.ts restore (--email=<email>|--id=<id>) --clear
//
// `set` hashes <newPassword> (bcryptjs, cost 12 — same as create-admin.ts and
// scripts/test-user.ts) and writes it to User.passwordHash, then prints a
// ready-to-run `restore` command carrying the OLD hash it just overwrote.
// `restore` writes that hash back VERBATIM — no re-hashing — which is what
// makes it exact: it recreates the exact row value that was there before, so
// the original password (which this script never sees a second time — bcrypt
// is one-way, "restore the old password" can only ever mean restoring the old
// HASH) works again as if `set` had never run. `--clear` covers the one case
// a hash can't: an account that had no password set (passwordHash IS NULL —
// email-invite/OAuth-only accounts, if this app ever grows one; today every
// credentials account has one, per src/app/sign-in/NOTES.md).
//
// No @example.com restriction, unlike scripts/test-user.ts — this operates on
// real accounts on purpose (e.g. resetting one you're locked out of), the same
// scope as create-admin.ts. Uses the soft-delete-aware `prisma` client, so a
// soft-deleted user's row is invisible to this script exactly as it is to the
// app itself.
//
// The printed `restore` command re-uses whichever of --email/--id `set` was
// called with, so --email works end to end. That means it re-resolves by
// email at restore time too — if the account's email changes in between, the
// printed command targets the wrong (or no) user. Deliberately not guarded
// against: pass --id instead if that gap matters for a given call.

import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53}$/;

function usage(): never {
  console.error(
    "Usage: npx tsx scripts/set-user-password.ts set     (--email=<email>|--id=<id>) <newPassword>\n" +
      "       npx tsx scripts/set-user-password.ts restore (--email=<email>|--id=<id>) <bcryptHash>\n" +
      "       npx tsx scripts/set-user-password.ts restore (--email=<email>|--id=<id>) --clear",
  );
  process.exitCode = 1;
  return process.exit(1);
}

function parseTarget(args: string[]): {
  where: { email: string } | { id: string };
  rawArg: string; // the literal --email=.../--id=... flag, for echoing back verbatim
  rest: string[];
} {
  const emailArg = args.find((a) => a.startsWith("--email="));
  const idArg = args.find((a) => a.startsWith("--id="));
  if (!!emailArg === !!idArg) usage(); // exactly one required
  const rest = args.filter((a) => a !== emailArg && a !== idArg);
  const rawArg = emailArg ?? idArg!;
  return {
    where: emailArg ? { email: emailArg.slice("--email=".length) } : { id: idArg!.slice("--id=".length) },
    rawArg,
    rest,
  };
}

// Quoted for direct copy-paste — an email can contain characters a shell would
// otherwise split on, and a bcrypt hash's `$`/`/` are shell-meaningful too.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function setPassword(args: string[]) {
  const { where, rawArg, rest } = parseTarget(args);
  const [newPassword] = rest;
  if (!newPassword) usage();

  const user = await prisma.user.findUnique({ where });
  if (!user) {
    console.error(`No user matching ${JSON.stringify(where)}.`);
    process.exitCode = 1;
    return;
  }

  const oldHash = user.passwordHash;
  const newHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });

  // Echoes back whichever of --email/--id was used to call `set`, rather than
  // always forcing --id: if this was --email=..., the printed restore command
  // re-resolves by email too. That means a later email change on this account
  // would make the printed command target the wrong (or no) user — accepted
  // as out of scope here, since the ask was to support --email at all, not to
  // survive edits to the account made in between `set` and `restore`.
  const restoreCmd = oldHash
    ? `npx tsx scripts/set-user-password.ts restore ${rawArg} ${shellQuote(oldHash)}`
    : `npx tsx scripts/set-user-password.ts restore ${rawArg} --clear`;

  console.log(`Password set for ${user.email} (id=${user.id}).`);
  console.log(`\nTo undo, run exactly:\n\n  ${restoreCmd}\n`);
}

async function restorePassword(args: string[]) {
  const { where, rest } = parseTarget(args); // rawArg unused here — restore already got a literal flag from the caller
  const clear = rest.includes("--clear");
  const [hash] = rest.filter((a) => a !== "--clear");

  if (!clear && !hash) usage();
  if (!clear && !BCRYPT_HASH.test(hash)) {
    console.error(
      `"${hash}" doesn't look like a bcrypt hash (expected $2a$/$2b$/$2y$ + cost + 53 chars).\n` +
        "Pass the exact value `set` printed, not a plaintext password — restore never re-hashes.",
    );
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.findUnique({ where });
  if (!user) {
    console.error(`No user matching ${JSON.stringify(where)}.`);
    process.exitCode = 1;
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: clear ? null : hash } });
  console.log(`Restored ${clear ? "no password (cleared)" : "the previous password hash"} for ${user.email}.`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "set") {
    await setPassword(rest);
  } else if (cmd === "restore") {
    await restorePassword(rest);
  } else {
    usage();
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
