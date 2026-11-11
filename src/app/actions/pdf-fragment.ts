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
// labels that were corrected, and a `page=` link through a sheet added or
// removed before it.
//
// It searches the stored page text (`FragmentChecker.sheetHolding`), so the
// viewer extracts no pages to ask; it draws only the one page answered.

/** One passage the viewer missed, and the 0-based sheets its link names, which it has already looked on. */
export type FragmentMiss = { passage: PassageText; named: number[] };

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
  if (!Array.isArray(named) || named.length > MAX_NAMED || !named.every((n) => Number.isInteger(n) && n >= 0)) return null;
  return { passage: { prefix: prefix as string | null, segments: read, suffix: suffix as string | null }, named: named as number[] };
}

/**
 * For each miss, the 1-based sheet holding its passage when exactly one sheet
 * outside those its link names holds it, once; null otherwise. Gated by
 * `canUserReadFile`, as the bytes are, and a file this viewer can't read
 * answers every miss with null, as one that holds none of them does, so the
 * question can't be asked of a PRIVATE file.
 */
export async function locateFragmentMisses(fileId: string, misses: unknown): Promise<(number | null)[]> {
  if (typeof fileId !== "string" || !Array.isArray(misses)) return [];
  const asked = misses.slice(0, MAX_FRAGMENT_PASSAGES).map(missOf);
  const none = asked.map(() => null);
  const session = await auth();
  if (!session?.user) return none;
  const file = await prisma.storedFile.findUnique({ where: { id: fileId }, select: { id: true, visibility: true } });
  if (!file || !(await canUserReadFile(session.user.id, session.user.role, file))) return none;

  const checker = new FragmentChecker();
  const found: (number | null)[] = [];
  for (const miss of asked) found.push(miss ? await checker.sheetHolding(file.id, miss.passage, miss.named) : null);
  return found;
}
