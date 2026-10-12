import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "./errors";

// docs/MCP.md §4 — a write that adds something is refused when it repeats
// within a day. An agent that times out and retries would otherwise make a
// second doc, a second link or a second append, and through MCP it has no
// header to resend and no reason to keep a random key.
//
// - **It covers only the writes that add something**: create_doc, both
//   upload routes, annotate, create_link, add_link_parts and edit_doc. Every
//   other write changes nothing more when repeated, so a repeat simply runs.
// - **The key is a hash of the operation and its canonical arguments**,
//   unique under the token, or of a caller's own `idempotencyKey`, which is
//   how a write is repeated on purpose — and a retry of *that* sends the same
//   key and is refused in its turn, where a `repeat: true` flag would run
//   twice.
// - **A repeat is refused, never replayed**: `already_done`, with the first
//   call's time and result, and nothing done.
// - **Inserting the row is the claim.** RUNNING before anything happens; the
//   unique (token_id, key) refuses a second. A repeat that collides reads the
//   row: DONE answers `already_done`; RUNNING waits for it, and takes over one
//   older than the longest a write can take; FAILED runs again, since every
//   refusal comes before anything is written.
// - **A key is good for a day.** A claim colliding with an older row nulls
//   that row's key and claims again; Postgres lets any number of rows share a
//   null in a unique index, so the row itself stays.

const DAY_MS = 24 * 60 * 60 * 1000;
/** The longest a covered write can take; a RUNNING row older than this died with its process. */
const RUNNING_LIMIT_MS = 5 * 60 * 1000;
/** How long a repeat waits for a RUNNING first call before answering `conflict`. */
const WAIT_MS = 30_000;

/** JSON with every object's keys sorted, so two calls with the same arguments hash alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function writeKey(operation: string, args: unknown, idempotencyKey?: string): string {
  const material = idempotencyKey !== undefined ? `${operation}\0key\0${idempotencyKey}` : `${operation}\0${canonicalJson(args)}`;
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

async function claim(tokenId: string, key: string, operation: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = await prisma.apiWrite.create({ data: { tokenId, key, operation }, select: { id: true } });
      return row.id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const existing = await prisma.apiWrite.findUnique({
        where: { tokenId_key: { tokenId, key } },
        select: { id: true, state: true, result: true, createdAt: true, finishedAt: true },
      });
      if (!existing) break;
      const age = Date.now() - existing.createdAt.getTime();
      if (age >= DAY_MS) {
        await prisma.apiWrite.updateMany({ where: { id: existing.id, key }, data: { key: null } });
        break;
      }
      if (existing.state === "DONE") {
        throw new ApiError("already_done", "This write was made already, within the last day; nothing was done again. To repeat it on purpose, pass a new idempotencyKey.", {
          at: (existing.finishedAt ?? existing.createdAt).toISOString(),
          result: existing.result,
        });
      }
      if (existing.state === "FAILED" || age >= RUNNING_LIMIT_MS) {
        // A failed write did nothing, and a stale RUNNING one died with its
        // process: either way the claim is free to take over.
        const taken = await prisma.apiWrite.updateMany({
          where: { id: existing.id, state: existing.state },
          data: { state: "RUNNING", createdAt: new Date(), result: Prisma.DbNull, finishedAt: null },
        });
        if (taken.count === 1) return existing.id;
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ApiError("conflict", "The same write is still running from an earlier call; read its result before trying again.");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new ApiError("conflict", "Couldn't claim this write; try again.");
}

/**
 * Runs `write` once per token, operation and arguments within a day.
 * `result` must be what the write answers — ids, URLs and a version, never a
 * body — and it is kept whole for a repeat to be told.
 */
export async function onceWithin<T extends Record<string, unknown>>(
  tokenId: string,
  operation: string,
  args: unknown,
  idempotencyKey: string | undefined,
  write: () => Promise<T>,
): Promise<T> {
  const key = writeKey(operation, args, idempotencyKey);
  const id = await claim(tokenId, key, operation);
  try {
    const result = await write();
    await prisma.apiWrite.update({
      where: { id },
      data: { state: "DONE", result: result as Prisma.InputJsonValue, finishedAt: new Date() },
    });
    return result;
  } catch (err) {
    await prisma.apiWrite
      .update({ where: { id }, data: { state: "FAILED", finishedAt: new Date() } })
      .catch((failure) => console.error(`[api-write] couldn't mark ${id} failed:`, failure));
    throw err;
  }
}
