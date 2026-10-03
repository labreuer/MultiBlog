import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import type { JSONContent } from "@tiptap/core";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { uniqueDocSlug } from "@/lib/doc-slug";
import { slugify } from "@/lib/slug";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import { contentExtensions, titleExtensions } from "@/lib/tiptap-schema";
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

// The doc a Markdown import creates: `body` is the parse's (markdownToDocContent),
// `title` the parse's title or the caller's fallback for it, "" for none.
//
// Seeded, and the row inserted only afterwards, per docs/DOC_IMPORT.md §5 —
// where the title fragment (not just the Doc.title column) and the ordering
// both matter more than they look. The ydoc row is written straight to
// Postgres rather than through the collab server, which is safe only because
// the doc is new: nobody can have it open yet.
export async function createDocWithContent(userId: string, title: string, body: JSONContent) {
  const seed = new Y.Doc();
  const seededBody = TiptapTransformer.toYdoc(body, "default", contentExtensions);
  Y.applyUpdate(seed, Y.encodeStateAsUpdate(seededBody));
  seededBody.destroy();
  // Only when there's something to say: seeding a textless paragraph instead
  // would make "no title" structurally different from what createDoc leaves.
  if (title) {
    const seededTitle = TiptapTransformer.toYdoc(
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: title }] }] },
      "title",
      titleExtensions,
    );
    Y.applyUpdate(seed, Y.encodeStateAsUpdate(seededTitle));
    seededTitle.destroy();
  }
  const { ydoc, stateVector } = encodeYdocState(seed);
  const cached = docContentFromYdoc(seed);
  seed.destroy();

  const doc = await insertDocRow(userId, cached.title);
  await ydocStore.createIfAbsent(ydocIdForDoc(doc.id), ydoc, stateVector);
  return prisma.doc.update({
    where: { id: doc.id },
    data: {
      proseJson: cached.proseJson as Prisma.InputJsonValue,
      updatedByUserId: userId,
    },
    select: { id: true, slug: true },
  });
}
