import { getFileAnnotationsAsThreads } from "@/lib/annotation-data";
import { annotationAnchorName } from "@/lib/annotation-anchor-name";
import { noteStandings, worklistFor, type NoteMoveShown, type NoteStanding, type WorklistItem } from "@/lib/file-note-move";
import { pdfPath } from "@/lib/file-version";
import { prisma } from "@/lib/prisma";
import { buildAnnotationEntries } from "@/components/annotation/annotation-entries";
import type { PdfAnnotationEntry } from "@/components/pdf/PdfAnnotationPanel";

// PLAN.md §19 Phase 3 — the annotations on one file, in the shape the PDF
// panel renders, for the version a page shows.
//
// Server-only: `buildAnnotationEntries` runs @tiptap/static-renderer, whose
// output is a React element that ships in the RSC payload. That is also why
// this is worth having as one function rather than two copies — the PDF page
// renders it for the first paint and `loadPdfAnnotationEntries` returns it
// after a post, and a panel fed two subtly different transforms would show
// cards that change shape the moment anyone annotates.
//
// **One query, narrowed here to the version shown** (docs/PDF.md §13,
// "Addresses"). What is *drawn* on a page is one version's: a thread's quads
// were measured on its version's sheets, and drawn on another's they would
// sit over other ink with nothing to say so. What is *listed* is the file's:
//
// - `entries` are the threads on the version shown, with every thread whose
//   root has no target, which is the file's and is listed on every version's
//   page;
// - `elsewhere` are the threads on the file's other versions, as entries that
//   name the version and link the note at its own address. Each carries its
//   card's fragment id and its replies', so a card's link written for one
//   address of the file finds its note from any other. A thread with nothing
//   left to show is in neither list.
//
// **Where each note stands among the versions is the viewer's own answer**
// (§13, "Moving a note forward"; `noteStandings`): a shown move is told to
// everyone, on the note's card and on its entry on the page of the version
// it left, and a hidden one and a "stays here" mark only to whoever may
// change them. `worklist` is that viewer's notes on earlier versions, on the
// latest's page alone. None of it is read for a file with one version.
//
// The thread → entry transform is identical for both containers; only the PDF
// target is extra, joined back on **by thread id** rather than by position so
// it cannot depend on buildAnnotationEntries' ordering.
//
// No permission check of its own — it takes a resolved file id, and each
// caller has already run the gate (`canUserReadFile`). Same arrangement, and
// the same reason, as tagsForTarget. `viewerId` narrows what is told, and
// opens nothing.

/** A thread on a version of the file other than the one shown. */
export type OtherVersionNote = {
  threadId: string;
  versionNumber: number;
  /** The note at its own version's address, with its card's fragment. */
  href: string;
  /** The fragment ids of its card and of each reply's, root first: what a card's link from another address lands on. */
  anchorNames: string[];
  quotedText: string;
  /** 0-based, or null for a target that names none. */
  pageIndex: number | null;
  displayName: string;
  createdAt: string;
  bodyText: string;
  replies: number;
  /** Whether the viewer may move it and mark it: its author, or the person its author works for. */
  mine: boolean;
  /** To such a viewer, whether it is marked "stays here". */
  stays: boolean;
  /** The move that took it off the version shown: a shown one, or a hidden one to whoever may show it. */
  left: NoteMoveShown | null;
};

export type PdfAnnotations = {
  entries: PdfAnnotationEntry[];
  elsewhere: OtherVersionNote[];
  /** The viewer's notes on earlier versions, on the latest's page; empty on every other. */
  worklist: WorklistItem[];
};

export async function pdfAnnotationEntriesFor(file: { id: string; slug: string }, fileVersionId: string, viewerId: string): Promise<PdfAnnotations> {
  const threads = await getFileAnnotationsAsThreads(file.id);
  const here = threads.filter((thread) => thread.fileVersionId === null || thread.fileVersionId === fileVersionId);
  const others = threads.filter((thread) => thread.fileVersionId !== null && thread.fileVersionId !== fileVersionId);

  const row = await prisma.storedFile.findUnique({
    where: { id: file.id },
    select: { currentVersionId: true, versions: { select: { id: true, number: true } } },
  });
  // A file with one version has no move, no mark and no worklist to read.
  const versioned = (row?.versions.length ?? 0) > 1;
  const authorOf = (thread: (typeof threads)[number]) => thread.comments.find((comment) => comment.id === thread.id)?.commenterUserId ?? null;
  const standings: Map<string, NoteStanding> = versioned
    ? await noteStandings(
        viewerId,
        threads.filter((thread) => thread.fileVersionId !== null).map((thread) => ({ id: thread.id, authorId: authorOf(thread) })),
      )
    : new Map();
  const worklist = versioned && row?.currentVersionId === fileVersionId ? await worklistFor(viewerId, { id: file.id, slug: file.slug, currentVersionId: row.currentVersionId }) : [];

  const targets = new Map(here.map((thread) => [thread.id, thread.pdfTarget]));
  const entries = (await buildAnnotationEntries(here)).map((entry) => ({
    threadId: entry.threadId,
    quotedText: entry.quotedText,
    color: entry.color,
    target: targets.get(entry.threadId) ?? null,
    root: entry.root,
    standing: standings.get(entry.threadId) ?? null,
  }));

  if (others.length === 0) return { entries, elsewhere: [], worklist };
  const numberOf = new Map((row?.versions ?? []).map((version) => [version.id, version.number]));
  const shownNumber = numberOf.get(fileVersionId);
  const elsewhere = others
    .flatMap((thread): OtherVersionNote[] => {
      const number = numberOf.get(thread.fileVersionId!);
      const root = thread.comments.find((comment) => comment.id === thread.id);
      if (number === undefined || !root) return [];
      const version = { number, isLatest: thread.fileVersionId === row?.currentVersionId };
      const rootAnchor = annotationAnchorName(root.displayName, root.createdAt);
      const replies = thread.comments.filter((comment) => comment.id !== thread.id);
      // The cards' own rule (`entryHasVisibleContent`): a deleted note with
      // no reply left to show is listed nowhere, and a deleted reply is not
      // counted.
      const liveReplies = replies.filter((reply) => reply.deletedByUserId === null);
      if (root.deletedByUserId !== null && liveReplies.length === 0) return [];
      return [
        {
          threadId: thread.id,
          versionNumber: number,
          href: `${pdfPath(file.slug, version)}#${rootAnchor}`,
          anchorNames: [rootAnchor, ...replies.map((reply) => annotationAnchorName(reply.displayName, reply.createdAt))],
          quotedText: thread.quotedText,
          pageIndex: thread.pdfTarget?.pageIndex ?? null,
          displayName: root.displayName,
          createdAt: root.createdAt,
          bodyText: root.deletedByUserId ? "" : root.bodyText,
          replies: liveReplies.length,
          mine: standings.get(thread.id)?.mine ?? false,
          stays: standings.get(thread.id)?.stays ?? false,
          // The newest move that left the version shown.
          left: standings.get(thread.id)?.moves.findLast((move) => move.fromNumber === shownNumber) ?? null,
        },
      ];
    })
    // Newest version first, and within one by sheet, as the cards are.
    .sort((a, b) => b.versionNumber - a.versionNumber || (a.pageIndex ?? Infinity) - (b.pageIndex ?? Infinity) || a.createdAt.localeCompare(b.createdAt));
  return { entries, elsewhere, worklist };
}
