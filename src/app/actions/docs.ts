"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { auth } from "@/lib/auth";
import { prisma, prismaIncludingDeleted } from "@/lib/prisma";
import { changeDocSlug, revertDocSlug as revertDocSlugInDb, uniqueDocSlug } from "@/lib/doc-slug";
import { slugify } from "@/lib/slug";
import {
  canManageDocs,
  canUserEditDoc,
  recentReadableDocsFor,
  searchReadableDocsFor,
  type LinkableDocJson,
} from "@/lib/doc-authz";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import { contentExtensions, titleExtensions } from "@/lib/tiptap-schema";
import { docContentFromYdoc } from "@/lib/doc-content";
import { markdownToDocContent } from "@/lib/markdown-import";
import { ydocStore, encodeYdocState } from "../../../server/ydoc-store";
import { DocVisibility } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { settleBulk, type BulkResult } from "@/lib/bulk-result";

async function requireEditableDocSession(docId: string) {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const doc = await prisma.doc.findUnique({ where: { id: docId } });
  if (!doc) {
    throw new Error("Doc not found.");
  }

  if (!(await canUserEditDoc(session.user.id, session.user.role, docId))) {
    throw new Error("You don't have permission to edit this doc.");
  }

  return { session, doc };
}

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
// "doc" placeholder, which RESERVED_SLUGS would then push to `doc-doc`,
// `doc-2`, ... A meaningless-but-unique slug beats a misleadingly generic one.
async function insertDocRow(userId: string, title: string) {
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

// Docs skip the title-first form a post uses (PLAN.md §12n) — the title is a
// live collaborative field (CollabTitleField.tsx), so asking for one before
// the doc exists just duplicates what the editor already does better. A doc
// is created titleless and slugged by its own id; see doc-title.ts for how
// "Untitled" is supplied at render without ever being real content.
//
// No useActionState/CreateDocState here (that's gone with the /docs/new
// form) — createDoc takes no input, so the only failure mode is the
// canManageDocs check, which /docs already gates the button on (§12f). This
// throw is defense in depth, not a UI-facing error path.
export async function createDoc(): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!canManageDocs(session.user.role)) {
    throw new Error("You don't have permission to create docs.");
  }

  const doc = await insertDocRow(session.user.id, "");

  // Eager ydoc creation (PLAN.md §12b): the ydoc row is written in the same
  // request as the doc row, closing the window in which a connection could
  // arrive before either exists. Not wrapped in the transaction above — the
  // two tables share no foreign key by design (§12b) — but a failure here is
  // non-fatal: ydocOnLoadDocument's own createIfAbsent call
  // (server/ydoc-hooks.ts) is the same forgiving fallback /ydoc-debug's "New
  // document" button already relies on for a name nobody's created yet.
  const emptyDoc = new Y.Doc();
  const { ydoc, stateVector } = encodeYdocState(emptyDoc);
  emptyDoc.destroy();
  await ydocStore.createIfAbsent(ydocIdForDoc(doc.id), ydoc, stateVector);

  revalidatePath("/docs");
  redirect(`/doc/${doc.id}/edit`);
}

// ---------------------------------------------------------------------------
// MARKDOWN IMPORT — /docs' "Import Markdown" and "Paste Markdown", beside
// "+ New doc". Two entry points, one action, differing only in where the text
// came from and what to call a doc holding no heading to take a title from.
// Full account — the title rule, the seeding, the size cap, why the paste box
// is a textarea — in docs/DOC_IMPORT.md.

// MUST stay under Next's own server-action body limit (1 MB by default, not
// overridden in next.config.ts). That limit is enforced while the body is still
// being read, so a payload above it never reaches this function and fails with
// an unstyled 413 instead: a cap at or above 1 MB is a message that never
// prints. Raise it only alongside `serverActions.bodySizeLimit`, never past it
// — docs/DOC_IMPORT.md §6.
const MAX_MARKDOWN_BYTES = 768 * 1024;
const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd", ".txt"];

