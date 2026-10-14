// Writes the MultiBlog skill for claude.ai (docs/MCP.md §21, "The skill"):
// the ZIP a person uploads under Customize > Skills, holding
// `multiblog/SKILL.md`, or that SKILL.md alone on stdout. Both come from
// src/lib/mcp/skill.ts, which builds the skill from the server instructions'
// own text, so a ZIP written from a checkout matches the tools that checkout
// serves. Nothing here reads the database: the skill names no account.
//
// Usage:
//   npx tsx scripts/mcp-skill.ts <out.zip>
//   npx tsx scripts/mcp-skill.ts --print

import { writeFileSync } from "node:fs";
import { SKILL_NAME, skillMarkdown, skillZip } from "../src/lib/mcp/skill";

const args = process.argv.slice(2);
if (args.includes("--print")) {
  process.stdout.write(skillMarkdown());
} else if (args.length === 1 && !args[0].startsWith("--")) {
  writeFileSync(args[0], skillZip());
  console.log(`Wrote ${args[0]}: ${SKILL_NAME}/SKILL.md. Upload it in claude.ai under Customize > Skills, and turn it on.`);
} else {
  console.error("Usage: npx tsx scripts/mcp-skill.ts <out.zip>\n       npx tsx scripts/mcp-skill.ts --print");
  process.exit(1);
}
