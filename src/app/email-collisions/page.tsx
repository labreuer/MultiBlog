import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { isAdmin } from "@/lib/role-checks";
import { toURLSearchParams } from "@/lib/table-query";
import { getTablePrefs } from "@/lib/user-preferences";
import {
  parseEmailCollisionsFilters,
  type EmailCollisionsFilters,
  type EmailCollisionsSortKey,
} from "@/lib/email-collisions-query";
import type { SortColumn } from "@/lib/table-sort";
import { pathWithQuery, signInPath } from "@/lib/sign-in-redirect";
import { staffDisplayNameOf } from "@/lib/display-name";
import EmailCollisionsTable, { type EmailCollisionRow } from "@/components/EmailCollisionsTable";

export const metadata: Metadata = { title: "Email collisions" };

// docs/COMMENTS.md, "The log" — where an account and an anonymous commenter
// met on one email, for an ADMIN to review. ADMIN-only, with no MCP tool and
// no wider tier: the rows hold emails and IP addresses.
//
// Unreviewed rows by default; `?reviewed=1` lists every row, the way the
// kit's show-deleted toggle lists deleted ones. Every column sorts, the
// comment counts and IP addresses through `email_collision_listing`.

function buildFilterWhere(filters: EmailCollisionsFilters): Prisma.EmailCollisionWhereInput {
  const where: Prisma.EmailCollisionWhereInput = {};
  if (!filters.reviewed) where.reviewedAt = null;
  if (filters.q) {
    const contains = { contains: filters.q, mode: "insensitive" as const };
    where.OR = [
      { email: contains },
      { lastIpAddress: contains },
      { claimIpAddress: contains },
      { ipAddresses: { has: filters.q } },
      { user: { email: contains } },
      { user: { name: contains } },
      { commenter: { displayName: contains } },
      { commenter: { email: contains } },
    ];
  }
  return where;
}

function buildOrderBy(sort: SortColumn<EmailCollisionsSortKey>[]): Prisma.EmailCollisionOrderByWithRelationInput[] {
  const nulls = (dir: "asc" | "desc") => (dir === "asc" ? "first" : "last");
  return sort.flatMap(({ key, dir }): Prisma.EmailCollisionOrderByWithRelationInput | Prisma.EmailCollisionOrderByWithRelationInput[] => {
    switch (key) {
      case "lastSeen":
        return { lastSeenAt: dir };
      case "firstSeen":
        return { firstSeenAt: dir };
      case "count":
        return { count: dir };
      case "source":
        return { source: dir };
      case "email":
        return { email: dir };
      case "account":
        return { user: { email: dir } };
      case "anonymous":
        return { commenter: { displayName: dir } };
      case "post":
        return { post: { title: dir } };
      case "anonymousComments":
        return { listing: { anonymousComments: dir } };
      case "requestIps":
        return { listing: { requestIps: { sort: dir, nulls: "last" } } };
      case "anonymousIps":
        return { listing: { anonymousIps: { sort: dir, nulls: "last" } } };
      case "accountIps":
        return { listing: { accountIps: { sort: dir, nulls: "last" } } };
      case "card":
        return [{ joinCode: { batch: { label: dir } } }, { joinCode: { serial: dir } }];
      case "claimIp":
        return { claimIpAddress: { sort: dir, nulls: "last" } };
      case "reviewedAt":
        return { reviewedAt: { sort: dir, nulls: nulls(dir) } };
      case "reviewedBy":
        return { reviewedBy: { name: { sort: dir, nulls: "last" } } };
    }
  });
}

export default async function EmailCollisionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Hoisted above the gate so the callbackUrl keeps the table's state, all of
  // which lives in the querystring (CLAUDE.md, "Admin tables are one kit").
  const urlSearchParams = toURLSearchParams(await searchParams);
  const session = await auth();
  if (!session?.user) {
    redirect(signInPath(pathWithQuery("/email-collisions", urlSearchParams)));
  }
  if (!isAdmin(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Email collisions</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to review email collisions.</p>
      </main>
    );
  }

  const prefs = await getTablePrefs(session.user.id, "email-collisions");
  const filters = parseEmailCollisionsFilters(urlSearchParams, prefs);
  const where = buildFilterWhere(filters);

  const [collisions, totalCount] = await Promise.all([
    prisma.emailCollision.findMany({
      where,
      orderBy: [...buildOrderBy(filters.sort), { id: "asc" }],
      take: filters.pageSize,
      skip: (filters.page - 1) * filters.pageSize,
      include: {
        // Relation includes bypass prisma.ts's soft-delete extension, so a
        // since-deleted account still shows, and says so.
        user: { select: { id: true, name: true, email: true, deletedByUserId: true } },
        commenter: { select: { id: true, displayName: true, email: true } },
        post: { select: { id: true, title: true } },
        joinCode: { select: { serial: true, batch: { select: { label: true } } } },
        reviewedBy: { select: { name: true, email: true } },
        listing: true,
      },
    }),
    prisma.emailCollision.count({ where }),
  ]);

  const rows: EmailCollisionRow[] = collisions.map((row) => ({
    id: row.id,
    source: row.source,
    email: row.email,
    count: row.count,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    account: row.user
      ? {
          name: staffDisplayNameOf(row.user, session.user.role),
          email: row.user.email,
          deleted: row.user.deletedByUserId !== null,
        }
      : null,
    anonymous: row.commenter ? { id: row.commenter.id, displayName: row.commenter.displayName } : null,
    anonymousComments: row.listing?.anonymousComments ?? 0,
    requestIps: row.listing?.requestIps ?? "",
    anonymousIps: row.listing?.anonymousIps ?? "",
    accountIps: row.listing?.accountIps ?? "",
    post: row.post ? { id: row.post.id, title: row.post.title } : null,
    card: row.joinCode ? { batchLabel: row.joinCode.batch.label, serial: row.joinCode.serial } : null,
    claimIp: row.claimIpAddress ?? "",
    reviewedAt: row.reviewedAt,
    reviewedByName: row.reviewedBy ? staffDisplayNameOf(row.reviewedBy, session.user.role) : "",
  }));

  return (
    <main style={{ maxWidth: 1200, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Email collisions</h1>
      <EmailCollisionsTable rows={rows} totalCount={totalCount} filters={filters} prefs={prefs} />
    </main>
  );
}
