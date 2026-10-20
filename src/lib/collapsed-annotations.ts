import { useSyncExternalStore } from "react";

// Which annotation cards this browser has collapsed (docs/ANNOTATIONS.md,
// "Collapsing a card"). Per browser rather than per account: it is a reading
// convenience, like the annotation toolbar's visibility and the comment box's
// mode, and lives in localStorage beside them.
//
// One key for every container. An annotation id is unique across docs and
// PDFs alike, so nothing here needs to know which page a card is on — the
// same entry collapses a card in the reading view, the editor's rail and the
// PDF panel.

export const COLLAPSED_STORAGE_KEY = "multiblog.collapsedAnnotations";

// Enough for a reader's whole working set; past it the oldest collapse goes
// first. Ids of deleted annotations are never cleaned up any other way.
export const MAX_COLLAPSED = 2000;

/**
 * Card id → `seen`: the newest posting time in the card's subtree when it was
 * collapsed. A server timestamp, so the "new" count compares server time with
 * server time and a skewed browser clock cannot change it.
 *
 * Oldest collapse first. A Map keeps insertion order, and so does JSON for
 * keys that aren't integers, which a cuid never is — so the order survives
 * storage, and eviction needs no timestamp of its own.
 */
export type CollapsedMap = ReadonlyMap<string, string>;

/** Whatever is stored, read leniently: a malformed value or entry is dropped, never thrown on. */
export function parseCollapsed(raw: string | null): CollapsedMap {
  const map = new Map<string, string>();
  if (!raw) return map;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return map;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return map;
  for (const [id, seen] of Object.entries(parsed)) {
    if (typeof seen === "string" && !Number.isNaN(Date.parse(seen))) map.set(id, seen);
  }
  return map;
}

export function serializeCollapsed(map: CollapsedMap): string {
  return JSON.stringify(Object.fromEntries(map));
}

/** `map` with these cards collapsed, newest last, the oldest evicted past `max`. */
export function withCollapsed(
  map: CollapsedMap,
  cards: readonly { id: string; seen: string }[],
  max = MAX_COLLAPSED,
): CollapsedMap {
  const next = new Map(map);
  for (const card of cards) {
    // Re-collapsing moves a card to the end, as the newest.
    next.delete(card.id);
    next.set(card.id, card.seen);
  }
  for (const id of next.keys()) {
    if (next.size <= max) break;
    next.delete(id);
  }
  return next;
}

export function withoutCollapsed(map: CollapsedMap, ids: Iterable<string>): CollapsedMap {
  const next = new Map(map);
  for (const id of ids) next.delete(id);
  return next;
}

/** The shape of AnnotationNodeData these helpers read, kept structural so they are testable alone. */
type ThreadNode = {
  id: string;
  createdAt: string;
  postedAt: string | null;
  deletedByUserId: string | null;
  replies: readonly ThreadNode[];
};

// When readers could first see a card. Its posting time and not its
// `createdAt`, which for a reply is when its composer was opened: a reply
// begun before a card was collapsed and posted after is still new to whoever
// collapsed it. `createdAt` only for a row posted before `postedAt` existed.
function shownAt(node: ThreadNode): string {
  return node.postedAt ?? node.createdAt;
}

/** The newest posting time in a card's subtree, the card included: what a collapse records as `seen`. */
export function newestInSubtree(node: ThreadNode): string {
  let newest = shownAt(node);
  for (const reply of node.replies) {
    const candidate = newestInSubtree(reply);
    if (Date.parse(candidate) > Date.parse(newest)) newest = candidate;
  }
  return newest;
}

/** Every id in a card's subtree, the card included. */
export function idsInSubtree(node: ThreadNode): string[] {
  return [node.id, ...node.replies.flatMap(idsInSubtree)];
}

/**
 * What a collapsed card's summary says about the replies under it: how many
 * are live, at any depth, and which of those arrived after `seen`, in the
 * order they render. A deleted reply counts for neither — it renders as
 * nothing, or as a "[deleted]" stub, and neither is something to come back
 * for.
 *
 * `through` is every card between this one and a new reply, whatever its
 * state: what has to be open for each new reply to be on the page at all,
 * since one can sit under a reply the reader collapsed separately.
 */
