import type { ChipKind, ChipRendering } from "../types";

// docs/MENTIONS.md — a mention stands for a person: a MultiBlog account. This
// is the kind's browser-safe part; its context loader is mention-context.ts.

export const MENTION = "mention";

export const MENTION_FORMS = ["name", "initials", "handle"] as const;
export type MentionForm = (typeof MENTION_FORMS)[number];

/** A mention's fields: who, and an optional form overriding the doc's. */
export type MentionData = { userId: string; form?: MentionForm };

/** A doc's choice for its mentions. */
export type MentionStyle = {
  form: MentionForm;
  /** Whether a label starts with `@`. Null takes the form's own default: on, except for initials. */
  at: boolean | null;
};

/** What a mention's label is computed from. Never an email address. */
export type MentionUser = {
  id: string;
  name: string | null;
  initials: string;
  slug: string;
  deleted: boolean;
  /** The person a bot works for, by name; null for a person's own account. */
  botOf: string | null;
};

/** One row of a mention menu: who, and whether they could read the doc they'd be mentioned in. */
export type MentionCandidate = { user: MentionUser; canRead: boolean };

/** The mention context: the users a doc's mentions name, by id, deleted ones included. */
export type MentionContext = Record<string, MentionUser>;

export const UNKNOWN_PERSON = "unknown person";

// A cuid today, and a pasted or hand-written id is whatever its author typed:
// bounded, so a chip can't carry a document's worth of text as an id.
const MAX_ID_LENGTH = 64;

function isForm(value: unknown): value is MentionForm {
  return typeof value === "string" && (MENTION_FORMS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The account's name as a mention shows it: its name, or its handle when it has none. */
function nameOf(user: MentionUser): string {
  return user.name?.trim() || user.slug;
}

function baseLabel(user: MentionUser, form: MentionForm): string {
  if (form === "handle") return user.slug;
  if (form === "initials") return user.initials.trim() || nameOf(user);
  return nameOf(user);
}

/** What tells apart two accounts whose labels are the same: a bot's person, or a person's handle. */
function qualifier(user: MentionUser, form: MentionForm): string | null {
  if (user.botOf?.trim()) return user.botOf.trim();
  // A handle is unique, and a label that is already the handle gains nothing from repeating it.
  return form === "handle" || baseLabel(user, form) === user.slug ? null : user.slug;
}

export const mentionKind: ChipKind<MentionData, MentionStyle, MentionContext> = {
  name: MENTION,

  validate(data) {
    if (!isRecord(data)) return null;
    const { userId, form } = data;
    if (typeof userId !== "string" || userId === "" || userId.length > MAX_ID_LENGTH) return null;
    return isForm(form) ? { userId, form } : { userId };
  },

  identity: (data) => data.userId,

  // A changed user id is a different mention.
  continues: () => false,

  targets: (data) => [data.userId],

  parseStyle(raw) {
    const style = isRecord(raw) ? raw : {};
    return {
      form: isForm(style.form) ? style.form : "name",
      at: typeof style.at === "boolean" ? style.at : null,
    };
  },

  parseContext(raw) {
    return isRecord(raw) ? (raw as MentionContext) : {};
  },

  render(chips, style, context) {
    const formOf = (data: MentionData) => data.form ?? style.form;

    // Which accounts each bare label stands for in this doc. Two that share
    // one are told apart; a label only one account wears is left alone.
    const wearers = new Map<string, Set<string>>();
    for (const data of chips) {
      const user = context[data.userId];
      if (!user) continue;
      const label = baseLabel(user, formOf(data));
      let ids = wearers.get(label);
      if (!ids) wearers.set(label, (ids = new Set()));
      ids.add(user.id);
    }

    return chips.map((data): ChipRendering => {
      const user = context[data.userId];
      if (!user) return { label: UNKNOWN_PERSON, href: null, postHref: null, status: "unknown" };
      const form = formOf(data);
      const at = style.at ?? form !== "initials";
      const base = baseLabel(user, form);
      const extra = (wearers.get(base)?.size ?? 0) > 1 ? qualifier(user, form) : null;
      const label = `${at ? "@" : ""}${base}${extra ? ` (${extra})` : ""}`;
      // The author page, in a doc and in a post alike.
      const href = `/authors/${user.slug}`;
      return user.deleted
        ? { label, href: null, postHref: null, status: "deleted" }
        : { label, href, postHref: href, status: "live" };
    });
  },
};
