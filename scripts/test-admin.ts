// Create or delete throwaway ADMIN accounts for manual testing (e.g. of
// concurrent-editing features, per CLAUDE.md). Restricted to @example.com
// addresses so it can never touch a real account.
//
// Usage:
//   npx tsx scripts/test-admin.ts create [email] [name]
//   npx tsx scripts/test-admin.ts delete [email]
// email defaults to test-admin@example.com; password is always "testpass123".

import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import { colorForSeed } from "../src/lib/author-colors";

const SAFE_EMAIL = /^[\w.+-]+@example\.com$/i;
const DEFAULT_EMAIL = "test-admin@example.com";
const TEST_PASSWORD = "testpass123";

function deriveInitials(name: string | null, email: string): string {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length > 0) {
    const first = words[0][0];
    const last = words.length > 1 ? words[words.length - 1][0] : words[0][1];
    return `${first}${last ?? ""}`.toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

async function create(email: string, name: string | null) {
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
      role: "ADMIN",
      color: colorForSeed(email),
      adminInitials: deriveInitials(name, email),
    },
  });
  // Pre-trusted (well past any reasonable trustThreshold) so comments this
  // account posts always auto-approve regardless of the site/post
  // moderation cascade — one less manual step when testing comment features.
  await prisma.commenter.create({
    data: { userId: user.id, email: user.email, displayName: name ?? user.email, approvedCount: 100 },
  });
  console.log(`Created ADMIN ${user.email} (id=${user.id}), password: ${TEST_PASSWORD}`);
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
  const [cmd, emailArg, nameArg] = process.argv.slice(2);
  const email = emailArg ?? DEFAULT_EMAIL;

  if (!SAFE_EMAIL.test(email)) {
    console.error(`Refusing to touch "${email}" — this script only operates on @example.com addresses.`);
    process.exitCode = 1;
    return;
  }

  if (cmd === "create") {
    await create(email, nameArg ?? null);
  } else if (cmd === "delete") {
    await del(email);
  } else {
    console.error("Usage: npx tsx scripts/test-admin.ts <create|delete> [email] [name]");
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
