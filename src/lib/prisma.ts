import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Prisma 7 removed the classic query engine: the client no longer reads the
// datasource URL itself, and every connection goes through a driver adapter
// we construct. `prisma.config.ts`'s `datasource` block still exists, but it
// only feeds the CLI's migrate/introspect — nothing at runtime reads it, so
// the URL has to be handed over explicitly here.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set — src/lib/prisma.ts cannot build a driver adapter without it.");
}

// Reusing the cached client across dev HMR reloads matters more under the
// adapter than it did before: each PrismaClient now owns a real pg connection
// pool, so a fresh one per reload leaks pools rather than just re-wrapping an
// engine process.
const client = globalForPrisma.prisma ?? new PrismaClient({ adapter: new PrismaPg(connectionString) });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = client;
}

// The raw, unextended client — sees every Post/User row regardless of
// soft-delete state. Only for the handful of call sites that must:
// - the /posts and /users admin tables (§3b/§3c PLAN.md), which need to
//   list a deleted row in order to offer restoring it;
// - setPostDeleted's existence check (restoring a post means finding it
//   *despite* it being deleted);
// - uniquePostSlug/uniqueUserSlug/signUp's uniqueness checks — slug/email stay DB-unique
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
    doc: {
      $allOperations: (params) => excludeSoftDeleted(params.operation, params.args, params.query),
    },
    // PLAN.md §19 — joins for exactly the reasons doc does: the same
    // deletedByUserId/deletedAt pair, an admin table (/files) that reaches for
    // prismaIncludingDeleted precisely so it can offer a restore, and slug
    // uniqueness that has to see soft-deleted rows. Annotation is still
    // excluded here and filters by hand, unchanged.
    storedFile: {
      $allOperations: (params) => excludeSoftDeleted(params.operation, params.args, params.query),
    },
    // PLAN.md §20c — joins for the same reason storedFile does: the same
    // deletedByUserId/deletedAt pair, and an admin table (/tags) that
    // reaches for prismaIncludingDeleted precisely so it can offer a restore.
    //
    // `tagAssignment` is deliberately NOT here, and filters by hand
    // instead. This extension intercepts *top-level* operations only, and an
    // assignment is read almost exclusively through a `tag_anchor`
    // include, which it cannot reach — so joining would make the model look
    // protected while every real read went around it. §20c states the
    // divergence as chosen rather than missed; this is the other half of that
    // statement.
    tag: {
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
