import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuthenticatedToken } from "@/lib/api/tokens";
import { instructionsFor, INSTRUCTIONS_MAX_CHARS } from "./instructions";
import { SKILL_DESCRIPTION, SKILL_DESCRIPTION_MAX_CHARS, SKILL_NAME, skillMarkdown } from "./skill";
import { listedName, TOOL_NAMES, TOOL_PREFIX } from "./tool";

// docs/MCP.md §21, "The skill" — what claude.ai refuses a skill for, and the
// one way the skill and the instructions can fall out of step with the
// server without anything else noticing: naming a tool it doesn't list.

const LISTED = new Set<string>(TOOL_NAMES.map(listedName));

/** Every `multiblog_…` name a text mentions, short of the `multiblog_*` wildcard. */
function namedTools(text: string): string[] {
  return [...text.matchAll(new RegExp(`${TOOL_PREFIX}[a-z_]+`, "g"))].map((m) => m[0]);
}

test("the name is one claude.ai takes", () => {
  assert.match(SKILL_NAME, /^[a-z0-9-]{1,64}$/);
  assert.doesNotMatch(SKILL_NAME, /anthropic|claude/);
});

test("the description fits claude.ai's cap and stays a plain YAML scalar", () => {
  assert.ok(SKILL_DESCRIPTION.length <= SKILL_DESCRIPTION_MAX_CHARS, `${SKILL_DESCRIPTION.length} characters`);
  assert.doesNotMatch(SKILL_DESCRIPTION, /[<>]/);
  assert.doesNotMatch(SKILL_DESCRIPTION, /: | #|\n/);
  assert.doesNotMatch(SKILL_DESCRIPTION, /^[-?:,[\]{}#&*!|>'"%@`\s]/);
});

test("SKILL.md opens with its frontmatter, the description on one line", () => {
  const lines = skillMarkdown().split("\n");
  assert.deepEqual(lines.slice(0, 4), ["---", `name: ${SKILL_NAME}`, `description: ${SKILL_DESCRIPTION}`, "---"]);
});

test("every tool the skill names is one the server lists", () => {
  const named = namedTools(skillMarkdown());
  assert.ok(named.length > 0);
  assert.deepEqual(
    named.filter((name) => !LISTED.has(name)),
    [],
  );
});

test("every tool the instructions name is one the server lists, and they fit Claude Code's cap with long names", () => {
  const long = (suffix: string) => ({
    id: suffix,
    name: `Bartholomew Montgomery-Fitzwilliam Abernathy-Kowalczyk the ${suffix}`,
    slug: `bartholomew-montgomery-fitzwilliam-abernathy-kowalczyk-the-${suffix}`,
    role: "AUTHOR" as const,
  });
  const token = { user: long("third"), issuer: long("fourth"), scopes: ["READ", "WRITE"] } as unknown as AuthenticatedToken;
  const instructions = instructionsFor(token);
  assert.ok(instructions.length <= INSTRUCTIONS_MAX_CHARS, `${instructions.length} characters`);
  assert.deepEqual(
    namedTools(instructions).filter((name) => !LISTED.has(name)),
    [],
  );
});
