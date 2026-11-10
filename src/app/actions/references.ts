"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { actorFromSessionUser, type Actor } from "@/lib/actor";
import { ApiError } from "@/lib/api/errors";
import { settleBulk, type BulkResult } from "@/lib/bulk-result";
import type { CiteCandidate } from "@/lib/entity-chips/kinds/citation";
import { citeCandidatesOf } from "@/lib/entity-chips/kinds/citation-context";
import { canUserReadFile } from "@/lib/file-authz";
import { prisma } from "@/lib/prisma";
import { findReferences } from "@/lib/reference-data";
import { referenceCitedBy as citedByFor, type ReferenceCitedBy } from "@/lib/reference-cited-by";
import { findReadablePdfs, referencesOfFile, type FileReference, type PdfCandidate } from "@/lib/reference-files";
import {
  importReferences,
  referencePath,
  setReferenceDeleted,
  untieReferenceFromFile as untieFromFile,
  updateReference,
  type ImportOutcome,
} from "@/lib/reference-write";
import { entryText } from "@/lib/references/entry";

// docs/CITATIONS.md — the reference library's server actions. Each is a
// wrapper: the gate and every rule are in src/lib/reference-write.ts, which
// the MCP tools call too (docs/MCP.md §1). An action adds the session and
// the revalidation.

async function requireActor(): Promise<Actor> {
  const session = await auth();
  if (!session?.user) throw new Error("You must be signed in.");
  return actorFromSessionUser(session.user);
}

/** A refusal's own words, which are written for whoever asked; anything else is a fault and keeps its type. */
function said(err: unknown): never {
  if (err instanceof ApiError) throw new Error(err.message);
  throw err;
}

export type ImportReport = { format: string | null; outcomes: ImportOutcome[]; errors: string[] };

/** Imports pasted BibTeX, RIS or CSL-JSON. Each record is created, reported as already held, or refused with why. */
export async function importReferencesAction(text: string): Promise<ImportReport> {
  const actor = await requireActor();
  if (typeof text !== "string" || text.length > 2_000_000) throw new Error("That is too much to import at once.");
  const report = await importReferences(actor, text).catch(said);
  revalidatePath("/references");
  return report;
}

export async function deleteReference(id: string): Promise<void> {
  await setReferenceDeleted(await requireActor(), id, true).catch(said);
  revalidatePath("/references");
}

export async function restoreReference(id: string): Promise<void> {
  await setReferenceDeleted(await requireActor(), id, false).catch(said);
  revalidatePath("/references");
}

// Per-row rather than one transaction, as every other table's bulk action is.
export async function bulkDeleteReferences(ids: string[]): Promise<BulkResult> {
  const actor = await requireActor();
  return settleBulk(ids, (id) => setReferenceDeleted(actor, id, true));
}

export async function bulkRestoreReferences(ids: string[]): Promise<BulkResult> {
  const actor = await requireActor();
  return settleBulk(ids, (id) => setReferenceDeleted(actor, id, false));
}

/** Sets the abbreviation a short citation shows; empty clears it. */
export async function updateReferenceShort(id: string, short: string): Promise<void> {
  const updated = await updateReference(await requireActor(), id, { short: String(short) }).catch(said);
  revalidatePath("/references");
  revalidatePath(referencePath(updated.key));
}

/** Renames a reference's key. The old key keeps answering. */
export async function updateReferenceKey(id: string, key: string): Promise<{ key: string }> {
  const updated = await updateReference(await requireActor(), id, { key: String(key) }).catch(said);
  revalidatePath("/references");
  revalidatePath(referencePath(updated.key));
  return { key: updated.key };
}

// docs/CITATIONS.md, "A work's PDF" — tying a reference to its PDF, from
// either side.

/** Sets a reference's PDF, or with null unties it: the File column of /references. */
export async function setReferenceFile(id: string, fileId: string | null): Promise<void> {
  if (typeof id !== "string" || (fileId !== null && typeof fileId !== "string")) throw new Error("That isn't a reference and a file.");
  await updateReference(await requireActor(), id, { fileId }).catch(said);
  revalidatePath("/references");
}

/** The PDFs the File column's picker offers: ones the viewer may read, by title, slug or file name. */
export async function searchReferencePdfs(query: string): Promise<PdfCandidate[]> {
  const session = await auth();
  if (!session?.user || typeof query !== "string") return [];
  return findReadablePdfs(actorFromSessionUser(session.user), query.slice(0, 100), 8);
}

/** A file the viewer may read, by id, or a refusal: what the PDF page's actions are asked about. */
async function readableFile(actor: Actor, fileId: string): Promise<void> {
  const file = typeof fileId === "string" ? await prisma.storedFile.findUnique({ where: { id: fileId }, select: { id: true, visibility: true } }) : null;
  if (!file || !(await canUserReadFile(actor.userId, actor.role, file))) throw new Error("That file isn't one you can read.");
}

/** Ties a reference to this PDF, from the PDF's page; answers the references the PDF is now the PDF of. */
export async function tieReferenceToFile(fileId: string, referenceId: string): Promise<FileReference[]> {
  const actor = await requireActor();
  await readableFile(actor, fileId);
  if (typeof referenceId !== "string") throw new Error("That isn't a reference.");
  await updateReference(actor, referenceId, { fileId }).catch(said);
  revalidatePath("/references");
  return referencesOfFile(fileId);
}

/** Unties a reference from this PDF, if it is still tied to it; answers the references the PDF is now the PDF of. */
export async function untieReferenceFromFile(fileId: string, referenceId: string): Promise<FileReference[]> {
  const actor = await requireActor();
  await readableFile(actor, fileId);
  if (typeof referenceId !== "string") throw new Error("That isn't a reference.");
  if (await untieFromFile(actor, referenceId, fileId).catch(said)) revalidatePath("/references");
  return referencesOfFile(fileId);
}

/** A work the PDF page's picker offers, and whether tying it here would move it from another PDF. */
export type FileReferenceCandidate = FileReference & { elsewhere: boolean };

/** The references the PDF page's picker offers, found as the citation menu finds them. */
export async function searchReferencesForFile(fileId: string, query: string): Promise<FileReferenceCandidate[]> {
  const session = await auth();
  if (!session?.user || typeof query !== "string" || typeof fileId !== "string") return [];
  const found = await findReferences(query.slice(0, 100), 8);
  return found
    .filter((reference) => !reference.deleted && reference.fileId !== fileId)
    .map((reference) => ({ id: reference.id, key: reference.key, entry: entryText(reference.item), elsewhere: reference.fileId !== null }));
}

/**
 * The citation menu's search (docs/CITATIONS.md, "The menu"): works by key,
 * abbreviation, title or author. For anyone signed in, since a reference's
 * record is public; what a citation may be put *in* is the editor's own gate.
 */
export async function searchCitable(query: string): Promise<CiteCandidate[]> {
  const session = await auth();
  if (!session?.user || typeof query !== "string") return [];
  return citeCandidatesOf(await findReferences(query.slice(0, 100), 8));
}

/**
 * What a reference's public page shows only to whoever may see it
 * (docs/CITATIONS.md, "Pages"): the docs and notes citing the work and its
 * PDF, each through its read rule. Null for a reader who isn't signed in,
 * who sees what the page already shows.
 */
export async function referenceCitedBy(referenceId: string): Promise<ReferenceCitedBy | null> {
  const session = await auth();
  if (!session?.user || typeof referenceId !== "string") return null;
  return citedByFor(actorFromSessionUser(session.user), referenceId);
}
