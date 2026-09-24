import { prismaIncludingDeleted } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";

// Next rejects app/doc/[slug]/page.tsx alongside app/doc/[id]/edit/page.tsx
// as two different dynamic segment names for the same path, so every
// /doc/[slug]/* route uses one segment name and resolves an id or a slug
// through this shared helper — id first, so a rename can't break a
// bookmarked edit URL (PLAN.md §12f).
//
// prismaIncludingDeleted rather than the soft-delete-filtered client: the
// editor route needs a soft-deleted doc to still resolve, so its Settings
// panel can offer Undelete. Callers that must not see a deleted doc (the
// reading route, PLAN.md §12g) check deletedAt themselves.
export async function resolveDocParam<T extends Prisma.DocSelect>(
  param: string,
  select: T,
): Promise<Prisma.DocGetPayload<{ select: T }> | null> {
  const byId = await prismaIncludingDeleted.doc.findUnique({ where: { id: param }, select });
  if (byId) return byId;
  return prismaIncludingDeleted.doc.findUnique({ where: { slug: param }, select });
}

// The doc a past slug now belongs to, from DocSlugHistory — for the reading
// route's live-slug miss (docs/DOCS.md "Routes"), which answers with a
// redirect to `/doc/<slug>` rather than a 404. A separate call rather than a
// `redirectTo` on resolveDocParam's result (resolveFileParam's shape): that
// helper's callers are the editor, /slug and /side-by-side, none of which
// follow history, and each would otherwise have to unwrap a result it ignores.
// Returns what the caller needs to gate on before disclosing the current slug.
export async function resolveDocSlugHistory(
  slug: string,
): Promise<{ id: string; slug: string; visibility: "PRIVATE" | "SHARED"; deletedByUserId: string | null } | null> {
  const entry = await prismaIncludingDeleted.docSlugHistory.findUnique({
    where: { slug },
    select: { doc: { select: { id: true, slug: true, visibility: true, deletedByUserId: true } } },
  });
  return entry?.doc ?? null;
}
