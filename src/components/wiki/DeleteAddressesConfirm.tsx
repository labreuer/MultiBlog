"use client";

import type { WikiAddressHistoryEntry } from "@/lib/wiki-rename";
import LocalTime from "../LocalTime";

// docs/WIKI.md "Deleting a page" — what a delete asks first, of a doc that
// has past wiki addresses: each old address, when the page left it, and
// whether it holds the address or only redirects; and that they stop
// redirecting at once, and that restoring the page won't bring them back. A
// doc with none deletes without asking, since Undelete undoes all of it. The
// editor's Delete, and the wiki table's row and bulk Delete, show it.

export type DocAddressHistory = {
  /** What the doc is called in a list of several, for a bulk Delete; left out for one. */
  label?: string;
  history: WikiAddressHistoryEntry[];
};

/** The past addresses a delete takes, and what that means: the body of every confirmation, the bulk toolbar's included, which draws its own buttons. */
export function AddressHistoryList({ docs }: { docs: DocAddressHistory[] }) {
  const several = docs.length > 1 || docs.some((doc) => doc.label !== undefined);
  return (
    <div data-delete-addresses="">
      <p>
        {several
          ? "These have past addresses, which are deleted with them:"
          : "Its past wiki addresses are deleted with it:"}
      </p>
      {docs.map((doc, i) => (
        <div key={i} style={{ marginTop: 4 }}>
          {doc.label !== undefined && <strong>{doc.label}</strong>}
          <ul style={{ margin: "2px 0 0 1.25em", listStyle: "disc" }}>
            {doc.history.map((row) => (
              <li key={row.id}>
                <code>{row.path}</code>, left <LocalTime value={row.leftAt} />,{" "}
                {row.reserved ? "held for this page" : "redirecting only"}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p style={{ marginTop: 6, color: "var(--text-secondary)" }}>
        They stop redirecting at once, and their addresses are free for any page. Restoring won&apos;t bring them back.
      </p>
    </div>
  );
}

/** AddressHistoryList with its own Delete and Cancel: the editor's Delete, and a wiki table row's. */
export default function DeleteAddressesConfirm({
  docs,
  pending,
  onConfirm,
  onCancel,
}: {
  docs: DocAddressHistory[];
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="alertdialog" aria-label="Delete past addresses too?" data-delete-addresses-confirm="" style={{ margin: "8px 0" }}>
      <AddressHistoryList docs={docs} />
      <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
        <button type="button" onClick={onConfirm} disabled={pending} style={{ color: "var(--danger)" }}>
          Delete
        </button>
        <button type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </div>
  );
}
