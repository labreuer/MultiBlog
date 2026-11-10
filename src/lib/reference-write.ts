import { Prisma } from "@/generated/prisma/client";
import type { Actor } from "@/lib/actor";
import { ApiError, forbidden, invalid, notFound } from "@/lib/api/errors";
import { scheduleCitationRefresh } from "@/lib/entity-chips/refresh";
import { canUserReadFile } from "@/lib/file-authz";
import { prisma, prismaIncludingDeleted as base } from "@/lib/prisma";
import { PDF_CONTENT_TYPE } from "@/lib/reference-files";
import { canWriteReferences } from "@/lib/role-checks";
import { keyBaseOf, parseCslItem, readCsl, type CslData } from "@/lib/references/csl";
import { identifiersOf, type Identifier } from "@/lib/references/identifiers";
import { parseReferences } from "@/lib/references/import";
import { foldKey, isKeyShaped, isLibraryKey, lookupKey, referencePath } from "@/lib/references/keys";

// docs/CITATIONS.md, "Who writes them" — every write to the reference
// library, taking an `Actor`: the server actions and the MCP tools both wrap
// these, so one rule binds people and agents (docs/MCP.md §1).
//
// Its transactions run on the base client: `reference` is not in the
// soft-delete extension (schema.prisma says why), and the base client's
// transaction is the type these helpers share.
//
// What each write holds to:
//
//  - **AUTHOR and above**, by the actor's role.
//  - **The record is parsed, never passed through** (`parseCslItem`): a
//    caller sends whatever JSON it likes.
//  - **An identifier that fails its check is refused**, not stored, and one
//    another reference holds is refused as `duplicate`, naming that
//    reference, deleted ones included: importing a second copy of a book is
//    the mistake this exists to catch, and a deleted copy is offered back.
//  - **The identifiers are written with the record**, in one transaction.
//  - **A key is permanent once used.** A rename leaves the old key in
//    `reference_key_history`, and no other reference may take it, in any
//    case: `key_folded` is written beside every key, here and nowhere else.
//  - **A key someone asks for is taken as given or refused**, never altered
//    to fit, since it is the key a manuscript will hold. A key an import's
//    source gave is kept when it fits and is free, and otherwise a key is
//    made, the source's kept as an alias when it doesn't fit.
//  - **A reference's file is a PDF the actor may read**, live: the work's
//    PDF, which a citation's page is a page of.

export { referencePath };

export type ReferenceInput = {
  /** The CSL-JSON item, as sent. */
  csl: unknown;
  /** A key asked for (`create_ref`'s, the rename box): taken as given or refused. Made from its first creator and year when absent. */
  key?: string | null;
  /**
   * The key the record's source gave it, for an import: kept when it is a
   * library key nobody holds; kept as an alias when it isn't one, a key made
   * in its place; and left alone when another reference holds it.
   */
  sourceKey?: string | null;
  /** The abbreviation a `short`-style citation shows. */
  short?: string | null;
  /** The PDF of the work, by file id; null unties it. The actor must be able to read it. */
  fileId?: string | null;
};

function requireWriter(actor: Actor): void {
  if (!canWriteReferences(actor.role)) throw forbidden("Adding to the reference library needs an author's account.");
}

const KEY_SHAPE = "A key is letters, digits and _, with :, . or - between them, at most 80 characters: radner2012, Frank_1970.";

/** An asked key as given, or the refusal: never altered to fit. */
function askedKey(raw: string | null | undefined): string | null {
  const key = raw?.trim();
  if (!key) return null;
  if (!isLibraryKey(key)) throw invalid(`${KEY_SHAPE} "${key}" isn't one.`, { key });
  return key;
}

/** The record and its identifiers, or the refusal: a malformed record, or an identifier that fails its check. */
function checked(csl: unknown): { item: CslData; identifiers: Identifier[] } {
  const parsed = parseCslItem(csl);
  if (!parsed.ok) throw invalid(parsed.error);
  const { identifiers, invalid: failed } = identifiersOf(parsed.item);
  if (failed.length > 0) {
    throw invalid(
      `${failed.map((id) => `${id.scheme} "${id.raw}"`).join(" and ")} ${failed.length > 1 ? "fail their checks" : "fails its check"}. Correct or remove ${failed.length > 1 ? "them" : "it"}.`,
      { identifiers: failed },
    );
  }
  return { item: parsed.item, identifiers };
}

