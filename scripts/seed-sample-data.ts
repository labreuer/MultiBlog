// Sample docs/posts/comments/annotations for a freshly rebuilt database.
// Ada and Grace are also seeded as listed landing-page contributors (PLAN.md
// §17e) — ORCID/website/blurb, plus an avatar fetched once and stored as
// bytes in user_avatar (§17n), so `/` has real-looking contributor cards out
// of the box rather than an empty sidebar. The avatar fetch is the only
// network call this script makes, and it's non-fatal.
//
// Usage:
//   npx tsx scripts/seed-sample-data.ts [--force]
//   npx tsx scripts/seed-sample-data.ts --reset [--force]
//
// Seeding always clears the previous sample content first (reset() below), so
// re-running is safe and idempotent rather than additive. --reset does only
// that clearing step and stops, leaving an empty database.
//
// **--force is the guard on both.** reset() empties the content tables
// wholesale, which is only defensible when the database holds nothing but a
// previous run of this script. So it refuses to touch anything unless the doc
// count is either 0 (a fresh database) or exactly SAMPLE_DOCS.length (this
// script's own output); any other number means content nobody here created,
// and --force is the deliberate override. The count is read *including*
// soft-deleted rows — a doc in the trash is still content this would destroy.
//
// User accounts are never cleared wholesale: only the three @sample.invalid
// addresses are removed, so an account someone actually signed up with
// (labreuer@gmail.com) survives both paths untouched.
//
// Deliberately NOT @example.com and not "E2E "-titled: those are the two
// things e2e/cleanup.teardown.ts sweeps, so seeding with them would mean the
// next `npm run e2e` silently deleted all of this. Fake addresses use the
// reserved .invalid TLD (RFC 2606) so they can never reach a real mailbox.
//
// Mechanics are copied from e2e/db-worker.ts rather than reinvented: a doc's
// ydoc row is created eagerly (§12b), a publish goes through
// ensureYdocSnapshotAt + postContentFromYdoc so Post.proseJson is a real
// snapshot (§15), and an annotation's mark is applied through the collab
// server exactly as postAnnotation does (§12i) — which is why the collab
// server has to be running for the anchored ones. A doc's *title* is seeded
// into its own Yjs fragment as well as the column: the fragment is canonical
// (§3d), and server/doc-cache.ts writes an empty title over the column on
// first flush if only the body was seeded.
import "dotenv/config";
import bcrypt from "bcryptjs";
import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import type { JSONContent } from "@tiptap/core";
import { prisma, prismaIncludingDeleted } from "../src/lib/prisma";
import { colorForSeed } from "../src/lib/author-colors";
import { uniqueUserSlug } from "../src/lib/user-slug";
import { uniqueDocSlug } from "../src/lib/doc-slug";
import { uniquePostSlug } from "../src/lib/post-slug";
import { contentExtensions, titleExtensions, pmDocContentSchema, pmBlurbSchema } from "../src/lib/tiptap-schema";
import { normalizeOrcid, normalizeWebsite } from "../src/lib/contributor-links";
import { storeAvatar } from "../src/lib/avatar";
import { findQuoteOccurrences } from "../src/lib/quote-occurrences";
import { postContentFromYdoc } from "../src/lib/post-content";
import { docContentFromYdoc } from "../src/lib/doc-content";
import { ensureYdocSnapshotAt } from "../src/lib/ydoc-snapshot";
import { seedAnnotationYdoc } from "../src/lib/annotation-ydoc-seed";
import { applyAnnotationMark } from "../src/lib/annotation-admin";
import { ydocIdForDoc, ydocIdForAnnotation } from "../src/lib/ydoc-names";
import { ydocStore, encodeYdocState } from "../server/ydoc-store";
import type { Role, DocVisibility, CommentStatus } from "../src/generated/prisma/enums";
import type { Prisma } from "../src/generated/prisma/client";

const PASSWORD = "testpass123";

function docFromText(text: string): JSONContent {
  return {
    type: "doc",
    content: text.split("\n\n").map((para) => ({
      type: "paragraph",
      ...(para ? { content: [{ type: "text", text: para }] } : {}),
    })),
  };
}

