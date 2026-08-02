// Etherpad changeset parsing and application, reduced to the subset an importer
// needs. See scripts/etherpad/README.md for the surrounding design.
//
// WHY THIS IS HAND-WRITTEN: there is no maintained standalone changeset package.
// Depending on ep_etherpad-lite would pull a ~200MB monolith with a
// settings/hook/plugin bootstrap, and the vendored copies floating around npm
// are CLI internals, not APIs.
//
// WHY IT IS SHORT: the hard half of Etherpad's Changeset.ts is COMPOSING
// changesets and attribution strings (compose/follow/slicerZipperFunc/
// AttributeMap). None of that is needed to walk a history forward. Applying a
// changeset to a flat array of {char, attributes} cells needs only the two
// regexes below plus base36. So the document model here is deliberately NOT
// Etherpad's `atext` (text + a parallel attribution-op string) but an exploded
// per-character array, and the attribution string is only ever DECODED, never
// emitted — which also means no canonical attribute ordering to get wrong.
//
// THREE SEMANTICS THAT ARE EASY TO GET BACKWARDS
//
// 1. AN OP'S ATTRIBUTE LIST IS A LIST OF INSTRUCTIONS, NOT A STATE. A pool entry
//    whose VALUE is empty — ["author", ""] — means "remove this key from these
//    characters"; it is how Etherpad's "clear authorship colors" button is
//    recorded. It must survive parsing and be dropped only when the merged
//    result is formed. Filtering empty values at parse time turns every removal
//    into a silent no-op: caught here on the one pad in 50 that had ever used
//    the feature, and only by the head-atext gate.
// 2. ON A `=` OP THE ATTRIBUTES ARE MERGED ONTO WHAT IS ALREADY THERE, not
//    substituted for it (Etherpad: composeAttributes with emptyValueIsDelete).
//    On a `+` op they ARE the complete set.
// 3. A CHANGESET'S OPS NEED NOT COVER THE WHOLE OLD TEXT. Etherpad's applyToText
//    ends with `assem.append(strIter.take(strIter.remaining()))` — the
//    unconsumed tail is implicitly kept. Nearly every real changeset relies on
//    this, which is why the old length is in the header at all.

import type { AText, AttribPool } from "./dirty-db";

// An interned, frozen attribute set. Interning means two cells with the same
// attributes are pointer-equal, which makes run detection in to-prosemirror.ts
// a `!==` and keeps memory flat across thousands of replayed revisions.
export type Attrs = Readonly<Record<string, string>>;
// `seed` marks a character as part of the pad's boilerplate seed text — what
// Etherpad's own `settings.defaultPadText` put there at creation, before anyone
// typed anything. It is set once, on the characters revision 0 inserts, and from
// then on it simply rides along: a `-` op drops those cells, an attributed `=`
// copies the flag onto the rewritten cell, and `+` ops never set it. That is what
// lets the importer present a history in which the boilerplate never existed even
// for a pad where somebody deleted it halfway through, or never deleted it at all
// — the flag identifies the characters, so no content matching is needed and a
// user editing inside the boilerplate doesn't defeat it.
export type Cell = { readonly ch: string; readonly attrs: Attrs; readonly seed?: true };

const interned = new Map<string, Attrs>();

// Builds a RESULT attribute set: empty values mean "absent", so they are dropped
// here rather than stored. See note 1 above for why the instruction lists that
// feed this must NOT be filtered the same way.
export function internAttrs(raw: Record<string, string>): Attrs {
  const keys = Object.keys(raw)
    .filter((k) => raw[k] !== "")
    .sort();
  let sig = "";
  for (const k of keys) sig += `${k}${raw[k]}`;
  const hit = interned.get(sig);
  if (hit) return hit;
  const value: Record<string, string> = {};
  for (const k of keys) value[k] = raw[k];
  Object.freeze(value);
  interned.set(sig, value);
  return value;
}

export const EMPTY_ATTRS = internAttrs({});

// Etherpad's own two regexes, verbatim in spirit: the header, and the op
// iterator (attribute refs, optional line count, opcode, char count — all base36).
const RE_HEADER = /^Z:([0-9a-z]+)([<>])([0-9a-z]+)([^$]*)\$([\s\S]*)$/;
const RE_OP = /((?:\*[0-9a-z]+)*)(?:\|([0-9a-z]+))?([-+=])([0-9a-z]+)/g;
const RE_ATTRIB_REF = /\*([0-9a-z]+)/g;

export type UnpackedChangeset = {
  oldLen: number;
  newLen: number;
  ops: string;
  charBank: string;
};

