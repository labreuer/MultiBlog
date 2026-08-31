// Proves the hand-written DDL in add_tags — and, since
// docs/ANCHORED_LINKS.md, in add_anchored_links — actually enforces what its
// comments claim (PLAN.md §20b/§20c).
//
// Everything else in this folder verifies *stored data*. This one verifies the
// *schema* — that the two CHECK constraints and the case-insensitive name index
// reject what they are supposed to reject — by attempting each violation and
// asserting Postgres refuses it. That is a different kind of check, and it
// exists because nothing else can reach these:
//
//   - `npx tsc --noEmit` sees TypeScript, and every violation below is
//     well-typed. A `tag_anchor` with two FKs set is a perfectly ordinary
//     Prisma create call.
//   - `npm run e2e` drives the UI, and the UI never attempts a violation — the
//     server actions build valid rows by construction. A suite that only walks
//     the happy path cannot tell a live constraint from a comment describing
//     one.
//   - A migration that silently failed to add a constraint (docs/DATABASE.md's
//     edit-an-applied-migration recipe, a restore from a dump taken before it)
//     leaves a database that behaves correctly right up until something writes
//     a bad row — at which point the bad row is simply there, and the CHECK
//     that was supposed to be impossible to violate never existed.
//
// So this is the acceptance test for the migration itself, worth re-running
// after either of docs/DATABASE.md's two recipes.
//
// **Writes and rolls back.** Everything happens inside one transaction that is
// always aborted, so a successful run leaves the database byte-identical. The
// rows are real ones (a real tag, a real assignment, against a real user
// and doc), which is why it needs some content to exist at all.
//
// Usage:
//   npx tsx scripts/integrity/check-tag-constraints.ts
//   ... --verbose        also print the line of Postgres' error that names the constraint
//
// Exits non-zero if any constraint failed to reject its violation — or if the
// one row PR 1 actually writes turned out not to be insertable.

import "dotenv/config";
import { prismaIncludingDeleted as prisma } from "../../src/lib/prisma";

const verbose = process.argv.includes("--verbose");

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

type Fixtures = {
  userId: string;
  assignmentId: string;
  docId: string;
  postId: string;
  /** The probe tag's exact name, so the case-collision probe can differ from it *only* by case. */
  tagName: string;
  /** An open draft anchored_link, owned by linkUserId (docs/ANCHORED_LINKS.md). */
  linkId: string;
  /**
   * A user created inside the probe transaction, so the one-draft-per-user
   * probes run against a creator guaranteed to have exactly the drafts this
   * script gave them — the first real user may legitimately have an open
   * draft of their own.
   */
  linkUserId: string;
};

type Probe = {
  name: string;
  /** What must reject it, spelled as Postgres names it in the error. */
  constraint: string;
  /** Why the rejection matters — the design decision the constraint encodes. */
  why: string;
  attempt: (tx: Tx, f: Fixtures) => Promise<unknown>;
};

