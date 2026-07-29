"use server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canUserReadDoc } from "@/lib/doc-authz";
import { SAFE_COLOR } from "@/lib/safe-css";
import type { DocLinkMark } from "@/lib/doc-link-anchor";

const MAX_TEXT_LENGTH = 2000;

// PLAN.md §14i — creating a link requires only canUserReadDoc: a doc link
// never mutates the document, so the same rule an annotation's composer
// uses applies here too. A group row is not written until there is
// something to save (§14i) — the first link into a fresh group creates
// both in one transaction, exactly as this function does when `groupId` is
// omitted; the dropdown/panel (§14h, Phase 6) that would let a caller pass
// an *existing* groupId doesn't exist yet, so every call today creates a
// new group.
export async function createDocLink(opts: {
  docId: string;
  mark: DocLinkMark;
  groupId?: string;
  text?: string;
  overrideColor?: string;
}): Promise<{ id: string; groupId: string } | { error: string }> {
  const session = await auth();
  if (!session?.user) {
    return { error: "Not signed in." };
  }

  const doc = await prisma.doc.findUnique({ where: { id: opts.docId }, select: { id: true, visibility: true } });
  if (!doc) {
    return { error: "Doc not found." };
  }
  if (!(await canUserReadDoc(session.user.id, session.user.role, doc))) {
    return { error: "You don't have permission to link this doc." };
  }
  if (opts.text && opts.text.length > MAX_TEXT_LENGTH) {
    return { error: "Text is too long." };
  }
  if (opts.overrideColor && !SAFE_COLOR.test(opts.overrideColor)) {
    return { error: "Invalid color." };
  }

  if (opts.groupId) {
    const group = await prisma.docLinkGroup.findUnique({ where: { id: opts.groupId } });
    if (!group || group.deletedAt) {
      return { error: "Group not found." };
    }
    const link = await prisma.docLink.create({
      data: {
        docId: opts.docId,
        mark: opts.mark as object,
        docLinkGroupId: group.id,
        userId: session.user.id,
        text: opts.text || null,
        overrideColor: opts.overrideColor || null,
      },
    });
    return { id: link.id, groupId: group.id };
  }

  const [group, link] = await prisma.$transaction(async (tx) => {
    const newGroup = await tx.docLinkGroup.create({ data: { userId: session.user.id } });
    const newLink = await tx.docLink.create({
      data: {
        docId: opts.docId,
        mark: opts.mark as object,
        docLinkGroupId: newGroup.id,
        userId: session.user.id,
        text: opts.text || null,
        overrideColor: opts.overrideColor || null,
      },
    });
    return [newGroup, newLink];
  });

  return { id: link.id, groupId: group.id };
}

async function requireOwnOrAdminLink(linkId: string) {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const link = await prisma.docLink.findUnique({ where: { id: linkId } });
  if (!link) {
    throw new Error("Doc link not found.");
  }
  const isOwn = link.userId === session.user.id;
  if (session.user.role !== "ADMIN" && !isOwn) {
    throw new Error("You don't have permission to modify this doc link.");
  }
  return { session, link };
}

// Debounced from the caller (§14i's "debounce-save once already saved at
// least once") — this action itself always writes immediately.
export async function updateDocLink(
  linkId: string,
  data: { text?: string | null; overrideColor?: string | null },
): Promise<{ error?: string }> {
  await requireOwnOrAdminLink(linkId);
  if (data.overrideColor && !SAFE_COLOR.test(data.overrideColor)) {
    return { error: "Invalid color." };
  }
  if (data.text && data.text.length > MAX_TEXT_LENGTH) {
    return { error: "Text is too long." };
  }
  await prisma.docLink.update({ where: { id: linkId }, data });
  return {};
}

export async function deleteDocLink(linkId: string): Promise<void> {
  const { link } = await requireOwnOrAdminLink(linkId);
  await prisma.docLink.update({ where: { id: link.id }, data: { deletedAt: new Date() } });
}

// PLAN.md §14h/§14i — "New Doc Link Group" opens an *unsaved* panel; this
// is called on that panel's first debounced save, not when the dropdown
// item is clicked. Creating eagerly would make the group invisible in the
// very dropdown that created it (membership there is "has a link to either
// doc") and orphan it if the panel is abandoned.
export async function createDocLinkGroup(data: {
  name?: string;
  text?: string;
  overrideColor?: string;
}): Promise<{ id: string } | { error: string }> {
  const session = await auth();
  if (!session?.user) {
    return { error: "Not signed in." };
  }
  if (data.text && data.text.length > MAX_TEXT_LENGTH) {
    return { error: "Text is too long." };
  }
  if (data.overrideColor && !SAFE_COLOR.test(data.overrideColor)) {
    return { error: "Invalid color." };
  }
  const group = await prisma.docLinkGroup.create({
    data: {
      userId: session.user.id,
      name: data.name || null,
      text: data.text || null,
      overrideColor: data.overrideColor || null,
    },
  });
  return { id: group.id };
}

async function requireOwnOrAdminGroup(groupId: string) {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const group = await prisma.docLinkGroup.findUnique({ where: { id: groupId } });
  if (!group) {
    throw new Error("Doc link group not found.");
  }
  const isOwn = group.userId === session.user.id;
  if (session.user.role !== "ADMIN" && !isOwn) {
    throw new Error("You don't have permission to modify this doc link group.");
  }
  return { session, group };
}

// Owner-or-admin (§14i, matching requireOwnOrAdmin) — a shared group's
// override_color can recolor every contributor's links in it, so editing
// it is more consequential than creating a link inside one.
export async function updateDocLinkGroup(
  groupId: string,
  data: { name?: string | null; text?: string | null; overrideColor?: string | null },
): Promise<{ error?: string }> {
  await requireOwnOrAdminGroup(groupId);
  if (data.overrideColor && !SAFE_COLOR.test(data.overrideColor)) {
    return { error: "Invalid color." };
  }
  if (data.text && data.text.length > MAX_TEXT_LENGTH) {
    return { error: "Text is too long." };
  }
  await prisma.docLinkGroup.update({ where: { id: groupId }, data });
  return {};
}

// §14h — deleting a group soft-deletes its links in one transaction, since
// docLinkGroupId is required and an orphaned link is meaningless. The
// reverse never happens automatically: deleting the last link does not
// delete its group (an empty group is a legitimate work in progress).
export async function deleteDocLinkGroup(groupId: string): Promise<void> {
  const { group } = await requireOwnOrAdminGroup(groupId);
  const now = new Date();
  await prisma.$transaction([
    prisma.docLink.updateMany({ where: { docLinkGroupId: group.id, deletedAt: null }, data: { deletedAt: now } }),
    prisma.docLinkGroup.update({ where: { id: group.id }, data: { deletedAt: now } }),
  ]);
}