// A one-paragraph, plain-text TipTap doc validated against blurbExtensions'
// schema — the same "the schema is the validation" rule the real write path
// (actions/contributor.ts, actions/users.ts) enforces (PLAN.md §17f), so a
// typo here fails loudly instead of seeding a doc the app itself couldn't
// have produced.
function blurb(text: string): Prisma.InputJsonValue {
  return pmBlurbSchema.nodeFromJSON(docFromText(text)).toJSON() as Prisma.InputJsonValue;
}

async function upsertUser(opts: {
  email: string;
  name: string;
  role: Role;
  initials: string;
  // Landing-page contributor fields (PLAN.md §17e/§17f) — optional, and run
  // through the same validators (normalizeOrcid/normalizeWebsite, blurb()
  // above) the app's own write paths use, so an invalid value here is a
  // script bug caught at seed time rather than bad data silently stored.
  isListedContributor?: boolean;
  orcidUrl?: string;
  website?: string;
  // Fetched and stored as bytes in user_avatar (PLAN.md §17n), not saved as
  // a remote URL — the seeded database should exercise the same self-hosted
  // path a real upload takes. Non-fatal if the fetch fails (offline, or
  // Wikimedia rate-limiting a rebuild), same tolerance addAnnotation already
  // shows toward the collab server being down.
  avatarSourceUrl?: string;
  contributorBlurbText?: string;
}): Promise<{ id: string; email: string; name: string }> {
  const existing = await prisma.user.findUnique({ where: { email: opts.email } });
  if (existing) {
    console.log(`  user ${opts.email} already exists — left alone`);
    return { id: existing.id, email: existing.email, name: existing.name ?? existing.email };
  }

  const orcid = opts.orcidUrl ? normalizeOrcid(opts.orcidUrl) : null;
  if (opts.orcidUrl && !orcid) {
    throw new Error(`Invalid ORCID for ${opts.email}: ${opts.orcidUrl}`);
  }
  const website = opts.website ? normalizeWebsite(opts.website) : null;
  if (opts.website && !website) {
    throw new Error(`Invalid website for ${opts.email}: ${opts.website}`);
  }

  const user = await prisma.user.create({
    data: {
      email: opts.email,
      slug: await uniqueUserSlug(opts.name, opts.email),
      name: opts.name,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      role: opts.role,
      color: colorForSeed(opts.email),
      adminInitials: opts.initials,
      emailVerified: new Date(),
      isListedContributor: opts.isListedContributor ?? false,
      orcid,
      website,
      contributorBlurb: opts.contributorBlurbText ? blurb(opts.contributorBlurbText) : undefined,
    },
  });
  console.log(`  user ${user.email} (${opts.role})`);

  if (opts.avatarSourceUrl) {
    await seedAvatar(user.id, opts.avatarSourceUrl);
  }
  return { id: user.id, email: user.email, name: opts.name };
}

