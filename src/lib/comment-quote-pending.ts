// PLAN.md §23g/§23n — a quotation the rich composer has inserted but the
// server has not yet resolved: the body carries a placeholder `anchorId`,
// and this is what the placeholder points at. Rides in the draft, crosses
// the action boundary as a JSON string, and is only ever a *hint* — the
// server re-finds the words itself and stores its own derivation (§23f).
// The Markdown box never produces one; there the matcher has only the text.
//
// Browser-safe: no Prisma, no parser.

export const PENDING_ANCHOR_PREFIX = "pending:";

export type PendingQuoteTarget = { kind: "post" | "comment"; id: string };

export type PendingQuoteHint = {
  /**
   * The placeholder in the body: `pending:<random>` — or null for an
   * *unbound* hint, which names a target to search without saying which
   * span it belongs to. The Markdown box has no ids to bind to, and the
   * off-page picker (PLAN.md §23h, Phase 4) must still tell the matcher
   * which post or comment to load, since it is not on the page.
   */
  id: string | null;
  target: PendingQuoteTarget;
  /** The selection's ProseMirror offsets in the target, when the composer had them (the article's editor); absent for a DOM selection in a comment card. */
  from?: number;
  to?: number;
  /** The words as selected. Used to find the range, never stored. */
  text: string;
};

/** The most hints one submission may carry — matches the per-comment quotation cap. */
export const MAX_PENDING_QUOTES = 20;

export function newPendingAnchorId(): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${PENDING_ANCHOR_PREFIX}${random}`;
}

export function isPendingAnchorId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PENDING_ANCHOR_PREFIX);
}

/**
 * Narrows the untrusted wire value (a JSON string from a hidden form field
 * or an action argument) to well-formed hints. Malformed entries are
 * dropped rather than refused: a hint is only ever a shortcut for the
 * matcher, and a comment with a bad hint is still a comment.
 */
export function parsePendingQuoteHints(raw: unknown): PendingQuoteHint[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const hints: PendingQuoteHint[] = [];
  for (const entry of parsed.slice(0, MAX_PENDING_QUOTES)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const target = e.target as Record<string, unknown> | undefined;
    if ((e.id !== null && !isPendingAnchorId(e.id)) || typeof e.text !== "string" || !e.text.trim()) continue;
    if (!target || (target.kind !== "post" && target.kind !== "comment") || typeof target.id !== "string" || !target.id) {
      continue;
    }
    const hint: PendingQuoteHint = {
      id: isPendingAnchorId(e.id) ? e.id : null,
      target: { kind: target.kind, id: target.id },
      text: e.text,
    };
    if (Number.isInteger(e.from) && Number.isInteger(e.to) && (e.to as number) > (e.from as number) && (e.from as number) >= 0) {
      hint.from = e.from as number;
      hint.to = e.to as number;
    }
    hints.push(hint);
  }
  return hints;
}