const MUST_REJECT: Probe[] = [
  {
    name: "anchor with no target",
    constraint: "tag_anchor_one_target_check",
    why: "an anchor that names nothing is not a degraded anchor — it is a row with no meaning (§20b)",
    attempt: (tx, f) =>
      tx.$executeRaw`INSERT INTO tag_anchor (id, assignment_id) VALUES ('probe-none', ${f.assignmentId})`,
  },
  {
    name: "anchor with two targets",
    constraint: "tag_anchor_one_target_check",
    why:
      "cross-container anchors are structurally ready and semantically deferred (§20i): until PERMISSIONS.md " +
      "decides how visibility combines across mixed-permission targets, one row means exactly one object",
    attempt: (tx, f) =>
      tx.$executeRaw`
        INSERT INTO tag_anchor (id, assignment_id, doc_id, post_id)
        VALUES ('probe-two', ${f.assignmentId}, ${f.docId}, ${f.postId})`,
  },
  {
    name: "selector_kind with no offsets",
    constraint: "tag_anchor_selector_columns_check",
    why: "a part-anchor naming a mechanism but no range is the half-written state the all-or-nothing CHECK exists for (§20b)",
    attempt: (tx, f) =>
      tx.$executeRaw`
        INSERT INTO tag_anchor (id, assignment_id, doc_id, selector_kind)
        VALUES ('probe-kindonly', ${f.assignmentId}, ${f.docId}, 'DOC_RANGE')`,
  },
  {
    name: "offsets with no selector_kind",
    constraint: "tag_anchor_selector_columns_check",
    why: "the mirror image — offsets expressed in no stated coordinate mechanism (§20b)",
    attempt: (tx, f) =>
      tx.$executeRaw`
        INSERT INTO tag_anchor (id, assignment_id, doc_id, anchor_from, anchor_to, selector)
        VALUES ('probe-offsets', ${f.assignmentId}, ${f.docId}, 3, 9, '{"v":1,"before":"","after":"","blocks":1}'::jsonb)`,
  },
  {
    name: "a second term differing only by case",
    constraint: "tag_name_lower_key",
    why: '"Epistemology" and "epistemology" are one term; slug uniqueness alone would admit both as distinct (§20c)',
    // The name must differ from the fixture tag's by *case alone* — a
    // different string would be rejected by nothing and prove nothing, which
    // is exactly the trap the "rejected, but not by <constraint>" branch below
    // exists to catch. (It caught this one.)
    attempt: (tx, f) =>
      tx.$executeRaw`
        INSERT INTO tag (id, slug, name, created_by_id, created_at)
        VALUES ('probe-case', 'probe-case-slug', ${f.tagName.toUpperCase()}, ${f.userId}, now())`,
  },
  // docs/ANCHORED_LINKS.md — the third table on the §20a envelope carries its
  // own copies of both CHECKs, plus the partial unique index that makes "the
  // viewer's draft" a definite article.
  {
    name: "link anchor with no target",
    constraint: "anchored_link_anchor_one_target_check",
    why: "the same §20a arc rule, restated per anchor table by design (a shared CHECK cannot span tables)",
    attempt: (tx, f) =>
      tx.$executeRaw`INSERT INTO anchored_link_anchor (id, link_id) VALUES ('probe-link-none', ${f.linkId})`,
  },
  {
    name: "link anchor with two targets",
    constraint: "anchored_link_anchor_one_target_check",
    why: "one row means exactly one object, in every consumer family (§20a)",
    attempt: (tx, f) =>
      tx.$executeRaw`
        INSERT INTO anchored_link_anchor (id, link_id, doc_id, post_id)
        VALUES ('probe-link-two', ${f.linkId}, ${f.docId}, ${f.postId})`,
  },
  {
    name: "link anchor selector_kind with no offsets",
    constraint: "anchored_link_anchor_selector_columns_check",
    why: "the same half-written state the tag CHECK rejects — and here every real row is a part, so the gap would be wider",
    attempt: (tx, f) =>
      tx.$executeRaw`
        INSERT INTO anchored_link_anchor (id, link_id, doc_id, selector_kind)
        VALUES ('probe-link-kindonly', ${f.linkId}, ${f.docId}, 'DOC_RANGE')`,
  },
  {
    name: "link anchor offsets with no selector_kind",
    constraint: "anchored_link_anchor_selector_columns_check",
    why: "the mirror image — offsets expressed in no stated coordinate mechanism (§20b)",
    attempt: (tx, f) =>
      tx.$executeRaw`
        INSERT INTO anchored_link_anchor (id, link_id, doc_id, anchor_from, anchor_to, selector)
        VALUES ('probe-link-offsets', ${f.linkId}, ${f.docId}, 3, 9, '{"v":1,"before":"","after":"","blocks":1}'::jsonb)`,
  },
  {
    name: "a second open draft for one user",
    constraint: "anchored_link_one_draft_per_user",
    why:
      "loadMyDraftLink is a definite article, and the get-or-create race's loser gets a catchable P2002 " +
      "rather than a twin draft (docs/ANCHORED_LINKS.md)",
    attempt: (tx, f) =>
      tx.$executeRaw`
        INSERT INTO anchored_link (id, created_by_id, created_at)
        VALUES ('probe-draft-two', ${f.linkUserId}, now())`,
  },
];

