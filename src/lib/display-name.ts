import type { Role } from "@/generated/prisma/enums";

// The name other people see for an account: on an annotation card, on search's
// annotation hits (and so in the permalink fragment built from it, which must
// come out the same on both — annotation-anchor-name.ts), on a cursor or a
// presence chip, in a comment's byline or history, and in a notification
// email. Pure and browser-safe, since the client-side surfaces need it too.
//
// **Never the email.** An account with no name gets a fixed label instead:
// its email would be in front of everyone who can see the surface. Not the
// slug either, which for a nameless account is derived from that email
// (user-slug.ts). Callers that show only this select no email at all, so a
// fallback to one can't come back without the query changing too.
export const NAMELESS_DISPLAY_NAME = "Anonymous";

export function displayNameOf(user: { name?: string | null }): string {
  return user.name?.trim() ? user.name : NAMELESS_DISPLAY_NAME;
}

// The management surfaces — the admin tables, their person filters, a byline
// picker — where an ADMIN needs to tell two nameless accounts apart and can
// read every email on /users anyway. Everyone else who reaches those surfaces
// (an AUTHOR on /docs, an EDITOR on the color roster) gets displayNameOf.
export function staffDisplayNameOf(user: { name?: string | null; email: string }, viewerRole: Role): string {
  if (viewerRole === "ADMIN" && !user.name?.trim()) return user.email;
  return displayNameOf(user);
}
