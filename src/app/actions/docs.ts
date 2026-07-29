"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import * as Y from "yjs";
import { auth } from "@/lib/auth";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { uniqueDocSlug, changeDocSlug, revertDocSlug as revertDocSlugInDb } from "@/lib/doc-slug";
import { canManageDocs, canUserEditDoc } from "@/lib/doc-authz";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import { ydocStore, encodeYdocState } from "../../../server/ydoc-store";
import { DocVisibility } from "@/generated/prisma/enums";

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

export type CreateDocState = { error?: string };

// Eager ydoc creation (PLAN.md §12b): the ydoc row is written in the same
// request as the doc row, closing the window in which a connection could
// arrive before either exists. Not wrapped in one DB transaction with the
// doc insert — the two tables share no foreign key by design (§12b) — but a
// failure here is non-fatal: ydocOnLoadDocument's own createIfAbsent call
// (server/ydoc-hooks.ts) is the same forgiving fallback /ydoc-debug's "New
// document" button already relies on for a name nobody's created yet.
export async function createDocAction(_prevState: CreateDocState, formData: FormData): Promise<CreateDocState> {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!canManageDocs(session.user.role)) {
    return { error: "You don't have permission to create docs." };
  }

  const title = formData.get("title");
  if (typeof title !== "string" || !title.trim()) {
    return { error: "Title is required." };
  }
  const trimmedTitle = title.trim();

  const slug = await uniqueDocSlug(trimmedTitle);
  const doc = await prisma.doc.create({
    data: {
      slug,
      title: trimmedTitle,
      authors: { create: { userId: session.user.id, bylineOrder: 0 } },
    },
  });

  const emptyDoc = new Y.Doc();
  const { ydoc, stateVector } = encodeYdocState(emptyDoc);
  emptyDoc.destroy();
  await ydocStore.createIfAbsent(ydocIdForDoc(doc.id), ydoc, stateVector);

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
