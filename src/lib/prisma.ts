import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const client = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = client;
}

// The raw, unextended client — sees every Post/User row regardless of
// soft-delete state. Only for the handful of call sites that must:
// - the /posts and /users admin tables (§3b/§3c PLAN.md), which need to
//   list a deleted row in order to offer restoring it;
// - setPostDeleted's existence check (restoring a post means finding it
//   *despite* it being deleted);
// - uniqueSlug/signUp's uniqueness checks — slug/email stay DB-unique
//   even for a soft-deleted row, so pretending one is free would just
//   trade a friendly "already exists" error for a raw P2002 at create
//   time (see the CLAUDE.md-adjacent note in post-status.ts's history).
export const prismaIncludingDeleted = client;

const READ_OPERATIONS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);

// Excludes soft-deleted rows from every ordinary read of Post/User, so a
// new query site can't forget the filter the way a hand-spread
// nonDeletedPostWhere()/nonDeletedUserWhere() call could (see PLAN.md
// §3b/§3c and §4's soft-delete note for the two-column convention this
// enforces). Only read operations are touched — create/update/delete pass
// through unchanged, since e.g. restoring a post means writing to a row
// this filter would otherwise hide from a read.
async function excludeSoftDeleted(operation: string, args: unknown, query: (args: unknown) => Promise<unknown>) {
  if (!READ_OPERATIONS.has(operation)) {
    return query(args);
  }
  const where = (args as { where?: object } | undefined)?.where;
  return query({ ...(args as object), where: { ...where, deletedByUserId: null } });
}

export const prisma = client.$extends({
  query: {
    post: {
      $allOperations: (params) => excludeSoftDeleted(params.operation, params.args, params.query),
    },
    user: {
      $allOperations: (params) => excludeSoftDeleted(params.operation, params.args, params.query),
    },
  },
});

// The extended client's interactive-transaction callback gets a differently
// (opaquely) typed `tx` than the base client's `Prisma.TransactionClient` —
// any helper hand-typed against the latter (e.g. actions/posts.ts's
// resolveRevision) stops type-checking once `prisma` becomes this extended
// client. Derive the real type from `prisma.$transaction` itself instead of
// guessing at it.
export type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
