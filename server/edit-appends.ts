// docs/MCP.md §6 — "which `ydoc_update` row did my edit become". A targeted
// edit answers with the id its own update was appended as — never the doc's
// newest row (`drainAppends`), which can be a keystroke that landed after
// it — because reverting the edit later starts from exactly that row.
//
// The edit endpoint opens its direct connection with a context carrying a
// fresh `editId`; Hocuspocus hands that context to onChange for the
// transaction the connection makes, and ydocOnChange settles the wait with
// whatever `appendUpdate` reports. In-memory, like the append queues: an edit
// waits on it for seconds at most.

const waiting = new Map<string, (id: bigint | null) => void>();

/** Starts waiting for `editId`'s append; the promise settles with its row id, or null after `timeoutMs`. */
export function expectAppend(editId: string, timeoutMs = 10_000): { appended: Promise<bigint | null>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const appended = new Promise<bigint | null>((resolve) => {
    waiting.set(editId, resolve);
    timer = setTimeout(() => {
      waiting.delete(editId);
      resolve(null);
    }, timeoutMs);
  });
  const cancel = () => {
    if (timer) clearTimeout(timer);
    const resolve = waiting.get(editId);
    waiting.delete(editId);
    resolve?.(null);
  };
  return { appended: appended.finally(() => timer && clearTimeout(timer)), cancel };
}

/** Called by ydocOnChange with the context of the transaction it appended. */
export function settleAppend(context: unknown, id: bigint | null): void {
  const editId = (context as { editId?: unknown } | null | undefined)?.editId;
  if (typeof editId !== "string") return;
  const resolve = waiting.get(editId);
  if (!resolve) return;
  waiting.delete(editId);
  resolve(id);
}
