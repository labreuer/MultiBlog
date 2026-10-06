import { SAFE_COLOR } from "@/lib/safe-css";

// What a caller may change on a doc link or a doc link group
// (src/app/actions/doc-links.ts), read out of whatever the action was sent.
//
// A server action receives any JSON its caller cares to send, whatever its
// parameter type says, and Prisma's `update` takes nested writes through a
// model's relations. Handed straight to `update`, `{ user: { update: { role:
// "ADMIN" } } }` on a group its caller owns would promote that caller, and
// any account can own a group. So the update is built here from the named
// fields alone, each a string or null, and anything else is refused rather
// than dropped: no caller sends anything else.

export const MAX_DOC_LINK_TEXT_LENGTH = 2000;

export type DocLinkEdit = { text?: string | null; overrideColor?: string | null };
export type DocLinkGroupEdit = DocLinkEdit & { name?: string | null };

type Edit = DocLinkGroupEdit;
type Parsed<T> = { data: T } | { error: string };

function parseEdit(input: unknown, fields: readonly (keyof Edit)[]): Parsed<Edit> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: "Invalid edit." };
  }
  const data: Edit = {};
  for (const [key, value] of Object.entries(input)) {
    if (!(fields as readonly string[]).includes(key)) {
      return { error: `Unknown field: ${key}.` };
    }
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") {
      return { error: `Invalid ${key}.` };
    }
    data[key as keyof Edit] = value;
  }
  if (data.overrideColor && !SAFE_COLOR.test(data.overrideColor)) {
    return { error: "Invalid color." };
  }
  if (data.text && data.text.length > MAX_DOC_LINK_TEXT_LENGTH) {
    return { error: "Text is too long." };
  }
  return { data };
}

export function parseDocLinkEdit(input: unknown): Parsed<DocLinkEdit> {
  return parseEdit(input, ["text", "overrideColor"]);
}

export function parseDocLinkGroupEdit(input: unknown): Parsed<DocLinkGroupEdit> {
  return parseEdit(input, ["name", "text", "overrideColor"]);
}