// Fetches one avatar and stores it through the same storeAvatar() the
// self-service upload uses — so the seeded rows are byte-for-byte what an
// upload would have produced (160px WebP, EXIF stripped), not a shortcut
// around the processing path.
async function seedAvatar(userId: string, sourceUrl: string): Promise<void> {
  try {
    const response = await fetch(sourceUrl, {
      // Wikimedia serves 403 to clients with no User-Agent.
      headers: { "User-Agent": "MultiBlog sample-data seeder (local development)" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const { hash, bytes } = await storeAvatar(userId, new Uint8Array(await response.arrayBuffer()));
    console.log(`    avatar stored (${bytes.byteLength} bytes, hash ${hash.slice(0, 8)}…)`);
  } catch (err) {
    console.log(`    ! avatar not stored (${err instanceof Error ? err.message : "unknown error"}) — initials will render instead`);
  }
}

async function createDoc(opts: {
  authorId: string;
  title: string;
  visibility: DocVisibility;
  bodyText: string;
}): Promise<{ id: string; slug: string; title: string; bodyText: string }> {
  const doc = await prisma.doc.create({
    data: {
      slug: await uniqueDocSlug(opts.title),
      title: opts.title,
      visibility: opts.visibility,
      authors: { create: { userId: opts.authorId, bylineOrder: 0 } },
    },
  });

  const seed = new Y.Doc();
  const seeded = TiptapTransformer.toYdoc(docFromText(opts.bodyText), "default", contentExtensions);
  Y.applyUpdate(seed, Y.encodeStateAsUpdate(seeded));
  seeded.destroy();
  // The title is a *separate* Yjs fragment (PLAN.md §3d), and it — not the
  // Doc.title column — is canonical: server/doc-cache.ts derives Doc.title
  // from this fragment whenever the collab server touches the document. Seed
  // only the body and the first flush writes an empty title straight over
  // whatever the column said.
  const seededTitle = TiptapTransformer.toYdoc(
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: opts.title }] }] },
    "title",
    titleExtensions,
  );
  Y.applyUpdate(seed, Y.encodeStateAsUpdate(seededTitle));
  seededTitle.destroy();
  const { ydoc, stateVector } = encodeYdocState(seed);

  // Write the title/prose_json cache the collab server would have written on
  // its first store debounce (server/doc-cache.ts), using that same derivation
  // so the two cannot disagree. Seeding only the ydoc leaves prose_json NULL,
  // and nothing recomputes it on read — so /docs reports the doc as 0
  // characters, and every non-editing surface sees an empty body, until
  // somebody happens to open it in an editor. Two of these four sample docs
  // used to be in exactly that state, and only escaped it by accident: the
  // ones that get an anchored annotation are touched through the collab
  // server by applyAnnotationMark, which triggers the flush as a side effect.
  // scripts/integrity/check-doc-integrity.ts is what surfaced it.
  const cached = docContentFromYdoc(seed);
  seed.destroy();
  await ydocStore.createIfAbsent(ydocIdForDoc(doc.id), ydoc, stateVector);
  // prose_json_length follows automatically — the doc_sync_prose_json_length
  // trigger fires on any UPDATE naming prose_json.
  await prisma.doc.update({
    where: { id: doc.id },
    data: { proseJson: cached.proseJson as Prisma.InputJsonValue, title: cached.title },
  });

  console.log(`  doc "${doc.title}" (${opts.visibility})`);
  return { id: doc.id, slug: doc.slug, title: doc.title, bodyText: opts.bodyText };
}

// Mirrors createTestPost's publish block: snapshot the doc's ydoc at its
// current head, derive the post's content from that snapshot, and record the
// publication event the post then points at.
async function createPost(opts: {
  docId: string;
  authorId: string;
  title: string;
  publish: "published" | "scheduled" | "draft";
  publishedAt?: Date;
}): Promise<{ id: string; slug: string; eventId: string | null }> {
  const post = await prisma.post.create({
    data: {
      slug: await uniquePostSlug(opts.title),
      title: opts.title,
      docId: opts.docId,
      authors: { create: { userId: opts.authorId, bylineOrder: 0, createdUserId: opts.authorId } },
    },
  });

  if (opts.publish === "draft") {
    console.log(`  post "${opts.title}" (draft)`);
    return { id: post.id, slug: post.slug, eventId: null };
  }

  const throughUpdateId = await ydocStore.maxUpdateId(ydocIdForDoc(opts.docId));
  if (throughUpdateId === null) throw new Error(`Doc ${opts.docId} has no update history to publish.`);
  const { snapshotId, doc: materialized } = await ensureYdocSnapshotAt({
    ydocId: ydocIdForDoc(opts.docId),
    throughUpdateId,
    userId: opts.authorId,
  });
  const { proseJson, title: docTitle } = postContentFromYdoc(materialized);
  materialized.destroy();
  const publishedTitle = opts.title || docTitle || "Untitled";

  const event = await prisma.postPublicationEvent.create({
    data: {
      postId: post.id,
      type: opts.publish === "scheduled" ? "SCHEDULED" : "PUBLISHED",
      docId: opts.docId,
      ydocSnapshotId: snapshotId,
      title: publishedTitle,
      proseJson: proseJson as Prisma.InputJsonValue,
      scheduledFor: opts.publish === "scheduled" ? opts.publishedAt : null,
      actorId: opts.authorId,
    },
  });
  await prisma.post.update({
    where: { id: post.id },
    data: {
      title: publishedTitle,
      proseJson: proseJson as Prisma.InputJsonValue,
      publishEventId: event.id,
      publishedAt: opts.publishedAt ?? new Date(),
    },
  });

  console.log(`  post "${publishedTitle}" (${opts.publish})`);
  return { id: post.id, slug: post.slug, eventId: event.id };
}

