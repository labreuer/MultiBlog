import { Prisma } from "@/generated/prisma/client";
import type { Actor } from "@/lib/actor";
import { ApiError, forbidden, invalid, notFound } from "@/lib/api/errors";
import { scheduleCitationRefresh } from "@/lib/entity-chips/refresh";
import { canUserReadFile } from "@/lib/file-authz";
import { prisma, prismaIncludingDeleted as base } from "@/lib/prisma";
import { PDF_CONTENT_TYPE } from "@/lib/reference-files";
import { canWriteReferences } from "@/lib/role-checks";
import { keyBaseOf, parseCslItem, readCsl, titleOf, type CslData } from "@/lib/references/csl";
import { identifiersOf, withoutFailedIdentifiers, type Identifier, type IdentifierScheme } from "@/lib/references/identifiers";
import { BATCH_BYTES, BATCH_RECORDS, IMPORT_KEPT_MS } from "@/lib/references/batches";
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
async function firstFree(base: string, free: (key: string) => Promise<boolean>): Promise<string> {
  if (await free(base)) return base;
  for (let n = 1; n < 26 * 27; n++) {
    const suffix = n < 26 ? String.fromCharCode(97 + n) : `${String.fromCharCode(96 + Math.floor(n / 26))}${String.fromCharCode(97 + (n % 26))}`;
    const candidate = `${base}${suffix}`;
    if (await free(candidate)) return candidate;
  }
  throw new ApiError("conflict", `No key like ${base} is free; give one.`);
}

const freeKey = (tx: Prisma.TransactionClient, base: string) => firstFree(base, async (key) => !(await keyTaken(tx, key)));

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
  if (input.fileId) await requireFile(actor, input.fileId);
  try {
    return await base.$transaction((tx) => insertReference(tx, actor, item, identifiers, { ...input, key: asked }));
  } catch (err) {
    if (!isIdentifierRace(err)) throw err;
    // Lost a race with another writer of the same work, or of the same key: say which.
    await base.$transaction((tx) => refuseDuplicate(tx, identifiers));
    throw new ApiError("conflict", "That key was taken as this was saved; try again.");
  }
}

/** The insert itself, inside the caller's transaction: an import's runs after its record's row. */
async function insertReference(
  tx: Prisma.TransactionClient,
  actor: Actor,
  item: CslData,
  identifiers: Identifier[],
  input: Omit<ReferenceInput, "csl">,
): Promise<{ id: string; key: string; keyNote?: KeyNote }> {
  const asked = input.key ?? null;
  const source = !asked && input.sourceKey?.trim() ? input.sourceKey.trim().normalize("NFC") : null;
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
}

/**
 * Replaces a reference's record with another (docs/CITATIONS.md, "Replacing
 * a record"): its key, abbreviation, PDF and citations stay, and the
 * citations are relabelled. A field the new record lacks is removed. The
 * abbreviation is set from `short` only when the reference has none.
 *
 * A deleted reference is restored with it when `restore` says so, in this
 * one write, since a restore followed by an update could stop between the
 * two; otherwise it is refused, as `update_ref` refuses one: a person
 * deleted it.
 */
export async function replaceReference(
  actor: Actor,
  id: string,
  csl: unknown,
  options: { restore: boolean; short?: string | null },
): Promise<{ id: string; key: string; restored: boolean }> {
  requireWriter(actor);
  const { item, identifiers } = checked(csl);
  try {
    return await replaceRecord(actor, id, item, identifiers, options);
  } catch (err) {
    if (!isIdentifierRace(err)) throw err;
    await base.$transaction((tx) => refuseDuplicate(tx, identifiers, id));
    throw new ApiError("conflict", "Another write reached that work as this was saved; try again.");
  }
}

/**
 * The replacement, in one transaction, and the relabelling once it commits.
 * `around` runs inside the same transaction, first and last: an import's
 * claim on its record's row, and the row's outcome.
 */
