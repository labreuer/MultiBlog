// The name other people see for an account on an annotation card and on
// search's annotation hits — and so in the permalink fragment built from it
// (annotation-anchor-name.ts), which must come out the same on both. Pure and
// browser-safe for the same reason that file is.
//
// **Never the email.** An account with no name gets a fixed label instead:
// its email would be in front of everyone who can read the doc, and in the
// fragment of every link to its cards. Not the slug either, which for a
// nameless account is derived from that email (user-slug.ts). Callers select
// no email at all, so a fallback to one can't come back without the query
// changing too.
export const NAMELESS_DISPLAY_NAME = "Anonymous";

export function displayNameOf(user: { name: string | null }): string {
  return user.name?.trim() ? user.name : NAMELESS_DISPLAY_NAME;
}
