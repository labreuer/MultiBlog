import { docBodyOf, versionBlocks } from "./doc-body";
import { docTitleOrFallback } from "./doc-title";
import type { BuiltSide } from "./diff-slider";
import { mergeChipContexts } from "./entity-chips/renderings";
import type { ChipContext, ChipInputs } from "./entity-chips/types";
import { prepareReplay, ReplayCursor, type ReplayPayload } from "./replay-log";

// docs/FORKS.md "Sliders on the diff page" — the worker that builds a doc at
// one version in the reader's browser, for a side a diff slider has moved to.
// It fetches the doc's log once (`/api/doc/[id]/replay`, the doc page's scrub
// bar's route, whose gate is who may have a slider), replays to the version
// and reads its blocks through the functions the server reads a version with
// (src/lib/doc-body.ts). So a move makes no request.
//
// **It answers a side whole or not at all.** `built: null` is every way it
// can't: the log didn't load, the version isn't in it, the replay threw, the
// body holds a chip kind this bundle doesn't know, or a chip names a record
// the chip-context endpoint doesn't answer this viewer for. `DiffView` then
// asks the server for the pair. Never a side built from part of the records:
// it would read differently from the same address reloaded.
//
// In a worker for the reason the diff's own is one (doc-diff.worker.ts):
// replaying a long log backward is a rebuild, and the slider's thumb is on
// the page's thread. Loaded on a slider's first touch, by a viewer with a
// doc's history; a reader without one never fetches it.

export type VersionRequest =
  /** Fetch a doc's log ahead of its first build: sent when its slider is first touched. */
  | { type: "open"; docId: string }
  | { type: "build"; id: number; docId: string; updateId: string };

/** `built` is null when this worker can't build the side, and the server is to. */
export type VersionAnswer = { id: number; built: BuiltSide | null };

/** The endpoint's own bound on the ids one request may ask about, per chip kind. */
const MAX_ASKED = 200;

type Log = { cursor: ReplayCursor; indexOf: Map<string, number> };

type Entry = {
  /** The doc's log, fetched once. A fetch that fails is forgotten, so the next build tries again. */
  log: Promise<Log | null> | null;
  /** Versions the log has been fetched again for: one the log lacks was written after its fetch. */
  sought: Set<string>;
  /** The chip records held for this doc: what the endpoint has answered. */
  context: ChipContext;
  /** Ids asked of the endpoint and not answered, per chip kind: not this viewer's to have, or nobody's. */
  refused: Map<string, Set<string>>;
};

const entries = new Map<string, Entry>();

function entryOf(docId: string): Entry {
  let entry = entries.get(docId);
  if (!entry) entries.set(docId, (entry = { log: null, sought: new Set(), context: {}, refused: new Map() }));
  return entry;
}

async function fetchLog(docId: string): Promise<Log | null> {
  try {
    // Never a cached copy: a second fetch is made because the first is behind.
    const res = await fetch(`/api/doc/${docId}/replay`, { cache: "no-store" });
    if (!res.ok) return null;
    const prepared = prepareReplay((await res.json()) as ReplayPayload);
    return { cursor: new ReplayCursor(prepared), indexOf: new Map(prepared.updates.map((update, index) => [update.id.toString(), index])) };
  } catch {
    return null;
  }
}

function logOf(docId: string, entry: Entry): Promise<Log | null> {
  if (!entry.log) {
    const log = fetchLog(docId).then((loaded) => {
      if (!loaded && entry.log === log) entry.log = null;
      return loaded;
    });
    entry.log = log;
  }
  return entry.log;
}

/** The records for `missing`, as the endpoint answers this viewer; null when it couldn't be asked. */
async function askFor(docId: string, missing: Record<string, string[]>): Promise<ChipContext | null> {
  const query = Object.entries(missing)
    .map(([kind, ids]) => `&${encodeURIComponent(kind)}=${ids.map(encodeURIComponent).join(",")}`)
    .join("");
  try {
    const res = await fetch(`/api/chip-context?doc=${encodeURIComponent(docId)}${query}`, { cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as ChipInputs).context ?? {};
  } catch {
    return null;
  }
}

async function build(docId: string, updateId: string): Promise<BuiltSide | null> {
  const entry = entryOf(docId);
  let log = await logOf(docId, entry);
  if (log && !log.indexOf.has(updateId) && !entry.sought.has(updateId)) {
    // The doc was edited after its log was fetched, and the slider's index,
    // fetched again since, has the later updates. Once for each such version.
    entry.sought.add(updateId);
    entry.log = null;
    log.cursor.destroy();
    log = await logOf(docId, entry);
  }
  const index = log?.indexOf.get(updateId);
  if (!log || index === undefined) return null;

  // Throws for bytes that aren't a Yjs update, or a body outside the doc schema.
  const body = docBodyOf(log.cursor.seek(index).doc);
  const at = log.cursor.prepared.updates[index].createdAt;

  // Twice at most: once with the records held, once more with what was asked for.
  for (let asked = false; ; asked = true) {
    const result = versionBlocks(body, entry.context);
    if (result.ok) return { title: docTitleOrFallback(body.title), at, blocks: result.blocks };
    if (result.reason !== "missing" || asked) return null;
    const { missing } = result;
    for (const [kind, ids] of Object.entries(missing)) {
      const refused = entry.refused.get(kind);
      if (ids.length > MAX_ASKED || ids.some((id) => refused?.has(id))) return null;
    }
    const answer = await askFor(docId, missing);
    if (!answer) return null;
    entry.context = mergeChipContexts(entry.context, answer);
    for (const [kind, ids] of Object.entries(missing)) {
      const held = entry.context[kind];
      for (const id of ids) {
        if (typeof held === "object" && held !== null && Object.hasOwn(held, id)) continue;
        let refused = entry.refused.get(kind);
        if (!refused) entry.refused.set(kind, (refused = new Set()));
        refused.add(id);
      }
    }
  }
}

// The page's tsconfig has the DOM's types and not a worker's, where `self` is
// a window whose `postMessage` wants a target origin.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<VersionRequest>) => void) | null;
  postMessage(answer: VersionAnswer): void;
};

// One build at a time: two sides of one doc share its cursor.
let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event) => {
  const request = event.data;
  if (request.type === "open") {
    void logOf(request.docId, entryOf(request.docId));
    return;
  }
  queue = queue.then(async () => {
    let built: BuiltSide | null = null;
    try {
      built = await build(request.docId, request.updateId);
    } catch {
      // Answered as any other side this can't build.
    }
    scope.postMessage({ id: request.id, built });
  });
};