export type ImportMarkdownState = { error?: string };

// The filename, minus directories and extension, as the title for a file whose
// Markdown gave up no heading. Not "Untitled" — see docs/DOC_IMPORT.md §4.
function titleFromFilename(name: string): string {
  return name
    .replace(/^.*[\\/]/, "")
    .replace(/\.[^.]+$/, "")
    .trim();
}

// FormData wrapper for useActionState, in the shape createPostFromDocAction
// (actions/posts.ts) established. Deliberately no try/catch around the whole
// body: the redirect() at the end throws Next's own signal, which must reach
// useActionState untouched rather than being reported as a validation error.
// The one try/catch is around the parse alone, where a throw is the *file's*
// fault and belongs in the form rather than in an error boundary as a 500.
export async function importMarkdownDocAction(
  _prevState: ImportMarkdownState,
  formData: FormData,
): Promise<ImportMarkdownState> {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  // Unlike createDoc's equivalent throw, this one is reachable-ish and so is
  // reported rather than thrown: /docs gates the control on the same check
  // (§12f), but a role changed mid-session still carries the old one in the JWT
  // until sign-out (docs/BROWSER_PANE.md, session strategy), so the form can outlive the
  // permission that drew it.
  if (!canManageDocs(session.user.role)) {
    return { error: "You don't have permission to create docs." };
  }

  // Which of the two controls submitted. The file wins if both somehow arrive
  // (docs/DOC_IMPORT.md §8).
  const file = formData.get("file");
  const pasted = formData.get("markdown");

  let markdown: string;
  // The doc's name when the Markdown holds no heading to take one from.
  let fallbackTitle: string;
  // How to refer to the input in an error message.
  let describe: string;

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_MARKDOWN_BYTES) {
      return {
        error: `${file.name} is ${Math.round(file.size / 1024)} KB — the import limit is ${Math.round(MAX_MARKDOWN_BYTES / 1024)} KB.`,
      };
    }
    const lowered = file.name.toLowerCase();
    if (!MARKDOWN_EXTENSIONS.some((ext) => lowered.endsWith(ext))) {
      return { error: `${file.name} isn't a Markdown file (expected ${MARKDOWN_EXTENSIONS.join(", ")}).` };
    }
    // .text() decodes as UTF-8 regardless of what the file actually is; a
    // Latin-1 source arrives mojibaked rather than rejected. Worth knowing, not
    // worth guessing an encoding over — every editor writing .md today writes
    // UTF-8.
    markdown = await file.text();
    fallbackTitle = titleFromFilename(file.name);
    describe = file.name;
  } else if (typeof pasted === "string" && pasted.trim()) {
    // Byte length, not string length — the cap is about the request body, and
    // a character outside ASCII is two to four bytes of it.
    const bytes = Buffer.byteLength(pasted, "utf8");
    if (bytes > MAX_MARKDOWN_BYTES) {
      return {
        error: `That's ${Math.round(bytes / 1024)} KB of Markdown — the import limit is ${Math.round(MAX_MARKDOWN_BYTES / 1024)} KB.`,
      };
    }
    markdown = pasted;
    // No filename to fall back to, and nothing worth inventing a name from: an
    // empty title is what `+ New doc` leaves and doc-title.ts renders as
    // "Untitled".
    fallbackTitle = "";
    describe = "The pasted Markdown";
  } else {
    return { error: "Choose a Markdown file, or paste some Markdown." };
  }

  if (!markdown.trim()) {
    return { error: `${describe} is empty.` };
  }

  let parsed;
  try {
    parsed = markdownToDocContent(markdown);
  } catch (err) {
    return { error: `Couldn't read that Markdown: ${err instanceof Error ? err.message : String(err)}` };
  }

  const title = parsed.title ?? fallbackTitle;

  // Seeded, and the row inserted only afterwards, per docs/DOC_IMPORT.md §5 —
  // where the title fragment (not just the Doc.title column) and the ordering
  // both matter more than they look.
  const seed = new Y.Doc();
  const seededBody = TiptapTransformer.toYdoc(parsed.body, "default", contentExtensions);
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

  const doc = await insertDocRow(session.user.id, cached.title);
  await ydocStore.createIfAbsent(ydocIdForDoc(doc.id), ydoc, stateVector);
  await prisma.doc.update({
    where: { id: doc.id },
    data: {
      proseJson: cached.proseJson as Prisma.InputJsonValue,
      updatedByUserId: session.user.id,
    },
  });

  revalidatePath("/docs");
  // The slug, not the id: for an imported doc those differ, and the slug is the
  // doc's own name rather than a cuid. Either resolves — resolveDocParam tries
  // id first, then slug (PLAN.md §12f) — so this is about which URL the author
  // lands on and bookmarks, not about whether the route works.
  redirect(`/doc/${doc.slug}/edit`);
}

