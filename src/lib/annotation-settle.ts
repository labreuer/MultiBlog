import type { JSONContent } from "@tiptap/core";
import type { Role } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { flushAnnotationCache } from "@/lib/annotation-admin";
import { decodeAnnotationBody } from "@/lib/annotation-body";
import { materializeYdocAt } from "@/lib/ydoc-snapshot";
import { ydocIdForAnnotation } from "@/lib/ydoc-names";
import { ydocStore, encodeYdocState } from "../../server/ydoc-store";

// PLAN.md §22e — settling an annotation body: recording a version of it.
// Plain functions taking identity explicitly (docs/MCP.md §1), shared by the
// actions that post and finish editing an annotation
// (src/app/actions/annotations.ts) and by the MCP server's annotate, which
// creates a LIVE annotation in one call. Never exported from a "use server"
// file: every export of one is callable from any browser with any arguments.

/** The longest an annotation body may be, in characters of text; long-form writing belongs in a doc. */
export const MAX_BODY_LENGTH = 5000;

export type SettledBody = {
  /** The drained tail of the body's own update log — what the snapshot is taken at. */
  mark: bigint;
  /** The body materialised at `mark`, encoded as `ydoc_snapshot` stores it. */
  snapshot: { ydoc: Uint8Array; stateVector: Uint8Array };
  /** The same document, decoded exactly as the cache columns hold it. */
  proseJson: JSONContent;
  bodyText: string;
  /** Whether the text is the cached (last settled) text — the no-op check. */
  unchanged: boolean;
};

/**
 * PLAN.md §22e — a body's settled state, ready to record as a version.
 *
 * Asks the collab server for the drained tail of the body's own update log
 * (`flushAnnotationCache` with `writeCache: false`, falling back to the
 * database's own reading of the tail if the collab server cannot be reached),
 * materialises the body *at* that mark, and decodes it with the same function
 * the cache writer uses. Everything a version is — its bytes, its mark, and
 * the two cache columns — comes from that one decoded document, which is what
 * lets `writeSettledBody` below make the cache and the newest snapshot agree
 * by construction rather than by a later check.
 *
 * Validated **before** anything is written: an emptied or over-long body
 * returns an error and touches no column, so a reader keeps seeing the last
 * settled text and the session stays open for the author to fix it.
 *
 * The bounded retry is the same one posting has always had, for the same
 * reason: the collab server's Y.Doc only holds what has actually arrived over
 * the websocket, and a keystroke followed immediately by a click can outrun
 * that delivery. `expectChange` is what "outran" means for the caller — a post
 * retries while the body is empty, a Done also retries while it still reads
 * as the cached text, since opening the editor and closing it again is a
 * legitimate no-op there and a race here.
 *
 * `unchanged` is compared on `bodyText` rather than on `proseJson`: two
 * settled states with identical text but a different mark structure are the
 * same thing to a reader, and a version nobody could tell from its
 * predecessor would still cost the author their grace window (§22b).
 *
 * Deliberately returns *data* rather than writing: every caller needs the
 * write to be part of its own transaction (post sets the status alongside it,
 * Done clears `editingSince` alongside it), and a helper that wrote on its own
 * would make both of those two statements that can half-happen.
 */
export async function settleAnnotationBody(
  annotationId: string,
  actor: { id: string; role: Role },
  opts: { expectChange: boolean },
): Promise<SettledBody | { error: string }> {
  const annotation = await prisma.annotation.findUnique({
    where: { id: annotationId },
    select: { bodyText: true },
  });
  if (!annotation) {
    return { error: "Annotation not found." };
  }
  const ydocId = ydocIdForAnnotation(annotationId);

  let settled: SettledBody | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const mark =
      (await flushAnnotationCache({ userId: actor.id, role: actor.role, annotationId, writeCache: false })) ??
      (await ydocStore.maxUpdateId(ydocId));
    if (mark === null) {
      return { error: "This annotation's body has no history to record." };
    }
    let doc;
    try {
      doc = await materializeYdocAt(ydocId, mark);
    } catch (err) {
      console.error(`[annotations] couldn't materialize ${ydocId} at ${mark}:`, err);
      return { error: "Couldn't read the annotation's body right now — try again shortly." };
    }
    try {
      const { proseJson, bodyText } = decodeAnnotationBody(doc);
      settled = {
        mark,
        snapshot: encodeYdocState(doc),
        proseJson,
        bodyText,
        unchanged: bodyText === annotation.bodyText,
      };
    } catch (err) {
      console.error(`[annotations] ${ydocId} at ${mark} isn't TipTap-decodable:`, err);
      return { error: "Couldn't read the annotation's body." };
    } finally {
      doc.destroy();
    }
    const outran = !settled.bodyText.trim() || (opts.expectChange && settled.unchanged);
    if (!outran) break;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150));
  }

  if (!settled!.bodyText.trim()) {
    return { error: "Annotation can't be empty." };
  }
  if (settled!.bodyText.length > MAX_BODY_LENGTH) {
    return { error: `Annotation is too long (max ${MAX_BODY_LENGTH} characters).` };
  }
  return settled!;
}

