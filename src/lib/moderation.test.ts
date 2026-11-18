import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCommentStatus } from "./moderation";

// docs/COMMENTS.md, "Identity, moderation and abuse": the resolution order.
// An ADMIN publishes; otherwise force_moderate queues; otherwise `trusted`,
// or reaching the threshold, publishes; otherwise the cascade decides.

type Input = Parameters<typeof resolveCommentStatus>[0];

const base: Input = {
  commenterIsAdmin: false,
  commenterForceModerate: false,
  commenterTrusted: false,
  commenterApprovedCount: 0,
  trustThreshold: 3,
  postPolicy: "INHERIT",
  authorPolicies: [],
  sitePolicy: "ALWAYS",
};

test("the resolution order", () => {
  const cases: [Partial<Input>, "PENDING" | "APPROVED"][] = [
    [{}, "PENDING"],
    [{ sitePolicy: "AUTO" }, "APPROVED"],
    [{ commenterIsAdmin: true }, "APPROVED"],
    [{ commenterIsAdmin: true, commenterForceModerate: true }, "APPROVED"],
    [{ commenterForceModerate: true, sitePolicy: "AUTO" }, "PENDING"],
    [{ commenterApprovedCount: 3 }, "APPROVED"],
    [{ commenterApprovedCount: 2 }, "PENDING"],
    [{ commenterTrusted: true }, "APPROVED"],
    // trusted publishes under a post's ALWAYS policy, as the threshold does
    [{ commenterTrusted: true, postPolicy: "ALWAYS" }, "APPROVED"],
    // force_moderate reins in a trusted account without touching its batch
    [{ commenterTrusted: true, commenterForceModerate: true }, "PENDING"],
    [{ commenterApprovedCount: 9, commenterForceModerate: true }, "PENDING"],
    [{ postPolicy: "AUTO" }, "APPROVED"],
    [{ postPolicy: "ALWAYS", sitePolicy: "AUTO" }, "PENDING"],
  ];
  for (const [overrides, expected] of cases) {
    assert.equal(resolveCommentStatus({ ...base, ...overrides }), expected, JSON.stringify(overrides));
  }
});
