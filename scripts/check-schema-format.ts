// Fails if `prisma/schema.prisma` isn't what `npx prisma format` would produce.
//
// Prisma has no `format --check` (checked against prisma@7.9), so this is the
// fail-if-dirty version: format into a scratch copy, compare, and put the
// original back either way. **It never leaves the file modified** — a check
// that silently rewrites your working tree is a formatter wearing a check's
// name, and the whole reason this exists is that `prisma format` rewriting
// things you didn't ask it to is the hazard.
//
// WHY NOT `prisma format && git diff --exit-code prisma/schema.prisma`. That
// one-liner conflates two different things: "the schema is misformatted" and
// "the schema has uncommitted edits". The second is true exactly when you are
// in the middle of a schema change — which is precisely when you would run this
// — so it would cry wolf on every real use and be ignored within a week. This
// compares the file against its own formatted self and says nothing about git.
//
// Usage:
//   npm run check:schema
//   npx tsx scripts/check-schema-format.ts --write   # format it instead of complaining
//
// Exits non-zero when the schema would change.

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveFromRoot } from "./resolve-from-root";

const SCHEMA = path.resolve(process.cwd(), "prisma/schema.prisma");
const BACKUP = `${SCHEMA}.check-backup`;
const write = process.argv.includes("--write");

/**
 * Line endings are git's business, not prisma's.
 *
 * `prisma format` always writes LF. `.gitattributes` pins the schema to LF
 * too, but a Windows editor can still save it CRLF between commits, and
 * comparing raw bytes then reports a difference on content identical line for
 * line — a check that fails on line endings alone is worse than no check.
 * Both sides normalise to LF, so this answers the question actually being
 * asked: would prisma format change anything a reviewer would see?
 */
function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function firstDifferingLine(a: string, b: string): { line: number; before: string; after: string } | null {
  const as = toLf(a).split("\n");
  const bs = toLf(b).split("\n");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    if (as[i] !== bs[i]) return { line: i + 1, before: as[i] ?? "(end of file)", after: bs[i] ?? "(end of file)" };
  }
  return null;
}

const original = readFileSync(SCHEMA, "utf8");
copyFileSync(SCHEMA, BACKUP);

let formatted: string;
try {
  // Prisma's CLI entry under node, not the `prisma` shim through a shell —
  // scripts/resolve-from-root.ts says why (the shim is a .cmd on Windows, and a
  // shell leaves the schema path unquoted).
  execFileSync(process.execPath, [resolveFromRoot("prisma/build/index.js"), "format", "--schema", SCHEMA], {
    stdio: "pipe",
  });
  formatted = readFileSync(SCHEMA, "utf8");
} finally {
  // Always restore first; `write` re-applies below. If prisma format threw
  // half-way, this is what stops a check from having eaten the schema.
  copyFileSync(BACKUP, SCHEMA);
  rmSync(BACKUP, { force: true });
}

const diff = firstDifferingLine(original, formatted);

if (diff === null) {
  console.log("prisma/schema.prisma is format-clean.");
  process.exit(0);
}

if (write) {
  writeFileSync(SCHEMA, formatted);
  console.log("prisma/schema.prisma reformatted.");
  process.exit(0);
}

console.error(
  `prisma/schema.prisma is not format-clean — first difference at line ${diff.line}:\n` +
    `  have: ${diff.before}\n` +
    `  want: ${diff.after}\n\n` +
    `Fix with \`npx prisma format\`. Then read the diff before staging it: that command rewrites\n` +
    `the WHOLE file, so anything it touches outside the block you edited is pre-existing drift\n` +
    `and belongs in its own commit, not buried in yours (CLAUDE.md's Database section,\n` +
    `docs/DATABASE.md's "Keeping schema.prisma format-clean").`,
);
process.exit(1);
