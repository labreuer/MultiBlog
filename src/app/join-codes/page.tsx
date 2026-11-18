import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { isAdmin } from "@/lib/role-checks";
import { toURLSearchParams } from "@/lib/table-query";
import { getTablePrefs } from "@/lib/user-preferences";
import {
  isJoinCodeStatus,
  parseJoinCodesFilters,
  type JoinCodesFilters,
  type JoinCodesSortKey,
} from "@/lib/join-codes-query";
import type { SortColumn } from "@/lib/table-sort";
import { pathWithQuery, signInPath } from "@/lib/sign-in-redirect";
import { staffDisplayNameOf } from "@/lib/display-name";
import { welcomePageReachesAuthors, WELCOME_PAGE_NAME } from "@/lib/front-page";
import { MAX_BATCH_CARDS } from "@/lib/join-codes/cards";
import JoinCodesTable, { type JoinBatchOption, type JoinCodeRow } from "@/components/JoinCodesTable";

export const metadata: Metadata = { title: "Join cards" };

// docs/EMAIL.md §10, "Minting and printing" — every join card, one row each,
// for an ADMIN to mint batches, print them, and revoke a card or a batch.
// ADMIN-only, with no MCP tool: a card makes an AUTHOR account, and the rows
// hold the emails of claims still waiting.
//
// Every column sorts, the status through `join_code_listing`. `?batch=<id>`
// narrows the table to one batch and puts its Print and Revoke above it.

function buildFilterWhere(filters: JoinCodesFilters): Prisma.JoinCodeWhereInput {
  const where: Prisma.JoinCodeWhereInput = {};
  if (filters.batch) where.batchId = filters.batch;
  if (filters.status !== "ALL") where.listing = { status: { in: [...filters.status] } };
  if (filters.q) {
    const contains = { contains: filters.q, mode: "insensitive" as const };
    const or: Prisma.JoinCodeWhereInput[] = [
      { pendingEmail: contains },
      { pendingName: contains },
      { batch: { label: contains } },
      { claimedUser: { email: contains } },
      { claimedUser: { name: contains } },
    ];
    const serial = /^\d{1,6}$/.test(filters.q.trim()) ? Number(filters.q.trim()) : null;
    if (serial !== null) or.push({ serial });
    where.OR = or;
  }
  return where;
}

function buildOrderBy(sort: SortColumn<JoinCodesSortKey>[]): Prisma.JoinCodeOrderByWithRelationInput[] {
  return sort.map(({ key, dir }): Prisma.JoinCodeOrderByWithRelationInput => {
    switch (key) {
      case "batch":
        return { batch: { label: dir } };
      case "serial":
        return { serial: dir };
      case "status":
        return { listing: { statusOrder: dir } };
      case "pendingEmail":
        return { pendingEmail: { sort: dir, nulls: "last" } };
      case "claimedBy":
        return { claimedUser: { name: { sort: dir, nulls: "last" } } };
      case "claimedAt":
        return { claimedAt: { sort: dir, nulls: "last" } };
      case "sends":
        return { confirmSends: dir };
      case "lastSent":
        return { confirmSentAt: { sort: dir, nulls: "last" } };
      case "expires":
        return { batch: { expiresAt: dir } };
      case "minted":
        return { batch: { createdAt: dir } };
    }
  });
}

export default async function JoinCodesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Hoisted above the gate so the callbackUrl keeps the table's state, all of
  // which lives in the querystring (CLAUDE.md, "Admin tables are one kit").
  const urlSearchParams = toURLSearchParams(await searchParams);
  const session = await auth();
  if (!session?.user) {
    redirect(signInPath(pathWithQuery("/join-codes", urlSearchParams)));
  }
  if (!isAdmin(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Join cards</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to manage join cards.</p>
      </main>
    );
  }

  const prefs = await getTablePrefs(session.user.id, "join-codes");
  const filters = parseJoinCodesFilters(urlSearchParams, prefs);
  const where = buildFilterWhere(filters);

  const [codes, totalCount, batches, welcomeReachesAuthors] = await Promise.all([
    prisma.joinCode.findMany({
      where,
      orderBy: [...buildOrderBy(filters.sort), { id: "asc" }],
      take: filters.pageSize,
      skip: (filters.page - 1) * filters.pageSize,
      select: {
        id: true,
        serial: true,
        pendingEmail: true,
        confirmSends: true,
        confirmSentAt: true,
        claimedAt: true,
        batch: { select: { id: true, label: true, expiresAt: true, createdAt: true } },
        // A relation include bypasses prisma.ts's soft-delete extension, so a
        // since-deleted account still shows, and says so.
        claimedUser: { select: { name: true, email: true, deletedByUserId: true } },
        listing: { select: { status: true } },
      },
    }),
    prisma.joinCode.count({ where }),
    prisma.joinBatch.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        label: true,
        createdAt: true,
        expiresAt: true,
        revokedAt: true,
        createdBy: { select: { name: true, email: true } },
        _count: { select: { codes: true } },
        codes: { where: { claimedAt: { not: null } }, select: { id: true } },
      },
    }),
    welcomePageReachesAuthors(),
  ]);

  const now = new Date();
  const batchOptions: JoinBatchOption[] = batches.map((batch) => ({
    id: batch.id,
    label: batch.label,
    createdAt: batch.createdAt,
    createdByName: staffDisplayNameOf(batch.createdBy, session.user.role),
    expiresAt: batch.expiresAt,
    state: batch.revokedAt ? "revoked" : batch.expiresAt <= now ? "expired" : "live",
    cards: batch._count.codes,
    claimed: batch.codes.length,
  }));

  const rows: JoinCodeRow[] = codes.map((row) => {
    const status = row.listing?.status ?? "";
    return {
      id: row.id,
      batchId: row.batch.id,
      batchLabel: row.batch.label,
      serial: row.serial,
      // The view writes one of JOIN_CODE_STATUSES; anything else would be a
      // view out of step with the code, shown as it is rather than hidden.
      status: isJoinCodeStatus(status) ? status : null,
      rawStatus: status,
      pendingEmail: row.pendingEmail,
      claimedBy: row.claimedUser
        ? {
            name: staffDisplayNameOf(row.claimedUser, session.user.role),
            email: row.claimedUser.email,
            deleted: row.claimedUser.deletedByUserId !== null,
          }
        : null,
      claimedAt: row.claimedAt,
      sends: row.confirmSends,
      lastSentAt: row.confirmSentAt,
      expiresAt: row.batch.expiresAt,
      mintedAt: row.batch.createdAt,
    };
  });

  return (
    <main style={{ maxWidth: 1200, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Join cards</h1>
      {!welcomeReachesAuthors && (
        <p style={{ color: "var(--text-secondary)" }}>
          No commons page &ldquo;{WELCOME_PAGE_NAME}&rdquo; is <code>SHARED</code> or <code>PUBLIC</code>, so a new
          account&apos;s first sign-in lands on a bare greeting (docs/EMAIL.md §10, &ldquo;The welcome page&rdquo;).
        </p>
      )}
      <JoinCodesTable
        rows={rows}
        totalCount={totalCount}
        filters={filters}
        prefs={prefs}
        batches={batchOptions}
        maxBatchCards={MAX_BATCH_CARDS}
      />
    </main>
  );
}
