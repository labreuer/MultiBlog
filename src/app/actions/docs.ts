"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import * as Y from "yjs";
import { auth } from "@/lib/auth";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { changeDocSlug, revertDocSlug as revertDocSlugInDb } from "@/lib/doc-slug";
import { canManageDocs, canUserEditDoc } from "@/lib/doc-authz";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import { ydocStore, encodeYdocState } from "../../../server/ydoc-store";
import { DocVisibility } from "@/generated/prisma/enums";
import { settleBulk, type BulkResult } from "@/lib/bulk-result";

async function requireEditableDocSession(docId: string) {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const doc = await prisma.doc.findUnique({ where: { id: docId } });
  if (!doc) {
    throw new Error("Doc not found.");
  }

  if (!(await canUserEditDoc(session.user.id, session.user.role, docId))) {
    throw new Error("You don't have permission to edit this doc.");
  }

  return { session, doc };
}

// Docs skip the title-first form a post uses (PLAN.md §12n) — the title is a
// live collaborative field (CollabTitleField.tsx), so asking for one before
// the doc exists just duplicates what the editor already does better. A doc
// is created titleless and slugged by its own id; see doc-title.ts for how
// "Untitled" is supplied at render without ever being real content.
//
// No useActionState/CreateDocState here (that's gone with the /docs/new
// form) — createDoc takes no input, so the only failure mode is the
// canManageDocs check, which /docs already gates the button on (§12f). This
// throw is defense in depth, not a UI-facing error path.
export async function createDoc(): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!canManageDocs(session.user.role)) {
    throw new Error("You don't have permission to create docs.");
  }

  // Doc.id is @default(cuid()) — unknown until the row is inserted — so the
  // cuid-as-slug (per PLAN.md §12n) needs a second write. The throwaway slug
  // only has to satisfy the unique constraint for the instant between the
  // two statements; nothing ever reads it.
  const doc = await prisma.$transaction(async (tx) => {
    const created = await tx.doc.create({
      data: {
        slug: crypto.randomUUID(),
        title: "",
        authors: { create: { userId: session.user.id, bylineOrder: 0 } },
      },
    });
    return tx.doc.update({ where: { id: created.id }, data: { slug: created.id } });
  });

  // Eager ydoc creation (PLAN.md §12b): the ydoc row is written in the same
  // request as the doc row, closing the window in which a connection could
  // arrive before either exists. Not wrapped in the transaction above — the
  // two tables share no foreign key by design (§12b) — but a failure here is
  // non-fatal: ydocOnLoadDocument's own createIfAbsent call
  // (server/ydoc-hooks.ts) is the same forgiving fallback /ydoc-debug's "New
  // document" button already relies on for a name nobody's created yet.
  const emptyDoc = new Y.Doc();
  const { ydoc, stateVector } = encodeYdocState(emptyDoc);
  emptyDoc.destroy();
  await ydocStore.createIfAbsent(ydocIdForDoc(doc.id), ydoc, stateVector);

  revalidatePath("/docs");
  redirect(`/doc/${doc.id}/edit`);
}

export async function updateDocVisibility(docId: string, visibility: DocVisibility): Promise<void> {
  await requireEditableDocSession(docId);
  if (!Object.values(DocVisibility).includes(visibility)) {
    throw new Error("Invalid visibility.");
  }
  await prisma.doc.update({ where: { id: docId }, data: { visibility } });
  revalidatePath(`/doc/${docId}/edit`);
  revalidatePath(`/doc/${docId}`);
}

export async function updateDocSlug(docId: string, newSlug: string): Promise<{ slug: string }> {
  const { doc } = await requireEditableDocSession(docId);
  const oldSlug = doc.slug;
  const slug = await changeDocSlug(docId, newSlug);

  revalidatePath(`/doc/${docId}/edit`);
  revalidatePath(`/doc/${docId}/slug`);
  revalidatePath("/docs");
  revalidatePath(`/doc/${oldSlug}`);
  revalidatePath(`/doc/${slug}`);
  return { slug };
}

