import { redirect } from "next/navigation";
import type { Metadata } from "next";
import type { JSONContent } from "@tiptap/core";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import { isAdmin } from "@/lib/authz";
import { resolveAvatarSrc } from "@/lib/avatar-url";
import type { Prisma } from "@/generated/prisma/client";
import { coercePageSize, toURLSearchParams } from "@/lib/table-query";
import { getTablePrefs } from "@/lib/user-preferences";
import { parseUsersFilters, type UsersFilters, type UsersSortKey } from "@/lib/users-query";
import type { SortColumn } from "@/lib/table-sort";
import { appUrl } from "@/lib/app-url";
import { pathWithQuery, signInPath } from "@/lib/sign-in-redirect";
import UsersTable from "@/components/UsersTable";

export const metadata: Metadata = { title: "Users" };

function buildFilterWhere(filters: UsersFilters): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = {};
  if (!filters.deleted) where.deletedByUserId = null;
  if (filters.q) {
    where.OR = [
      { name: { contains: filters.q, mode: "insensitive" } },
      { email: { contains: filters.q, mode: "insensitive" } },
      { adminInitials: { contains: filters.q, mode: "insensitive" } },
      { orcid: { contains: filters.q, mode: "insensitive" } },
      { website: { contains: filters.q, mode: "insensitive" } },
    ];
  }
  return where;
}

function buildOrderBy(sort: SortColumn<UsersSortKey>[]): Prisma.UserOrderByWithRelationInput[] {
  return sort.map(({ key, dir }): Prisma.UserOrderByWithRelationInput => {
    switch (key) {
      case "name":
        // A user with no name sorted by their email while this was client-side
        // (`a.name ?? a.email`). Postgres can't fall back mid-ORDER BY, so a
        // nameless row sorts as a null instead — kept at the end either way.
        return { name: { sort: dir, nulls: "last" } };
      case "email":
        return { email: dir };
      case "adminInitials":
        return { adminInitials: dir };
      case "role":
        // Postgres orders an enum by declaration order, and Role is declared
        // ADMIN → EDITOR → AUTHOR → AUTHORIZED → COMMENTER, so this is the
        // privilege order UsersTable's ROLE_ORDER used to spell out by hand.
        return { role: dir };
      case "moderationPolicy":
        return { moderationPolicy: dir };
      case "rowsPerPage":
        return { rowsPerPage: dir };
      case "posts":
        return { postAuthors: { _count: dir } };
      case "isListedContributor":
        return { isListedContributor: dir };
      case "contributorOrder":
        return { contributorOrder: { sort: dir, nulls: "last" } };
      case "orcid":
        return { orcid: { sort: dir, nulls: "last" } };
      case "website":
        return { website: { sort: dir, nulls: "last" } };
      case "createdAt":
        return { createdAt: dir };
      case "deletedAt":
        return { deletedAt: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
      case "deleted":
        return { deletedByUserId: { sort: dir, nulls: dir === "asc" ? "first" : "last" } };
    }
  });
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Hoisted above the gate so an anonymous visitor's callbackUrl keeps the
  // filters, sort and page they arrived with — this table's whole state lives
  // in the querystring (CLAUDE.md, "Admin tables are one kit").
  const urlSearchParams = toURLSearchParams(await searchParams);
  const session = await auth();
  if (!session?.user) {
    redirect(signInPath(pathWithQuery("/users", urlSearchParams)));
  }
  if (!isAdmin(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Users</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to manage users.</p>
      </main>
    );
  }

  const prefs = await getTablePrefs(session.user.id, "users");
  const filters = parseUsersFilters(urlSearchParams, prefs);
  const where = buildFilterWhere(filters);

  const [users, totalCount] = await Promise.all([
    prismaIncludingDeleted.user.findMany({
      where,
      orderBy: buildOrderBy(filters.sort),
      take: filters.pageSize,
      skip: (filters.page - 1) * filters.pageSize,
      // `include` (not `select`) means every scalar column comes back — which
      // is exactly why an avatar is a row in its own table rather than a
      // Bytes column here (PLAN.md §17n). The hash is pulled in explicitly;
      // the bytes are unreachable from this query by construction.
      include: {
        _count: { select: { postAuthors: true, invites: true } },
        avatar: { select: { hash: true } },
        invites: {
          orderBy: { sentAt: "desc" },
          take: 1,
          select: { token: true, sentAt: true, clickedAt: true, acceptedAt: true, expiresAt: true, revokedAt: true },
        },
      },
    }),
    prismaIncludingDeleted.user.count({ where }),
  ]);

  const rows = users.map((user) => ({
    id: user.id,
    slug: user.slug,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    adminInitials: user.adminInitials,
    role: user.role,
    moderationPolicy: user.moderationPolicy,
    // Coerced so the select can always show a matching option, even if the
    // stored value predates the current option list (PLAN.md §16b).
    rowsPerPage: coercePageSize(user.rowsPerPage),
    color: user.color,
    avatarSrc: resolveAvatarSrc({ userId: user.id, avatarHash: user.avatar?.hash, image: user.image }),
    isListedContributor: user.isListedContributor,
    contributorBlurb: user.contributorBlurb as JSONContent | null,
    contributorOrder: user.contributorOrder,
    orcid: user.orcid,
    website: user.website,
    createdAt: user.createdAt,
    postCount: user._count.postAuthors,
    inviteCount: user._count.invites,
    lastInvite: user.invites[0]
      ? {
          // Resolved here, not client-side: APP_URL is a bare (non-
          // NEXT_PUBLIC_) env var, so it's unreachable from "use client" code
          // — see src/lib/app-url.ts. Guarded on expiry too: an invite never
          // re-sent keeps its raw token past expiresAt (docs/EMAIL.md's
          // residual-exposure note), and this column shouldn't present that
          // as a live link.
          url:
            user.invites[0].token && user.invites[0].expiresAt > new Date()
              ? appUrl(`/invite?token=${user.invites[0].token}`)
              : null,
          sentAt: user.invites[0].sentAt,
          clickedAt: user.invites[0].clickedAt,
          acceptedAt: user.invites[0].acceptedAt,
          expiresAt: user.invites[0].expiresAt,
          revokedAt: user.invites[0].revokedAt,
        }
      : null,
    deletedAt: user.deletedAt,
    deleted: user.deletedByUserId !== null,
  }));

  return (
    <main style={{ maxWidth: 1200, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Users</h1>
      <UsersTable rows={rows} totalCount={totalCount} filters={filters} prefs={prefs} />
    </main>
  );
}
