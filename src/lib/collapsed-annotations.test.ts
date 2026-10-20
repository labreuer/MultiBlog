import { test } from "node:test";
import assert from "node:assert/strict";
import {
  idsInSubtree,
  newestInSubtree,
  parseCollapsed,
  replyCounts,
  serializeCollapsed,
  withCollapsed,
  withoutCollapsed,
} from "./collapsed-annotations";

// docs/ANNOTATIONS.md, "Collapsing a card". What is stored is whatever a
// browser last wrote under a key any script on the origin can touch, so the
// parse's rejection surface is the part worth a table: a bad value must cost
// the reader their collapsed cards, never the page.

test("parseCollapsed: nothing stored, or nothing usable, is an empty map", () => {
  for (const raw of [null, "", "not json", "[]", "null", "42", '"a string"', "{"]) {
    assert.equal(parseCollapsed(raw).size, 0, `for ${JSON.stringify(raw)}`);
  }
});

test("parseCollapsed: keeps well-formed entries and drops malformed ones beside them", () => {
  const map = parseCollapsed(
    JSON.stringify({
      good: "2026-10-18T03:44:03.940Z",
      notADate: "yesterday-ish",
      aNumber: 1760000000000,
      anObject: { seen: "2026-10-18T03:44:03.940Z" },
      nothing: null,
    }),
  );
  assert.deepEqual([...map], [["good", "2026-10-18T03:44:03.940Z"]]);
});

test("parseCollapsed: an id that names an Object.prototype key is just an id", () => {
  const map = parseCollapsed(JSON.stringify({ constructor: "2026-10-18T00:00:00.000Z" }));
  assert.equal(map.has("constructor"), true);
  assert.equal(parseCollapsed("{}").has("constructor"), false);
});

const SEEN = "2026-10-18T00:00:00.000Z";

test("serializeCollapsed round-trips through parseCollapsed, order included", () => {
  // Eviction reads the order back out of storage, so it has to survive there.
  const map = withCollapsed(new Map(), ["cmz", "cma", "cmm"].map((id) => ({ id, seen: SEEN })));
  const back = parseCollapsed(serializeCollapsed(map));
  assert.deepEqual([...back.keys()], ["cmz", "cma", "cmm"]);
  assert.deepEqual(back, map);
});

test("withCollapsed: re-collapsing a card refreshes its entry rather than adding a second", () => {
  const first = withCollapsed(new Map(), [{ id: "a", seen: SEEN }]);
  const second = withCollapsed(first, [{ id: "a", seen: "2026-10-19T00:00:00.000Z" }]);
  assert.deepEqual([...second], [["a", "2026-10-19T00:00:00.000Z"]]);
  // And the input is left alone.
  assert.equal(first.get("a"), SEEN);
});

test("withCollapsed: past the cap, the oldest collapses go first, a re-collapse counting as new", () => {
  let map = withCollapsed(new Map(), [{ id: "old", seen: SEEN }]);
  map = withCollapsed(map, [{ id: "middle", seen: SEEN }]);
  map = withCollapsed(map, [{ id: "old", seen: SEEN }]);
  map = withCollapsed(map, [{ id: "new", seen: SEEN }], 2);
  assert.deepEqual([...map.keys()], ["old", "new"]);
});

test("withoutCollapsed: removes what it is given and ignores what isn't there", () => {
  const map = withCollapsed(new Map(), [
    { id: "a", seen: SEEN },
    { id: "b", seen: SEEN },
  ]);
  assert.deepEqual([...withoutCollapsed(map, ["a", "missing"]).keys()], ["b"]);
});

// A thread, each card posted the moment it was created:
//   root (Oct 1) → r1 (Oct 2) → r1a (Oct 5, deleted) → r1a1 (Oct 6)
//                → r2 (Oct 3)
type Node = { id: string; createdAt: string; postedAt: string | null; deletedByUserId: string | null; replies: Node[] };
const day = (d: number) => `2026-10-0${d}T00:00:00.000Z`;
const card = (id: string, d: number, replies: Node[] = [], deletedByUserId: string | null = null): Node => ({
  id,
  createdAt: day(d),
  postedAt: day(d),
  deletedByUserId,
  replies,
});
const thread = card("root", 1, [card("r1", 2, [card("r1a", 5, [card("r1a1", 6)], "someone")]), card("r2", 3)]);

// replyCounts with its new replies as ids, for comparing.
function counts(node: Node, seen: string | null) {
  const { replies, unseen, through } = replyCounts(node, seen);
  return { replies, unseen: unseen.map((reply) => reply.id), through };
}

test("newestInSubtree reaches every depth, and a lone card is its own newest", () => {
  assert.equal(newestInSubtree(thread), day(6));
  assert.equal(newestInSubtree(thread.replies[1]), day(3));
});

test("idsInSubtree lists the card and everything under it, deleted or not", () => {
  assert.deepEqual(idsInSubtree(thread), ["root", "r1", "r1a", "r1a1", "r2"]);
});

test("replyCounts: live replies at any depth; a deleted one counts for neither number", () => {
  assert.deepEqual(counts(thread, null), { replies: 3, unseen: [], through: [] });
  // Seen as of Oct 2: r1a1 (Oct 6) and r2 (Oct 3) arrived since, in render
  // order; r1a is deleted. Reaching r1a1 means opening r1 and r1a's stub.
  assert.deepEqual(counts(thread, day(2)), { replies: 3, unseen: ["r1a1", "r2"], through: ["r1", "r1a"] });
  // Exactly at a reply's own time is not after it.
  assert.deepEqual(counts(thread, day(6)), { replies: 3, unseen: [], through: [] });
  assert.deepEqual(counts(thread.replies[1], null), { replies: 0, unseen: [], through: [] });
});

// The case `postedAt` exists for: a reply whose composer was opened on Oct 2,
// before the card was collapsed on Oct 3, and posted on Oct 4, after it. Its
// `createdAt` says it is older than what was seen; it is not.
const slowReply = { ...card("slow", 2), postedAt: day(4) };
const withSlowReply = card("root", 1, [card("r1", 3), slowReply]);

test("a reply is new by when it was posted, not when its composer opened", () => {
  assert.equal(newestInSubtree(withSlowReply), day(4));
  assert.deepEqual(counts(withSlowReply, day(3)), { replies: 2, unseen: ["slow"], through: [] });
  // And collapsing after it was posted has seen it.
  assert.deepEqual(counts(withSlowReply, newestInSubtree(withSlowReply)), { replies: 2, unseen: [], through: [] });
});

test("a row with no posting time falls back to its createdAt", () => {
  const legacy = card("root", 1, [{ ...card("old", 5), postedAt: null }]);
  assert.equal(newestInSubtree(legacy), day(5));
  assert.deepEqual(counts(legacy, day(4)), { replies: 1, unseen: ["old"], through: [] });
});