export function replyCounts<T extends ThreadNode & { replies: readonly T[] }>(
  node: T,
  seen: string | null,
): { replies: number; unseen: T[]; through: string[] } {
  const since = seen === null ? Number.POSITIVE_INFINITY : Date.parse(seen);
  let replies = 0;
  const unseen: T[] = [];
  const through = new Set<string>();
  const visit = (current: T, path: readonly string[]) => {
    for (const reply of current.replies) {
      if (reply.deletedByUserId === null) {
        replies++;
        if (Date.parse(shownAt(reply)) > since) {
          unseen.push(reply);
          for (const id of path) through.add(id);
        }
      }
      visit(reply, [...path, reply.id]);
    }
  };
  visit(node, []);
  return { replies, unseen, through: [...through] };
}

// ---- The store -------------------------------------------------------------
//
// Two layers. `collapsed` is what localStorage holds. `revealed` is in memory
// only: cards opened *for* the reader, because they followed a permalink or
// clicked a highlight to get there. A reveal shows the card without
// forgetting that it was collapsed, so it is closed again on the next visit;
// the toggle is the only thing that writes.

export type CollapseState = { collapsed: CollapsedMap; revealed: ReadonlySet<string> };

// The server's answer, and so the first client render's: nothing collapsed.
// The browser's own answer arrives right after hydration, which is what
// `useSyncExternalStore`'s third argument is for — the same shape the comment
// box's remembered mode uses (CommentForm).
const SERVER_STATE: CollapseState = { collapsed: new Map(), revealed: new Set() };

let current: CollapseState | null = null;
const listeners = new Set<() => void>();

/** Null when storage is unreadable (blocked, or a private mode that throws), as distinct from empty. */
function readStorage(): CollapsedMap | null {
  try {
    return parseCollapsed(window.localStorage.getItem(COLLAPSED_STORAGE_KEY));
  } catch {
    return null;
  }
}

function snapshot(): CollapseState {
  current ??= { collapsed: readStorage() ?? new Map(), revealed: new Set() };
  return current;
}

function publish(next: CollapseState) {
  current = next;
  for (const listener of listeners) listener();
}

// Another tab wrote. The `storage` event never fires in the tab that made the
// change, which is why `publish` exists beside it. A null key is
// `localStorage.clear()`.
function onStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== COLLAPSED_STORAGE_KEY) return;
  publish({ collapsed: readStorage() ?? new Map(), revealed: snapshot().revealed });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

// Read-modify-write against storage rather than against `current`, so a
// collapse made in another tab since this one last heard is kept, not
// overwritten. Where storage can't be read, `current` is all there is, and
// collapsing still works for as long as the page is open.
function update(change: (base: CollapsedMap) => CollapsedMap, unreveal: readonly string[]) {
  const collapsed = change(readStorage() ?? snapshot().collapsed);
  try {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, serializeCollapsed(collapsed));
  } catch {
    // A browser that blocks storage just doesn't remember past this page.
  }
  const revealed = new Set(snapshot().revealed);
  for (const id of unreveal) revealed.delete(id);
  publish({ collapsed, revealed });
}

export function collapseCards(cards: readonly { id: string; seen: string }[]) {
  update(
    (base) => withCollapsed(base, cards),
    cards.map((card) => card.id),
  );
}

export function expandCards(ids: readonly string[]) {
  update((base) => withoutCollapsed(base, ids), ids);
}

/**
 * Opens these cards for now, without writing anything. Returns whether any of
 * them was actually closed — the caller's cue to wait a frame before
 * measuring or scrolling, since the card is about to change height.
 */
export function revealCards(ids: readonly string[]): boolean {
  const state = snapshot();
  const closed = ids.filter((id) => state.collapsed.has(id) && !state.revealed.has(id));
  if (closed.length === 0) return false;
  publish({ collapsed: state.collapsed, revealed: new Set([...state.revealed, ...closed]) });
  return true;
}

/**
 * For a jump to a card: reveal these cards, then run `jump` — a frame later
 * if anything opened, so a scroll measures the card at the height it is
 * about to have rather than the one-line height it had.
 */
export function revealThen(ids: readonly string[], jump: () => void) {
  if (revealCards(ids)) requestAnimationFrame(jump);
  else jump();
}

export function useCollapseState(): CollapseState {
  return useSyncExternalStore(subscribe, snapshot, () => SERVER_STATE);
}

export function isCollapsed(state: CollapseState, id: string): boolean {
  return state.collapsed.has(id) && !state.revealed.has(id);
}