/** Refuses when another reference already holds one of `identifiers`. */
async function refuseDuplicate(tx: Prisma.TransactionClient, identifiers: Identifier[], exceptId?: string): Promise<void> {
  if (identifiers.length === 0) return;
  const held = await tx.referenceIdentifier.findFirst({
    where: { OR: identifiers.map((id) => ({ scheme: id.scheme, value: id.value })), ...(exceptId ? { referenceId: { not: exceptId } } : {}) },
    select: { scheme: true, value: true, reference: { select: { key: true, deletedAt: true } } },
  });
  if (!held) return;
  throw new ApiError(
    "duplicate",
    `The library already holds this work as ${held.reference.key}${held.reference.deletedAt ? ", deleted; restore that one" : "; cite that one"} (same ${held.scheme}).`,
    { key: held.reference.key, url: referencePath(held.reference.key), ...(held.reference.deletedAt ? { deleted: true } : {}) },
  );
}

/** Whether any reference has, or ever had, this key, in any case. */
async function keyTaken(tx: Prisma.TransactionClient, key: string, exceptId?: string): Promise<boolean> {
  const keyFolded = lookupKey(key);
  const [live, historic] = await Promise.all([
    tx.reference.findFirst({ where: { keyFolded, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } }),
    tx.referenceKeyHistory.findFirst({ where: { keyFolded, ...(exceptId ? { referenceId: { not: exceptId } } : {}) }, select: { id: true } }),
  ]);
  return live !== null || historic !== null;
}

/** `base`, or `base` with the first free letter after it: radner2012, radner2012b, radner2012c. */
async function freeKey(tx: Prisma.TransactionClient, base: string): Promise<string> {
  if (!(await keyTaken(tx, base))) return base;
  for (let n = 1; n < 26 * 27; n++) {
    const suffix = n < 26 ? String.fromCharCode(97 + n) : `${String.fromCharCode(96 + Math.floor(n / 26))}${String.fromCharCode(97 + (n % 26))}`;
    const candidate = `${base}${suffix}`;
    if (!(await keyTaken(tx, candidate))) return candidate;
  }
  throw new ApiError("conflict", `No key like ${base} is free; give one.`);
}

async function requireFile(actor: Actor, fileId: string): Promise<void> {
  const file = await prisma.storedFile.findUnique({ where: { id: fileId }, select: { id: true, visibility: true, contentType: true } });
  if (!file || !(await canUserReadFile(actor.userId, actor.role, file))) throw notFound("That file");
  if (file.contentType !== PDF_CONTENT_TYPE) throw invalid("That file isn't a PDF. A reference's file is the work's PDF.");
}

function shortOf(raw: string | null | undefined): string | null {
  const short = raw?.replace(/\s+/g, " ").trim();
  return short ? short.slice(0, 40) : null;
}

/** A unique-constraint failure on the identifier table: two writers of one work at once. */
function isIdentifierRace(err: unknown): boolean {
  return (err as { code?: unknown })?.code === "P2002";
}

/**
 * Why a reference's key isn't the key its source gave it: the source's key
 * isn't a library key and is kept as an alias (`alias`), isn't one and is too
 * long or holds white space to be kept even so (`unfit`), or another
 * reference holds it (`taken`).
 */
export type KeyNote = { reason: "alias" | "unfit" | "taken"; sourceKey: string };