// Every write below that moves Doc.updatedAt also names who moved it
// (Doc.updatedByUserId). updatedAt is @updatedAt, so Prisma bumps it on any
// update to the row whether or not the column is named — leaving updatedBy
// out would let "Updated" advance while "Updated by" still credited an older
// edit, which reads worse on /docs than either value alone.
export async function updateDocVisibility(docId: string, visibility: DocVisibility): Promise<void> {
  const { session } = await requireEditableDocSession(docId);
  if (!Object.values(DocVisibility).includes(visibility)) {
    throw new Error("Invalid visibility.");
  }
  await prisma.doc.update({
    where: { id: docId },
    data: { visibility, updatedByUserId: session.user.id },
  });
  revalidatePath(`/doc/${docId}/edit`);
  revalidatePath(`/doc/${docId}`);
}

export async function updateDocSlug(docId: string, newSlug: string): Promise<{ slug: string }> {
  const { session, doc } = await requireEditableDocSession(docId);
  const oldSlug = doc.slug;
  const slug = await changeDocSlug(docId, newSlug, session.user.id);

  revalidatePath(`/doc/${docId}/edit`);
  revalidatePath(`/doc/${docId}/slug`);
  revalidatePath("/docs");
  revalidatePath(`/doc/${oldSlug}`);
  revalidatePath(`/doc/${slug}`);
  return { slug };
}

export async function deleteDocSlugHistory(docId: string, slug: string): Promise<void> {
  await requireEditableDocSession(docId);
  await prisma.docSlugHistory.deleteMany({ where: { docId, slug } });
  revalidatePath(`/doc/${docId}/slug`);
}

export async function revertDocSlug(docId: string): Promise<{ slug: string }> {
  const { session, doc } = await requireEditableDocSession(docId);
  const oldSlug = doc.slug;
  const slug = await revertDocSlugInDb(docId, session.user.id);

  revalidatePath(`/doc/${docId}/edit`);
  revalidatePath(`/doc/${docId}/slug`);
  revalidatePath("/docs");
  revalidatePath(`/doc/${oldSlug}`);
  revalidatePath(`/doc/${slug}`);
  return { slug };
}

// Adds/removes a single DocAuthor row — see updatePostAuthor
// (src/app/actions/posts.ts) for the identical rationale.
export async function updateDocAuthor(docId: string, userId: string, included: boolean): Promise<void> {
  await requireEditableDocSession(docId);

  if (included) {
    const existing = await prisma.docAuthor.findUnique({ where: { docId_userId: { docId, userId } } });
    if (existing) return;
    const maxOrder = await prisma.docAuthor.aggregate({ where: { docId }, _max: { bylineOrder: true } });
    await prisma.docAuthor.create({
      data: { docId, userId, bylineOrder: (maxOrder._max.bylineOrder ?? -1) + 1 },
    });
  } else {
    const count = await prisma.docAuthor.count({ where: { docId } });
    if (count <= 1) {
      throw new Error("A doc must have at least one author.");
    }
    await prisma.docAuthor.delete({ where: { docId_userId: { docId, userId } } }).catch(() => {});
  }

  revalidatePath(`/doc/${docId}/edit`);
  revalidatePath("/docs");
}