async function replaceRecord(
  actor: Actor,
  id: string,
  item: CslData,
  identifiers: Identifier[],
  options: { restore: boolean; short?: string | null },
  around?: { first(tx: Prisma.TransactionClient): Promise<void>; last(tx: Prisma.TransactionClient, replaced: { key: string; restored: boolean }): Promise<void> },
): Promise<{ id: string; key: string; restored: boolean }> {
  const replaced = await base.$transaction(async (tx) => {
    await around?.first(tx);
    const current = await tx.reference.findUnique({ where: { id }, select: { id: true, key: true, short: true, deletedAt: true } });
    if (!current) throw notFound("That reference");
    if (current.deletedAt && !options.restore) throw new ApiError("conflict", "That reference is deleted; a person deleted it, and only a person restores it.", { key: current.key });
    await refuseDuplicate(tx, identifiers, id);
    await tx.referenceIdentifier.deleteMany({ where: { referenceId: id } });
    if (identifiers.length > 0) {
      await tx.referenceIdentifier.createMany({ data: identifiers.map((identifier) => ({ referenceId: id, scheme: identifier.scheme, value: identifier.value })) });
    }
    const restored = current.deletedAt !== null;
    await tx.reference.update({
      where: { id },
      data: {
        csl: item as Prisma.InputJsonValue,
        ...(current.short === null && shortOf(options.short) ? { short: shortOf(options.short) } : {}),
        ...(restored ? { deletedAt: null, deletedByUserId: null } : {}),
        updatedById: actor.userId,
      },
    });
    const done = { id, key: current.key, restored };
    await around?.last(tx, done);
    return done;
  });
  // Once committed, the docs and notes citing the work are relabelled (docs/CITATIONS.md, "Refresh").
  scheduleCitationRefresh([id]);
  return replaced;
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


/** One record of an import, as the browser parsed it: never trusted, built again here. */
export type ImportRecordInput = {
  /** Its place in the import. */
  place: number;
  /** The key its source gave it, as written. */
  sourceKey: string | null;
  /** biblatex's `shorthand`, the abbreviation of a reference that has none. */
  short: string | null;
  /** The CSL-JSON record. */
  csl: unknown;
  /** The reference whose record this replaces: a duplicate the preview offered to replace. */
  replace: string | null;
};

export type ImportOutcome =
  | { place: number; status: "created"; key: string; title: string; keyNote?: KeyNote }
  | { place: number; status: "replaced"; key: string; title: string; restored: boolean }
  | { place: number; status: "duplicate"; key: string; title: string; deleted: boolean }
  | { place: number; status: "refused"; title: string; error: string };

/** An import's id, as the browser makes one. */
const IMPORT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function importIdOf(raw: unknown): string {
  if (typeof raw !== "string" || !IMPORT_ID_RE.test(raw)) throw invalid("That isn't an import's id.");
  return raw;
}

/** A batch's records, or the refusal of a batch that isn't one: what a server action is sent is whatever its caller likes. */
export function importBatchOf(raw: unknown): ImportRecordInput[] {
  if (!Array.isArray(raw) || raw.length === 0) throw invalid("An import batch is a list of records.");
  if (raw.length > BATCH_RECORDS) throw invalid(`An import batch is at most ${BATCH_RECORDS} records.`);
  if (new TextEncoder().encode(JSON.stringify(raw)).length > BATCH_BYTES) throw invalid("That import batch is too large.");
  return raw.map((record): ImportRecordInput => {
    const entry = record && typeof record === "object" ? (record as Record<string, unknown>) : {};
    const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
    if (!Number.isSafeInteger(entry.place) || (entry.place as number) < 0) throw invalid("Each record of an import has its place in it.");
    return { place: entry.place as number, sourceKey: text(entry.sourceKey, 400), short: text(entry.short, 400), csl: entry.csl, replace: text(entry.replace, 64) };
  });
}

type ImportRow = { place: number; outcome: string; key: string | null; detail: unknown };

/** A row as the outcome it records. */
function outcomeOf(row: ImportRow): ImportOutcome {
  const detail = (row.detail && typeof row.detail === "object" ? row.detail : {}) as Record<string, unknown>;
  const title = typeof detail.title === "string" ? detail.title : "";
  switch (row.outcome) {
    case "created":
      return { place: row.place, status: "created", key: row.key ?? "", title, ...(detail.keyNote ? { keyNote: detail.keyNote as KeyNote } : {}) };
    case "replaced":
      return { place: row.place, status: "replaced", key: row.key ?? "", title, restored: detail.restored === true };
    case "duplicate":
      return { place: row.place, status: "duplicate", key: row.key ?? "", title, deleted: detail.deleted === true };
    default:
      return { place: row.place, status: "refused", title, error: typeof detail.error === "string" ? detail.error : "Not imported." };
  }
}

/** An outcome as its row's columns. */
function rowOf(outcome: ImportOutcome): { outcome: string; key: string | null; detail: Prisma.InputJsonValue } {
  const { place: _place, status, ...rest } = outcome;
  void _place;
  const { key, ...detail } = rest as { key?: string } & Record<string, unknown>;
  return { outcome: status, key: key ?? null, detail: detail as Prisma.InputJsonValue };
}

const isUniqueViolation = (err: unknown) => (err as { code?: unknown })?.code === "P2002";

/**
 * Imports one batch of records the browser parsed (docs/CITATIONS.md, "The
 * import box", "A record is imported once"). Each stands alone: it is built
 * again from its CSL-JSON, an identifier that fails its check dropped, as
 * the preview said; one already in the library is reported with the key it
 * has there, or replaces that reference's record where the preview offered
 * it; one that can't be kept is reported with why; and the rest are created,
 * each with its source's key where that fits and is free.
 *
 * A record sent before answers what its row says, so nothing is added twice.
 */
export async function importReferenceBatch(actor: Actor, importId: string, records: readonly ImportRecordInput[]): Promise<ImportOutcome[]> {
  requireWriter(actor);
  // A user's rows past their week, deleted as they next import, so nothing sweeps them.
  await prisma.referenceImportRecord.deleteMany({ where: { userId: actor.userId, createdAt: { lt: new Date(Date.now() - IMPORT_KEPT_MS) } } });
  const outcomes: ImportOutcome[] = [];
  for (const record of records) outcomes.push(await importOne(actor, importId, record));
  return outcomes;
}

/** The row for this record, if it has one. */
async function rowFor(actor: Actor, importId: string, place: number): Promise<ImportOutcome | null> {
  const row = await prisma.referenceImportRecord.findUnique({
    where: { userId_importId_place: { userId: actor.userId, importId, place } },
    select: { place: true, outcome: true, key: true, detail: true },
  });
  return row ? outcomeOf(row) : null;
}

/** An outcome with no reference to write it with, its row written alone; of two sends at once, the second reads the first's. */
async function recordAlone(actor: Actor, importId: string, outcome: ImportOutcome): Promise<ImportOutcome> {
  try {
    await prisma.referenceImportRecord.create({ data: { userId: actor.userId, importId, place: outcome.place, ...rowOf(outcome) } });
    return outcome;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return (await rowFor(actor, importId, outcome.place)) ?? outcome;
  }
}

async function importOne(actor: Actor, importId: string, record: ImportRecordInput): Promise<ImportOutcome> {
  const answered = await rowFor(actor, importId, record.place);
  if (answered) return answered;

  const parsed = parseCslItem(record.csl);
  if (!parsed.ok) return recordAlone(actor, importId, { place: record.place, status: "refused", title: "", error: parsed.error });
  const { data } = withoutFailedIdentifiers(parsed.item);
  const { identifiers } = identifiersOf(data);
  const title = titleOf(readCsl(data));
  const place = record.place;

  // The row first: of two sends of this record at once, the second waits here on the
  // first's, fails, and reads it, rather than failing later on the reference's key or
  // identifier and reporting the record as a duplicate of its own first send.
  const where = { userId_importId_place: { userId: actor.userId, importId, place } };
  const claim = async (tx: Prisma.TransactionClient) => {
    await tx.referenceImportRecord.create({ data: { userId: actor.userId, importId, place, outcome: "pending", detail: {} } });
  };
  const settle = (tx: Prisma.TransactionClient, done: ImportOutcome) => tx.referenceImportRecord.update({ where, data: rowOf(done) });
  try {
    if (record.replace) {
      const target = record.replace;
      let outcome: ImportOutcome | null = null;
      await replaceRecord(actor, target, data, identifiers, { restore: true, short: record.short }, {
        first: async (tx) => {
          await claim(tx);
          await refuseReplacingMore(tx, identifiers, target);
        },
        last: async (tx, replaced) => {
          outcome = { place, status: "replaced", key: replaced.key, title, restored: replaced.restored };
          await settle(tx, outcome);
        },
      });
      return outcome!;
    }
    return await base.$transaction(async (tx): Promise<ImportOutcome> => {
      await claim(tx);
      const created = await insertReference(tx, actor, data, identifiers, { sourceKey: record.sourceKey, short: record.short });
      const done: ImportOutcome = { place, status: "created", key: created.key, title, ...(created.keyNote ? { keyNote: created.keyNote } : {}) };
      await settle(tx, done);
      return done;
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === "duplicate") {
      return recordAlone(actor, importId, { place, status: "duplicate", key: String(err.details.key), title, deleted: err.details.deleted === true });
    }
    if (err instanceof ApiError && (err.code === "invalid" || err.code === "not_found")) {
      return recordAlone(actor, importId, { place, status: "refused", title, error: err.message });
    }
    if (err instanceof ApiError) {
      // A failure another try might not meet, such as a key taken while this was saved: no
      // row, so the record is tried again when it is sent again.
      return { place, status: "refused", title, error: err.message };
    }
    if (isUniqueViolation(err)) {
      // This record's row, written by another send of it; or a key or an identifier taken as
      // this was saved, which another try may not meet.
      const row = await rowFor(actor, importId, place);
      if (row) return row;
      return { place, status: "refused", title, error: "Another write reached that key or work as this was saved; import it again." };
    }
    throw err;
  }
}

/**
 * Refuses to replace `target` with a record that also matches another
 * reference, its DOI one's and its ISBN another's: it replaces neither, and
 * the preview named both. And refuses a target the record doesn't match,
 * which no preview offered.
 */
async function refuseReplacingMore(tx: Prisma.TransactionClient, identifiers: Identifier[], target: string): Promise<void> {
  const held = identifiers.length
    ? await tx.referenceIdentifier.findMany({ where: { OR: identifiers.map((id) => ({ scheme: id.scheme, value: id.value })) }, select: { referenceId: true, reference: { select: { key: true } } } })
    : [];
  const holders = new Map(held.map((row) => [row.referenceId, row.reference.key]));
  if (!holders.has(target)) throw invalid("That record isn't one the library holds, so it replaces nothing.");
  if (holders.size > 1) throw invalid(`That record matches ${[...holders.values()].join(" and ")}, by its DOI and its ISBN, so it replaces neither.`);
}

/** An import's report, read from its rows (docs/CITATIONS.md, "Every outcome has a row"): the browser keeps no copy of it. */
export async function importReport(actor: Actor, importId: string): Promise<ImportOutcome[]> {
  requireWriter(actor);
  const rows = await prisma.referenceImportRecord.findMany({
    where: { userId: actor.userId, importId },
    orderBy: { place: "asc" },
    select: { place: true, outcome: true, key: true, detail: true },
  });
  return rows.filter((row) => row.outcome !== "pending").map(outcomeOf);
}

/** What the preview asks of one record: the key its source gave it, the key one would be made from, and what identifies it. */
export type PreviewQuery = { sourceKey: string | null; keyBase: string; identifiers: Identifier[] };

/** The reference holding one of a record's identifiers. */
export type HeldReference = { id: string; key: string; title: string; deleted: boolean };

/** What only the server knows about a record (docs/CITATIONS.md, "The import box"): the key the import would give it now, and which references hold it. */
export type PreviewAnswer = { key: string; keyNote?: KeyNote; held: HeldReference[] };

/**
 * The preview's question, asked of the library as it is now. `reserved` is
 * the keys earlier records of the same import were given, so two records
 * from one source don't both get `radner2012`. A key here is the one an
 * import would give now; the report says the one it gave.
 */
export async function previewReferenceImport(actor: Actor, queries: readonly PreviewQuery[], reserved: readonly string[]): Promise<PreviewAnswer[]> {
  requireWriter(actor);
  const taken = new Set(reserved.map(lookupKey));
  const ids = queries.flatMap((query) => query.identifiers);
  const held = ids.length
    ? await prisma.referenceIdentifier.findMany({
        where: { OR: ids.map((id) => ({ scheme: id.scheme as IdentifierScheme, value: id.value })) },
        select: { scheme: true, value: true, reference: { select: { id: true, key: true, csl: true, deletedAt: true } } },
      })
    : [];
  const byIdentifier = new Map(held.map((row) => [`${row.scheme} ${row.value}`, row.reference]));
  return base.$transaction(async (tx) => {
    const free = async (key: string) => !taken.has(lookupKey(key)) && !(await keyTaken(tx, key));
    const answers: PreviewAnswer[] = [];
    for (const query of queries) {
      const holders = new Map<string, HeldReference>();
      for (const id of query.identifiers) {
        const reference = byIdentifier.get(`${id.scheme} ${id.value}`);
        if (reference) holders.set(reference.id, { id: reference.id, key: reference.key, title: titleFromStored(reference.csl), deleted: reference.deletedAt !== null });
      }
      const source = query.sourceKey?.trim().normalize("NFC") || null;
      let key: string;
      let keyNote: KeyNote | undefined;
      if (source && isLibraryKey(source) && (await free(source))) key = source;
      else {
        if (source) keyNote = { reason: !(await free(source)) ? "taken" : isKeyShaped(source) ? "alias" : "unfit", sourceKey: source };
        key = await firstFree(query.keyBase && isLibraryKey(query.keyBase) ? query.keyBase : "ref", free);
      }
      if (holders.size === 0) taken.add(lookupKey(key));
      answers.push({ key, ...(keyNote ? { keyNote } : {}), held: [...holders.values()] });
    }
    return answers;
  });
}

function titleFromStored(csl: unknown): string {
  const parsed = parseCslItem(csl, { decode: false });
  return parsed.ok ? titleOf(readCsl(parsed.item)) : "";
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
