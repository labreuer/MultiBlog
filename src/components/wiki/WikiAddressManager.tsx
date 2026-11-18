"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { deleteWikiAddressRowAction, renameWikiPageAction, revertWikiAddressAction, type WikiRenameState } from "@/app/actions/wiki";
import { checkWikiName } from "@/lib/wiki-name";
import { isWikiVariant } from "@/lib/wiki-address";
import type { WikiAddressHistoryEntry } from "@/lib/wiki-rename";
import LocalTime from "../LocalTime";

// docs/WIKI.md "Renaming", "The control and the history" — a wiki page's
// address on /doc/<slug>/slug: Rename, which takes the name and the variant
// (the editor's name field takes the name alone), and the address history,
// each row saying whether it holds its address or only redirects when
// nothing else answers, with Revert on the most recent reserved row and a
// delete on each, which ends its redirect and, for a reserved row, frees its
// address. The server asks every rule again (wiki-rename.ts). For a doc
// moved out of the wiki, which has no address and keeps its released rows
// ("Moving out of the wiki"), only the history and its deletes.

type Props = {
  docId: string;
  /** The page's address and name, null for a doc moved out of the wiki. */
  path: string | null;
  name: string | null;
  variant: string;
  history: WikiAddressHistoryEntry[];
};

const cell = { padding: "4px 8px 4px 0" } as const;

export default function WikiAddressManager({ docId, path, name, variant, history }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(name ?? "");
  const [variantDraft, setVariantDraft] = useState(variant);
  const [error, setError] = useState<{ message: string; takenPath?: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const checked = checkWikiName(nameDraft);
  const variantOk = isWikiVariant(variantDraft.trim());
  const changed = checked.ok && (checked.name !== name || variantDraft.trim() !== variant);
  const what = path === null ? "doc" : "page";
  const newestReserved = history.find((row) => row.reserved)?.id ?? null;

  function settle(answer: WikiRenameState) {
    if (!answer.ok) {
      setError({ message: answer.error, takenPath: answer.takenPath });
      return;
    }
    setEditing(false);
    router.refresh();
  }

  function rename() {
    if (!checked.ok || !variantOk) return;
    setError(null);
    startTransition(async () => settle(await renameWikiPageAction(docId, checked.name, variantDraft.trim())));
  }

  function revert() {
    setError(null);
    startTransition(async () => settle(await revertWikiAddressAction(docId)));
  }

  function deleteRow(rowId: string) {
    setError(null);
    startTransition(async () => {
      const answer = await deleteWikiAddressRowAction(docId, rowId);
      if (answer.error) {
        setError({ message: answer.error });
        return;
      }
      setConfirmingDelete(null);
      router.refresh();
    });
  }

  return (
    <section data-wiki-address-manager="" style={{ marginBottom: "2.5em" }}>
      {path !== null && (
        <p>
          Address: <Link href={path}>{path}</Link>
          {!editing && (
            <>
              {" "}
              <button
                type="button"
                onClick={() => {
                  setNameDraft(name ?? "");
                  setVariantDraft(variant);
                  setError(null);
                  setEditing(true);
                }}
                style={{ marginLeft: 4 }}
              >
                Rename…
              </button>
            </>
          )}
        </p>
      )}
      {editing && path !== null && (
        <div style={{ margin: "8px 0", display: "grid", gap: 6, maxWidth: 420 }}>
          <label>
            Name{" "}
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              disabled={pending}
              aria-label="Name"
              style={{ padding: "4px 6px", width: "100%" }}
            />
          </label>
          <label>
            Variant{" "}
            <input
              value={variantDraft}
              onChange={(e) => setVariantDraft(e.target.value)}
              disabled={pending}
              aria-label="Variant"
              placeholder="none: the page itself"
              style={{ padding: "4px 6px", width: "100%" }}
            />
          </label>
          {!checked.ok && nameDraft !== "" && <p style={{ color: "var(--error)", fontSize: "0.85rem" }}>{checked.message}</p>}
          {!variantOk && (
            <p style={{ color: "var(--error)", fontSize: "0.85rem" }}>
              A variant is lowercase letters, digits and single dashes, or nothing for the page itself.
            </p>
          )}
          <div>
            <button type="button" onClick={rename} disabled={pending || !changed || !variantOk}>
              Rename
            </button>{" "}
            <button type="button" onClick={() => setEditing(false)} disabled={pending}>
              Cancel
            </button>
          </div>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            The address it leaves stays this page&apos;s: links to it still reach the page, and no other page can take it
            until you delete it below. A change of capitals alone keeps nothing.
          </p>
        </div>
      )}
      {error && (
        <p style={{ color: "var(--error)", fontSize: "0.85rem" }} role="alert">
          {error.message}
          {error.takenPath && (
            <>
              {" "}
              <Link href={error.takenPath}>See the page there.</Link>
            </>
          )}
        </p>
      )}

      <h2 style={{ fontSize: "1rem", marginTop: path === null ? 0 : 24 }}>{path === null ? "Past wiki addresses" : "Past addresses"}</h2>
      {history.length === 0 ? (
        <p style={{ color: "var(--text-secondary)" }}>No past addresses.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }} data-wiki-address-history="">
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
              <th style={cell}>Address</th>
              <th style={cell}>Left on</th>
              <th style={cell}>By</th>
              <th style={cell}>Holds it?</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {history.map((row) => (
              <tr key={row.id} style={{ borderBottom: "1px solid var(--border-subtle)" }} data-wiki-address-row={row.path}>
                <td style={cell}>{row.path}</td>
                <td style={{ ...cell, color: "var(--text-secondary)" }}>
                  <LocalTime value={row.leftAt} />
                </td>
                <td style={{ ...cell, color: "var(--text-secondary)" }}>{row.movedBy ?? "—"}</td>
                <td style={{ ...cell, color: "var(--text-secondary)" }}>
                  {row.reserved ? "Yes: no other page can take it" : "No: it redirects only when nothing else is there"}
                </td>
                <td style={cell}>
                  {row.id === newestReserved && (
                    <button type="button" onClick={revert} disabled={pending}>
                      Revert
                    </button>
                  )}
                </td>
                <td style={{ padding: "4px 0" }}>
                  {confirmingDelete === row.id ? (
                    <span style={{ color: "var(--text-secondary)" }}>
                      Delete?{" "}
                      <button
                        type="button"
                        onClick={() => deleteRow(row.id)}
                        disabled={pending}
                        style={{ fontWeight: "bold", color: "var(--success)" }}
                      >
                        Yes
                      </button>{" "}
                      /{" "}
                      <button
                        type="button"
                        onClick={() => setConfirmingDelete(null)}
                        disabled={pending}
                        style={{ fontWeight: "bold", color: "var(--danger)" }}
                      >
                        No
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingDelete(row.id)}
                      disabled={pending}
                      style={{ color: "var(--danger)" }}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {history.length > 0 && (
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", marginTop: "0.5em" }}>
          A past address sends whoever may read this {what} on to it. Deleting one ends that, and frees the address for
          another page.
          {path !== null && <> Revert inside an hour of a rename undoes it outright, and keeps nothing for the address it leaves.</>}
        </p>
      )}
    </section>
  );
}