export async function deleteDocSlugHistory(docId: string, slug: string): Promise<void> {
  await requireEditableDocSession(docId);
  await prisma.docSlugHistory.deleteMany({ where: { docId, slug } });
  revalidatePath(`/doc/${docId}/slug`);
}

export async function revertDocSlug(docId: string): Promise<{ slug: string }> {
  const { doc } = await requireEditableDocSession(docId);
  const oldSlug = doc.slug;
  const slug = await revertDocSlugInDb(docId);

  revalidatePath(`/doc/${docId}/edit`);
  revalidatePath(`/doc/${docId}/slug`);
  revalidatePath("/docs");
  revalidatePath(`/doc/${oldSlug}`);
  revalidatePath(`/doc/${slug}`);
  return { slug };
}

// Adds/removes a single DocAuthor row — see updatePostAuthor
// (src/app/actions/posts.ts) for the identical rationale.
export async function updateDocAuthor(docId: string, userId: string, included: boolean): Promise<void> {
  await requireEditableDocSession(docId);

  if (included) {
    const existing = await prisma.docAuthor.findUnique({ where: { docId_userId: { docId, userId } } });
    if (existing) return;
    const maxOrder = await prisma.docAuthor.aggregate({ where: { docId }, _max: { bylineOrder: true } });
    await prisma.docAuthor.create({
      data: { docId, userId, bylineOrder: (maxOrder._max.bylineOrder ?? -1) + 1 },
    });
  } else {
    const count = await prisma.docAuthor.count({ where: { docId } });
    if (count <= 1) {
      throw new Error("A doc must have at least one author.");
    }
    await prisma.docAuthor.delete({ where: { docId_userId: { docId, userId } } }).catch(() => {});
  }

  revalidatePath(`/doc/${docId}/edit`);
  revalidatePath("/docs");
}

export async function updateDocAuthorOrder(docId: string, orderedUserIds: string[]): Promise<void> {
  await requireEditableDocSession(docId);

  const current = await prisma.docAuthor.findMany({ where: { docId }, select: { userId: true } });
  const currentIds = new Set(current.map((a) => a.userId));
  if (orderedUserIds.length !== currentIds.size || orderedUserIds.some((id) => !currentIds.has(id))) {
    throw new Error("Author list changed — please retry.");
  }

  await prisma.$transaction(
    orderedUserIds.map((userId, bylineOrder) =>
      prisma.docAuthor.update({ where: { docId_userId: { docId, userId } }, data: { bylineOrder } }),
    ),
  );

  revalidatePath(`/doc/${docId}/edit`);
  revalidatePath("/docs");
}

// Soft delete/restore double as each other's undo — see setPostDeleted
// (src/app/actions/posts.ts) for the identical rationale, including why this
// goes through prismaIncludingDeleted rather than requireEditableDocSession.
async function setDocDeleted(docId: string, deleted: boolean): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const doc = await prismaIncludingDeleted.doc.findUnique({ where: { id: docId } });
  if (!doc) {
    throw new Error("Doc not found.");
  }
  if (!(await canUserEditDoc(session.user.id, session.user.role, docId))) {
    throw new Error("You don't have permission to delete this doc.");
  }
  await prisma.doc.update({
    where: { id: docId },
    data: deleted ? { deletedByUserId: session.user.id, deletedAt: new Date() } : { deletedByUserId: null, deletedAt: null },
  });
  revalidatePath("/docs");
}

export async function deleteDoc(docId: string): Promise<void> {
  await setDocDeleted(docId, true);
}

export async function restoreDoc(docId: string): Promise<void> {
  await setDocDeleted(docId, false);
}

// Bulk delete/restore (PLAN.md §16g) — see bulkDeletePosts for why these are
// per-row rather than one transaction.
export async function bulkDeleteDocs(docIds: string[]): Promise<BulkResult> {
  return settleBulk(docIds, (id) => setDocDeleted(id, true));
}

export async function bulkRestoreDocs(docIds: string[]): Promise<BulkResult> {
  return settleBulk(docIds, (id) => setDocDeleted(id, false));
}

export async function bulkSetDocVisibility(docIds: string[], visibility: DocVisibility): Promise<BulkResult> {
  return settleBulk(docIds, (id) => updateDocVisibility(id, visibility));
}
