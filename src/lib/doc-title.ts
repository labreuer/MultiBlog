// A doc's title fragment can be empty — created that way (createDoc,
// src/app/actions/docs.ts) and legitimately clearable later, with Doc.title
// now an honest cache of it (server/doc-cache.ts, PLAN.md §12n). "Untitled"
// is never stored: it's supplied here, at render, everywhere a doc's title
// is shown or used to derive something (a slug suggestion, a sort key).
// Pure — no Prisma import — so both server pages and the client DocEditor
// can use it.
export const UNTITLED_DOC = "Untitled";

export function docTitleOrFallback(title: string): string {
  return title.trim() || UNTITLED_DOC;
}
