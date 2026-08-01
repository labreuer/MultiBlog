// One-shot import of real data from a pre-§15 database (schema as of commit
// 526692e) into the present schema. Reads five legacy tables — User, Post,
// PostCollab, PostCollabUpdate, PostAuthor — and writes the equivalent rows
// here. Every other legacy table is ignored by instruction (no data).
//
// Usage:
//   npx tsx scripts/import-legacy.ts --source=<postgres-url> [--dry-run]
//     [--visibility=PRIVATE|SHARED] [--timeout=<ms>]
//
// --source is the OLD database's connection string; the target is whatever
// DATABASE_URL points at, same as every other script here. --dry-run does the
// entire import inside a transaction and then rolls it back, so the summary it
// prints is a real result rather than an estimate — run it first.
// --visibility sets the imported docs' Doc.visibility (default PRIVATE, the
// schema default; PLAN.md §12e). --timeout raises the transaction budget for a
// large update log (default 600000, i.e. 10 minutes).
//
// LEGACY POSTS BECOME DOCS. NO POST ROWS ARE CREATED.
// Back then a Post owned its editable content: PostCollab held the live Yjs
// state, PostCollabUpdate its update log. Now a post is an immutable snapshot
// of a Doc (PLAN.md §15) and live content lives in the generic ydoc stack
// (§11) keyed by `ydoc:<docId>`. The editable thing a legacy Post actually
// *was* is therefore a Doc, and that is the only row this import creates for
// it — publishing is a later, deliberate act through /posts/[id] (§15c), not
// something a data migration should decide on your behalf. Consequences:
//
// - **Doc.id is set to the legacy Post.id.** Nothing requires it, but it makes
//   the ydoc id `ydoc:<old post id>` and keeps the import traceable by eye.
// - **The legacy Post.slug becomes the Doc.slug.** Doc slugs live in their own
//   /doc/* namespace (§12c), so they cannot collide with anything a future
//   post claims under /[slug] — nothing is being reserved or used up here.
// - **PostAuthor becomes DocAuthor**, byline order preserved. DocAuthor has no
//   `createdUserId`, so unlike PostAuthor there is no provenance column to
//   invent a value for.
// - **Soft-delete state transfers**: legacy Post.deletedByUserId/deletedAt
//   become the Doc's own pair. deletedByUserId is remapped through the same
//   email-matching map the bylines use, and it is the column that actually
//   hides a row — src/lib/prisma.ts's read filter tests `deletedByUserId:
//   null`, not deletedAt — so a legacy deleter who is not among the imported
//   users is reported rather than quietly dropped, since the result would be
//   a doc carrying a deletedAt that still appears everywhere.
// - **Doc.proseJson stays null.** It is a cache of the ydoc, written by
//   server/doc-cache.ts on the collab server's next store debounce (§12d);
//   /doc/[slug] decodes the ydoc until then.
//
// THE UPDATE LOG IS IMPORTED AS-IS, AND THAT IS SAFE
// PLAN.md §11b invariant 1 requires row #1 of ydoc_update to be a full state
// and every later row a plain delta. The legacy log already obeyed exactly
// that rule — server/collab.ts's onChange at 526692e wrote
// `existingCount === 0 ? Y.encodeStateAsUpdate(document) : update`. So the rows
// transfer in their original order with no synthetic base row, and
// /ydoc-debug's replay works on them. The one exception is handled below: a
// PostCollab row whose log is empty (the log was reset by a publish and never
// re-appended) gets a single full-state row synthesized from PostCollab.ydoc,
// which is what ydocStore.createIfAbsent would have written anyway.
//
// AND THE LOG IS ALSO WHAT THE ydoc BLOB IS COMPUTED FROM
// PostCollab.ydoc is NOT imported verbatim when a log exists — it is discarded
// and the blob is recomputed as mergeUpdates(every log row). The two are meant
// to be one history seen two ways and in the real legacy data they are not
// always: a document was found whose PostCollab.ydoc carries the title
// "Three aspects of interaction" while replaying all 458 of its
// PostCollabUpdate rows yields no title fragment at all. Importing the blob
// verbatim preserves that contradiction — the ydoc row says one thing, the log
// says another, and a live editing session would disagree with /ydoc-debug's
// replay permanently. Recomputing makes the two consistent by construction.
// Verified before relying on it: for a legacy-shaped log (full state + deltas)
// mergeUpdates reproduces the source document's body, title, and state vector
// exactly, and equals a row-by-row replay of the same rows.
//
// What this costs: any content that lives ONLY in the discarded blob is
// dropped, because by definition the log never recorded it. That is the
// intended trade — a rebuildable history beats an unexplained blob — but it is
// real, so every discarded blob that disagreed with its log is listed
// individually in the summary rather than folded into a count.
//
// THE TITLE IS FOLDED INTO THE BASE OF THE HISTORY WHEN IT IS MISSING
// Both schemas keep the title in a "title" Yjs fragment, and the legacy
// onLoadDocument seeded it on every load — so most imported ydocs already
// carry one and are left untouched. Where the fragment IS empty, though,
// server/doc-cache.ts would write it through as Doc.title = "" on the first
// store debounce (deliberately — §12n: the fragment is the title, Doc.title
// only its cache), silently discarding the title imported onto the Doc row.
// So Post.title is merged into the ydoc as well, into row 1 of the log rather
// than as a new row: Yjs is append-only and cannot prepend, but row 1 is a
// full state (invariant 1) and the title is its own fragment, so the result
// is a title present from the very first replay position with rows 2..N
// untouched. See resolveTitle for why one delta is merged into both the base
// row and the final state instead of inserting into each. The summary names
// both groups individually — which ydocs were given a title and which already
// had one (with the title it found, flagged when it disagrees with Post.title)
// — since "did the titles survive" is the question this import most needs to
// answer and a bare count doesn't.
//
// Legacy PostCollabUpdate.id is used for ORDERING ONLY — new ids come from the
// target's own sequence. Preserving the literal ids would collide with rows
// already in the target and desync the sequence; §11b only ever reads the log
// in ascending id order, so order is the whole of what matters.
//
// USERS ARE MATCHED BY EMAIL, NEVER DUPLICATED
// A target that already has an admin (scripts/create-admin.ts) must not get a
// second row for the same person. An existing email wins: the legacy row is
// skipped and its id is mapped onto the existing user's, so byline references
// resolve to the account already there. Slugs that collide get a -2/-3 suffix,
// same rule as uniqueUserSlug/uniqueDocSlug.
//
// NOT IMPORTED: ydoc snapshots (by instruction — none exist), posts, and
// everything downstream of a Revision.

