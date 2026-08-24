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
import type {
  DbHandlers,
  TestUser,
  TestPost,
  ThreadState,
  PublicationEventSummary,
  TestYdoc,
  TestYdocSnapshot,
  TestDoc,
  DocState,
  AnnotationState,
  TestDocLink,
  DocLinkFields,
  ContributorFields,
  AvatarFacts,
  TestInvite,
} from "./db-worker";

export type {
  TestUser,
  TestPost,
  ThreadState,
  PublicationEventSummary,
  TestYdoc,
  TestYdocSnapshot,
  TestDoc,
  DocState,
  AnnotationState,
  TestDocLink,
  DocLinkFields,
  ContributorFields,
  AvatarFacts,
  TestInvite,
} from "./db-worker";
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

export const setTestUserRole = (...args: Parameters<DbHandlers["setTestUserRole"]>): Promise<void> =>
  call("setTestUserRole", ...args);

export const deleteTestUser = (...args: Parameters<DbHandlers["deleteTestUser"]>): Promise<void> =>
  call("deleteTestUser", ...args);

export const createTestPost = (...args: Parameters<DbHandlers["createTestPost"]>): Promise<TestPost> =>
  call("createTestPost", ...args);

export const deleteTestPost = (...args: Parameters<DbHandlers["deleteTestPost"]>): Promise<void> =>
  call("deleteTestPost", ...args);

export const createTestDoc = (...args: Parameters<DbHandlers["createTestDoc"]>): Promise<TestDoc> =>
  call("createTestDoc", ...args);

export const addTestDocAuthor = (...args: Parameters<DbHandlers["addTestDocAuthor"]>): Promise<void> =>
  call("addTestDocAuthor", ...args);

export const addTestPostAuthor = (...args: Parameters<DbHandlers["addTestPostAuthor"]>): Promise<void> =>
  call("addTestPostAuthor", ...args);

export const deleteTestDoc = (...args: Parameters<DbHandlers["deleteTestDoc"]>): Promise<void> =>
  call("deleteTestDoc", ...args);

export const clearColumnOrder = (...args: Parameters<DbHandlers["clearColumnOrder"]>): Promise<void> =>
  call("clearColumnOrder", ...args);

export const getInvites = (...args: Parameters<DbHandlers["getInvites"]>): Promise<TestInvite[]> =>
  call("getInvites", ...args);

export const createTestInvite = (
  ...args: Parameters<DbHandlers["createTestInvite"]>
): Promise<{ url: string }> => call("createTestInvite", ...args);

export const getSiteDefaultColumnOrder = (
  ...args: Parameters<DbHandlers["getSiteDefaultColumnOrder"]>
): Promise<Awaited<ReturnType<DbHandlers["getSiteDefaultColumnOrder"]>>> => call("getSiteDefaultColumnOrder", ...args);

export const setSiteDefaultColumnOrder = (
  ...args: Parameters<DbHandlers["setSiteDefaultColumnOrder"]>
): Promise<void> => call("setSiteDefaultColumnOrder", ...args);

export const getDocState = (...args: Parameters<DbHandlers["getDocState"]>): Promise<DocState | null> =>
  call("getDocState", ...args);

export const getDocAuthorEmails = (...args: Parameters<DbHandlers["getDocAuthorEmails"]>): Promise<string[]> =>
  call("getDocAuthorEmails", ...args);

export const getContributorFields = (
  ...args: Parameters<DbHandlers["getContributorFields"]>
): Promise<ContributorFields | null> => call("getContributorFields", ...args);

export const getAvatarFacts = (...args: Parameters<DbHandlers["getAvatarFacts"]>): Promise<AvatarFacts | null> =>
  call("getAvatarFacts", ...args);

export const createTestDocLink = (...args: Parameters<DbHandlers["createTestDocLink"]>): Promise<TestDocLink> =>
  call("createTestDocLink", ...args);

export const deleteTestDocLinkGroup = (...args: Parameters<DbHandlers["deleteTestDocLinkGroup"]>): Promise<void> =>
  call("deleteTestDocLinkGroup", ...args);

