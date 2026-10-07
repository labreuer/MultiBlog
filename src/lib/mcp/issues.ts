import { z } from "zod";

type Issue = z.core.$ZodIssue;

// A schema refusal as lines a model can act on. zod reports a union that
// no branch fits as one "Invalid input" at the union's path, with each
// branch's own issues nested inside it — so a malformed edit_doc item would
// say only "edits.0: Invalid input". This names the forms the union takes,
// by the keys each requires (read from the schema, since the issues name
// only what was missing), and then the issues of the branch that came
// closest (the fewest), at their full path.

const pathOf = (path: readonly PropertyKey[]): string => path.map(String).join(".") || "(arguments)";

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable || current instanceof z.ZodDefault) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

/** The schema at `path` under `schema`, or null where a union or anything else makes it ambiguous. */
function schemaAt(schema: z.ZodType | null, path: readonly PropertyKey[]): z.ZodType | null {
  let current = schema;
  for (const segment of path) {
    if (!current) return null;
    const inner = unwrap(current);
    if (inner instanceof z.ZodObject) current = (inner.shape as Record<string, z.ZodType>)[String(segment)] ?? null;
    else if (inner instanceof z.ZodArray) current = inner.element as z.ZodType;
    else return null;
  }
  return current ? unwrap(current) : null;
}

/** "old + new" for a strict object's required keys; null for any other schema, or one with none. */
function formOf(schema: z.ZodType): string | null {
  const inner = unwrap(schema);
  if (!(inner instanceof z.ZodObject)) return null;
  const required = Object.entries(inner.shape as Record<string, z.ZodType>)
    .filter(([, field]) => field._zod.optin !== "optional")
    .map(([key]) => key);
  return required.length > 0 ? required.join(" + ") : null;
}

export function issueLines(issues: readonly Issue[], schema: z.ZodType | null, prefix: readonly PropertyKey[] = []): string[] {
  const lines: string[] = [];
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      const union = schemaAt(schema, issue.path);
      const options = union instanceof z.ZodUnion ? (union.options as z.ZodType[]) : null;
      const forms = options?.map(formOf) ?? [];
      if (options && forms.every((form) => form !== null)) {
        lines.push(`${pathOf(path)}: fits none of its forms, which need ${forms.join(" | ")}`);
      }
      let closest = 0;
      issue.errors.forEach((branch, index) => {
        if (branch.length < issue.errors[closest].length) closest = index;
      });
      lines.push(...issueLines(issue.errors[closest], options?.[closest] ?? null, path));
      continue;
    }
    lines.push(`${pathOf(path)}: ${issue.message}`);
  }
  return lines;
}
