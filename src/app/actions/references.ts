"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { actorFromSessionUser, type Actor } from "@/lib/actor";
import { ApiError } from "@/lib/api/errors";
import { settleBulk, type BulkResult } from "@/lib/bulk-result";
import { importReferences, referencePath, setReferenceDeleted, updateReference, type ImportOutcome } from "@/lib/reference-write";

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
