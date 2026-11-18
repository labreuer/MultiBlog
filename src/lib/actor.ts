import type { Role } from "@/generated/prisma/enums";
import type { SearchActor } from "@/lib/search/types";

// docs/MCP.md §1 — who an operation acts as, handed to it explicitly by
// whichever front door called: the web app's server actions build one from
// the session, the MCP endpoint from a token's user.
//
// **One type, and an adapter for each shape identity already takes**, so no
// call site reshapes it by hand: `{ userId, role }` for search, `{ id, role }`
// for `anchoredLinkForViewer` and `canUserReadComment`, and positional
// arguments for the per-object predicates, which read straight off the
// fields.
//
// The role is the account's as its front door last read it: a token's actor
// is read from the user row on every request (src/lib/api/tokens.ts), and a
// session's from the JWT, which reads the account again every five minutes
// (src/app/sign-in/NOTES.md). A rule that can't wait for that reads the row
// itself, as ownerWhoCanAct and requireCanMakePublic do (src/lib/wiki-claim.ts).

export type Actor = { userId: string; role: Role };

/** The session user as an actor. */
export function actorFromSessionUser(user: { id: string; role: Role }): Actor {
  return { userId: user.id, role: user.role };
}

/** `search()`'s shape. */
export function searchActorOf(actor: Actor): NonNullable<SearchActor> {
  return { userId: actor.userId, role: actor.role };
}

/** `anchoredLinkForViewer`'s, `canUserReadComment`'s and the annotation helpers' shape. */
export function viewerOf(actor: Actor): { id: string; role: Role } {
  return { id: actor.userId, role: actor.role };
}
