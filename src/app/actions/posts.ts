"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { uniqueSlug } from "@/lib/slug";
import { canManagePosts, canUserEditPost } from "@/lib/authz";
import { Prisma } from "@/generated/prisma/client";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

async function requireEditableSession(postId: string) {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) {
    throw new Error("Post not found.");
  }

  if (!(await canUserEditPost(session.user.id, session.user.role, postId))) {
    throw new Error("You don't have permission to edit this post.");
  }

  return { session, post };
}

export type CreatePostState = { error?: string };

export async function createPostAction(
  _prevState: CreatePostState,
  formData: FormData,
): Promise<CreatePostState> {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!canManagePosts(session.user.role)) {
    return { error: "You don't have permission to create posts." };
  }

  const title = formData.get("title");
  if (typeof title !== "string" || !title.trim()) {
    return { error: "Title is required." };
  }
  const trimmedTitle = title.trim();

  const slug = await uniqueSlug(trimmedTitle);
  const post = await prisma.post.create({
    data: {
      slug,
      title: trimmedTitle,
      status: "DRAFT",
      authors: { create: { userId: session.user.id, bylineOrder: 0 } },
      revisions: {
        create: {
          revisionNumber: 1,
          title: trimmedTitle,
          doc: EMPTY_DOC,
          editorId: session.user.id,
        },
      },
    },
  });

  redirect(`/posts/${post.id}/edit`);
}

async function nextRevisionNumber(postId: string): Promise<number> {
  const latest = await prisma.revision.findFirst({
    where: { postId },
    orderBy: { revisionNumber: "desc" },
    select: { revisionNumber: true },
  });
  return (latest?.revisionNumber ?? 0) + 1;
}

export async function saveDraft(
  postId: string,
  title: string,
  doc: Prisma.InputJsonValue,
): Promise<{ revisionNumber: number }> {
  const { session } = await requireEditableSession(postId);
  const revisionNumber = await nextRevisionNumber(postId);

  await prisma.$transaction([
    prisma.revision.create({
      data: { postId, revisionNumber, title, doc, editorId: session.user.id },
    }),
    prisma.post.update({ where: { id: postId }, data: { title } }),
  ]);

  revalidatePath(`/posts/${postId}/edit`);
  revalidatePath(`/posts/${postId}/history`);
  return { revisionNumber };
}

export async function publishPost(
  postId: string,
  title: string,
  doc: Prisma.InputJsonValue,
  changelog?: string,
): Promise<{ revisionNumber: number }> {
  const { session, post } = await requireEditableSession(postId);
  const revisionNumber = await nextRevisionNumber(postId);

  const revision = await prisma.revision.create({
    data: {
      postId,
      revisionNumber,
      title,
      doc,
      editorId: session.user.id,
      changelog: changelog?.trim() || undefined,
    },
  });

  await prisma.post.update({
    where: { id: postId },
    data: {
      title,
      status: "PUBLISHED",
      currentRevisionId: revision.id,
      publishedAt: post.publishedAt ?? new Date(),
    },
  });

  revalidatePath(`/posts/${postId}/edit`);
  revalidatePath(`/posts/${postId}/history`);
  revalidatePath("/posts");
  return { revisionNumber };
}

export async function restoreRevision(
  postId: string,
  revisionNumber: number,
): Promise<{ newRevisionNumber: number }> {
  const { session } = await requireEditableSession(postId);

  const source = await prisma.revision.findUnique({
    where: { postId_revisionNumber: { postId, revisionNumber } },
  });
  if (!source) {
    throw new Error("Revision not found.");
  }

  const newRevisionNumber = await nextRevisionNumber(postId);
  await prisma.$transaction([
    prisma.revision.create({
      data: {
        postId,
        revisionNumber: newRevisionNumber,
        title: source.title,
        doc: source.doc as Prisma.InputJsonValue,
        editorId: session.user.id,
        changelog: `Restored from revision ${revisionNumber}`,
      },
    }),
    prisma.post.update({ where: { id: postId }, data: { title: source.title } }),
  ]);

  revalidatePath(`/posts/${postId}/edit`);
  revalidatePath(`/posts/${postId}/history`);
  return { newRevisionNumber };
}
