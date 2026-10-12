import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import type { JSONContent } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { uniqueDocSlug } from "@/lib/doc-slug";
import { slugify } from "@/lib/slug";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import {
  authorHighlightExtensions,
  contentExtensions,
  pmDocContentSchema,
  pmTitleSchema,
  titleAuthorHighlightExtensions,
  titleExtensions,
} from "@/lib/tiptap-schema";
import { markNew } from "@/lib/doc-edit";
import { docContentFromYdoc } from "@/lib/doc-content";
import { ydocStore, encodeYdocState } from "../../server/ydoc-store";

// Creating a doc's row, and creating a doc seeded with content. Plain server
// code, not "use server": every export of an action module is callable from
// any browser, and these take the creating user's id as an argument and check
// nothing. Their callers check first — /docs' actions (src/app/actions/docs.ts)
// on the session, scripts/import-claude-chats.ts on the importing account.

// Doc.id is @default(cuid()) — unknown until the row is inserted — so the
// cuid-as-slug (per PLAN.md §12n) needs a second write. The throwaway slug
// only has to satisfy the unique constraint for the instant between the two
// statements; nothing ever reads it.
async function insertDocRowSluggedById(userId: string, title: string) {
  return prisma.$transaction(async (tx) => {
    const created = await tx.doc.create({
      data: {
        slug: crypto.randomUUID(),
        title,
        createdByUserId: userId,
        updatedByUserId: userId,
        authors: { create: { userId, bylineOrder: 0 } },
      },
    });
    return tx.doc.update({ where: { id: created.id }, data: { slug: created.id } });
  });
}

function isSlugTaken(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  const target = (err as { meta?: { target?: unknown } })?.meta?.target;
  return code === "P2002" && (Array.isArray(target) ? target.includes("slug") : target === "slug");
}

// `title` is the Doc.title *column* only, and every caller passes what its
// doc's title fragment will say — "" for a blank doc, whose fragment is
// likewise empty. The fragment is canonical (PLAN.md §3d): a column seeded with
// anything the fragment doesn't also contain is overwritten by
// server/doc-cache.ts on the collab server's first flush.
//
// A doc with a title gets a slug made FROM it; a titleless one keeps the
// cuid-as-slug §12n describes. That split is what the title says, not who the
// caller is, but the two happen to line up: only the Markdown import knows a
// doc's name at creation time, because only it is handed one (docs/DOC_IMPORT.md
// §5). `+ New doc` is titleless by design and stays on the cuid.
//
// A title that slugifies to nothing — punctuation only, or a script with no
// ASCII in it at all — falls back to the cuid rather than to slugify's own
// "doc" placeholder, which uniqueDocSlug would then push to `doc`, `doc-2`,
// ... A meaningless-but-unique slug beats a misleadingly generic one.
export async function insertDocRow(userId: string, title: string) {
  if (!title || !slugify(title, "")) {
    return insertDocRowSluggedById(userId, title);
  }

  // uniqueDocSlug reads outside the insert, so two imports of same-named docs
  // landing together can compute the same candidate and race. The loser sees a
  // P2002 on Doc.slug and asks again — by which point the winner's row is
  // visible and it gets the `-2`. Bounded, then the cuid, so this always ends.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.doc.create({
        data: {
          slug: await uniqueDocSlug(title),
          title,
          createdByUserId: userId,
          updatedByUserId: userId,
          authors: { create: { userId, bylineOrder: 0 } },
        },
      });
    } catch (err) {
      if (!isSlugTaken(err)) {
        throw err;
      }
    }
  }
  return insertDocRowSluggedById(userId, title);
}

/**
 * A seed's text marked as `authorId`'s, by the rule an edit marks a block
 * that is all new with (`markNew`): everywhere the schema allows the mark, so
 * not in a code block, which takes no marks. One rule for both, because a
 * mark added here that the schema refuses is checked by nothing on the way
 * into the ydoc, and then refuses every edit to the doc, since an edit checks
 * the whole doc it writes.
 */
function markAuthor(json: JSONContent, schema: Schema, authorId: string): JSONContent {
  return markNew(schema.nodeFromJSON(json), { schema, authorId }).toJSON();
}