export function unpack(changeset: string): UnpackedChangeset {
  const m = RE_HEADER.exec(changeset);
  if (!m) throw new Error(`not a changeset: ${JSON.stringify(changeset.slice(0, 60))}`);
  const oldLen = parseInt(m[1], 36);
  const delta = parseInt(m[3], 36) * (m[2] === ">" ? 1 : -1);
  return { oldLen, newLen: oldLen + delta, ops: m[4], charBank: m[5] };
}

// The op's attribute list as INSTRUCTIONS — empty values preserved (note 1).
function readInstructions(refs: string, pool: Record<string, [string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!refs) return out;
  RE_ATTRIB_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_ATTRIB_REF.exec(refs)) !== null) {
    const entry = pool[parseInt(m[1], 36)];
    if (!entry) throw new Error(`attribute ${m[1]} (${parseInt(m[1], 36)}) is not in the pool`);
    out[entry[0]] = entry[1];
  }
  return out;
}

function applyInstructions(base: Attrs, instructions: Record<string, string>): Attrs {
  const merged: Record<string, string> = { ...base };
  for (const k of Object.keys(instructions)) merged[k] = instructions[k];
  return internAttrs(merged);
}

export function poolOf(pool: AttribPool): Record<string, [string, string]> {
  return pool.numToAttrib as Record<string, [string, string]>;
}

// The empty pad, i.e. the state revision 0 is applied to. Etherpad's Pad
// constructor splices the initial text into a bare "\n".
export function emptyDocument(): Cell[] {
  return [{ ch: "\n", attrs: EMPTY_ATTRS }];
}

export type ApplyAnomaly = { kind: "line-count"; op: string; declared: number; actual: number };

export type ApplyOptions = {
  // Collects `|lines` mismatches instead of throwing: the declared newline count
  // is a redundancy check, and the atext checkpoints are the real gate — a soft
  // signal here can't turn into a spurious abort on a live run.
  anomalies?: ApplyAnomaly[];
  // Flags every character this changeset inserts as boilerplate (see `Cell`).
  // Passed only for revision 0, whose inserts ARE the pad's seed text. Marking
  // during application rather than by offset afterwards keeps it correct however
  // the seeding changeset is shaped.
  markInsertsAsSeed?: boolean;
};

// Applies one changeset, mutating `cells` in place and returning it.
export function applyChangeset(
  cells: Cell[],
  changeset: string,
  pool: Record<string, [string, string]>,
  options: ApplyOptions = {},
): Cell[] {
  const { anomalies, markInsertsAsSeed } = options;
  const { oldLen, newLen, ops, charBank } = unpack(changeset);
  if (cells.length !== oldLen) {
    throw new Error(`changeset expects a document of ${oldLen} chars, replay has ${cells.length}`);
  }

  let cursor = 0;
  let bank = 0;
  RE_OP.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = RE_OP.exec(ops)) !== null) {
    const [, refs, lineRef, opcode, charRef] = m;
    const n = parseInt(charRef, 36);
    const declaredLines = lineRef === undefined ? null : parseInt(lineRef, 36);

    if (opcode === "=") {
      if (cursor + n > cells.length) throw new Error(`= op of ${n} runs past the end of the document`);
      if (refs) {
        const instructions = readInstructions(refs, pool);
        for (let i = 0; i < n; i++) {
          const cell = cells[cursor + i];
          const attrs = applyInstructions(cell.attrs, instructions);
          // Rewriting a cell must carry `seed` across, or an attribute change
          // over the boilerplate (a "clear authorship colors" sweep covers the
          // whole document, boilerplate included) would launder it into content.
          cells[cursor + i] = cell.seed ? { ch: cell.ch, attrs, seed: true } : { ch: cell.ch, attrs };
        }
      }
      if (declaredLines !== null && anomalies) {
        let actual = 0;
        for (let i = 0; i < n; i++) if (cells[cursor + i].ch === "\n") actual += 1;
        if (actual !== declaredLines) anomalies.push({ kind: "line-count", op: m[0], declared: declaredLines, actual });
      }
      cursor += n;
    } else if (opcode === "-") {
      if (cursor + n > cells.length) throw new Error(`- op of ${n} runs past the end of the document`);
      if (declaredLines !== null && anomalies) {
        let actual = 0;
        for (let i = 0; i < n; i++) if (cells[cursor + i].ch === "\n") actual += 1;
        if (actual !== declaredLines) anomalies.push({ kind: "line-count", op: m[0], declared: declaredLines, actual });
      }
      cells.splice(cursor, n);
    } else {
      if (bank + n > charBank.length) throw new Error(`+ op of ${n} runs past the end of the charbank`);
      const attrs = internAttrs(readInstructions(refs, pool));
      const inserted: Cell[] = new Array(n);
      let actual = 0;
      for (let i = 0; i < n; i++) {
        // Index access, not [...spread]: Etherpad counts UTF-16 code units, and
        // iterating by code point would desynchronize the charbank cursor on any
        // astral character. Surrogate halves land in adjacent cells and rejoin
        // in order on the way out.
        const ch = charBank[bank + i];
        if (ch === "\n") actual += 1;
        inserted[i] = markInsertsAsSeed ? { ch, attrs, seed: true } : { ch, attrs };
      }
      if (declaredLines !== null && anomalies && actual !== declaredLines) {
        anomalies.push({ kind: "line-count", op: m[0], declared: declaredLines, actual });
      }
      bank += n;
      cells.splice(cursor, 0, ...inserted);
      cursor += n;
    }
  }

  // Note 3: whatever the ops didn't reach is kept implicitly — nothing to do.
  if (cells.length !== newLen) {
    throw new Error(`changeset declares a result of ${newLen} chars, replay produced ${cells.length}`);
  }
  return cells;
}

