// docs/PDF.md §13, "Moving a note forward" — what a bulk carry would do, and
// what one did, in words: for the candidate's page, the version list and a
// version's map page, which show one before it is run.
//
// Browser-safe: it takes the numbers `src/lib/file-anchor-move.ts` answers,
// as plain shapes, and imports nothing from there.

type Stays = readonly { number: number; count: number }[];

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 notes and 1 link part", or either alone; null for neither. */
function things(notes: number, parts: number): string | null {
  const said = [notes > 0 ? count(notes, "note", "notes") : null, parts > 0 ? count(parts, "link part", "link parts") : null].filter((part) => part !== null);
  return said.length > 0 ? said.join(" and ") : null;
}

/** "2 on version 1 and 1 on version 2". */
function byVersion(stays: Stays): string {
  const said = stays.map((stay) => `${stay.count} on version ${stay.number}`);
  return said.length <= 1 ? (said[0] ?? "") : `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}`;
}

const versionsSaid = (numbers: readonly number[]) =>
  numbers.length === 1 ? `version ${numbers[0]}` : `versions ${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;

/** What a carry would do, a sentence to a line: the maps it would store first, what would move, and what would stay. */
export function carryPreviewWords(preview: {
  toNumber: number;
  fromNumbers: readonly number[];
  notes: number;
  parts: number;
  stays: Stays;
  storesMaps: readonly number[];
}): string[] {
  const lines: string[] = [];
  if (preview.storesMaps.length > 0) {
    lines.push(
      `It would first match the pages of ${versionsSaid(preview.storesMaps)} with those of the version before, and store that. ` +
        `That says they hold the same text: a link written against one is carried to the other from then on, and nothing takes a page map away.`,
    );
  }
  const moving = things(preview.notes, preview.parts);
  const staying = preview.stays.reduce((sum, stay) => sum + stay.count, 0);
  lines.push(
    moving
      ? `${moving} would move to version ${preview.toNumber}.`
      : staying > 0
        ? `Nothing would move to version ${preview.toNumber}.`
        : `No posted note or minted link part is on an earlier version for a carry to move.`,
  );
  if (staying > 0) lines.push(`${byVersion(preview.stays)} would stay, for ${staying === 1 ? "its author" : "their authors"} to move or leave.`);
  return lines;
}

/** What a carry did: how many it moved, how many stayed on each version, and how many it skipped. */
export function carryResultWords(result: { toNumber: number; moved: number; stayed: Stays; skipped: number; storedMaps: readonly number[] }): string[] {
  const lines: string[] = [];
  if (result.storedMaps.length > 0) lines.push(`The pages of ${versionsSaid(result.storedMaps)} are matched with those of the version before.`);
  lines.push(result.moved > 0 ? `${count(result.moved, "note or link part was", "notes and link parts were")} moved to version ${result.toNumber}.` : `Nothing was moved.`);
  if (result.stayed.length > 0) lines.push(`${byVersion(result.stayed)} stayed.`);
  if (result.skipped > 0) {
    lines.push(`${count(result.skipped, "was", "were")} skipped: moved or marked by someone while this was being worked out. The next carry takes what is still there.`);
  }
  return lines;
}
