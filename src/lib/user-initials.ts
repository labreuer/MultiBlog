// An account's admin initials when it is made — sign-up's and a bot's
// (src/lib/bots.ts): the first letters of the first and last words of the
// name, or the first two letters of a one-word name or of the email.
export function deriveInitials(name: string | null, email: string): string {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length > 0) {
    const first = words[0][0];
    const last = words.length > 1 ? words[words.length - 1][0] : words[0][1];
    return `${first}${last ?? ""}`.toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}