export const countDocLinks = (...args: Parameters<DbHandlers["countDocLinks"]>): Promise<number> =>
  call("countDocLinks", ...args);

export const getDocLinkGroupIds = (...args: Parameters<DbHandlers["getDocLinkGroupIds"]>): Promise<string[]> =>
  call("getDocLinkGroupIds", ...args);

export const getDocLinkFields = (...args: Parameters<DbHandlers["getDocLinkFields"]>): Promise<DocLinkFields | null> =>
  call("getDocLinkFields", ...args);

export const countDocYdocUpdates = (...args: Parameters<DbHandlers["countDocYdocUpdates"]>): Promise<number> =>
  call("countDocYdocUpdates", ...args);

export const getAnnotationStates = (...args: Parameters<DbHandlers["getAnnotationStates"]>): Promise<AnnotationState[]> =>
  call("getAnnotationStates", ...args);

export const markPresentAtStamp = (...args: Parameters<DbHandlers["markPresentAtStamp"]>): Promise<boolean> =>
  call("markPresentAtStamp", ...args);

export const createTestAnnotation = (
  ...args: Parameters<DbHandlers["createTestAnnotation"]>
): Promise<{ id: string }> => call("createTestAnnotation", ...args);

export const createComment = (...args: Parameters<DbHandlers["createComment"]>) => call("createComment", ...args);

export const createQuoteThread = (...args: Parameters<DbHandlers["createQuoteThread"]>) =>
  call("createQuoteThread", ...args);

export const getThread = (...args: Parameters<DbHandlers["getThread"]>): Promise<ThreadState | null> =>
  call("getThread", ...args);

export const getPublicationEvents = (
  ...args: Parameters<DbHandlers["getPublicationEvents"]>
): Promise<PublicationEventSummary[]> => call("getPublicationEvents", ...args);

export const getPostContentText = (...args: Parameters<DbHandlers["getPostContentText"]>): Promise<string | null> =>
  call("getPostContentText", ...args);

export const countDocYdocSnapshots = (...args: Parameters<DbHandlers["countDocYdocSnapshots"]>): Promise<number> =>
  call("countDocYdocSnapshots", ...args);

export const getCommentStatus = (...args: Parameters<DbHandlers["getCommentStatus"]>) =>
  call("getCommentStatus", ...args);

export const createTestYdoc = (...args: Parameters<DbHandlers["createTestYdoc"]>): Promise<TestYdoc> =>
  call("createTestYdoc", ...args);

export const deleteTestYdoc = (...args: Parameters<DbHandlers["deleteTestYdoc"]>): Promise<void> =>
  call("deleteTestYdoc", ...args);

export const countYdocUpdates = (...args: Parameters<DbHandlers["countYdocUpdates"]>): Promise<number> =>
  call("countYdocUpdates", ...args);

export const getMaxYdocUpdateId = (...args: Parameters<DbHandlers["getMaxYdocUpdateId"]>): Promise<string | null> =>
  call("getMaxYdocUpdateId", ...args);

export const getYdocSnapshots = (...args: Parameters<DbHandlers["getYdocSnapshots"]>): Promise<TestYdocSnapshot[]> =>
  call("getYdocSnapshots", ...args);

export const getYdocClients = (...args: Parameters<DbHandlers["getYdocClients"]>): Promise<Record<string, string>> =>
  call("getYdocClients", ...args);

export const replayYdocText = (...args: Parameters<DbHandlers["replayYdocText"]>): Promise<string> =>
  call("replayYdocText", ...args);

export const getUserIdByEmail = (...args: Parameters<DbHandlers["getUserIdByEmail"]>): Promise<string | null> =>
  call("getUserIdByEmail", ...args);

export const countAllYdocs = (...args: Parameters<DbHandlers["countAllYdocs"]>): Promise<number> =>
  call("countAllYdocs", ...args);

export const sweepTestData = (...args: Parameters<DbHandlers["sweepTestData"]>) => call("sweepTestData", ...args);