async function addComment(opts: {
  postId: string;
  anchoredEventId: string;
  email: string;
  displayName: string;
  body: string;
  status: CommentStatus;
  quote?: { from: number; to: number; text: string };
}): Promise<void> {
  const commenter = await prisma.commenter.upsert({
    where: { email: opts.email },
    update: {},
    create: { email: opts.email, displayName: opts.displayName },
  });

  const quoted = opts.quote;
  const thread = quoted
    ? await prisma.commentThread.create({
        data: {
          postId: opts.postId,
          anchoredEventId: opts.anchoredEventId,
          anchorFrom: quoted.from,
          anchorTo: quoted.to,
          quotedText: quoted.text,
        },
      })
    : ((await prisma.commentThread.findFirst({ where: { postId: opts.postId, quotedText: "" } })) ??
      (await prisma.commentThread.create({
        data: { postId: opts.postId, anchoredEventId: opts.anchoredEventId, anchorFrom: 0, anchorTo: 0, quotedText: "" },
      })));

  await prisma.comment.create({
    data: {
      threadId: thread.id,
      commenterId: commenter.id,
      body: { text: opts.body },
      status: opts.status,
      statusChangedAt: opts.status === "PENDING" ? null : new Date(),
    },
  });
  if (opts.status === "APPROVED") {
    await prisma.commenter.update({ where: { id: commenter.id }, data: { approvedCount: { increment: 1 } } });
  }
}

// Row first, mark second (§12i): the annotation is valid whether or not the
// mark lands, so a collab server that isn't running degrades this to a
// document-level annotation rather than failing the seed.
async function addAnnotation(opts: {
  docId: string;
  docBodyText: string;
  userId: string;
  role: Role;
  bodyText: string;
  quote?: string;
  parentAnnotationId?: string;
  raised?: boolean;
}): Promise<string> {
  const { proseJson, ydoc, stateVector } = seedAnnotationYdoc(opts.bodyText);

  const annotation = await prisma.annotation.create({
    data: {
      docId: opts.docId,
      userId: opts.userId,
      parentAnnotationId: opts.parentAnnotationId ?? null,
      bodyText: opts.bodyText,
      proseJson: proseJson as Prisma.InputJsonValue,
      status: opts.raised ? "RAISED" : "LIVE",
      raisedAt: opts.raised ? new Date() : null,
    },
  });
  await ydocStore.createIfAbsent(ydocIdForAnnotation(annotation.id), ydoc, stateVector);

  if (opts.quote) {
    const node = pmDocContentSchema.nodeFromJSON(docFromText(opts.docBodyText));
    const [occurrence] = findQuoteOccurrences(node, opts.quote);
    if (!occurrence) {
      console.log(`    ! quote not found, left document-level: "${opts.quote.slice(0, 40)}"`);
    } else {
      const { applied } = await applyAnnotationMark({
        docId: opts.docId,
        userId: opts.userId,
        role: opts.role,
        annotationId: annotation.id,
        from: occurrence.from,
        to: occurrence.to,
        quotedText: opts.quote,
      });
      if (!applied) {
        console.log("    ! mark not applied (is the collab server running?) — annotation is document-level");
      }
    }
  }

  console.log(`  annotation by ${opts.userId.slice(0, 8)}… ${opts.parentAnnotationId ? "(reply)" : ""}`);
  return annotation.id;
}

const ADA_DOC_BODY = `The Analytical Engine has no pretensions whatever to originate anything. It can do whatever we know how to order it to perform. Its province is to assist us in making available what we are already acquainted with.

Many persons imagine that because the Engine gives its results in numerical notation, its processes must be arithmetical rather than algebraical. This is an error. The Engine can arrange and combine its numerical quantities exactly as if they were letters or any other general symbols.

Supposing, for instance, that the fundamental relations of pitched sounds were susceptible of such expression, the Engine might compose elaborate and scientific pieces of music of any degree of complexity or extent.`;

