// The Playwright-side face of the DB helpers. Every function here is a thin
// typed wrapper around one JSON round-trip to e2e/db-worker.ts, which is where
// the actual Prisma calls (and the @example.com safety rail) live — see the
// header comment there for why the split exists at all.
//
// One `tsx` child per Playwright worker process, spawned lazily on first use
// and shared by every test that worker runs, so the ~1.5s startup is paid once
// rather than per call. Round trips after that are sub-millisecond.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { DbHandlers, TestUser, TestPost, ThreadState, RevisionSummary } from "./db-worker";

export type { TestUser, TestPost, ThreadState, RevisionSummary } from "./db-worker";
export { TEST_PASSWORD, ADMIN_EMAIL, uniqueEmail, uniqueTitle, docFromText } from "./naming";

// stdin/stdout are pipes; stderr is inherited, hence the `null` slot.
type DbWorkerProcess = ChildProcessByStdio<Writable, Readable, null>;

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void };

let child: DbWorkerProcess | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

function ensureChild(): DbWorkerProcess {
  if (child) return child;

  // `node --import tsx` rather than `npx tsx`: no shell, no .cmd shim, and no
  // dependence on npm's bin resolution — all three of which are where this
  // would otherwise go wrong on Windows.
  const workerPath = path.resolve(__dirname, "db-worker.ts");
  const spawned = spawn(process.execPath, ["--import", "tsx", workerPath], {
    cwd: path.resolve(__dirname, ".."),
    stdio: ["pipe", "pipe", "inherit"],
  });

  readline.createInterface({ input: spawned.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    const { id, ok, value, error } = JSON.parse(line);
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(value);
    else entry.reject(new Error(error));
  });

  spawned.on("exit", (code) => {
    child = null;
    for (const entry of pending.values()) {
      entry.reject(new Error(`e2e db worker exited (code ${code}) with a request in flight.`));
    }
    pending.clear();
  });

  child = spawned;
  return spawned;
}

function call<K extends keyof DbHandlers>(
  fn: K,
  ...args: Parameters<DbHandlers[K]>
): Promise<Awaited<ReturnType<DbHandlers[K]>>> {
  const proc = ensureChild();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    proc.stdin.write(`${JSON.stringify({ id, fn, args })}\n`);
  });
}

/** Stops the worker. Safe to call when none was ever started. */
export function disconnect(): void {
  child?.stdin.end();
  child?.kill();
  child = null;
}

// Playwright's own teardown doesn't know about this child, so make sure a
// crashed or interrupted run doesn't leave one behind.
process.on("exit", () => {
  child?.kill();
});

export const createTestUser = (...args: Parameters<DbHandlers["createTestUser"]>): Promise<TestUser> =>
  call("createTestUser", ...args);

export const deleteTestUser = (...args: Parameters<DbHandlers["deleteTestUser"]>): Promise<void> =>
  call("deleteTestUser", ...args);

export const createTestPost = (...args: Parameters<DbHandlers["createTestPost"]>): Promise<TestPost> =>
  call("createTestPost", ...args);

export const deleteTestPost = (...args: Parameters<DbHandlers["deleteTestPost"]>): Promise<void> =>
  call("deleteTestPost", ...args);

export const createComment = (...args: Parameters<DbHandlers["createComment"]>) => call("createComment", ...args);

export const createQuoteThread = (...args: Parameters<DbHandlers["createQuoteThread"]>) =>
  call("createQuoteThread", ...args);

export const getThread = (...args: Parameters<DbHandlers["getThread"]>): Promise<ThreadState | null> =>
  call("getThread", ...args);

export const getLatestRevisionId = (...args: Parameters<DbHandlers["getLatestRevisionId"]>) =>
  call("getLatestRevisionId", ...args);

export const getRevisions = (...args: Parameters<DbHandlers["getRevisions"]>): Promise<RevisionSummary[]> =>
  call("getRevisions", ...args);

export const hasCollabDoc = (...args: Parameters<DbHandlers["hasCollabDoc"]>): Promise<boolean> =>
  call("hasCollabDoc", ...args);

export const getCommentStatus = (...args: Parameters<DbHandlers["getCommentStatus"]>) =>
  call("getCommentStatus", ...args);

export const sweepTestData = (...args: Parameters<DbHandlers["sweepTestData"]>) => call("sweepTestData", ...args);