// An attribution string is a sequence of `+` ops only (provable from Etherpad's
// slicerZipperFunc: the attribution operand is always `+`, so the output opcode
// table can only ever emit `+` or nothing). Decoding one is therefore the same
// iterator with a narrower expectation.
export function atextToCells(atext: AText, pool: Record<string, [string, string]>): Cell[] {
  const cells: Cell[] = [];
  let bank = 0;
  RE_OP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_OP.exec(atext.attribs)) !== null) {
    if (m[3] !== "+") throw new Error(`attribution string contains a '${m[3]}' op`);
    const n = parseInt(m[4], 36);
    const attrs = internAttrs(readInstructions(m[1], pool));
    for (let i = 0; i < n; i++) cells.push({ ch: atext.text[bank + i], attrs });
    bank += n;
  }
  // Characters past the end of the attribution string carry no attributes.
  for (let i = bank; i < atext.text.length; i++) cells.push({ ch: atext.text[i], attrs: EMPTY_ATTRS });
  return cells;
}

// Compares a replayed document against a stored one. Returns null when equal, or
// a message naming the exact character. Comparing CELL MODELS rather than
// re-serializing to an attribution string is deliberate: it needs no emitter and
// no canonical attribute ordering, so a mismatch is always a real divergence
// rather than a formatting difference — which is what keeps the gate trustworthy
// enough to leave switched on.
export function cellsDiffer(replayed: Cell[], stored: Cell[]): string | null {
  const shared = Math.min(replayed.length, stored.length);
  for (let i = 0; i < shared; i++) {
    if (replayed[i].ch !== stored[i].ch) {
      return (
        `char ${i}: replay has ${JSON.stringify(replayed[i].ch)}, stored has ${JSON.stringify(stored[i].ch)}` +
        ` (context ${JSON.stringify(cellsText(replayed.slice(Math.max(0, i - 20), i + 20)))})`
      );
    }
    if (replayed[i].attrs !== stored[i].attrs) {
      return (
        `attributes at char ${i} (${JSON.stringify(replayed[i].ch)}): replay has ` +
        `${JSON.stringify(replayed[i].attrs)}, stored has ${JSON.stringify(stored[i].attrs)}`
      );
    }
  }
  if (replayed.length !== stored.length) {
    return `length: replay has ${replayed.length} chars, stored has ${stored.length}`;
  }
  return null;
}

export function cellsText(cells: Cell[]): string {
  let out = "";
  for (const cell of cells) out += cell.ch;
  return out;
}

export function hasSeedCells(cells: Cell[]): boolean {
  for (const cell of cells) if (cell.seed) return true;
  return false;
}

// The document with its boilerplate seed text removed — what the import maps and
// publishes. The full array is what the atext checkpoints compare against, so
// this never weakens the correctness gate: the replay still has to reproduce
// Etherpad exactly, boilerplate included; only the mapping looks away from it.
export function withoutSeedCells(cells: Cell[]): Cell[] {
  const out: Cell[] = [];
  for (const cell of cells) if (!cell.seed) out.push(cell);
  return out;
}

// Total characters a changeset inserts — used only for the summary's
// "how much did the generated log grow relative to what was actually typed"
// sanity ratio.
export function insertedChars(changeset: string): number {
  const { ops } = unpack(changeset);
  let total = 0;
  RE_OP.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE_OP.exec(ops)) !== null) if (m[3] === "+") total += parseInt(m[4], 36);
  return total;
}