/** Adds a work to the library. Answers its id, the key it was given, and why that isn't its source's key. */
export async function createReference(actor: Actor, input: ReferenceInput): Promise<{ id: string; key: string; keyNote?: KeyNote }> {
  requireWriter(actor);
  const { item, identifiers } = checked(input.csl);
  const asked = askedKey(input.key);
  const source = !asked && input.sourceKey?.trim() ? input.sourceKey.trim().normalize("NFC") : null;
  if (input.fileId) await requireFile(actor, input.fileId);

  try {
    return await base.$transaction(async (tx) => {
      await refuseDuplicate(tx, identifiers);
      if (asked && (await keyTaken(tx, asked))) {
        throw new ApiError("conflict", `The key ${asked} is taken, or was once another reference's.`, { key: asked });
      }
      const made = () => freeKey(tx, keyBaseOf(readCsl(item)));
      let key: string;
      let alias: string | null = null;
      let keyNote: KeyNote | undefined;
      if (asked) key = asked;
      else if (source && (await keyTaken(tx, source))) {
        key = await made();
        keyNote = { reason: "taken", sourceKey: source };
      } else if (source && !isLibraryKey(source)) {
        key = await made();
        if (isKeyShaped(source)) alias = source;
        keyNote = { reason: alias ? "alias" : "unfit", sourceKey: source };
      } else key = source ?? (await made());
      const created = await tx.reference.create({
        data: {
          key,
          keyFolded: foldKey(key),
          csl: item as Prisma.InputJsonValue,
          short: shortOf(input.short),
          fileId: input.fileId ?? null,
          createdById: actor.userId,
          updatedById: actor.userId,
          identifiers: { create: identifiers.map((id) => ({ scheme: id.scheme, value: id.value })) },
          ...(alias ? { keyHistory: { create: { key: alias, keyFolded: foldKey(alias) } } } : {}),
        },
        select: { id: true, key: true },
      });
      return keyNote ? { ...created, keyNote } : created;
    });
  } catch (err) {
    if (!isIdentifierRace(err)) throw err;
    // Lost a race with another writer of the same work, or of the same key: say which.
    await base.$transaction((tx) => refuseDuplicate(tx, identifiers));
    throw new ApiError("conflict", "That key was taken as this was saved; try again.");
  }
}

/**
 * Corrects a reference: its record, its abbreviation, its file, or its key.
 * Each field is changed only when given. A new key leaves the old one
 * answering.
 */
export async function updateReference(actor: Actor, id: string, input: Partial<ReferenceInput>): Promise<{ id: string; key: string }> {
  requireWriter(actor);
  const current = await prisma.reference.findUnique({ where: { id }, select: { id: true, key: true, keyFolded: true, deletedAt: true } });
  if (!current) throw notFound("That reference");
  if (current.deletedAt) throw new ApiError("conflict", "That reference is deleted; restore it first.");

  const record = input.csl === undefined ? null : checked(input.csl);
  const asked = input.key === undefined || input.key === null ? null : askedKey(input.key);
  if (input.key !== undefined && input.key !== null && !asked) throw invalid(KEY_SHAPE);
  if (input.fileId) await requireFile(actor, input.fileId);

  try {
    const updated = await base.$transaction(async (tx) => {
      if (record) await refuseDuplicate(tx, record.identifiers, id);
      const rekeyed = asked !== null && asked !== current.key;
      // A change of case alone rewrites the key and leaves no old key behind: the old one still finds it.
      const recased = rekeyed && foldKey(asked) === current.keyFolded;
      if (rekeyed && !recased && (await keyTaken(tx, asked, id))) {
        throw new ApiError("conflict", `The key ${asked} is taken, or was once another reference's.`, { key: asked });
      }
      if (record) {
        await tx.referenceIdentifier.deleteMany({ where: { referenceId: id } });
        if (record.identifiers.length > 0) {
          await tx.referenceIdentifier.createMany({
            data: record.identifiers.map((identifier) => ({ referenceId: id, scheme: identifier.scheme, value: identifier.value })),
          });
        }
      }
      if (rekeyed && !recased) {
        // The old key keeps answering; coming back to a key this reference once had, in any case, frees it from the history.
        await tx.referenceKeyHistory.deleteMany({ where: { referenceId: id, keyFolded: foldKey(asked) } });
        await tx.referenceKeyHistory.create({ data: { referenceId: id, key: current.key, keyFolded: current.keyFolded } });
      }
      return tx.reference.update({
        where: { id },
        data: {
          ...(record ? { csl: record.item as Prisma.InputJsonValue } : {}),
          ...(rekeyed ? { key: asked, keyFolded: foldKey(asked) } : {}),
          ...(input.short !== undefined ? { short: shortOf(input.short) } : {}),
          ...(input.fileId !== undefined ? { fileId: input.fileId } : {}),
          updatedById: actor.userId,
        },
        select: { id: true, key: true },
      });
    });
    // A citation's label is computed from the record and the abbreviation
    // (docs/CITATIONS.md, "Refresh"): once committed, the docs and notes
    // citing this work are relabelled.
    scheduleCitationRefresh([id]);
    return updated;
  } catch (err) {
    if (!isIdentifierRace(err)) throw err;
    if (record) await base.$transaction((tx) => refuseDuplicate(tx, record.identifiers, id));
    throw new ApiError("conflict", "That key was taken as this was saved; try again.");
  }
}