const GRACE_DOC_BODY = `The most damaging phrase in the language is "we have always done it this way". A compiler exists because nobody should have to write in octal to be understood by a machine.

Programs should be written in the language of the problem, not the language of the hardware. If a statement reads like the sentence a manager would say out loud, the program is more likely to survive its author.

Testing is not an act of suspicion. It is the only way anyone finds out what was actually built rather than what was intended.`;

const ALAN_DOC_BODY = `We may compare a man in the process of computing a real number to a machine which is only capable of a finite number of conditions.

The behaviour of the computer at any moment is determined by the symbols which he is observing, and his state of mind at that moment. This assumption, that the number of states of mind is finite, is the one which makes the argument work at all.`;

const LUKE_DOC_BODY = `Every admin table now renders through one kit: filters, sort and pagination live in the querystring and are applied in Postgres, never client-side.

A column derived from a to-many relation cannot be a Prisma orderBy. Where that mattered, a database view keyed one-to-one on the row's id turns the problem into a to-one relation, which Prisma orders natively.`;

type SampleDocSpec = {
  key: string;
  authorKey: string;
  title: string;
  visibility: DocVisibility;
  bodyText: string;
};

// The docs this script creates, as data rather than four inline calls: its
// length is what the --force guard compares the database's doc count against,
// so adding or removing a doc here can't leave the guard checking a stale
// number.
const SAMPLE_DOCS: SampleDocSpec[] = [
  { key: "ada", authorKey: "ada", title: "Notes on the Analytical Engine", visibility: "SHARED", bodyText: ADA_DOC_BODY },
  { key: "grace", authorKey: "grace", title: "On Compilers and Plain Language", visibility: "SHARED", bodyText: GRACE_DOC_BODY },
  { key: "alan", authorKey: "alan", title: "Computable Numbers, Revisited", visibility: "PRIVATE", bodyText: ALAN_DOC_BODY },
  { key: "luke", authorKey: "luke", title: "Admin table conventions", visibility: "PRIVATE", bodyText: LUKE_DOC_BODY },
];

// Only these are deleted by reset(); an account someone actually signed up
// with is never in this list, so it survives both --reset and a reseed.
const SAMPLE_EMAILS = ["ada@sample.invalid", "grace@sample.invalid", "alan@sample.invalid"];

type Args = { force: boolean; resetOnly: boolean };

function parseArgs(argv: string[]): Args {
  const known = new Set(["--force", "--reset"]);
  const unknown = argv.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown argument(s): ${unknown.join(", ")}. Usage: npx tsx scripts/seed-sample-data.ts [--reset] [--force]`,
    );
  }
  return { force: argv.includes("--force"), resetOnly: argv.includes("--reset") };
}

// reset() empties the content tables wholesale, which is only defensible on a
// database holding nothing but this script's own output. Counting docs is the
// cheapest proxy for "is there anything else here": 0 means a fresh database,
// SAMPLE_DOCS.length means a previous run, and any other number means content
// nobody here created.
//
// Counted through prismaIncludingDeleted on purpose — the default client hides
// soft-deleted rows, and a doc in the trash is still content this would
// destroy, so hiding it from the guard is exactly the wrong direction.
async function assertSafeToTouch(force: boolean): Promise<void> {
  const docCount = await prismaIncludingDeleted.doc.count();
  if (docCount === 0 || docCount === SAMPLE_DOCS.length) return;
  if (force) {
    console.log(`--force: proceeding against ${docCount} existing doc(s).\n`);
    return;
  }
  throw new Error(
    `Refusing to run: found ${docCount} doc(s), which is neither 0 (a fresh database) nor ` +
      `${SAMPLE_DOCS.length} (this script's own output), so this database holds content the script ` +
      `didn't create. Clearing empties the content tables wholesale and would destroy it. ` +
      `Re-run with --force if that is genuinely what you want.`,
  );
}

// Clears everything this script creates so it can be re-run cleanly.