export type CreateDocOptions = {
  /** The byline, in order: user ids, the first its lead. The creator alone when absent. */
  byline?: string[];
  /**
   * Whose `authorHighlight` every character of the seed carries — the MCP
   * server passes its actor, so Claude's text shows in Claude's colour and a
   * person's later edits in theirs (docs/MCP.md §6). The import and the
   * importer pass nothing, and their text is unmarked as it always was.
   */
  author?: string | null;
  /** An imported chat: a record of what was said, which edit_doc refuses (docs/MCP.md §6). */
  record?: boolean;
  /** What the importer matches its source to this doc by: a chat's id, a summary's file name. */
  importKey?: string;
};

// The doc a Markdown import creates: `body` is the parse's (markdownToDocContent),
// `title` the parse's title or the caller's fallback for it, "" for none.
//
// Seeded first, then **written in one transaction**: the row with its whole
// byline, the `ydoc` row and its first update, and the `proseJson` cache. A
// failure part way through would otherwise leave a doc whose first open seeds
// an empty document — and a byline written afterwards could fail once the
// row had committed, leaving a PRIVATE doc only its creator can read. The
// ydoc is written straight to Postgres rather than through the collab server,
// which is safe only because the doc is new: nobody can have it open yet
// (docs/DOC_IMPORT.md §5).
//
// The seed's Yjs clients are registered in its `clients` map as the creator,
// as an annotation's seed is, so the replay view names who wrote the first
// text.
export async function createDocWithContent(userId: string, title: string, body: JSONContent, opts: CreateDocOptions = {}) {
  const author = opts.author ?? null;
  const seed = new Y.Doc();
  const clientIds: number[] = [];
  const seededBody = TiptapTransformer.toYdoc(
    author ? markAuthor(body, pmDocContentSchema, author) : body,
    "default",
    author ? authorHighlightExtensions : contentExtensions,
  );
  Y.applyUpdate(seed, Y.encodeStateAsUpdate(seededBody));
  clientIds.push(seededBody.clientID);
  seededBody.destroy();
  // Only when there's something to say: seeding a textless paragraph instead
  // would make "no title" structurally different from what createDoc leaves.
  if (title) {
    const titleDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: title }] }] };
    const seededTitle = TiptapTransformer.toYdoc(
      author ? markAuthor(titleDoc, pmTitleSchema, author) : titleDoc,
      "title",
      author ? titleAuthorHighlightExtensions : titleExtensions,
    );
    Y.applyUpdate(seed, Y.encodeStateAsUpdate(seededTitle));
    clientIds.push(seededTitle.clientID);
    seededTitle.destroy();
  }
  const clients = seed.getMap<string>("clients");
  for (const clientId of clientIds) clients.set(String(clientId), userId);
  const { ydoc, stateVector } = encodeYdocState(seed);
  const cached = docContentFromYdoc(seed);
  seed.destroy();

  const byline = [...new Set(opts.byline ?? [userId])];
  // A slug from the title when it has one (see insertDocRow), claimed in the
  // transaction; a lost race on it retries the whole create, and the third
  // try falls back to the cuid, so this always ends.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const slug = attempt < 2 && cached.title && slugify(cached.title, "") ? await uniqueDocSlug(cached.title) : null;
    try {
      return await prisma.$transaction(async (tx) => {
        const created = await tx.doc.create({
          data: {
            slug: slug ?? crypto.randomUUID(),
            title: cached.title,
            createdByUserId: userId,
            updatedByUserId: userId,
            proseJson: cached.proseJson as Prisma.InputJsonValue,
            record: opts.record === true,
            importKey: opts.importKey ?? null,
            authors: { create: byline.map((authorId, bylineOrder) => ({ userId: authorId, bylineOrder })) },
          },
          select: { id: true, slug: true },
        });
        const doc = slug
          ? created
          : await tx.doc.update({ where: { id: created.id }, data: { slug: created.id }, select: { id: true, slug: true } });
        await ydocStore.createInTransaction(tx as unknown as Prisma.TransactionClient, ydocIdForDoc(doc.id), ydoc, stateVector);
        return doc;
      });
    } catch (err) {
      if (!isSlugTaken(err) || slug === null) throw err;
    }
  }
  throw new Error("Couldn't claim a slug for the new doc.");
}
