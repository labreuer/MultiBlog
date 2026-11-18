"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { actorFromSessionUser, type Actor } from "@/lib/actor";
import { ApiError } from "@/lib/api/errors";
import { settleBulk, type BulkResult } from "@/lib/bulk-result";
import { mintJoinBatch, revokeJoinCard, revokeJoinCards } from "@/lib/join-codes/cards";
import { parseJoinExpiry } from "@/lib/join-codes/expiry";

// /join-codes' writes (docs/EMAIL.md §10, "Minting and printing"): minting a
// batch, and revoking a card, a selection of cards or a batch. Each is a
// wrapper over src/lib/join-codes/cards.ts, which holds the ADMIN gate (the
// session's role and the account row's) and every rule, as it does for
// scripts/join-codes/mint.ts.
//
// Minting answers with the batch's id alone. The codes are never sent to the
// browser by an action: the sheet derives them again, at
// /join-codes/print?batch=<id>.

export type JoinCodesAnswer<T> = { ok: true; value: T } | { ok: false; error: string };

/** A refusal is an ApiError's message; anything else is a fault, logged and answered in a line that says to reload. */
async function answering<T>(what: string, run: (actor: Actor) => Promise<T>): Promise<JoinCodesAnswer<T>> {
  const session = await auth();
  if (!session?.user) return { ok: false, error: "You are signed out. Sign in, then try again." };
  try {
    return { ok: true, value: await run(actorFromSessionUser(session.user)) };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    console.error(`[join-codes] ${what} failed:`, err);
    return { ok: false, error: "That didn't work. Reload the page and try again." };
  }
}

function revalidate(): void {
  revalidatePath("/join-codes");
  revalidatePath("/dashboard");
}

/**
 * A batch, from the mint form. `expires` is the form's date, read as the end
 * of that day, UTC, as the script reads its --expires.
 */
export async function mintJoinBatchAction(input: {
  label: unknown;
  count: unknown;
  expires: unknown;
}): Promise<JoinCodesAnswer<{ batchId: string; count: number }>> {
  const label = typeof input.label === "string" ? input.label : "";
  const count = typeof input.count === "number" ? input.count : Number(input.count);
  const expiresAt = typeof input.expires === "string" ? parseJoinExpiry(input.expires) : null;
  if (!expiresAt) return { ok: false, error: "A batch needs an expiry date." };
  const answer = await answering("mint", async (actor) => {
    const { batchId, cards } = await mintJoinBatch(actor, { label, count, expiresAt });
    return { batchId, count: cards.length };
  });
  if (answer.ok) revalidate();
  return answer;
}

/** One card, from its row. Answers how many cards it ended: 0 for one already claimed or revoked. */
export async function revokeJoinCardAction(cardId: unknown): Promise<JoinCodesAnswer<number>> {
  if (typeof cardId !== "string") return { ok: false, error: "That isn't a card." };
  const answer = await answering("revoke card", (actor) => revokeJoinCard(actor, cardId));
  if (answer.ok) revalidate();
  return answer;
}

/** The selected cards, one at a time, each reporting its own outcome. */
export async function bulkRevokeJoinCards(ids: string[]): Promise<BulkResult> {
  const session = await auth();
  if (!session?.user) throw new Error("You are signed out. Sign in, then try again.");
  const actor = actorFromSessionUser(session.user);
  const { failed } = await settleBulk(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [], (id) =>
    revokeJoinCard(actor, id),
  );
  revalidate();
  return { failed };
}

/** A whole batch: its unclaimed cards end, and every pending claim's password hash goes with them. */
export async function revokeJoinBatchAction(batchId: unknown): Promise<JoinCodesAnswer<number>> {
  if (typeof batchId !== "string") return { ok: false, error: "That isn't a batch." };
  const answer = await answering("revoke batch", (actor) => revokeJoinCards(actor, batchId));
  if (answer.ok) revalidate();
  return answer;
}
