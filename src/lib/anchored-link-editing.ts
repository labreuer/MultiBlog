// docs/ANCHORED_LINKS.md, "Editing a minted link" — what an Edit affordance
// shows, decided from the viewer's open link (open-link-store.ts) rather
// than asked of the server: the moment the tray's Copy link or Discard
// finishes, every Edit button on the page re-derives itself from the same
// store the tray just re-rendered from, with no refresh. Browser-safe — no
// Prisma, no session — and pure, so the four arms have a unit test.
//
// The strings the server also refuses with live here, exported, so the hint
// beside a disabled button and the action's own rejection (the stale-tab
// case: a second tab still showing last minute's state) can never drift.

export const DRAFT_BLOCKS_EDIT_MESSAGE = "Copy or discard your draft link first.";
export const LAST_PART_MESSAGE = "A shared link keeps at least one passage — delete the link instead.";

/** The slice of the open link an affordance needs — the store's view, or a test's literal. */
export type OpenLinkSummary = { id: string; minted: boolean; partCount: number };

export type EditAffordance =
  /** The store hasn't answered yet: render nothing rather than a button that flips a moment later. */
  | { state: "unknown" }
  /**
   * Edit may proceed: nothing is open, or an empty draft is (the action
   * discards it — it is the row removing a draft's last part leaves behind),
   * or another minted link is mid-edit (its edits were live, so closing it
   * loses nothing).
   */
  | { state: "ready" }
  /** This link is the one in the tray already; Done lives there. */
  | { state: "open-here" }
  /** A draft with passages is open. Finishing it is the viewer's call, so the button says why it waits. */
  | { state: "blocked"; reason: string };

export function editAffordance(open: OpenLinkSummary | null | undefined, linkId: string): EditAffordance {
  if (open === undefined) return { state: "unknown" };
  if (open === null) return { state: "ready" };
  if (open.id === linkId) return { state: "open-here" };
  if (!open.minted && open.partCount > 0) return { state: "blocked", reason: DRAFT_BLOCKS_EDIT_MESSAGE };
  return { state: "ready" };
}