/**
 * The settle transaction (PLAN.md §22e): one `ydoc_snapshot` on the body's
 * own ydoc at the settled mark, and the annotation's cache columns written
 * from the same decoded document, plus whatever the caller settles alongside
 * (status and `postedAt` for a post, `editingSince`/`editedAt` for a Done).
 *
 * One transaction, so a posted annotation with no version 1 — or a version
 * with a cache that disagrees with it — cannot exist even briefly. The
 * snapshot's `createdAt` is the caller's `at`, the same instant it stamps on
 * the row, so `postedAt` and version 1's timestamp are one moment and §22b's
 * window is measured between values that agree.
 *
 * `userId` is who settled it: the acting user, which is the ADMIN when an
 * ADMIN edited (§22f), and why callers pass the session's id rather than the
 * annotation's author.
 *
 * A snapshot already sitting at the mark is reused rather than duplicated —
 * nothing legitimate produces one (the debug button refuses annotation ydocs
 * and an unchanged body settles nothing), so this is a guard, not a path.
 */
export async function writeSettledBody(opts: {
  annotationId: string;
  settled: SettledBody;
  userId: string;
  at: Date;
  alongside: Prisma.AnnotationUpdateInput;
}): Promise<void> {
  const { annotationId, settled, userId, at, alongside } = opts;
  const ydocId = ydocIdForAnnotation(annotationId);
  await prisma.$transaction(async (tx) => {
    const existing = await tx.ydocSnapshot.findFirst({
      where: { ydocId, lastYdocUpdateId: settled.mark },
      select: { id: true },
    });
    if (!existing) {
      await tx.ydocSnapshot.create({
        data: {
          ydocId,
          ydoc: Buffer.from(settled.snapshot.ydoc),
          stateVector: Buffer.from(settled.snapshot.stateVector),
          lastYdocUpdateId: settled.mark,
          userId,
          createdAt: at,
        },
      });
    }
    await tx.annotation.update({
      where: { id: annotationId },
      data: {
        proseJson: settled.proseJson as Prisma.InputJsonValue,
        bodyText: settled.bodyText,
        proseJsonUpdateId: settled.mark,
        ...alongside,
      },
    });
  });
}

/**
 * PLAN.md §22e — the version of a parent body an anchored reply is measured
 * against: the mark of the parent's newest snapshot, which is the last
 * settled body and therefore exactly what the replier was reading (a reader
 * of a body sees settled text, never keystrokes). The log's tail is the
 * fallback for a parent with no snapshot at all — a row the backfill missed.
 *
 * Not `Annotation.proseJsonUpdateId`: that is the cache's own checkpoint and
 * can trail a Done (the flush writes content without an id, and the debounce
 * skips a body under edit), so a reply stamped from it could name a state its
 * quote does not reproduce.
 */
export async function parentSettledMark(parentId: string): Promise<bigint | null> {
  const ydocId = ydocIdForAnnotation(parentId);
  const newest = await prisma.ydocSnapshot.findFirst({
    where: { ydocId },
    orderBy: { lastYdocUpdateId: "desc" },
    select: { lastYdocUpdateId: true },
  });
  return newest?.lastYdocUpdateId ?? (await ydocStore.maxUpdateId(ydocId));
}
