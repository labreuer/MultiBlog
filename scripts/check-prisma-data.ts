// Fails if a function hands one of its own parameters to a Prisma write as
// the write's data, instead of building that data from named fields.
//
// WHAT THIS IS DEFENDING. A server action receives whatever JSON its caller
// sends, whatever its parameter type says, and Prisma's `update` and `create`
// follow a model's relations: `{ user: { update: { role: "ADMIN" } } }` in a
// doc-link group's update data rewrites its owner's user row, which is how
// any signed-in account could once make itself an ADMIN
// (src/lib/doc-link-edit.ts). Nothing else notices: the parameter's type is a
// subset of Prisma's input type, so it compiles, and checking every field the
// type names looks like validation while a field it doesn't name goes through.
//
// THE RULE. The data of a write is an object built in place from named fields,
// or the output of a parse that builds one, never a parameter. This flags,
// for `create`, `createMany`, `update`, `updateMany`, `upsert` and their
// `AndReturn` forms, a `data` (or an upsert's `create`/`update`) that is
//   - a parameter of an enclosing function, or a binding destructured from one;
//   - a property read off one (`input.fields`);
//   - an object literal spreading one (`{ ...input, updatedAt }`);
//   - a local initialised from any of those, followed through other locals.
// It covers all of src/, not only the actions: an operation moved out of an
// action into src/lib (docs/MCP.md §1) carries its caller's input with it.
//
// WHY THE COMPILER API AND NOT A GREP. The whole question is whether a name is
// a parameter, and a grep can't follow a name to its declaration. The parse
// resolves no imports and runs no type check, so it costs about a second.
//
// WHAT IT DOES NOT CATCH: data assembled in another function and returned, or
// passed through a call. Those are built from named fields by construction, or
// the other function is where the rule applies.
//
// WHAT IT FLAGS THAT IS SAFE: a callback's parameter, as in
// `rows.map((row) => tx.x.create({ data: row }))`, even when `rows` was built
// locally. The same shape over `input.items` is the bug, and the parse can't
// tell the two apart; build the data from the row's named fields instead.
//
// Usage:
//   npm run check:prisma-data
//   npx tsx scripts/check-prisma-data.ts <file>...   (just those files)
//
// Exits non-zero, listing file:line, for each write whose data is a parameter.

import { globSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);

/** The properties of a write's argument that become row data. */
const DATA_PROPERTIES = new Set(["data", "create", "update"]);

const named = process.argv.slice(2);
const files = (named.length > 0 ? named : globSync("src/**/*.{ts,tsx}", { cwd: process.cwd() }))
  .map((f) => f.split(path.sep).join("/"))
  .filter((f) => !f.startsWith("src/generated/") && !f.endsWith(".test.ts"))
  .sort();

const program = ts.createProgram(files, { noResolve: true, noLib: true, allowJs: false, jsx: ts.JsxEmit.Preserve });
const checker = program.getTypeChecker();

/** Whether a declaration is a function parameter, or a binding destructured from one. */
function isParameterBinding(decl: ts.Declaration): boolean {
  let node: ts.Node = decl;
  while (ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    node = node.parent;
  }
  return ts.isParameter(node);
}

/**
 * Why `expr` is a parameter's value, or null if it isn't. Follows property
 * reads, `as`/`satisfies`/`!`/parentheses, and a local's initialiser.
 */
function parameterOrigin(expr: ts.Expression, seen = new Set<ts.Node>()): string | null {
  if (seen.has(expr)) return null;
  seen.add(expr);
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isNonNullExpression(expr)) {
    return parameterOrigin(expr.expression, seen);
  }
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    return parameterOrigin(expr.expression, seen);
  }
  if (ts.isObjectLiteralExpression(expr)) {
    for (const prop of expr.properties) {
      if (!ts.isSpreadAssignment(prop)) continue;
      const origin = parameterOrigin(prop.expression, seen);
      if (origin) return `a spread of ${origin}`;
    }
    return null;
  }
  if (!ts.isIdentifier(expr)) return null;
  return symbolOrigin(checker.getSymbolAtLocation(expr), expr.text, seen);
}

function symbolOrigin(symbol: ts.Symbol | undefined, name: string, seen: Set<ts.Node>): string | null {
  for (const decl of symbol?.declarations ?? []) {
    if (isParameterBinding(decl)) return `parameter \`${name}\``;
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const origin = parameterOrigin(decl.initializer, seen);
      if (origin) return `${origin}, through \`${name}\``;
    }
  }
  return null;
}

function checkDataValue(value: ts.Expression | ts.ShorthandPropertyAssignment): string | null {
  // `{ data }`: the name is the property's own symbol, so ask for the value's.
  // This is the shape the doc-link bug had.
  if (ts.isShorthandPropertyAssignment(value)) {
    return symbolOrigin(checker.getShorthandAssignmentValueSymbol(value), value.name.text, new Set());
  }
  return parameterOrigin(value);
}

const violations: string[] = [];

function visit(node: ts.Node, sourceFile: ts.SourceFile): void {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    WRITE_METHODS.has(node.expression.name.text) &&
    node.arguments.length > 0 &&
    ts.isObjectLiteralExpression(node.arguments[0])
  ) {
    for (const prop of node.arguments[0].properties) {
      const name = prop.name && ts.isIdentifier(prop.name) ? prop.name.text : null;
      if (!name || !DATA_PROPERTIES.has(name)) continue;
      const value = ts.isPropertyAssignment(prop) ? prop.initializer : ts.isShorthandPropertyAssignment(prop) ? prop : null;
      if (!value) continue;
      const reason = checkDataValue(value);
      if (reason) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(prop.getStart(sourceFile));
        const call = node.expression.getText(sourceFile);
        violations.push(`${sourceFile.fileName}:${line + 1}: ${call}'s \`${name}\` is ${reason}`);
      }
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
    `Found ${violations.length} Prisma write(s) whose data is a parameter:\n\n` +
      violations.map((v) => `  ${v}`).join("\n") +
      `\n\nBuild the data from named fields instead, or from a parse that does, such as` +
      `\nsrc/lib/doc-link-edit.ts. A server action is sent whatever its caller likes, and` +
      `\nPrisma follows relations, so a field the parameter's type doesn't name can still` +
      `\nwrite another table. See this script's header.\n`,
  );
  process.exit(1);
}

console.log(`No Prisma write takes a parameter as its data, in ${files.length} files.`);