// A constraint set that rejects everything is not a passing test. These are
// what tell the two apart — the shapes the design says are *legal*, which have
// to go in.
const MUST_ACCEPT: Probe[] = [
  {
    name: "whole-object row (one target, four part columns null)",
    constraint: "",
    why: "the only shape PR 1 writes (§20h)",
    attempt: (tx, f) =>
      tx.$executeRaw`
        INSERT INTO tag_anchor (id, assignment_id, doc_id)
        VALUES ('probe-ok', ${f.assignmentId}, ${f.docId})`,
  },
  {
    name: "DOC_RANGE part row with offsets and no selector blob",
    constraint: "",
    // Worth pinning even though PR 1 never writes it. §20b's CHECK is an
    // equality over the whole group ("the group is empty iff the kind is
    // absent"), NOT a per-kind requirement, and this row is why that is right:
    // it is exactly what §20e step 1's backfill produces, since today's
    // annotation column anchors carry offsets, a quote and a stamp but no
    // before/after context blob at all. A stricter CHECK demanding a selector
    // per part row would reject the migration that has to run in PR 2.
    why: "the shape §20e's annotation backfill writes — offsets, quote and stamp, no context blob",
    attempt: (tx, f) =>
      tx.$executeRaw`
        INSERT INTO tag_anchor (id, assignment_id, doc_id, selector_kind, anchor_from, anchor_to, quoted_text)
        VALUES ('probe-docrange', ${f.assignmentId}, ${f.docId}, 'DOC_RANGE', 3, 9, 'six ch')`,
  },
  {
    name: "DOC_RANGE link part — the shape the writer actually produces",
    constraint: "",
    why: "addAnchoredLinkPart's doc row: offsets, quote and context blob together (docs/ANCHORED_LINKS.md)",
    attempt: (tx, f) =>
      tx.$executeRaw`
        INSERT INTO anchored_link_anchor
          (id, link_id, doc_id, selector_kind, anchor_from, anchor_to, quoted_text, selector)
        VALUES ('probe-link-ok', ${f.linkId}, ${f.docId}, 'DOC_RANGE', 3, 9, 'six ch',
          '{"v":1,"before":"","after":"","blocks":1}'::jsonb)`,
  },
  {
    name: "a second link for a user whose first is minted",
    constraint: "",
    // This is what makes the index *partial* rather than one-link-per-user:
    // minting frees the slot, which is the entire lifecycle (mint → new
    // draft accumulates → mint again).
    why: "minting frees the one-draft slot — the WHERE clause is the feature, not an optimisation",
    attempt: (tx, f) =>
      tx.$executeRaw`
        INSERT INTO anchored_link (id, created_by_id, created_at, minted_at)
        VALUES ('probe-link-minted', ${f.linkUserId}, now(), now())`,
  },
];

// What the specified CHECK deliberately does NOT catch, printed rather than
// left in a comment nobody reads. Recorded here because "which constraint
// covers this?" is the question this script exists to answer, and an honest
// answer includes the gaps.
//
// Not tightened in PR 1: per-kind requirements only become knowable once the
// writers exist (PR 2, §20h steps 7–9), and a CHECK guessed at before them
// could reject the very rows the annotation backfill has to write — the
// DOC_RANGE case above is precisely that trap, met once already. Tightening
// later is an ADD CONSTRAINT plus a DROP, which is cheap; shipping one that
// blocks a migration is not.
const KNOWN_RESIDUALS = [
  "PDF_TEXT with offsets but no `selector` blob is accepted — for a PDF the blob *is* the anchor, " +
    "so such a row anchors nothing. §20b's formula is group-wide, not per-kind; PR 2's writer is " +
    "where the per-kind rule belongs.",
];

/** Aborts the probe transaction without being mistaken for a real failure. */
class RollbackSignal extends Error {}

/**
 * Runs one attempt inside its own SAVEPOINT and returns Postgres' complaint, or
 * null if the row went in.
 *
 * The savepoint is not optional: a constraint violation aborts the enclosing
 * transaction, so without one every probe after the first would die with
 * "current transaction is aborted" — reporting five faults that are really the
 * first probe's success.
 */
