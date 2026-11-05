import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionKind, UNKNOWN_PERSON, type MentionContext, type MentionData, type MentionUser } from "./mention";

// docs/MENTIONS.md — the mention kind's fields, forms and labels.

const user = (id: string, over: Partial<MentionUser> = {}): MentionUser => ({
  id,
  name: "Luke Breuer",
  initials: "LB",
  slug: "luke-breuer",
  deleted: false,
  botOf: null,
  ...over,
});

const context: MentionContext = {
  luke: user("luke"),
  andrew: user("andrew", { name: "Andrew Stone", initials: "AS", slug: "andrew-stone" }),
  nameless: user("nameless", { name: null, initials: "N", slug: "n-example" }),
  gone: user("gone", { name: "Gone Author", initials: "GA", slug: "gone-author", deleted: true }),
};

const labels = (chips: MentionData[], style: unknown = {}, ctx: MentionContext = context) =>
  mentionKind.render(chips, mentionKind.parseStyle(style), ctx).map((r) => r.label);

test("validate keeps a user id and a known form, and drops everything else", () => {
  assert.deepEqual(mentionKind.validate({ userId: "luke" }), { userId: "luke" });
  assert.deepEqual(mentionKind.validate({ userId: "luke", form: "initials" }), { userId: "luke", form: "initials" });
  assert.deepEqual(mentionKind.validate({ userId: "luke", form: "nickname" }), { userId: "luke" });
  assert.deepEqual(mentionKind.validate({ userId: "luke", label: "@Someone Else" }), { userId: "luke" });
  for (const bad of [null, undefined, "luke", [], {}, { userId: "" }, { userId: 7 }, { userId: "x".repeat(65) }]) {
    assert.equal(mentionKind.validate(bad), null, JSON.stringify(bad));
  }
});

test("identity is the user, and a mention continues no other", () => {
  assert.equal(mentionKind.identity({ userId: "luke", form: "initials" }), mentionKind.identity({ userId: "luke" }));
  assert.notEqual(mentionKind.identity({ userId: "luke" }), mentionKind.identity({ userId: "andrew" }));
  assert.equal(mentionKind.continues({ userId: "luke" }, { userId: "andrew" }), false);
  assert.deepEqual(mentionKind.targets({ userId: "luke" }), ["luke"]);
});

test("each form, with its own default for the @", () => {
  const chip = [{ userId: "luke" }];
  assert.deepEqual(labels(chip), ["@Luke Breuer"]);
  assert.deepEqual(labels(chip, { form: "name" }), ["@Luke Breuer"]);
  assert.deepEqual(labels(chip, { form: "initials" }), ["LB"]);
  assert.deepEqual(labels(chip, { form: "handle" }), ["@luke-breuer"]);
});

test("each form with and without the @", () => {
  const chip = [{ userId: "luke" }];
  assert.deepEqual(labels(chip, { form: "name", at: false }), ["Luke Breuer"]);
  assert.deepEqual(labels(chip, { form: "initials", at: true }), ["@LB"]);
  assert.deepEqual(labels(chip, { form: "handle", at: false }), ["luke-breuer"]);
});

test("a chip's own form overrides the doc's", () => {
  assert.deepEqual(labels([{ userId: "luke", form: "initials" }, { userId: "andrew" }], { form: "name" }), [
    "LB",
    "@Andrew Stone",
  ]);
});

test("a style this build doesn't recognise falls back to the default", () => {
  for (const style of [null, "name", { form: "nickname" }, { form: 3, at: "yes" }]) {
    assert.deepEqual(labels([{ userId: "luke" }], style), ["@Luke Breuer"], JSON.stringify(style));
  }
});

test("an account with no name shows its handle", () => {
  assert.deepEqual(labels([{ userId: "nameless" }]), ["@n-example"]);
  assert.deepEqual(labels([{ userId: "nameless" }], {}, { nameless: user("nameless", { name: "  ", slug: "n-example" }) }), [
    "@n-example",
  ]);
});

test("a live mention links to the author page", () => {
  const [rendering] = mentionKind.render([{ userId: "luke" }], mentionKind.parseStyle({}), context);
  assert.deepEqual(rendering, {
    label: "@Luke Breuer",
    href: "/authors/luke-breuer",
    postHref: "/authors/luke-breuer",
    status: "live",
  });
});

test("a deleted account keeps its label, unlinked", () => {
  const [rendering] = mentionKind.render([{ userId: "gone" }], mentionKind.parseStyle({}), context);
  assert.deepEqual(rendering, { label: "@Gone Author", href: null, postHref: null, status: "deleted" });
});

test("an id that resolves to nothing is an unknown person", () => {
  const [rendering] = mentionKind.render([{ userId: "nobody" }], mentionKind.parseStyle({}), context);
  assert.deepEqual(rendering, { label: UNKNOWN_PERSON, href: null, postHref: null, status: "unknown" });
});

test("two accounts with one name are told apart: a bot by its person, a person by their handle", () => {
  const ctx: MentionContext = {
    bot1: user("bot1", { name: "Claude", initials: "C", slug: "claude", botOf: "Luke Breuer" }),
    bot2: user("bot2", { name: "Claude", initials: "C", slug: "claude-2", botOf: "Andrew Stone" }),
    twin: user("twin", { name: "Luke Breuer", initials: "LB", slug: "luke-breuer-2" }),
    luke: user("luke"),
  };
  assert.deepEqual(labels([{ userId: "bot1" }, { userId: "bot2" }], {}, ctx), [
    "@Claude (Luke Breuer)",
    "@Claude (Andrew Stone)",
  ]);
  assert.deepEqual(labels([{ userId: "luke" }, { userId: "twin" }], {}, ctx), [
    "@Luke Breuer (luke-breuer)",
    "@Luke Breuer (luke-breuer-2)",
  ]);
});

test("the same account mentioned twice is not a clash, and one bot alone needs no person", () => {
  const ctx: MentionContext = { bot1: user("bot1", { name: "Claude", slug: "claude", botOf: "Luke Breuer" }) };
  assert.deepEqual(labels([{ userId: "bot1" }, { userId: "bot1" }], {}, ctx), ["@Claude", "@Claude"]);
});

test("the same rule tells apart two people with the same initials, and handles never clash", () => {
  const ctx: MentionContext = {
    a: user("a", { name: "Luke Breuer", initials: "LB", slug: "luke-breuer" }),
    b: user("b", { name: "Lena Brandt", initials: "LB", slug: "lena-brandt" }),
  };
  const chips = [{ userId: "a" }, { userId: "b" }];
  assert.deepEqual(labels(chips, { form: "initials" }, ctx), ["LB (luke-breuer)", "LB (lena-brandt)"]);
  assert.deepEqual(labels(chips, { form: "name" }, ctx), ["@Luke Breuer", "@Lena Brandt"]);
  assert.deepEqual(labels(chips, { form: "handle" }, ctx), ["@luke-breuer", "@lena-brandt"]);
});

test("a clash is per label: one chip's own form can clash where the doc's doesn't", () => {
  const ctx: MentionContext = {
    a: user("a", { name: "Luke Breuer", initials: "LB", slug: "luke-breuer" }),
    b: user("b", { name: "Lena Brandt", initials: "LB", slug: "lena-brandt" }),
  };
  assert.deepEqual(labels([{ userId: "a", form: "initials" }, { userId: "b", form: "initials" }, { userId: "b" }], {}, ctx), [
    "LB (luke-breuer)",
    "LB (lena-brandt)",
    "@Lena Brandt",
  ]);
});
