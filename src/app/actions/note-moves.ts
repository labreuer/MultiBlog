"use server";

import { auth } from "@/lib/auth";
import { actorFromSessionUser, type Actor } from "@/lib/actor";
import { ApiError } from "@/lib/api/errors";
import { moveNote, openWorklist, setNoteMoveHidden, setNoteStays, type NoteMoveInput, type NoteRef, type OpenedWorklist } from "@/lib/file-note-move";

// docs/PDF.md §13, "Moving a note forward" — the selective move's actions:
// one note moved by its author, marked as staying, or its move shown or
// hidden, and the worklist's suggestions.
//
// Each is a wrapper: the gate and the rule are in src/lib/file-note-move.ts,
// which takes an `Actor` (CLAUDE.md, "A write the UI and the MCP server
// share"). This adds the session, and turns a refusal into an answer its
// caller shows, since each is made from a list where the next note is still
// to be decided.
//
// **None revalidates a path.** The PDF page is rendered per request, and its
// viewer is behind `ssr: false`, where a refresh alone is lost (CLAUDE.md):
// the surface loads its notes again itself (`loadPdfAnnotationEntries`).

/** What an action here answers: what was asked for, or why not, in words for whoever clicked. */
export type NoteAnswer<T> = { ok: true; value: T } | { ok: false; error: string };

async function noteAction<T>(run: (actor: Actor) => Promise<T>): Promise<NoteAnswer<T>> {
  const session = await auth();
  if (!session?.user) return { ok: false, error: "You are signed out. Sign in, then try again." };
  try {
    return { ok: true, value: await run(actorFromSessionUser(session.user)) };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    console.error("[note-moves] an action failed:", err);
    return { ok: false, error: "That didn't work. Reload the page and try again." };
  }
}

/** The viewer's notes on earlier versions of a file, with where each would go on the latest. It stores nothing. */
export async function openNoteWorklist(fileId: string): Promise<NoteAnswer<OpenedWorklist>> {
  return noteAction((actor) => openWorklist(actor, fileId));
}

/**
 * Moves one note to the target given on a later version. `moved: false` is a
 * note that had changed since the decision was made, with nothing written.
 */
export async function moveNoteForward(input: NoteMoveInput): Promise<NoteAnswer<{ moved: boolean; toNumber: number }>> {
  if (typeof input !== "object" || input === null) return { ok: false, error: "That isn't a move." };
  // Each field by name: a server action is sent whatever its caller likes.
  const { kind, id, fromVersionId, fingerprint, destinationVersionId, target } = input;
  return noteAction(async (actor) => {
    const { moved, toNumber } = await moveNote(actor, { kind, id, fromVersionId, fingerprint, destinationVersionId, target });
    return { moved, toNumber };
  });
}

/** Marks a note "stays here", or takes the mark off. */
export async function markNoteStays(ref: NoteRef, stays: boolean): Promise<NoteAnswer<{ stays: boolean; versionNumber: number }>> {
  if (typeof ref !== "object" || ref === null || typeof stays !== "boolean") return { ok: false, error: "That isn't a note." };
  const { kind, id } = ref;
  return noteAction(async (actor) => {
    const result = await setNoteStays(actor, { kind, id }, stays);
    return { stays: result.stays, versionNumber: result.versionNumber };
  });
}

/** Shows or hides one move of the viewer's own note. */
export async function setNoteMoveShown(moveId: string, shown: boolean): Promise<NoteAnswer<{ shown: boolean }>> {
  if (typeof moveId !== "string" || typeof shown !== "boolean") return { ok: false, error: "That isn't a move." };
  return noteAction(async (actor) => {
    await setNoteMoveHidden(actor, moveId, !shown);
    return { shown };
  });
}
