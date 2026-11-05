// Fails if a write changes a field an entity chip's label is computed from
// and the function it sits in never starts that chip kind's label refresh.
//
// WHAT THIS IS DEFENDING. A chip's label is computed from its target's record
// (docs/ENTITY_CHIPS.md, rule 2), and two columns hold computed labels as
// text: a doc's `prose_json`, which search reads, and a note's `body_text`.
// An edit rewrites both through the ordinary store. A rename is not an edit,
// so the write that renames has to start the refresh itself (step 1, item
// 10). One that doesn't still compiles, lints and passes its tests, and every
// open editor still shows the new name, since a live label is computed. Only
// search and the RAISED email keep the old one, for a doc nobody opens.
//
// THE RULE. For each table below, a Prisma `update`, `updateMany`,
// `updateManyAndReturn` or `upsert` whose data names one of its fields must
// sit inside a function that also calls the table's refresh. The data has to
// be readable here: an object built in place (a `cond ? {…} : {…}` counts,
// as both branches), or a local built from one in the same function (its
// literal, plus any `local.field = …` after it).
// Anything else is flagged as unreadable rather than passed.
//
// A new chip kind adds its table here, with the fields its context loader
// reads (the kind contract, item 3).
//
// WHY THE COMPILER API AND NOT A GREP. The fields are common words (`name`,
// `slug`), and what matters is whether one is a key of this call's data.
//
// WHAT IT DOES NOT CATCH: raw SQL, a script outside src/ and server/, and a
// write through a relation (`{ user: { update: { name } } }` in another
// model's data). `scripts/integrity/check-doc-integrity.ts` reports the stale
// labels any of those leaves, as `chip-labels`.
//
// Usage:
//   npm run check:label-refresh
//   npx tsx scripts/check-label-refresh.ts <file>...   (just those files)
//
// Exits non-zero, listing file:line, for each write with no refresh beside it.

import { globSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

type Watched = { fields: ReadonlySet<string>; refresh: string; doc: string };

/** Per Prisma model (as the client names it): the fields a label reads, and the call that refreshes. */
const WATCHED: Record<string, Watched> = {
  // docs/MENTIONS.md, "Refresh": a name, initials, a handle, or the person a bot works for.
  user: {
    fields: new Set(["name", "adminInitials", "slug", "worksForUserId", "worksFor"]),
    refresh: "scheduleMentionRefresh",
    doc: "docs/MENTIONS.md, \"Refresh\"",
  },
  // docs/CITATIONS.md, "Refresh": a reference's record, or its abbreviation.
  reference: {
    fields: new Set(["csl", "short"]),
    refresh: "scheduleCitationRefresh",
    doc: "docs/CITATIONS.md, \"Refresh\"",
  },
};

const WRITE_METHODS = new Set(["update", "updateMany", "updateManyAndReturn", "upsert"]);

/** The properties of a write's argument that become an existing row's data. */
const DATA_PROPERTIES = new Set(["data", "update"]);

const named = process.argv.slice(2);
const files = (named.length > 0 ? named : globSync("{src,server}/**/*.{ts,tsx}", { cwd: process.cwd() }))
  .map((f) => f.split(path.sep).join("/"))
  .filter((f) => !f.startsWith("src/generated/") && !f.endsWith(".test.ts"))
  .sort();

const program = ts.createProgram(files, { noResolve: true, noLib: true, allowJs: false, jsx: ts.JsxEmit.Preserve });
const checker = program.getTypeChecker();

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** The outermost function around `node`: a refresh is called once the whole write has committed. */
function outermostFunction(node: ts.Node): ts.Node | null {
  let found: ts.Node | null = null;
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (isFunctionLike(at)) found = at;
  }
  return found;
}

function unwrap(expr: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isNonNullExpression(expr)) {
    expr = expr.expression;
  }
  return expr;
}

/** The keys an object literal names, or null when it spreads something this can't read. */
function literalKeys(literal: ts.ObjectLiteralExpression): string[] | null {
  const keys: string[] = [];
  for (const prop of literal.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const spread = keysOf(prop.expression, literal);
      if (!spread) return null;
      keys.push(...spread);
      continue;
    }
    if (!prop.name) return null;
    if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) keys.push(prop.name.text);
    else return null;
  }
  return keys;
}