async function attemptInSavepoint(tx: Tx, probe: Probe, fixtures: Fixtures): Promise<string | null> {
  await tx.$executeRawUnsafe("SAVEPOINT probe");
  try {
    await probe.attempt(tx, fixtures);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT probe");
  }
}

async function main() {
  const [user, doc, post] = await Promise.all([
    prisma.user.findFirst({ select: { id: true } }),
    prisma.doc.findFirst({ select: { id: true } }),
    prisma.post.findFirst({ select: { id: true } }),
  ]);
  if (!user || !doc || !post) {
    console.error(
      "Needs at least one user, one doc and one post to build a real row against.\n" +
        "Seed with `npx tsx scripts/seed-sample-data.ts`, or make throwaways with scripts/test-user.ts and friends.",
    );
    await prisma.$disconnect();
    process.exit(1);
  }

  const failures: string[] = [];

  await prisma
    .$transaction(async (tx) => {
      const tagName = `Probe Constraint Term ${Date.now()}`;
      const tag = await tx.tag.create({
        data: { slug: `probe-${Date.now()}`, name: tagName, createdById: user.id },
        select: { id: true },
      });
      const assignment = await tx.tagAssignment.create({
        data: { tagId: tag.id, userId: user.id },
        select: { id: true },
      });
      // The link fixtures get their own user — see Fixtures.linkUserId.
      const linkUser = await tx.user.create({
        data: {
          email: `probe-link-${Date.now()}@probe.invalid`,
          slug: `probe-link-user-${Date.now()}`,
          adminInitials: "PL",
        },
        select: { id: true },
      });
      const link = await tx.anchoredLink.create({
        data: { createdById: linkUser.id },
        select: { id: true },
      });
      const fixtures: Fixtures = {
        userId: user.id,
        assignmentId: assignment.id,
        docId: doc.id,
        postId: post.id,
        tagName,
        linkId: link.id,
        linkUserId: linkUser.id,
      };

      for (const probe of MUST_REJECT) {
        const rejection = await attemptInSavepoint(tx, probe, fixtures);
        if (rejection === null) {
          failures.push(`${probe.name}: ACCEPTED — ${probe.constraint} is not enforcing. ${probe.why}`);
        } else if (!rejection.includes(probe.constraint)) {
          // Rejected by something else. Worth failing on: a row refused for an
          // unrelated reason (a typo'd column, a missing FK) would mask the
          // constraint being absent, which is precisely what this script is for.
          failures.push(
            `${probe.name}: rejected, but not by ${probe.constraint} — so this proves nothing about that ` +
              `constraint. Postgres said: ${rejection.split("\n")[0]}`,
          );
        } else {
          console.log(`  ok    ${probe.name}\n          → ${probe.constraint}`);
          if (verbose) {
            const line = rejection.split("\n").find((l) => l.includes(probe.constraint));
            if (line) console.log(`          ${line.trim()}`);
          }
        }
      }

      for (const probe of MUST_ACCEPT) {
        const rejection = await attemptInSavepoint(tx, probe, fixtures);
        if (rejection !== null) {
          failures.push(
            `${probe.name}: REJECTED — this is ${probe.why}, and it could not be written. ` +
              `Postgres said: ${rejection.split("\n")[0]}`,
          );
        } else {
          console.log(`  ok    ${probe.name}\n          → accepted (${probe.why})`);
        }
      }

      // Always. Nothing above is meant to survive.
      throw new RollbackSignal();
    })
    .catch((err) => {
      if (!(err instanceof RollbackSignal)) throw err;
    });

  console.log(
    `\n${MUST_REJECT.length + MUST_ACCEPT.length} constraint probe(s) — ` +
      `${MUST_REJECT.length} must reject, ${MUST_ACCEPT.length} must accept — ${failures.length} failure(s)`,
  );
  for (const f of failures) console.log(`  FAIL  ${f}`);
  for (const r of KNOWN_RESIDUALS) console.log(`  NOTE  not covered: ${r}`);

  await prisma.$disconnect();
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