export async function updateDocAuthorOrder(docId: string, orderedUserIds: string[]): Promise<void> {
  await requireEditableDocSession(docId);

  const current = await prisma.docAuthor.findMany({ where: { docId }, select: { userId: true } });
  const currentIds = new Set(current.map((a) => a.userId));
  if (orderedUserIds.length !== currentIds.size || orderedUserIds.some((id) => !currentIds.has(id))) {
    throw new Error("Author list changed — please retry.");
  }

  await prisma.$transaction(
    orderedUserIds.map((userId, bylineOrder) =>
      prisma.docAuthor.update({ where: { docId_userId: { docId, userId } }, data: { bylineOrder } }),
    ),
  );

  revalidatePath(`/doc/${docId}/edit`);
  revalidatePath("/docs");
}

// Soft delete/restore double as each other's undo — see setPostDeleted
// (src/app/actions/posts.ts) for the identical rationale, including why this
// goes through prismaIncludingDeleted rather than requireEditableDocSession.
async function setDocDeleted(docId: string, deleted: boolean): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("Unauthorized.");
  }
  const doc = await prismaIncludingDeleted.doc.findUnique({ where: { id: docId } });
  if (!doc) {
    throw new Error("Doc not found.");
  }
  if (!(await canUserEditDoc(session.user.id, session.user.role, docId))) {
    throw new Error("You don't have permission to delete this doc.");
  }
  await prisma.doc.update({
    where: { id: docId },
    data: deleted
      ? { deletedByUserId: session.user.id, deletedAt: new Date(), updatedByUserId: session.user.id }
      : { deletedByUserId: null, deletedAt: null, updatedByUserId: session.user.id },
  });
  revalidatePath("/docs");
}

export async function deleteDoc(docId: string): Promise<void> {
  await setDocDeleted(docId, true);
}

export async function restoreDoc(docId: string): Promise<void> {
  await setDocDeleted(docId, false);
}

// Bulk delete/restore (PLAN.md §16g) — see bulkDeletePosts for why these are
// per-row rather than one transaction.
export async function bulkDeleteDocs(docIds: string[]): Promise<BulkResult> {
  return settleBulk(docIds, (id) => setDocDeleted(id, true));
}

export async function bulkRestoreDocs(docIds: string[]): Promise<BulkResult> {
  return settleBulk(docIds, (id) => setDocDeleted(id, false));
}

export async function bulkSetDocVisibility(docIds: string[], visibility: DocVisibility): Promise<BulkResult> {
  return settleBulk(docIds, (id) => updateDocVisibility(id, visibility));
}


// The editor toolbar's link-popover doc picker (LinkControls.tsx). With a
// query: title matches among the docs this viewer may read, prefix matches
// first. Without one: the most recently edited. Both capped at
// LINK_PICKER_LIMIT. Returns [] rather than redirecting when signed out:
// every surface carrying the toolbar is already gated, so an expired session
// mid-keystroke degrades to "no results" instead of yanking the page to
// /sign-in.
export async function searchLinkableDocs(query: string): Promise<LinkableDocJson[]> {
  const session = await auth();
  if (!session?.user) return [];
  const trimmed = query.trim().slice(0, 200);
  const rows = trimmed
    ? await searchReadableDocsFor(session.user.id, session.user.role, trimmed)
    : await recentReadableDocsFor(session.user.id, session.user.role);
  return rows.map(({ updatedAt, ...doc }) => ({ ...doc, updatedAt: updatedAt.toISOString() }));
}
