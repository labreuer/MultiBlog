// Reads an Etherpad Lite `dirty.db` into memory. See scripts/etherpad/README.md
// for what the data means and what it becomes; this file only knows the file
// format.
//
// dirty.db is newline-delimited JSON, one `{"key":..., "val":...}` per write,
// append-only, LAST WRITE WINS. Two things about it are easy to get wrong and
// both were confirmed against the real file rather than assumed:
//
// - A DELETED key is a line with NO `val` PROPERTY AT ALL. node-dirty writes
//   `JSON.stringify({key, val: undefined})`, and JSON.stringify drops undefined
//   values, so a removal serializes as `{"key":"pad:foo"}`. It is not
//   `"val":null`. 8 of the 58 pads in the real file are tombstoned this way, so
//   reading `o.val` and testing for null silently resurrects all of them.
//   `null` is treated as a tombstone too — no legitimate Etherpad value is null,
//   so accepting both costs nothing — and the two are counted separately.
// - A PAD ID CAN CONTAIN COLONS ("Imitation, limitation and desire: I" is a real
//   pad here), so keys are classified by ANCHORING ON THE SUFFIX, never by
//   splitting on the first colon.
//
// A truncated final line is a normal consequence of a crash mid-write. It is
// skipped and counted rather than thrown on — except when its text mentions
// `pad:`, where losing a revision silently is worse than failing.

import fs from "node:fs";
import readline from "node:readline";

export type Attrib = [key: string, value: string];

// Etherpad's AttributePool. `Pad.toJSON` persists `toJsonable()`, which is
// `{numToAttrib, nextNum}` only — `attribToNum` is rebuilt on load and is not in
// the file. A keyRev's `meta.pool`, though, is the LIVE pool instance, written
// without going through toJsonable, so it can also carry `attribToNum`. Both
// shapes are accepted; only numToAttrib is ever read.
export type AttribPool = { numToAttrib: Record<string, Attrib>; nextNum?: number; attribToNum?: unknown };

export type AText = { text: string; attribs: string };

export type SavedRevision = {
  revNum: number | string;
  savedById: string;
  label?: string;
  timestamp: number;
  id?: string;
};

export type PadRecord = {
  atext: AText;
  pool: AttribPool;
  head: number;
  chatHead?: number;
  publicStatus?: boolean;
  savedRevisions?: SavedRevision[];
  padSettings?: unknown;
};

export type Revision = {
  changeset: string;
  meta: { author: string; timestamp: number; atext?: AText; pool?: AttribPool };
};

export type GlobalAuthor = {
  colorId?: number | string;
  name?: string | null;
  timestamp?: number;
  lastSeen?: number;
  padIDs?: Record<string, unknown>;
};

// The properties Etherpad's own Pad.toJSON is known to write. Anything else on a
// pad record is reported rather than ignored — that one check turns version skew
// (an old pad file from before the TS rewrite) into a startup message instead of
// a silent partial import.
const KNOWN_PAD_PROPS = new Set([
  "atext",
  "pool",
  "head",
  "chatHead",
  "publicStatus",
  "savedRevisions",
  "padSettings",
]);

export type EtherpadDb = {
  pads: Map<string, PadRecord>;
  revs: Map<string, Map<number, Revision>>;
  chats: Map<string, number>;
  authors: Map<string, GlobalAuthor>;
  stats: {
    lines: number;
    distinctKeys: number;
    tombstonedMissingVal: number;
    tombstonedNull: number;
    tombstonedPads: string[];
    corruptLines: number;
    // Every distinct top-level key prefix with a count. This is the line that
    // tells you whether a plugin is storing real content outside the pad
    // namespace — ep_comments_page, for one, writes `comments:<padId>` as a
    // top-level key, and nothing else in this importer would ever notice.
    keyKinds: Map<string, number>;
    unknownPadProps: Map<string, number>;
    orphanRevPads: string[];
  };
};

const RE_REV = /^pad:(.*):revs:(\d+)$/;
const RE_CHAT = /^pad:(.*):chat:(\d+)$/;
const RE_PAD = /^pad:(.*)$/;
const RE_AUTHOR = /^globalAuthor:(.*)$/;

