import { invalid } from "@/lib/api/errors";
import { displayNameOf } from "@/lib/display-name";
import type { HeadlineFragment } from "@/lib/search/headline";

// docs/MCP.md §4 — the small rules every result follows, in one place so the
// tools can't drift apart on them. A result is what the model reads, as
// compact JSON, so what it costs beyond its text is its keys and identifiers:
// a byline is one string, a date is a day (a minute in a thread), and a
// snippet is one string with its matches marked.

/** A snippet as one string: fragments joined by an ellipsis, each match in `**…**` (§14). */
export function markedSnippet(fragments: HeadlineFragment[]): string {
  return fragments
    .map((parts) => parts.map((part) => (part.match ? `**${part.text}**` : part.text)).join(""))
    .join(" … ");
}

/** A byline as one string of names, in byline order — never an email (display-name.ts). */
export function bylineOf(people: { name: string | null }[]): string {
  return people.map((person) => displayNameOf(person)).join(", ");
}

/** A date as its day, UTC. */
export function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** A date to the minute, UTC: what a thread's entries carry (§9). */
export function minuteOf(date: Date): string {
  return date.toISOString().slice(0, 16).replace("T", " ");
}

/** `text` cut to about `max` characters on a word, with an ellipsis when cut. */
export function clip(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  const cut = collapsed.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The serialized size of a result, as a client measures it (§4). */
export function sizeOf(result: unknown): number {
  return JSON.stringify(result).length;
}

/** An opaque list cursor: an offset, and the page size it was cut at. */
export type Cursor = { offset: number; size: number };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.offset, cursor.size]), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined, defaultSize: number): Cursor {
  if (raw === undefined) return { offset: 0, size: defaultSize };
  try {
    const [offset, size] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown[];
    if (Number.isInteger(offset) && Number.isInteger(size) && (offset as number) >= 0 && (size as number) > 0) {
      return { offset: offset as number, size: size as number };
    }
  } catch {
    // Falls through to the refusal below.
  }
  throw invalid("That cursor isn't one this server gave out; start again without it.");
}

/** A page of `items` at `cursor`, and the cursor for the next page when there is one. */
export function pageOf<T>(items: T[], cursor: Cursor): { items: T[]; next?: string } {
  const page = items.slice(cursor.offset, cursor.offset + cursor.size);
  const nextOffset = cursor.offset + cursor.size;
  return nextOffset < items.length ? { items: page, next: encodeCursor({ offset: nextOffset, size: cursor.size }) } : { items: page };
}