/**
 * Unties a reference from `fileId`, if it is still tied to that file: what
 * the PDF's page asks, which may be showing a tie someone has since moved
 * to another PDF. Answers whether it untied anything.
 */
export async function untieReferenceFromFile(actor: Actor, id: string, fileId: string): Promise<boolean> {
  requireWriter(actor);
  const current = await prisma.reference.findUnique({ where: { id }, select: { fileId: true } });
  if (!current || current.fileId !== fileId) return false;
  await updateReference(actor, id, { fileId: null });
  return true;
}

/**
 * Deletes or restores a reference. A deleted one keeps its key and its
 * identifiers, as a deleted account keeps its handle: a citation of it shows
 * struck through, and a duplicate of it is still caught.
 */
export async function setReferenceDeleted(actor: Actor, id: string, deleted: boolean): Promise<void> {
  requireWriter(actor);
  const found = await prisma.reference.findUnique({ where: { id }, select: { id: true } });
  if (!found) throw notFound("That reference");
  await prisma.reference.update({
    where: { id },
    data: deleted ? { deletedAt: new Date(), deletedByUserId: actor.userId } : { deletedAt: null, deletedByUserId: null },
  });
}

export type ImportOutcome =
  | { status: "created"; key: string; title: string; keyNote?: KeyNote }
  | { status: "duplicate"; key: string; title: string; deleted: boolean }
  | { status: "refused"; title: string; error: string };

/**
 * Imports pasted BibTeX, RIS or CSL-JSON, one record or many. Each record
 * stands alone: one already in the library is reported with the key it has
 * there, one that can't be kept is reported with why, and the rest are
 * created. A key the source gave is used when it is free.
 */
export async function importReferences(actor: Actor, text: string): Promise<{ format: string | null; outcomes: ImportOutcome[]; errors: string[] }> {
  requireWriter(actor);
  const parsed = parseReferences(text);
  const outcomes: ImportOutcome[] = [];
  for (const reference of parsed.references) {
    const title = reference.item.title?.text ?? "";
    try {
      // The source's key if it fits and nobody has it; otherwise one is made, since a clash is not the importer's mistake.
      const created = await createReference(actor, { csl: reference.data, sourceKey: reference.key });
      outcomes.push({ status: "created", key: created.key, title, ...(created.keyNote ? { keyNote: created.keyNote } : {}) });
    } catch (err) {
      if (err instanceof ApiError && err.code === "duplicate") {
        outcomes.push({ status: "duplicate", key: String(err.details.key), title, deleted: err.details.deleted === true });
      } else if (err instanceof ApiError) {
        outcomes.push({ status: "refused", title, error: err.message });
      } else {
        throw err;
      }
    }
  }
  return { format: parsed.format, outcomes, errors: parsed.errors };
}

/** The reference a key names now, or once did, ignoring case: its id and current key. Deleted ones included. */
export async function resolveReferenceKey(key: string): Promise<{ id: string; key: string; deleted: boolean } | null> {
  if (!isKeyShaped(key)) return null;
  const keyFolded = lookupKey(key);
  const direct = await prisma.reference.findUnique({ where: { keyFolded }, select: { id: true, key: true, deletedAt: true } });
  if (direct) return { id: direct.id, key: direct.key, deleted: direct.deletedAt !== null };
  const historic = await prisma.referenceKeyHistory.findUnique({
    where: { keyFolded },
    select: { reference: { select: { id: true, key: true, deletedAt: true } } },
  });
  return historic ? { id: historic.reference.id, key: historic.reference.key, deleted: historic.reference.deletedAt !== null } : null;
}
