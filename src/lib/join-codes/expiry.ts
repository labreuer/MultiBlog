// docs/EMAIL.md §10, "Minting and printing" — a batch's expiry as an ADMIN
// types it, for the mint script's --expires and /join-codes' mint form alike.
// A bare date is the end of that day, UTC, so a batch dated for an event's
// last day lasts through it wherever its cards are scanned; anything else is
// read as a date-time. Pure, so it is tested without a database.

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The instant `text` names, or null when it names none. */
export function parseJoinExpiry(text: string): Date | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (BARE_DATE.test(trimmed)) {
    const date = new Date(`${trimmed}T23:59:59.999Z`);
    // `new Date` rolls 2026-02-30 over into March; a date that doesn't
    // round-trip is not a date.
    return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== trimmed ? null : date;
  }
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date;
}
