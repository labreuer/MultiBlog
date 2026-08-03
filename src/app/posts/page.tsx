import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import { canManagePosts, canEditAnyPost } from "@/lib/authz";
import { derivePostStatus } from "@/lib/post-status";
import type { Prisma } from "@/generated/prisma/client";
import { toURLSearchParams } from "@/lib/table-query";
import { getDefaultPageSize } from "@/lib/user-preferences";
import { parsePostsFilters, type PostsFilters, type PostsSortKey } from "@/lib/posts-query";
import type { SortColumn } from "@/lib/table-sort";
import PostsTable from "@/components/PostsTable";

function buildFilterWhere(filters: PostsFilters): Prisma.PostWhereInput {
  const where: Prisma.PostWhereInput = {};
  if (!filters.deleted) where.deletedByUserId = null;
  if (filters.q) where.title = { contains: filters.q, mode: "insensitive" };
  return where;
}

function buildOrderBy(sort: SortColumn<PostsSortKey>[]): Prisma.PostOrderByWithRelationInput[] {
  return sort.map(({ key, dir }): Prisma.PostOrderByWithRelationInput => {
    switch (key) {
      case "title":
        return { title: dir };
      case "published":
        // publishedAt holds a future date for a scheduled row and a past one
        // for a published row (there is no separate scheduledFor anymore), so
        // this single ordering already covers both. A draft has none at all;
        // nulls stay last in either direction, matching what the client-side
        // comparator did before this moved into Postgres.
        return { publishedAt: { sort: dir, nulls: "last" } };
      case "events":
        return { publicationEvents: { _count: dir } };
      case "created":
        return { createdAt: dir };
      case "deleted":
        return { deletedByUserId: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
    }
  });
}

export default async function PostsPage({
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
        <h1>Posts</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to manage posts.</p>
      </main>
    );
  }

  const urlSearchParams = toURLSearchParams(await searchParams);
  const defaultPageSize = await getDefaultPageSize(session.user.id);
  const filters = parsePostsFilters(urlSearchParams, defaultPageSize);

  const where: Prisma.PostWhereInput = {
    AND: [
      canEditAnyPost(session.user.role) ? {} : { authors: { some: { userId: session.user.id } } },
      buildFilterWhere(filters),
    ],
  };

  const [posts, totalCount] = await Promise.all([
    prismaIncludingDeleted.post.findMany({
      where,
      orderBy: buildOrderBy(filters.sort),
      take: filters.pageSize,
      skip: (filters.page - 1) * filters.pageSize,
      include: {
        authors: {
          orderBy: { bylineOrder: "asc" },
          select: { user: { select: { adminInitials: true } } },
        },
        publicationEvents: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { createdAt: true, actor: { select: { name: true, email: true } } },
        },
        threads: { select: { comments: { select: { status: true, deletedByUserId: true } } } },
        _count: { select: { publicationEvents: true } },
      },
    }),
    prismaIncludingDeleted.post.count({ where }),
  ]);

  const rows = posts.map((post) => {
    const latest = post.publicationEvents[0];
    const status = derivePostStatus(post);

    let approved = 0;
    let pending = 0;
    for (const thread of post.threads) {
      for (const comment of thread.comments) {
        if (comment.deletedByUserId !== null) continue;
        if (comment.status === "APPROVED") approved++;
        else if (comment.status === "PENDING") pending++;
      }
    }

    return {
      id: post.id,
      slug: post.slug,
      title: post.title,
      authors: post.authors.map((a) => a.user.adminInitials).join(", "),
      status,
      publishedAt: post.publishedAt,
      createdAt: post.createdAt,
      eventCount: post._count.publicationEvents,
      lastEditorName: latest?.actor?.name ?? latest?.actor?.email ?? "—",
      lastEditAt: latest?.createdAt ?? null,
      approved,
      pending,
      deleted: post.deletedByUserId !== null,
    };
  });

  return (
    <main style={{ maxWidth: 1000, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Posts</h1>
      <p>
        <Link href="/posts/new">+ New post</Link>
      </p>
      <PostsTable rows={rows} totalCount={totalCount} filters={filters} defaultPageSize={defaultPageSize} />
    </main>
  );
}