import "dotenv/config";
import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { PrismaPg } from "@prisma/adapter-pg";
import { titleAuthorHighlightExtensions } from "../src/lib/tiptap-schema";
import { extractText } from "../src/lib/diff";
import { PrismaClient } from "../src/generated/prisma/client";
import type { Prisma } from "../src/generated/prisma/client";
import { prismaIncludingDeleted } from "../src/lib/prisma";
import { ydocIdForDoc } from "../src/lib/ydoc-names";
import { slugify } from "../src/lib/slug";
import { Role, ModerationPolicy, DocVisibility } from "../src/generated/prisma/enums";

type LegacyUser = {
  id: string;
  email: string;
  slug: string;
  emailVerified: Date | null;
  name: string | null;
  image: string | null;
  passwordHash: string | null;
  role: string;
  moderationPolicy: string;
  color: string;
  adminInitials: string;
  createdAt: Date;
  deletedByUserId: string | null;
  deletedAt: Date | null;
};

type LegacyPost = {
  id: string;
  slug: string;
  title: string;
  createdAt: Date;
  deletedByUserId: string | null;
  deletedAt: Date | null;
};
type LegacyPostCollab = { postId: string; ydoc: Buffer; updatedAt: Date };
type LegacyPostAuthor = { postId: string; userId: string; bylineOrder: number };

const ROLLBACK = Symbol("dry-run-rollback");
const UPDATE_BATCH = 1000;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