async function reset() {
  console.log("Clearing previous sample content…");
  await prisma.comment.deleteMany({});
  await prisma.commentThread.deleteMany({});
  // Deleting the post cascades its publication events (and clears the
  // publishEventId that points at one of them).
  await prisma.postSlugHistory.deleteMany({});
  await prisma.post.deleteMany({});
  // Annotation.doc cascades, but its ydoc rows have no FK back (§13a), so the
  // ydoc tables below are cleared explicitly rather than left orphaned.
  await prisma.annotation.deleteMany({});
  await prisma.docSlugHistory.deleteMany({});
  await prisma.doc.deleteMany({});
  await prisma.commenter.deleteMany({});
  await prisma.ydocSnapshot.deleteMany({});
  await prisma.ydocUpdate.deleteMany({});
  await prisma.ydoc.deleteMany({});
  await prisma.user.deleteMany({ where: { email: { in: SAMPLE_EMAILS } } });
  console.log("  cleared\n");
}

async function main() {
  const { force, resetOnly } = parseArgs(process.argv.slice(2));
  await assertSafeToTouch(force);

  if (resetOnly) {
    await reset();
    console.log("Done — sample data removed.");
    return;
  }

  console.log("Seeding sample data…\n");
  await reset();

  console.log("Users:");
  const luke = await upsertUser({ email: "labreuer@gmail.com", name: "Luke Breuer", role: "ADMIN", initials: "LB" });
  const ada = await upsertUser({
    email: "ada@sample.invalid",
    name: "Ada Lovelace",
    role: "EDITOR",
    initials: "AL",
    isListedContributor: true,
    website: "https://en.wikipedia.org/wiki/Ada_Lovelace",
    avatarSourceUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4c/Ada_Lovelace_daguerreotype_by_Antoine_Claudet_1843_-_cropped.png/330px-Ada_Lovelace_daguerreotype_by_Antoine_Claudet_1843_-_cropped.png",
    contributorBlurbText:
      "Mathematician and writer whose notes on Babbage's Analytical Engine include what is recognized as the first published algorithm intended for a machine.",
  });
  const grace = await upsertUser({
    email: "grace@sample.invalid",
    name: "Grace Hopper",
    role: "AUTHOR",
    initials: "GH",
    isListedContributor: true,
    orcidUrl: "https://orcid.org/0009-0007-6015-7076",
    avatarSourceUrl:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/9/98/Commodore_Grace_M._Hopper%2C_USN_%28covered%29_head_and_shoulders_crop.jpg/330px-Commodore_Grace_M._Hopper%2C_USN_%28covered%29_head_and_shoulders_crop.jpg",
    contributorBlurbText:
      "Pioneer of machine-independent programming languages and the first compiler; her work at the U.S. Navy led directly to COBOL.",
  });
  const alan = await upsertUser({ email: "alan@sample.invalid", name: "Alan Turing", role: "AUTHORIZED", initials: "AT" });
  const usersByKey: Record<string, { id: string }> = { luke, ada, grace, alan };

  console.log("\nDocs:");
  const docsByKey = new Map<string, Awaited<ReturnType<typeof createDoc>>>();
  for (const spec of SAMPLE_DOCS) {
    docsByKey.set(
      spec.key,
      await createDoc({
        authorId: usersByKey[spec.authorKey].id,
        title: spec.title,
        visibility: spec.visibility,
        bodyText: spec.bodyText,
      }),
    );
  }
  const adaDoc = docsByKey.get("ada")!;
  const graceDoc = docsByKey.get("grace")!;
  const alanDoc = docsByKey.get("alan")!;
  const lukeDoc = docsByKey.get("luke")!;

  console.log("\nPosts:");
  const day = 24 * 60 * 60 * 1000;
  const adaPost = await createPost({
    docId: adaDoc.id,
    authorId: ada.id,
    title: "Notes on the Analytical Engine",
    publish: "published",
    publishedAt: new Date(Date.now() - 9 * day),
  });
  const gracePost = await createPost({
    docId: graceDoc.id,
    authorId: grace.id,
    title: "On Compilers and Plain Language",
    publish: "published",
    publishedAt: new Date(Date.now() - 2 * day),
  });
  await createPost({
    docId: alanDoc.id,
    authorId: alan.id,
    title: "Computable Numbers, Revisited",
    publish: "scheduled",
    publishedAt: new Date(Date.now() + 5 * day),
  });
  await createPost({
    docId: lukeDoc.id,
    authorId: luke.id,
    title: "Admin table conventions",
    publish: "draft",
  });

  console.log("\nComments:");
  const adaQuote = "Its province is to assist us in making available what we are already acquainted with.";
  const adaNode = pmDocContentSchema.nodeFromJSON(docFromText(ADA_DOC_BODY));
  const [adaOccurrence] = findQuoteOccurrences(adaNode, adaQuote);

  await addComment({
    postId: adaPost.id,
    anchoredEventId: adaPost.eventId!,
    email: "charles@sample.invalid",
    displayName: "Charles Babbage",
    body: "This states the case more precisely than I managed in twenty years of trying.",
    status: "APPROVED",
  });
  await addComment({
    postId: adaPost.id,
    anchoredEventId: adaPost.eventId!,
    email: "reader@sample.invalid",
    displayName: "A Curious Reader",
    body: "Is there a worked example of the music case anywhere?",
    status: "PENDING",
  });
  await addComment({
    postId: adaPost.id,
    anchoredEventId: adaPost.eventId!,
    email: "spammer@sample.invalid",
    displayName: "Best Deals Now",
    body: "CHEAP ENGINES CLICK HERE",
    status: "SPAM",
  });
  if (adaOccurrence) {
    await addComment({
      postId: adaPost.id,
      anchoredEventId: adaPost.eventId!,
      email: "menabrea@sample.invalid",
      displayName: "Luigi Menabrea",
      body: "Worth quoting on its own — this is the sentence people misread most often.",
      status: "APPROVED",
      quote: { from: adaOccurrence.from, to: adaOccurrence.to, text: adaQuote },
    });
    console.log("  (one quote-anchored thread)");
  }
  await addComment({
    postId: gracePost.id,
    anchoredEventId: gracePost.eventId!,
    email: "reader@sample.invalid",
    displayName: "A Curious Reader",
    body: "The line about testing deserves to be on a poster.",
    status: "APPROVED",
  });
  await addComment({
    postId: gracePost.id,
    anchoredEventId: gracePost.eventId!,
    email: "skeptic@sample.invalid",
    displayName: "Unconvinced",
    body: "Plain language is fine until you need the hardware to go fast.",
    status: "PENDING",
  });
  console.log("  6 comments across APPROVED / PENDING / SPAM");

  console.log("\nAnnotations:");
  const rootId = await addAnnotation({
    docId: adaDoc.id,
    docBodyText: ADA_DOC_BODY,
    userId: grace.id,
    role: "AUTHOR",
    bodyText: "This is the passage I'd put in front of anyone who thinks the machine is doing the thinking.",
    quote: "It can do whatever we know how to order it to perform.",
  });
  await addAnnotation({
    docId: adaDoc.id,
    docBodyText: ADA_DOC_BODY,
    userId: alan.id,
    role: "AUTHORIZED",
    bodyText: "Agreed — though the interesting question is what we are able to order it to perform.",
    parentAnnotationId: rootId,
  });
  await addAnnotation({
    docId: graceDoc.id,
    docBodyText: GRACE_DOC_BODY,
    userId: ada.id,
    role: "EDITOR",
    bodyText: "Should this open with the compiler argument rather than the quotation?",
    quote: "Programs should be written in the language of the problem, not the language of the hardware.",
    raised: true,
  });
  // Deliberately unanchored, so /annotations has a row rendering the
  // document-level state (§12h/§12j) that nothing else would produce.
  await addAnnotation({
    docId: graceDoc.id,
    docBodyText: GRACE_DOC_BODY,
    userId: luke.id,
    role: "ADMIN",
    bodyText: "Filed against the doc as a whole: needs a closing paragraph.",
  });

  console.log("\nDone.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  // Closing the pool rather than calling process.exit(): the hard exit tore
  // down libuv handles mid-close and printed an "Assertion failed:
  // !(handle->flags & UV_HANDLE_CLOSING)" after every run. ydocStore shares
  // this same client (server/ydoc-store.ts imports it), so one disconnect
  // covers every connection the script opens.
  .finally(async () => {
    await prisma.$disconnect();
  });
