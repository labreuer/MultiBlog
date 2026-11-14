"use server";

import { auth } from "@/lib/auth";
import { canUserReadFile } from "@/lib/file-authz";
import { MAX_FRAGMENT_PASSAGES, type PassageSegment, type PassageText } from "@/lib/pdf-fragment";
import { FragmentChecker } from "@/lib/pdf-fragment-check";
import { prisma } from "@/lib/prisma";

// docs/PDF_FRAGMENT_LINKS.md §6 — where a passage is, when the viewer
// doesn't find it on the sheets its link names: the one sheet in the file
// that holds it once, by the rule the check uses for "the page the passage
// is on" (`foundOnPage`, §8). This is what carries a `p=` link through
// labels that were corrected, and a `sheet=` link through a sheet added or
// removed before it.
//
// It searches the stored page text (`FragmentChecker.sheetHolding`), so the
// viewer extracts no pages to ask; it draws only the one page answered.

/**
 * One passage the viewer missed, and the 0-based sheets of the version shown
 * that it has already looked on: the sheets its link names, or the ones the
 * page maps carried it to. `from` is set for a carried link: the version it
 * names, and the 0-based sheets it names there.
 */
export type FragmentMiss = { passage: PassageText; named: number[]; from?: { version: number; named: number[] } };

/**
 * Where a missed passage is: the 1-based sheet of the version shown that
 * holds it, when exactly one sheet beside those looked on does, once; and,
 * for a carried link, whether the version it names holds it where the link
 * says, which is what a passage corrected by a better copy or cut by a later
 * draft looks like (docs/PDF.md §13, "Links into the file").
 */
export type FragmentMissAnswer = { sheet: number | null; heldByNamed: boolean };

/** A passage part is a quote's words, never a book's. */
const MAX_PART_LENGTH = 2_000;
/** More sheets than any file has; a label is rarely on more than two. */
const MAX_NAMED = 10_000;
// A passage's segments, which a fragment's length bounds already; this bounds what a caller can send.
const MAX_SEGMENTS = 64;

function isPart(value: unknown, nullable: boolean): boolean {
  return (nullable && value === null) || (typeof value === "string" && value.length <= MAX_PART_LENGTH);
}

/** The miss as sent, rebuilt from its named fields, or null when it isn't one. */
function missOf(value: unknown): FragmentMiss | null {
  if (!value || typeof value !== "object") return null;
  const { passage, named } = value as { passage?: unknown; named?: unknown };
  if (!passage || typeof passage !== "object") return null;
  const { prefix, segments, suffix } = passage as Record<string, unknown>;
  if (!isPart(prefix, true) || !isPart(suffix, true)) return null;
  if (!Array.isArray(segments) || segments.length === 0 || segments.length > MAX_SEGMENTS) return null;
  const read: PassageSegment[] = [];
  for (const segment of segments) {
    const { start, end } = (segment ?? {}) as Record<string, unknown>;
    if (!isPart(start, false) || !isPart(end, true)) return null;
    read.push({ start: start as string, end: end as string | null });
  }
  const sheets = (list: unknown): list is number[] => Array.isArray(list) && list.length <= MAX_NAMED && list.every((n) => Number.isInteger(n) && n >= 0);
  if (!sheets(named)) return null;
  const { from } = value as { from?: unknown };
  let carriedFrom: FragmentMiss["from"];
  if (from !== undefined && from !== null) {
    const { version, named: there } = from as { version?: unknown; named?: unknown };
    if (!Number.isInteger(version) || (version as number) < 1 || !sheets(there)) return null;
    carriedFrom = { version: version as number, named: there };
  }
  return { passage: { prefix: prefix as string | null, segments: read, suffix: suffix as string | null }, named, ...(carriedFrom ? { from: carriedFrom } : {}) };
}

/**
 * For each miss, where its passage is (`FragmentMissAnswer`). Gated by
 * `canUserReadFile`, as the bytes are, and a file this viewer can't read
 * answers every miss with nothing found, as one that holds none of them
 * does, so the question can't be asked of a PRIVATE file.
 */
export async function locateFragmentMisses(fileId: string, fileVersionId: string, misses: unknown): Promise<FragmentMissAnswer[]> {
  if (typeof fileId !== "string" || typeof fileVersionId !== "string" || !Array.isArray(misses)) return [];
  const asked = misses.slice(0, MAX_FRAGMENT_PASSAGES).map(missOf);
  const none = asked.map((): FragmentMissAnswer => ({ sheet: null, heldByNamed: false }));
  const session = await auth();
  if (!session?.user) return none;
  const file = await prisma.storedFile.findUnique({ where: { id: fileId }, select: { id: true, visibility: true } });
  if (!file || !(await canUserReadFile(session.user.id, session.user.role, file))) return none;

  const checker = new FragmentChecker();
  const found: FragmentMissAnswer[] = [];
  for (const miss of asked) {
    if (!miss) {
      found.push({ sheet: null, heldByNamed: false });
      continue;
    }
    const sheet = await checker.sheetHolding(file.id, fileVersionId, miss.passage, miss.named);
    // Asked only of a miss nothing else answers: a passage found on another sheet is shown there.
    const heldByNamed = sheet === null && miss.from !== undefined && (await checker.heldOn(file.id, miss.from.version, miss.passage, miss.from.named));
    found.push({ sheet, heldByNamed });
  }
  return found;
}
