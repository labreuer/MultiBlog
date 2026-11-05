import type { MentionStyle } from "./mention";

// docs/ENTITY_CHIPS.md, "Styling" — the mention styles a person picks from,
// as one list for the doc's setting, the post's and the action that stores
// the post's. One list rather than a form and an "@" checkbox: there are
// five outcomes worth offering, and each reads as what a mention will look
// like. Browser-safe.

export type MentionOption = { value: string; label: string; style: MentionStyle };

export const MENTION_OPTIONS: readonly MentionOption[] = [
  { value: "name", label: "@Full Name", style: { form: "name", at: null } },
  { value: "name-plain", label: "Full Name", style: { form: "name", at: false } },
  { value: "initials", label: "Initials", style: { form: "initials", at: null } },
  { value: "initials-at", label: "@Initials", style: { form: "initials", at: true } },
  { value: "handle", label: "@handle", style: { form: "handle", at: null } },
];

/** The option that reads as `style` does. */
export function mentionOptionFor(style: MentionStyle): string {
  // A handle is offered one way, with its @.
  if (style.form === "handle") return "handle";
  const withAt = style.at ?? style.form !== "initials";
  if (style.form === "initials") return withAt ? "initials-at" : "initials";
  return withAt ? "name" : "name-plain";
}

export function mentionOption(value: string): MentionOption | null {
  return MENTION_OPTIONS.find((option) => option.value === value) ?? null;
}
