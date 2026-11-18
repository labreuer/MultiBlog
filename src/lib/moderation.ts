import type { ModerationPolicy } from "@/generated/prisma/enums";

type CascadeInput = {
  postPolicy: ModerationPolicy;
  authorPolicies: ModerationPolicy[];
  sitePolicy: "ALWAYS" | "AUTO";
};

// post -> author -> site, each level either resolving the cascade or
// deferring to the next (INHERIT). Multiple co-authors can each carry their
// own override; the most conservative (ALWAYS) wins among the ones that
// don't defer, since PLAN.md's cascade wording assumes a single author and
// doesn't say how to combine several.
function resolveCascadePolicy({ postPolicy, authorPolicies, sitePolicy }: CascadeInput): "ALWAYS" | "AUTO" {
  if (postPolicy !== "INHERIT") {
    return postPolicy;
  }
  const overrides = authorPolicies.filter((policy) => policy !== "INHERIT");
  if (overrides.includes("ALWAYS")) {
    return "ALWAYS";
  }
  if (overrides.includes("AUTO")) {
    return "AUTO";
  }
  return sitePolicy;
}

type ResolveCommentStatusInput = CascadeInput & {
  commenterIsAdmin: boolean;
  commenterForceModerate: boolean;
  /** `commenter.trusted`: a join card's account (docs/EMAIL.md §10, "Trusted commenters"). */
  commenterTrusted: boolean;
  commenterApprovedCount: number;
  trustThreshold: number;
};

// Resolution order per PLAN.md §6: ADMIN commenters always publish
// immediately, ahead of force_moderate; otherwise force_moderate always
// queues; otherwise a trusted commenter (`trusted`, or >= trustThreshold
// prior approvals) publishes immediately; otherwise the moderation cascade
// decides. docs/COMMENTS.md, "Identity, moderation and abuse".
export function resolveCommentStatus(input: ResolveCommentStatusInput): "PENDING" | "APPROVED" {
  if (input.commenterIsAdmin) {
    return "APPROVED";
  }
  if (input.commenterForceModerate) {
    return "PENDING";
  }
  if (input.commenterTrusted || input.commenterApprovedCount >= input.trustThreshold) {
    return "APPROVED";
  }
  return resolveCascadePolicy(input) === "AUTO" ? "APPROVED" : "PENDING";
}
