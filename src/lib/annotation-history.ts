import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/actor";
import { canUserAccessAnnotationYdoc } from "@/lib/annotation-authz";
import { isVersionQuoted, visibleVersions, withSupersededAt } from "@/lib/edit-grace";
import { decodeAnnotationSnapshot } from "@/lib/annotation-body";
import { displayNameOf } from "@/lib/display-name";
import { ydocIdForAnnotation } from "@/lib/ydoc-names";

// PLAN.md §22e — the history behind an annotation's "edited" marker: the
// body's snapshots, decoded, under §22b's silence rule. A plain module taking
// an explicit actor (docs/MCP.md §1), shared by `getAnnotationHistory`
// (src/app/actions/annotations.ts) and the MCP server's thread read.
//
// **The rule runs here, on the server, exactly as the UI runs it**: the
// existence of a silent edit is the thing withheld, so a caller never sees a
// version's timestamp to apply the window itself (CLAUDE.md).
//
// Read gate: whoever can read the container can read the history, the same
// question `canUserAccessAnnotationYdoc` asks for the body itself. Editing is
// narrower (author or ADMIN); seeing what changed is not, because the current
// text is already visible to every reader and hiding its predecessor would
// leave a visible "edited" marker with nothing behind it.

export type AnnotationVersion = {
  revisionNo: number;
  proseJson: unknown;
  bodyText: string;
  createdAt: string;
  authorName: string | null;
  current: boolean;
};

/** Newest first. Empty when the actor may not read the annotation, or there is none. */
export async function annotationHistoryFor(actor: Actor, annotationId: string): Promise<AnnotationVersion[]> {
  const annotation = await prisma.annotation.findUnique({
    where: { id: annotationId },
    select: {
      userId: true,
      status: true,
      postedAt: true,
      doc: { select: { id: true, visibility: true } },
      file: { select: { id: true, visibility: true } },
    },
  });
  if (!annotation) return [];
  if (!(await canUserAccessAnnotationYdoc(actor.userId, actor.role, annotation))) return [];

  // The versions are the body's snapshots in mark order (§22e), and the
  // replies that quote it are the anchored, undeleted ones — the same two
  // facts annotation-data.ts's loaders hold for a whole page. A version's
  // author is selected by name alone: no email, so none can be fallen back to.
  const [snapshots, replies] = await Promise.all([
    prisma.ydocSnapshot.findMany({
      where: { ydocId: ydocIdForAnnotation(annotationId) },
      orderBy: { lastYdocUpdateId: "asc" },
      include: { user: { select: { name: true } } },
    }),
    prisma.annotation.findMany({
      where: { parentAnnotationId: annotationId, anchorFrom: { not: null }, deletedByUserId: null },
      select: { ydocUpdateId: true },
    }),
  ]);
  const marks = snapshots.map((s) => s.lastYdocUpdateId);
  const stamps = replies.flatMap((r) => (r.ydocUpdateId === null ? [] : [r.ydocUpdateId]));

  const versions = withSupersededAt(
    snapshots.map((s, index) => ({ ...s, revisionNo: index + 1 })),
    (_row, index) => isVersionQuoted(marks, stamps, index),
  );
  // `postedAt` is the DRAFT -> LIVE transition — the moment readers could
  // first have seen anything. Null only for a row the backfill never reached,
  // for which every version is shown rather than silenced.
  const postedAt = annotation.postedAt ?? new Date(0);
  const visible = visibleVersions(versions, postedAt);
  const newestNo = versions[versions.length - 1]?.revisionNo;

  // Decoded from the snapshot bytes on demand — there is no text copy
  // anywhere (§22e). A version that will not decode is listed from nothing
  // rather than dropped, so the count a reader sees is still honest.
  return visible
    .map((version) => {
      let body: { proseJson: unknown; bodyText: string };
      try {
        body = decodeAnnotationSnapshot(new Uint8Array(version.ydoc));
      } catch (err) {
        console.error(`[annotations] version ${version.revisionNo} of ${annotationId} isn't TipTap-decodable:`, err);
        body = { proseJson: null, bodyText: "" };
      }
      return {
        revisionNo: version.revisionNo,
        proseJson: body.proseJson,
        bodyText: body.bodyText,
        createdAt: version.createdAt.toISOString(),
        authorName: version.user ? displayNameOf(version.user) : null,
        current: version.revisionNo === newestNo,
      };
    })
    .reverse();
}
