import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canManagePosts, canEditAnyPost } from "@/lib/authz";
import type { Prisma } from "@/generated/prisma/client";
import { parseCommentsFilters, type CommentsSortKey } from "@/lib/comments-query";
import type { SortColumn } from "@/lib/use-sortable-rows";
import CommentsTable from "@/components/CommentsTable";
import styles from "./page.module.css";

// Deep-link-only filters (no dedicated dropdown yet — see the page's Help
// section): ?post=<postId>, ?author=<userId>, ?commenter=<commenterId>.
// Combined with whatever role-based post scoping already applies below.
function parseDeepLinkWhere(searchParams: URLSearchParams): Prisma.CommentWhereInput {
  const where: Prisma.CommentWhereInput = {};
  const post = searchParams.get("post");
  const author = searchParams.get("author");
  const commenter = searchParams.get("commenter");

  const threadWhere: Prisma.CommentThreadWhereInput = {};
  if (post) threadWhere.postId = post;
  if (author) threadWhere.post = { authors: { some: { userId: author } } };
  if (Object.keys(threadWhere).length > 0) {
    where.thread = threadWhere;
  }
  if (commenter) where.commenterId = commenter;
  return where;
}

function buildFilterWhere(filters: ReturnType<typeof parseCommentsFilters>): Prisma.CommentWhereInput {
  const where: Prisma.CommentWhereInput = {};
  if (filters.status !== "ALL") where.status = { in: [...filters.status] };
  if (filters.threadStatus !== "ALL") where.thread = { status: { in: [...filters.threadStatus] } };
  if (!filters.deleted) where.deletedByUserId = null;
  if (filters.q) {
    where.OR = [
      { body: { path: ["text"], string_contains: filters.q, mode: "insensitive" } },
      { commenter: { displayName: { contains: filters.q, mode: "insensitive" } } },
      { commenter: { email: { contains: filters.q, mode: "insensitive" } } },
    ];
  }
  return where;
}

function buildOrderBy(sort: SortColumn<CommentsSortKey>[]): Prisma.CommentOrderByWithRelationInput[] {
  return sort.map(({ key, dir }): Prisma.CommentOrderByWithRelationInput => {
    switch (key) {
      case "status":
        return { status: dir };
      case "threadStatus":
        return { thread: { status: dir } };
      case "post":
        return { thread: { post: { title: dir } } };
      case "commenter":
        return { commenter: { displayName: dir } };
      case "created":
        return { createdAt: dir };
      case "statusChanged":
        return { statusChangedAt: dir };
      case "deleted":
        // deletedByUserId is null for a non-deleted comment — order nulls
        // (not-deleted) first when ascending, last when descending, to
        // match the client-side compareByKey convention PostsTable/
        // UsersTable use for their own "deleted" sort key.
        return { deletedByUserId: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
    }
  });
}

export default async function CommentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!canManagePosts(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Comments</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to manage comments.</p>
      </main>
    );
  }

  const resolvedSearchParams = await searchParams;
  const flatParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(resolvedSearchParams)) {
    if (typeof value === "string") flatParams[key] = value;
    else if (Array.isArray(value) && value.length > 0) flatParams[key] = value[0];
  }
  const urlSearchParams = new URLSearchParams(flatParams);
  const filters = parseCommentsFilters(urlSearchParams);

  // `baseWhere` is "everything this user could ever see here" (role scope +
  // deep links); `filterWhere` layers the UI filters on top of it. Kept
  // separate because the commenter-activity counts below are meant to
  // summarize a commenter's overall activity within what this user can see,
  // not just activity matching today's status/threadStatus/search filters.
  const baseWhere: Prisma.CommentWhereInput = {
    AND: [
      canEditAnyPost(session.user.role) ? {} : { thread: { post: { authors: { some: { userId: session.user.id } } } } },
      parseDeepLinkWhere(urlSearchParams),
    ],
  };
  const where: Prisma.CommentWhereInput = { AND: [baseWhere, buildFilterWhere(filters)] };
  const orderBy = buildOrderBy(filters.sort);

  const [comments, totalCount, countRows] = await Promise.all([
    prisma.comment.findMany({
      where,
      orderBy,
      take: filters.pageSize,
      skip: (filters.page - 1) * filters.pageSize,
      include: {
        commenter: { select: { id: true, displayName: true, email: true } },
        thread: {
          select: {
            id: true,
            status: true,
            quotedText: true,
            post: { select: { id: true, slug: true, title: true } },
          },
        },
      },
    }),
    prisma.comment.count({ where }),
    prisma.comment.findMany({
      where: { AND: [baseWhere, { deletedByUserId: null }] },
      select: { commenterId: true, status: true },
    }),
  ]);

  const counts = new Map<string, { submitted: number; inModeration: number; spam: number }>();
  for (const row of countRows) {
    const entry = counts.get(row.commenterId) ?? { submitted: 0, inModeration: 0, spam: 0 };
    if (row.status === "APPROVED") entry.submitted++;
    else if (row.status === "PENDING") entry.inModeration++;
    else if (row.status === "SPAM") entry.spam++;
    counts.set(row.commenterId, entry);
  }

  const rows = comments.map((comment) => {
    const commenterCounts = counts.get(comment.commenterId) ?? { submitted: 0, inModeration: 0, spam: 0 };
    return {
      id: comment.id,
      postId: comment.thread.post.id,
      postSlug: comment.thread.post.slug,
      postTitle: comment.thread.post.title,
      commenterId: comment.commenterId,
      commenterName: comment.commenter.displayName,
      commenterEmail: comment.commenter.email,
      bodyText: (comment.body as { text?: string } | null)?.text ?? "",
      status: comment.status,
      threadStatus: comment.thread.status,
      createdAt: comment.createdAt,
      statusChangedAt: comment.statusChangedAt,
      deleted: comment.deletedByUserId !== null,
      commenterCounts,
    };
  });

  return (
    <main style={{ maxWidth: 1200, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1 className={styles.heading}>Comments</h1>
      <CommentsTable rows={rows} totalCount={totalCount} filters={filters} />
    </main>
  );
}
