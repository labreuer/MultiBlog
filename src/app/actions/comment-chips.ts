"use server";

import { auth } from "@/lib/auth";
import { actorFromSessionUser } from "@/lib/actor";
import { commentCiteCandidates, commentMentionCandidates, type CommentWriter } from "@/lib/comment-chips";
import type { CiteCandidate } from "@/lib/entity-chips/kinds/citation";
import type { MentionUser } from "@/lib/entity-chips/kinds/mention";

// docs/ENTITY_CHIPS.md, "Chips in comments" — the rich comment editor's `@`
// and `[@` menus. Open to a commenter who is signed out, as the comment form
// is: what they are offered is what the post's page already shows them, its
// byline, the contributor list and its bibliography. The rules are
// src/lib/comment-chips.ts'; this adds the session.

async function writer(): Promise<CommentWriter> {
  const session = await auth();
  return session?.user ? actorFromSessionUser(session.user) : null;
}

/** The people a comment on `postId` may mention whose name or handle contains `query`. */
export async function searchCommentMentionable(query: string, postId: string): Promise<MentionUser[]> {
  if (typeof query !== "string" || typeof postId !== "string") return [];
  return commentMentionCandidates(await writer(), postId, query.slice(0, 100));
}

/** The works a comment on `postId` may cite that match `query`: the post's own first. */
export async function searchCommentCitable(query: string, postId: string): Promise<CiteCandidate[]> {
  if (typeof query !== "string" || typeof postId !== "string") return [];
  return commentCiteCandidates(await writer(), postId, query.slice(0, 100));
}