// Mirrors docSlugInUse/userSlugInUse (a slug is taken if it is any row's
// current slug OR sits in that table's history as a redirect source), but
// reads through the transaction and also honors slugs claimed earlier in this
// same import — uncommitted rows the library helpers, which query the global
// client, could not see. RESERVED_SLUGS is deliberately not consulted: it
// guards the /[slug] post catch-all, and neither docs nor users route there.
async function claimSlug(
  tx: Prisma.TransactionClient,
  kind: "doc" | "user",
  desired: string,
  claimed: Set<string>,
): Promise<string> {
  const base = slugify(desired, kind);
  let candidate = base;
  let suffix = 2;

  const taken = async (slug: string): Promise<boolean> => {
    if (claimed.has(slug)) return true;
    if (kind === "doc") {
      return (
        (await tx.doc.findFirst({ where: { slug }, select: { id: true } })) !== null ||
        (await tx.docSlugHistory.findFirst({ where: { slug }, select: { id: true } })) !== null
      );
    }
    return (
      (await tx.user.findFirst({ where: { slug }, select: { id: true } })) !== null ||
      (await tx.userSlugHistory.findFirst({ where: { slug }, select: { id: true } })) !== null
    );
  };

  while (await taken(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  claimed.add(candidate);
  return candidate;
}

// Decides what, if anything, this ydoc's "title" fragment needs — and reports
// what it found either way, so the summary can name both groups rather than
// just counting one. `seeded: false` is the common case: the legacy server's
// onLoadDocument seeded the fragment on every load, so any post opened in the
// editor after the title moved into Yjs already carries one.
//
// The delta is returned STANDALONE on purpose. The caller merges this one
// delta into both the base log row and the final state, which keeps them the
// same items: insert into each separately instead and the two independent
// insertions CRDT-merge into a doubled title. It is built from a Y.Doc that
// already has the final state applied, so its clocks continue from real ones
// rather than starting a parallel lineage.
//
// The inserted shape matches the legacy onLoadDocument exactly — a "paragraph"
// XmlElement holding one XmlText, which is what titleExtensions expects.
// What a given state's "title" fragment reads as. Read back through the same
// path server/doc-cache.ts uses, so what gets reported is what the app would
// actually show. Also used to compare the discarded legacy blob against the
// replayed log below, which is where the two are known to disagree.
type TitleRead = { present: false } | { present: true; text: string };

function readTitle(state: Uint8Array): TitleRead {
  const d = new Y.Doc();
  try {
    Y.applyUpdate(d, state);
    if (d.getXmlFragment("title").length === 0) return { present: false };
    try {
      const json = TiptapTransformer.extensions(titleAuthorHighlightExtensions).fromYdoc(d, "title");
      return { present: true, text: extractText(json) };
    } catch {
      // An anomaly worth naming, not worth aborting the import over — the
      // fragment is there, so nothing is seeded either way.
      return { present: true, text: "(present, but not TipTap-decodable)" };
    }
  } finally {
    d.destroy();
  }
}

function describeTitle(t: TitleRead): string {
  return t.present ? JSON.stringify(t.text) : "no title fragment";
}

// The update that puts `title` into a "title" fragment, as a standalone delta
// against `base`. The caller merges it into row 1 and then recomputes the blob
// from the resulting rows, so the two cannot drift apart.
//
// `base` must be ROW 1, not the merged final state — see the call site for the
// measured consequence of getting that wrong. The inserted shape matches the
// legacy onLoadDocument exactly: a "paragraph" XmlElement holding one XmlText,
// which is what titleExtensions expects.
function buildTitleDelta(base: Uint8Array, title: string): Uint8Array {
  const d = new Y.Doc();
  try {
    Y.applyUpdate(d, base);
    const fragment = d.getXmlFragment("title");
    const before = Y.encodeStateVector(d);
    const paragraph = new Y.XmlElement("paragraph");
    if (title) paragraph.insert(0, [new Y.XmlText(title)]);
    fragment.insert(0, [paragraph]);
    return new Uint8Array(Y.encodeStateAsUpdate(d, before));
  } finally {
    // Safe: the return expression is fully evaluated before this runs, and the
    // encoded bytes are their own buffer rather than a view into the doc.
    d.destroy();
  }
}

function asEnum<T extends Record<string, string>>(values: T, raw: string, column: string): T[keyof T] {
  const match = Object.values(values).find((v) => v === raw);
  if (!match) fail(`Legacy ${column} value ${JSON.stringify(raw)} has no counterpart in the present schema.`);
  return match as T[keyof T];
}

async function main() {
  const sourceUrl = arg("source");
  if (!sourceUrl) fail("--source=<postgres-url> is required (the OLD database).");

  const dryRun = process.argv.includes("--dry-run");
  const timeout = Number(arg("timeout") ?? 600_000);
  const visibility = asEnum(DocVisibility, arg("visibility") ?? DocVisibility.PRIVATE, "visibility");

  if (sourceUrl === process.env.DATABASE_URL) {
    fail("--source is the same as DATABASE_URL. The source must be the OLD database, not the target.");
  }

  const source = new PrismaClient({ adapter: new PrismaPg(sourceUrl) });

  console.log(`\nSource: ${sourceUrl.replace(/:[^:@/]+@/, ":****@")}`);
  console.log(`Target: ${(process.env.DATABASE_URL ?? "").replace(/:[^:@/]+@/, ":****@")}`);
  console.log(dryRun ? "Mode:   DRY RUN (everything rolls back)\n" : "Mode:   LIVE\n");

  // Legacy tables have no @@map, so they are Prisma's defaults: PascalCase
  // table names and camelCase columns, both of which Postgres folds to
  // lowercase unless quoted. Every identifier below is quoted for that reason.
  const users = await source.$queryRawUnsafe<LegacyUser[]>(
    `SELECT "id", "email", "slug", "emailVerified", "name", "image", "passwordHash", "role"::text AS "role",
            "moderationPolicy"::text AS "moderationPolicy", "color", "adminInitials", "createdAt",
            "deletedByUserId", "deletedAt"
       FROM "User" ORDER BY "createdAt" ASC`,
  );
  const posts = await source.$queryRawUnsafe<LegacyPost[]>(
    `SELECT "id", "slug", "title", "createdAt", "deletedByUserId", "deletedAt"
       FROM "Post" ORDER BY "createdAt" ASC`,
  );
  const collabs = await source.$queryRawUnsafe<LegacyPostCollab[]>(
    `SELECT "postId", "ydoc", "updatedAt" FROM "PostCollab"`,
  );
  const postAuthors = await source.$queryRawUnsafe<LegacyPostAuthor[]>(
    `SELECT "postId", "userId", "bylineOrder" FROM "PostAuthor" ORDER BY "postId", "bylineOrder" ASC`,
  );

  console.log(
    `Read from source: ${users.length} user(s), ${posts.length} post(s), ` +
      `${collabs.length} collab doc(s), ${postAuthors.length} byline row(s).`,
  );

  const collabByPost = new Map(collabs.map((c) => [c.postId, c]));
  const summary = {
    usersInserted: 0,
    usersLinked: 0,
    docs: 0,
    docAuthors: 0,
    ydocs: 0,
    updateRows: 0,
    synthesizedBaseRows: 0,
    computedFromLog: 0,
    blobDisagreed: [] as string[],
    titlesSeeded: [] as string[],
    titlesPresent: [] as string[],
    softDeletedDocs: 0,
    docsWithoutContent: [] as string[],
    unresolvedDeleters: [] as string[],
    renamedSlugs: [] as string[],
  };

  try {
    await prismaIncludingDeleted.$transaction(
      async (tx) => {
        // ---- Users -------------------------------------------------------
        // deletedByUserId is a self-FK, so it is left null on insert and
        // backfilled once every row exists.
        const userIdMap = new Map<string, string>();
        const claimedUserSlugs = new Set<string>();

        for (const u of users) {
          const existing = await tx.user.findUnique({ where: { email: u.email }, select: { id: true } });
          if (existing) {
            userIdMap.set(u.id, existing.id);
            summary.usersLinked += 1;
            continue;
          }
          const slug = await claimSlug(tx, "user", u.slug, claimedUserSlugs);
          if (slug !== u.slug) summary.renamedSlugs.push(`user ${u.email}: ${u.slug} -> ${slug}`);

          await tx.user.create({
            data: {
              id: u.id,
              email: u.email,
              slug,
              emailVerified: u.emailVerified,
              name: u.name,
              image: u.image,
              passwordHash: u.passwordHash,
              role: asEnum(Role, u.role, "User.role"),
              moderationPolicy: asEnum(ModerationPolicy, u.moderationPolicy, "User.moderationPolicy"),
              color: u.color,
              adminInitials: u.adminInitials,
              createdAt: u.createdAt,
              deletedAt: u.deletedAt,
            },
          });
          userIdMap.set(u.id, u.id);
          summary.usersInserted += 1;
        }

        for (const u of users) {
          if (!u.deletedByUserId) continue;
          const self = userIdMap.get(u.id);
          const deleter = userIdMap.get(u.deletedByUserId);
          if (!self || !deleter || self !== u.id) continue; // linked-to-existing rows keep their own state
          await tx.user.update({ where: { id: self }, data: { deletedByUserId: deleter } });
        }

        // ---- Legacy Post -> Doc ------------------------------------------
        const claimedDocSlugs = new Set<string>();
        const bylinesByPost = new Map<string, LegacyPostAuthor[]>();
        for (const a of postAuthors) {
          const list = bylinesByPost.get(a.postId) ?? [];
          list.push(a);
          bylinesByPost.set(a.postId, list);
        }

        for (const p of posts) {
          const docSlug = await claimSlug(tx, "doc", p.slug, claimedDocSlugs);
          if (docSlug !== p.slug) summary.renamedSlugs.push(`doc ${p.id}: ${p.slug} -> ${docSlug}`);

          // Soft-delete state rides across as a pair. deletedByUserId is both
          // the FK and the discriminator src/lib/prisma.ts filters reads on,
          // so an unresolvable deleter would leave a doc that carries a
          // deletedAt yet still shows up everywhere — surfaced rather than
          // silently half-applied.
          let deletedByUserId: string | null = null;
          if (p.deletedByUserId) {
            deletedByUserId = userIdMap.get(p.deletedByUserId) ?? null;
            if (!deletedByUserId) summary.unresolvedDeleters.push(`${docSlug} (${p.id})`);
          }

          await tx.doc.create({
            data: {
              id: p.id, // deliberate — see header
              slug: docSlug,
              title: p.title,
              visibility,
              createdAt: p.createdAt,
              deletedByUserId,
              deletedAt: p.deletedAt,
            },
          });
          summary.docs += 1;
          if (deletedByUserId || p.deletedAt) summary.softDeletedDocs += 1;

          for (const a of bylinesByPost.get(p.id) ?? []) {
            const userId = userIdMap.get(a.userId);
            if (!userId) continue; // byline row referencing a user that no longer exists
            await tx.docAuthor.create({ data: { docId: p.id, userId, bylineOrder: a.bylineOrder } });
            summary.docAuthors += 1;
          }

          // ---- PostCollab -> Ydoc, PostCollabUpdate -> YdocUpdate --------
          const collab = collabByPost.get(p.id);
          if (!collab) {
            // No live content ever existed for this post; the Doc stands with
            // its title and an empty body, and ydocOnLoadDocument will create
            // the ydoc row on first connect.
            summary.docsWithoutContent.push(`${docSlug} (${p.id})`);
            continue;
          }

          const ydocId = ydocIdForDoc(p.id);
          const legacyState = new Uint8Array(collab.ydoc);

          const updates = await source.$queryRawUnsafe<{ id: bigint; update: Buffer }[]>(
            `SELECT "id", "update" FROM "PostCollabUpdate" WHERE "postId" = $1 ORDER BY "id" ASC`,
            p.id,
          );

          // THE LOG WINS OVER PostCollab.ydoc WHENEVER THERE IS A LOG.
          // The two are supposed to be the same history seen two ways, and in
          // the legacy data they are not always: at least one real document
          // has a PostCollab.ydoc carrying a title while replaying its entire
          // PostCollabUpdate log produces no title fragment at all. Importing
          // the blob verbatim would carry that disagreement across intact —
          // the ydoc row would say one thing and ydoc_update another, so
          // /ydoc-debug's replay and anything else that rebuilds from the log
          // would disagree with a live editing session forever.
          //
          // So when there is a log, the imported blob is COMPUTED from it
          // (mergeUpdates over row 1's full state plus every delta, verified
          // to reproduce the same body/title/state-vector as the live document
          // it came from) and PostCollab.ydoc is discarded. The blob and the
          // log are then consistent by construction rather than by assumption.
          // With no log there is nothing to compute from, so the blob is used
          // as-is and becomes the synthesized base row further down.
          // The rows that will become ydoc_update, in order. With no log there
          // is nothing to replay, so the legacy blob becomes a single
          // full-state row — which is exactly what ydocStore.createIfAbsent
          // would have written, and satisfies invariant 1 the same way.
          // Uint8Array<ArrayBuffer>, not the default Uint8Array<ArrayBufferLike>:
          // Prisma's Bytes input requires the former, and Y.mergeUpdates returns
          // the latter — hence the re-wraps at each assignment below.
          const rows: Uint8Array<ArrayBuffer>[] =
            updates.length > 0 ? updates.map((u) => new Uint8Array(u.update)) : [legacyState];
          const usedLog = updates.length > 0;
          if (!usedLog) summary.synthesizedBaseRows += 1;

          if (usedLog) {
            summary.computedFromLog += 1;
            // Name the disagreement rather than silently resolving it: the
            // discarded blob's title is real content the log does not contain.
            const fromBlob = readTitle(legacyState);
            const fromLog = readTitle(new Uint8Array(Y.mergeUpdates(rows)));
            if (
              fromBlob.present !== fromLog.present ||
              (fromBlob.present && fromLog.present && fromBlob.text !== fromLog.text)
            ) {
              summary.blobDisagreed.push(
                `${docSlug} (${p.id}) — discarded blob had ${describeTitle(fromBlob)}, ` +
                  `replayed log has ${describeTitle(fromLog)}`,
              );
            }
          }

          // The new stack treats the title fragment AS the title:
          // server/doc-cache.ts writes an empty fragment through as
          // Doc.title = "" on the first store debounce, deliberately (§12n).
          // So a ydoc carrying no title fragment would lose the title imported
          // onto the Doc row above the moment anyone opened it. Folding
          // Post.title into the history is what prevents that — and note this
          // asks the REPLAYED state, so a document whose log lost its title
          // gets one seeded even though the discarded blob had one.
          // Post.title (not the discarded blob's title) is the seed on
          // purpose: Doc.title above is Post.title, and doc-cache rewrites
          // Doc.title from this fragment on the first store, so seeding
          // anything else would make the row contradict itself on first open.
          const existingTitle = readTitle(new Uint8Array(Y.mergeUpdates(rows)));
          if (!existingTitle.present) {
            // Built from ROW 1, not from the merged final state. This is not
            // cosmetic: Y.encodeStateAsUpdate(doc, sv) emits the doc's ENTIRE
            // delete set alongside the structs newer than sv, so a delta built
            // from the final state carries every deletion the document ever
            // accumulated. Merging that into row 1 injects those deletes at the
            // START of the log, where they then delete content rows 2..N go on
            // to insert -- measured on a real 458-row document, that silently
            // cost 72 characters of body text (1461 -> 1389) while the blob
            // still showed all of it. Built from row 1 the delta carries only
            // row 1's own delete set (74 bytes rather than 445 on that same
            // document) and replay matches the blob exactly.
            const delta = buildTitleDelta(rows[0], p.title);
            rows[0] = new Uint8Array(Y.mergeUpdates([rows[0], delta]));
            summary.titlesSeeded.push(`${docSlug} (${p.id}) — inserted ${JSON.stringify(p.title)}`);
          } else {
            // Flag a ydoc whose own title disagrees with the Post row's. Not an
            // error and nothing is changed — the fragment wins, since it is
            // what doc-cache will write Doc.title from on the first store —
            // but it is the one case where the imported Doc.title is about to
            // be replaced by something else the moment the doc is opened.
            const differs = existingTitle.text !== p.title;
            summary.titlesPresent.push(
              `${docSlug} (${p.id}) — ydoc title ${JSON.stringify(existingTitle.text)}` +
                (differs ? `  [Post.title was ${JSON.stringify(p.title)}]` : ""),
            );
          }

          // The blob is derived from the exact rows about to be written, AFTER
          // any title fold — so "the blob equals a replay of the log" is true
          // by construction rather than by argument. (Verified on real data
          // that mergeUpdates over a legacy-shaped log and a row-by-row replay
          // of the same rows agree on body, title, and state vector.)
          const state = new Uint8Array(Y.mergeUpdates(rows));
          // From the update bytes rather than a Y.Doc round-trip, so there is
          // no gc decision to make and the vector cannot disagree with its blob.
          const stateVector = Y.encodeStateVectorFromUpdate(state);

          await tx.ydoc.create({
            data: { id: ydocId, ydoc: Buffer.from(state), stateVector: Buffer.from(stateVector) },
          });
          summary.ydocs += 1;

          // Batched: a long-lived doc's log can run to many thousands of rows,
          // and one round trip each would dominate the transaction. Postgres
          // assigns the autoincrement ids in insertion order within a batch, so
          // ascending-id order — all §11b ever reads — is kept.
          for (let i = 0; i < rows.length; i += UPDATE_BATCH) {
            const batch = rows.slice(i, i + UPDATE_BATCH);
            await tx.ydocUpdate.createMany({
              data: batch.map((update) => ({ ydocId, update })),
            });
            summary.updateRows += batch.length;
          }

          // Doc.updatedAt and Ydoc.updatedAt are both @updatedAt, which Prisma
          // stamps with now() on create regardless of what is passed. Raw SQL
          // is the only way to land the legacy PostCollab.updatedAt the import
          // was asked to carry across.
          await tx.$executeRawUnsafe(`UPDATE "doc" SET "updated_at" = $1 WHERE "id" = $2`, collab.updatedAt, p.id);
          await tx.$executeRawUnsafe(`UPDATE "ydoc" SET "updated_at" = $1 WHERE "id" = $2`, collab.updatedAt, ydocId);
        }

        if (dryRun) throw ROLLBACK;
      },
      { timeout, maxWait: 30_000 },
    );
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  } finally {
    await source.$disconnect();
  }

  console.log(`\n${dryRun ? "Would import" : "Imported"}:`);
  console.log(`  users:        ${summary.usersInserted} inserted, ${summary.usersLinked} linked to existing by email`);
  console.log(
    `  docs:         ${summary.docs} (from legacy posts; no post rows created)` +
      (summary.softDeletedDocs ? `, ${summary.softDeletedDocs} soft-deleted` : ""),
  );
  console.log(`  doc_authors:  ${summary.docAuthors}`);
  console.log(
    `  ydocs:        ${summary.ydocs} ` +
      `(${summary.titlesSeeded.length} given a title, ${summary.titlesPresent.length} already had one)`,
  );
  console.log(
    `  blob source:  ${summary.computedFromLog} computed by replaying the update log, ` +
      `${summary.ydocs - summary.computedFromLog} taken from PostCollab.ydoc (no log to replay)`,
  );
  console.log(
    `  ydoc_updates: ${summary.updateRows}` +
      (summary.synthesizedBaseRows ? ` (${summary.synthesizedBaseRows} synthesized base row(s))` : ""),
  );

  if (summary.blobDisagreed.length) {
    console.log(
      `\n  Legacy PostCollab.ydoc DISAGREED with its own update log and was discarded` +
        ` (${summary.blobDisagreed.length}) — the log won, see the header:`,
    );
    for (const s of summary.blobDisagreed) console.log(`    ${s}`);
  }
  if (summary.titlesSeeded.length) {
    console.log(
      `\n  Given a title — no title fragment in the legacy ydoc, so Post.title was folded` +
        ` into the base of its history (${summary.titlesSeeded.length}):`,
    );
    for (const s of summary.titlesSeeded) console.log(`    ${s}`);
  }
  if (summary.titlesPresent.length) {
    console.log(`\n  Already had a title — left untouched (${summary.titlesPresent.length}):`);
    for (const s of summary.titlesPresent) console.log(`    ${s}`);
  }
  if (summary.renamedSlugs.length) {
    console.log(`\n  Slug collisions resolved (${summary.renamedSlugs.length}):`);
    for (const r of summary.renamedSlugs) console.log(`    ${r}`);
  }
  if (summary.unresolvedDeleters.length) {
    console.log(
      `\n  Legacy Post.deletedByUserId did not resolve to an imported user — deletedAt kept,` +
        ` but these docs are NOT hidden from reads (${summary.unresolvedDeleters.length}):`,
    );
    for (const s of summary.unresolvedDeleters) console.log(`    ${s}`);
  }
  if (summary.docsWithoutContent.length) {
    console.log(`\n  Docs with no PostCollab row — imported with an empty body (${summary.docsWithoutContent.length}):`);
    for (const s of summary.docsWithoutContent) console.log(`    ${s}`);
  }
  console.log(dryRun ? "\nNothing was written. Re-run without --dry-run to apply.\n" : "\nDone.\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prismaIncludingDeleted.$disconnect());
