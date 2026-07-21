// Create or delete throwaway user accounts (any role) for manual testing
// (e.g. of concurrent-editing features, role-gated actions, or comment
// trust/moderation states per CLAUDE.md). Restricted to @example.com
// addresses so it can never touch a real account.
//
// Usage:
//   npx tsx scripts/test-user.ts create [email] [name] [--role=ADMIN|EDITOR|AUTHOR|COMMENTER] [--trusted] [--force-moderate]
//   npx tsx scripts/test-user.ts delete [email]
// email defaults to test-admin@example.com; password is always "testpass123".
// --role defaults to ADMIN. --trusted and --force-moderate each create a
// Commenter row for the new user (approvedCount: 100 and forceModerate: true
// respectively — both can be passed together) so comment-trust/moderation
// tests don't need a separate manual DB step; omit both to leave the user
// without a pre-existing Commenter row (one gets upserted lazily on their
// first comment, same as any real account).

import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import { colorForSeed } from "../src/lib/author-colors";
import { Role } from "../src/generated/prisma/enums";

const SAFE_EMAIL = /^[\w.+-]+@example\.com$/i;
const DEFAULT_EMAIL = "test-admin@example.com";
const TEST_PASSWORD = "testpass123";
const ROLE_VALUES = Object.values(Role);

function deriveInitials(name: string | null, email: string): string {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length > 0) {
    const first = words[0][0];
    const last = words.length > 1 ? words[words.length - 1][0] : words[0][1];
    return `${first}${last ?? ""}`.toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

function parseCreateArgs(args: string[]): {
  email: string;
  name: string | null;
  role: Role;
  trusted: boolean;
  forceModerate: boolean;
} {
  const positional: string[] = [];
  let role: Role = "ADMIN";
  let trusted = false;
  let forceModerate = false;

  for (const arg of args) {
    if (arg === "--trusted") {
      trusted = true;
    } else if (arg === "--force-moderate") {
      forceModerate = true;
    } else if (arg.startsWith("--role=")) {
      const value = arg.slice("--role=".length).toUpperCase();
      if (!ROLE_VALUES.includes(value as Role)) {
        throw new Error(`Invalid --role value "${value}" — must be one of ${ROLE_VALUES.join(", ")}.`);
      }
      role = value as Role;
    } else {
      positional.push(arg);
    }
  }

  const [emailArg, nameArg] = positional;
  return { email: emailArg ?? DEFAULT_EMAIL, name: nameArg ?? null, role, trusted, forceModerate };
}

async function create(email: string, name: string | null, role: Role, trusted: boolean, forceModerate: boolean) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.error(`${email} already exists (role=${existing.role}). Delete it first or pick another email.`);
    process.exitCode = 1;
    return;
  }

  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 12);
  const user = await prisma.user.create({
    data: {
      email,
      name,
      passwordHash,
      role,
      color: colorForSeed(email),
      adminInitials: deriveInitials(name, email),
    },
  });

  if (trusted || forceModerate) {
    await prisma.commenter.create({
      data: {
        userId: user.id,
        email: user.email,
        displayName: name ?? user.email,
        approvedCount: trusted ? 100 : 0,
        forceModerate,
      },
    });
  }

  console.log(`Created ${role} ${user.email} (id=${user.id}), password: ${TEST_PASSWORD}`);
  if (trusted || forceModerate) {
    console.log(`Commenter row: approvedCount=${trusted ? 100 : 0}, forceModerate=${forceModerate}`);
  }
}

async function del(email: string) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    console.log(`${email} does not exist, nothing to do.`);
    return;
  }
  // Deleting the user alone would only null out the Commenter row's userId
  // (an optional FK), leaving an orphaned row keyed to this email — which
  // blocks `create` from ever reusing this email again (Commenter.email is
  // unique) and made a real throwaway-account collision during testing.
  await prisma.commenter.deleteMany({ where: { email } });
  await prisma.user.delete({ where: { email } });
  console.log(`Deleted ${email} (was role=${existing.role}).`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "create") {
    const { email, name, role, trusted, forceModerate } = parseCreateArgs(rest);
    if (!SAFE_EMAIL.test(email)) {
      console.error(`Refusing to touch "${email}" — this script only operates on @example.com addresses.`);
      process.exitCode = 1;
      return;
    }
    await create(email, name, role, trusted, forceModerate);
  } else if (cmd === "delete") {
    const email = rest[0] ?? DEFAULT_EMAIL;
    if (!SAFE_EMAIL.test(email)) {
      console.error(`Refusing to touch "${email}" — this script only operates on @example.com addresses.`);
      process.exitCode = 1;
      return;
    }
    await del(email);
  } else {
    console.error(
      "Usage: npx tsx scripts/test-user.ts create [email] [name] [--role=ADMIN|EDITOR|AUTHOR|COMMENTER] [--trusted] [--force-moderate]\n" +
        "       npx tsx scripts/test-user.ts delete [email]",
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