/** Every `name.key = …` inside `scope`. */
function assignedKeys(name: string, scope: ts.Node): string[] {
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === name
    ) {
      keys.push(node.left.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return keys;
}

/** The keys `expr` holds as row data, or null when they can't be read from the source. */
function keysOf(expr: ts.Expression, at: ts.Node): string[] | null {
  const value = unwrap(expr);
  if (ts.isObjectLiteralExpression(value)) return literalKeys(value);
  // `cond ? { a } : { b }`, alone or spread: whichever branch runs, so both.
  if (ts.isConditionalExpression(value)) {
    const [yes, no] = [keysOf(value.whenTrue, at), keysOf(value.whenFalse, at)];
    return yes && no ? [...yes, ...no] : null;
  }
  if (!ts.isIdentifier(value)) return null;
  return keysOfLocal(checker.getSymbolAtLocation(value), value.text, at);
}

/** The keys a local holds: its literal's, plus whatever the function assigns onto it afterwards. */
function keysOfLocal(symbol: ts.Symbol | undefined, name: string, at: ts.Node): string[] | null {
  const scope = outermostFunction(at);
  for (const decl of symbol?.declarations ?? []) {
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) return null;
    const initial = unwrap(decl.initializer);
    if (!ts.isObjectLiteralExpression(initial)) return null;
    const keys = literalKeys(initial);
    if (!keys) return null;
    return [...keys, ...(scope ? assignedKeys(name, scope) : [])];
  }
  return null;
}

function calls(scope: ts.Node, callee: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

const violations: string[] = [];

function visit(node: ts.Node, sourceFile: ts.SourceFile): void {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    WRITE_METHODS.has(node.expression.name.text) &&
    ts.isPropertyAccessExpression(node.expression.expression) &&
    node.arguments.length > 0 &&
    ts.isObjectLiteralExpression(node.arguments[0])
  ) {
    const model = node.expression.expression.name.text;
    const watched = Object.hasOwn(WATCHED, model) ? WATCHED[model] : null;
    for (const prop of watched ? node.arguments[0].properties : []) {
      const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
      if (!watched || !name || !DATA_PROPERTIES.has(name)) continue;
      if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
      const where = () => {
        const { line } = sourceFile.getLineAndCharacterOfPosition(prop.getStart(sourceFile));
        return `${sourceFile.fileName}:${line + 1}: ${node.expression.getText(sourceFile)}`;
      };
      // `{ data }`: the name is the property's own symbol, so ask for the value's.
      const keys = ts.isShorthandPropertyAssignment(prop)
        ? keysOfLocal(checker.getShorthandAssignmentValueSymbol(prop), prop.name.text, node)
        : keysOf(prop.initializer, node);
      if (!keys) {
        violations.push(`${where()}'s \`${name}\` can't be read here: build it in place, from named fields`);
        continue;
      }
      const changed = keys.filter((key) => watched.fields.has(key));
      if (changed.length === 0) continue;
      const scope = outermostFunction(node);
      if (scope && calls(scope, watched.refresh)) continue;
      violations.push(`${where()} sets ${changed.map((key) => `\`${key}\``).join(", ")} and never calls ${watched.refresh}() (${watched.doc})`);
    }
  }
  ts.forEachChild(node, (child) => visit(child, sourceFile));
}

for (const file of files) {
  const sourceFile = program.getSourceFile(file);
  if (sourceFile) visit(sourceFile, sourceFile);
}

if (violations.length > 0) {
  console.error(
    `Found ${violations.length} write(s) that change what a chip's label reads, with no refresh:\n\n` +
      violations.map((v) => `  ${v}`).join("\n") +
      `\n\nA doc's prose_json and a note's body_text hold each chip's label as text, and only` +
      `\nan edit or a refresh rewrites them. Call the refresh after the write commits, outside` +
      `\nits transaction. See this script's header.\n`,
  );
  process.exit(1);
}

console.log(`Every write to a field a chip's label reads starts its refresh, in ${files.length} files.`);
