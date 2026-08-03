// What a batched admin-table action reports back (PLAN.md §16f/§16g).
//
// These actions delegate to the per-row action once per id and are
// deliberately not transactional (§16k), so "it failed" is rarely the whole
// truth: a selection mixing rows the caller may change with rows it may not —
// which is the normal case for anyone who isn't ADMIN — half succeeds. A
// `Promise<void>` over `Promise.all` cannot express that. It rejects on the
// first failure and discards which ids those were, so the browser learns one
// bit for the entire batch and the row borders have to redden every row,
// including the ones that saved.
//
// Returning this instead is what lets each row report its own outcome.
export type BulkFailure = { id: string; message: string };
export type BulkResult = { failed: BulkFailure[] };

/**
 * Why `message` is filtered rather than passed through.
 *
 * Next redacts the message of an error *thrown* out of a server action in
 * production, replacing it with a digest — which is a real protection, since a
 * raw Prisma rejection carries the failing query and absolute source paths.
 * A *returned* value gets no such treatment, so returning `reason.message`
 * verbatim would route around that protection and put those internals on an
 * admin's screen.
 *
 * The discriminator is that this codebase's own authorization guards throw
 * plain `new Error("You can't delete your own account.")`, whose `name` is
 * exactly `"Error"`, while anything from a library (`PrismaClientKnownRequest-
 * Error`, `TypeError`, …) carries its own name. So a plain Error is treated as
 * a message written to be read by the person who tripped it, and everything
 * else collapses to a generic string.
 *
 * `redacted` says which happened, because the generic branch is the one whose
 * real reason has to be logged instead of shown — see settleBulk. Erring
 * toward the generic is the safe direction precisely *because* nothing is
 * lost by it: the detail moves to the server log rather than disappearing.
 */
const GENERIC_MESSAGE = "Something went wrong on the server.";

function describeFailure(reason: unknown): { message: string; redacted: boolean } {
  if (reason instanceof Error && reason.name === "Error" && reason.message) {
    return { message: reason.message, redacted: false };
  }
  return { message: GENERIC_MESSAGE, redacted: true };
}

/**
 * Runs `perId` for every id and reports per-id outcomes instead of throwing.
 *
 * `Promise.allSettled` rather than `Promise.all` changes *reporting* only, not
 * what executes: `Promise.all` already starts every promise eagerly, so the
 * calls that were going to succeed have always run to completion even when an
 * earlier one rejected. This is the same behaviour, finally described
 * accurately.
 *
 * `fulfilled` carries each successful call's return value, for the callers
 * that need to act on it — `comments.ts` revalidates the posts its moderated
 * comments belonged to, and must now revalidate only the ones that landed.
 */
export async function settleBulk<T>(
  ids: string[],
  perId: (id: string) => Promise<T>,
): Promise<BulkResult & { fulfilled: T[] }> {
  const settled = await Promise.allSettled(ids.map((id) => perId(id)));

  const failed: BulkFailure[] = [];
  const fulfilled: T[] = [];
  settled.forEach((result, i) => {
    if (result.status === "fulfilled") {
      fulfilled.push(result.value);
      return;
    }

    const { message, redacted } = describeFailure(result.reason);
    // Logging the redacted ones is not optional bookkeeping — it replaces
    // something `Promise.allSettled` took away. Under `Promise.all` the first
    // rejection propagated out of the server action and Next logged it (with a
    // digest in production, to correlate against exactly this). allSettled
    // captures the rejection instead, so nothing throws, so nothing is logged,
    // and a generic sentence on an admin's screen would be the only trace the
    // failure ever happened.
    //
    // Only the redacted ones. A plain Error is one of this codebase's own
    // guards — "You can't delete your own account." — which the admin reads in
    // full; it is ordinary feedback, not a fault, and logging every refused
    // authorization at error level would bury the real ones.
    //
    // The row id is the correlation key: it is in this line, and the UI marks
    // that exact row red, so "the failure I saw" and "the line in the log" can
    // be matched without a separate request id.
    if (redacted) {
      console.error(`[bulk] ${ids[i]} failed:`, result.reason);
    }
    failed.push({ id: ids[i], message });
  });

  return { failed, fulfilled };
}
