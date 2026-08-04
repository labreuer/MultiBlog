import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import { canManagePosts, canEditAnyPost } from "@/lib/authz";
import { derivePostStatus } from "@/lib/post-status";
import type { Prisma } from "@/generated/prisma/client";
import { toURLSearchParams } from "@/lib/table-query";
import { getTablePrefs } from "@/lib/user-preferences";
import { parsePostsFilters, type PostsFilters, type PostsSortKey } from "@/lib/posts-query";
import type { SortColumn } from "@/lib/table-sort";
import PostsTable from "@/components/PostsTable";

function buildFilterWhere(filters: PostsFilters): Prisma.PostWhereInput {
  const where: Prisma.PostWhereInput = {};
  if (!filters.deleted) where.deletedByUserId = null;
  if (filters.q) where.title = { contains: filters.q, mode: "insensitive" };
  return where;
}

// flatMap, not map: one sort key can expand into more than one ORDER BY term
// — "comments" does, because the column shows two numbers and a tie on the
// first is broken by the second.
function buildOrderBy(sort: SortColumn<PostsSortKey>[]): Prisma.PostOrderByWithRelationInput[] {
  return sort.flatMap(({ key, dir }): Prisma.PostOrderByWithRelationInput[] => {
    switch (key) {
      case "title":
        return [{ title: dir }];
      case "authors":
        // post_metrics.byline is the same string_agg the cell renders. NULL
        // for an authorless post, kept last in either direction rather than
        // leading the table as "" would.
        return [{ metrics: { byline: { sort: dir, nulls: "last" } } }];
      case "comments":
        // The cell reads "<approved> (in moderation <pending>)", so approved
        // is the primary key and pending only settles ties — which makes a
        // post with moderation waiting sort above an otherwise identical one
        // descending, matching how the cell reads.
        return [{ metrics: { approvedCount: dir } }, { metrics: { pendingCount: dir } }];
      case "published":
        // publishedAt holds a future date for a scheduled row and a past one
        // for a published row (there is no separate scheduledFor anymore), so
        // this single ordering already covers both. A draft has none at all;
        // nulls stay last in either direction, matching what the client-side
        // comparator did before this moved into Postgres.
        return [{ publishedAt: { sort: dir, nulls: "last" } }];
      case "events":
        return [{ publicationEvents: { _count: dir } }];
      case "editor":
      case "lastEdit":
        // Through the post_activity view (schema.prisma's PostActivity), which
        // is a to-one relation and therefore orderable by its own columns —
        // unlike publicationEvents, the to-many these values actually come
        // from. A post with no events has no view row, so nulls stay last in
        // either direction, matching how the cell already renders that case.
        return key === "editor"
          ? [{ activity: { lastEditorName: { sort: dir, nulls: "last" } } }]
          : [{ activity: { lastEventAt: { sort: dir, nulls: "last" } } }];
      case "created":
        return [{ createdAt: dir }];
      case "slug":
        return [{ slug: dir }];
      case "moderationPolicy":
        return [{ moderationPolicy: dir }];
      case "deletedAt":
        return [{ deletedAt: { sort: dir, nulls: dir === "asc" ? "first" : "last" } }];
      case "deleted":
        return [{ deletedByUserId: { sort: dir, nulls: dir === "asc" ? "first" : "last" } }];
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
  const prefs = await getTablePrefs(session.user.id, "posts");
  const filters = parsePostsFilters(urlSearchParams, prefs);

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
      // Explicit select, not `include` — `include` fetches every Post scalar
      // plus the named relations, and Post.proseJson is the entire post body.
      // Nothing here renders it (a post's body is read on the public page,
      // from this same column, by an entirely different query) — it was
      // crossing from Postgres into this process on every /posts load for no
      // reason. `/docs` already excludes its body the same way; this was the
      // one admin table still pulling a full document body it never uses.
      select: {
        id: true,
        slug: true,
        title: true,
        publishEventId: true,
        moderationPolicy: true,
        createdAt: true,
        publishedAt: true,
        deletedByUserId: true,
        deletedAt: true,
        // Every derived column on this page is read from the view that sorts
        // it, so the displayed value and the sorted expression are the same
        // expression by construction. Sorting by one thing while displaying
        // another is the trap this avoids (§16e).
        //
        // What this replaced, and why it's cheaper than it looks: `authors`
        // joined PostAuthor→User per row purely to join initials into a
        // string, and `threads` pulled *every comment of every post on the
        // page* into this process to count two of the four statuses. Both are
        // now one `WHERE post_id IN (…)` against post_metrics — Prisma issues
        // an `include` of a to-one relation as its own keyed query, not a
        // join, so this is one extra round trip flat rather than per row.
        activity: true,
        metrics: true,
        _count: { select: { publicationEvents: true } },
      },
    }),
    prismaIncludingDeleted.post.count({ where }),
  ]);

  const rows = posts.map((post) => {
    const status = derivePostStatus(post);

    return {
      id: post.id,
      slug: post.slug,
      title: post.title,
      // string_agg over the byline happens in the view, so a null here means
      // a post with no authors at all — the same empty cell the JS join
      // produced for that case.
      authors: post.metrics?.byline ?? "",
      status,
      publishedAt: post.publishedAt,
      createdAt: post.createdAt,
      eventCount: post._count.publicationEvents,
      // COALESCE(name, email) happens inside the view, so a null here means
      // either no events at all or a system actor — both of which the table
      // has always shown as an em dash.
      lastEditorName: post.activity?.lastEditorName ?? "—",
      lastEditAt: post.activity?.lastEventAt ?? null,
      // The view counts a post with no comments as 0 rather than omitting it,
      // so these fall back only if the row is somehow missing entirely.
      approved: post.metrics?.approvedCount ?? 0,
      pending: post.metrics?.pendingCount ?? 0,
      moderationPolicy: post.moderationPolicy,
      deletedAt: post.deletedAt,
      deleted: post.deletedByUserId !== null,
    };
  });

  return (
    <main style={{ maxWidth: 1000, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Posts</h1>
      <p>
        <Link href="/posts/new">+ New post</Link>
      </p>
      <PostsTable rows={rows} totalCount={totalCount} filters={filters} prefs={prefs} />
    </main>
  );
}
