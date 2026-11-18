// An email as a person types it, before any account is looked up by it
// (src/lib/accounts.ts, docs/EMAIL.md §10). Pure, so its unit test needs no
// database.

/** An email as it is stored: trimmed, its case as typed. */
export function normalizeAccountEmail(email: string): string {
  return email.trim();
}

/**
 * Whether a typed email is plausible enough to send mail to: one `@` with
 * something either side, no whitespace, and at most 254 characters. Not a
 * validation of the address, which only a delivered mail is.
 */
export function isPlausibleEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email);
}