function keyKind(key: string): string {
  if (RE_REV.test(key)) return "pad:*:revs:N";
  if (RE_CHAT.test(key)) return "pad:*:chat:N";
  if (RE_PAD.test(key)) return "pad:*";
  const colon = key.indexOf(":");
  return colon === -1 ? key : `${key.slice(0, colon)}:*`;
}

export async function readDirtyDb(path: string): Promise<EtherpadDb> {
  const data = new Map<string, unknown>();
  const keyKinds = new Map<string, number>();
  const tombstonedPads: string[] = [];
  let lines = 0;
  let tombstonedMissingVal = 0;
  let tombstonedNull = 0;
  let corruptLines = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(path),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    lines += 1;

    let row: { key?: unknown; val?: unknown };
    try {
      row = JSON.parse(line) as { key?: unknown; val?: unknown };
    } catch {
      // A crash mid-write leaves a partial line. Tolerable — unless it was
      // about to be pad content, in which case a revision is missing and a
      // clean-looking import would be a lie.
      corruptLines += 1;
      if (line.includes('"pad:')) {
        throw new Error(
          `${path}: line ${lines} is unparseable JSON and mentions a pad key, so a pad record or revision ` +
            `is truncated. Refusing to import a partial history.\n  ${line.slice(0, 200)}`,
        );
      }
      continue;
    }

    if (typeof row.key !== "string") {
      corruptLines += 1;
      continue;
    }
    const key = row.key;
    keyKinds.set(keyKind(key), (keyKinds.get(keyKind(key)) ?? 0) + 1);

    const missing = !("val" in row);
    if (missing || row.val === null) {
      if (missing) tombstonedMissingVal += 1;
      else tombstonedNull += 1;
      if (data.has(key)) {
        const padMatch = !RE_REV.test(key) && !RE_CHAT.test(key) && RE_PAD.exec(key);
        if (padMatch) tombstonedPads.push(padMatch[1]);
      }
      data.delete(key);
      continue;
    }

    data.set(key, row.val);
  }

  const pads = new Map<string, PadRecord>();
  const revs = new Map<string, Map<number, Revision>>();
  const chats = new Map<string, number>();
  const authors = new Map<string, GlobalAuthor>();
  const unknownPadProps = new Map<string, number>();

  for (const [key, val] of data) {
    let m: RegExpExecArray | null;
    if ((m = RE_REV.exec(key))) {
      let byRev = revs.get(m[1]);
      if (!byRev) revs.set(m[1], (byRev = new Map()));
      byRev.set(Number(m[2]), val as Revision);
    } else if ((m = RE_CHAT.exec(key))) {
      chats.set(m[1], (chats.get(m[1]) ?? 0) + 1);
    } else if ((m = RE_AUTHOR.exec(key))) {
      authors.set(m[1], val as GlobalAuthor);
    } else if ((m = RE_PAD.exec(key))) {
      const record = val as PadRecord;
      // A `pad:`-prefixed key whose value isn't pad-shaped is a plugin storing
      // something under a name that only looks like a pad. Report, don't guess.
      if (!record || typeof record !== "object" || !record.atext || !record.pool) {
        keyKinds.set("pad:* (not a pad record)", (keyKinds.get("pad:* (not a pad record)") ?? 0) + 1);
        continue;
      }
      for (const prop of Object.keys(record)) {
        if (!KNOWN_PAD_PROPS.has(prop)) unknownPadProps.set(prop, (unknownPadProps.get(prop) ?? 0) + 1);
      }
      pads.set(m[1], record);
    }
  }

  const orphanRevPads = [...revs.keys()].filter((name) => !pads.has(name));
  // A pad deleted and later recreated under the same name is not a deleted pad;
  // only names absent from the final state are, and each is worth naming once.
  const deletedPads = [...new Set(tombstonedPads)].filter((name) => !pads.has(name));

  return {
    pads,
    revs,
    chats,
    authors,
    stats: {
      lines,
      distinctKeys: data.size,
      tombstonedMissingVal,
      tombstonedNull,
      tombstonedPads: deletedPads,
      corruptLines,
      keyKinds,
      unknownPadProps,
      orphanRevPads,
    },
  };
}
