// Create the first real ADMIN account on a fresh deployment. Unlike
// scripts/test-user.ts (which refuses anything but @example.com), this is meant
// for a genuine account, so it accepts any email — run it once, by hand, right
// after `prisma migrate deploy` on a DB that has no users yet. See DEPLOY.md §1c.
//
// A User needs email, slug, adminInitials, and passwordHash set explicitly (the
// rest default); role is forced to ADMIN here. Re-running with an email that
// already exists is a harmless no-op rather than an error, so a repeated deploy
// step doesn't fail.
//
// Usage:
//   npx tsx scripts/create-admin.ts <email> <name> <adminInitials> <password>
// name may contain spaces — quote it. Example:
//   npx tsx scripts/create-admin.ts admin@example.com "Jane Doe" JD 's3cret'

import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import { colorForSeed } from "../src/lib/author-colors";
import { uniqueUserSlug } from "../src/lib/user-slug";

async function main() {
  const [email, name, adminInitials, password] = process.argv.slice(2);

  if (!email || !name || !adminInitials || !password) {
    console.error(
      "Usage: npx tsx scripts/create-admin.ts <email> <name> <adminInitials> <password>\n" +
        '  (name may contain spaces — quote it, e.g. "Jane Doe")',
    );
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`${email} already exists (role=${existing.role}); nothing to do.`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const slug = await uniqueUserSlug(name, email);
  const user = await prisma.user.create({
    data: {
      email,
      slug,
      name,
      passwordHash,
      role: "ADMIN",
      color: colorForSeed(email),
      adminInitials: adminInitials.trim(),
    },
  });

  console.log(`Created ADMIN ${user.email} (id=${user.id}, slug=${user.slug}).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
