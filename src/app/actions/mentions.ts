"use server";

import { auth } from "@/lib/auth";
import { actorFromSessionUser } from "@/lib/actor";
import type { ChipTarget } from "@/lib/entity-chips/context-for";
import type { MentionCandidate } from "@/lib/entity-chips/kinds/mention";
import { mentionCandidates } from "@/lib/entity-chips/kinds/mention-search";

// The mention menu's search (docs/MENTIONS.md). The rule and the gate are
// `mentionCandidates`'; this adds the session.
export async function searchMentionable(query: string, target: ChipTarget): Promise<MentionCandidate[]> {
  const session = await auth();
  if (!session?.user) return [];
  // The arguments are whatever the caller sent: only their expected shapes go on.
  const safeTarget: ChipTarget | null =
    target && typeof target === "object"
      ? "doc" in target && typeof target.doc === "string"
        ? { doc: target.doc }
        : "annotation" in target && typeof target.annotation === "string"
          ? { annotation: target.annotation }
          : null
      : null;
  if (!safeTarget || typeof query !== "string") return [];
  return mentionCandidates(actorFromSessionUser(session.user), safeTarget, query.slice(0, 100));
}
