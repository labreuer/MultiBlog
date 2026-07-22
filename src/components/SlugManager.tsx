"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { updatePostSlug, deletePostSlugHistory, revertPostSlug } from "@/app/actions/posts";
import { updateUserSlug, deleteUserSlugHistory, revertUserSlug } from "@/app/actions/users";
import { REVERT_DISCARD_WINDOW_MS } from "@/lib/slug";

export type SlugHistoryRow = { slug: string; createdAt: string };

type Props = {
  entityType: "post" | "user";
  entityId: string;
  currentSlug: string;
  // What uniquePostSlug/uniqueUserSlug would produce from this entity's
  // title/name today (excluding the entity's own slug/history rows) — shown
  // so an admin can see whether the current slug has drifted from the
  // standard one, e.g. after a title change or a manual edit.
  standardSlug: string;
  // "" for a post ("/<slug>"), "/authors" for a user ("/authors/<slug>") —
  // only used to spell out the affected URL below.
  urlPrefix: string;
  history: SlugHistoryRow[];
};

// The one interactive surface for changing a post's or a user's slug and
// managing its PostSlugHistory/UserSlugHistory rows — deliberately its own
// page (linked from PostSettingsPanel / UsersTable) rather than an inline
// blur-to-save field, since a rename here 301s every existing link to the
// old slug and isn't something to trigger accidentally. Both entity types
// share this component since the interaction is identical; only which
// server actions get called differs (see entityType).
//
// Saving a new slug commits immediately (no confirm/cancel gate) — the
// safety net is the "Revert" button on the most recent past-slugs row
// instead, a one-click undo in the same spirit as the rest of the app's
// soft-delete/restore controls (PostsTable/UsersTable: no confirmation
// dialog, the action is its own undo).
export default function SlugManager({ entityType, entityId, currentSlug, standardSlug, urlPrefix, history }: Props) {
  const router = useRouter();
  const [slug, setSlug] = useState(currentSlug);
  const [rows, setRows] = useState(history);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(currentSlug);
  const [changeError, setChangeError] = useState<string | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [confirmingDeleteSlug, setConfirmingDeleteSlug] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function startEditing() {
    setDraft(slug);
    setEditing(true);
    setChangeError(null);
  }

  function cancelEditing() {
    setEditing(false);
    setChangeError(null);
  }

  function commitChange(newSlugValue: string) {
    setChangeError(null);
    const oldSlug = slug;
    startTransition(async () => {
      try {
        const result =
          entityType === "post" ? await updatePostSlug(entityId, newSlugValue) : await updateUserSlug(entityId, newSlugValue);
        setSlug(result.slug);
        setRows((prev) => [...prev, { slug: oldSlug, createdAt: new Date().toISOString() }]);
        setEditing(false);
        router.refresh();
      } catch (e) {
        setChangeError(e instanceof Error ? e.message : "Failed to change url.");
      }
    });
  }

  function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === slug) {
      cancelEditing();
      return;
    }
    commitChange(draft);
  }

  function handleUseStandard() {
    commitChange(standardSlug);
  }

  function handleRevert() {
    setRevertError(null);
    const oldSlug = slug;
    // The row being consumed is always the last one — mirror
    // revertPostSlug/revertUserSlug's own discard-if-recent check here so
    // the optimistic update matches what the server just did, instead of
    // unconditionally leaving a replacement row until router.refresh() lands.
    const consumedRow = rows[rows.length - 1];
    const keepReplacementRow = consumedRow
      ? Date.now() - new Date(consumedRow.createdAt).getTime() >= REVERT_DISCARD_WINDOW_MS
      : true;
    startTransition(async () => {
      try {
        const result = entityType === "post" ? await revertPostSlug(entityId) : await revertUserSlug(entityId);
        setSlug(result.slug);
        setRows((prev) =>
          keepReplacementRow
            ? [...prev.slice(0, -1), { slug: oldSlug, createdAt: new Date().toISOString() }]
            : prev.slice(0, -1),
        );
        router.refresh();
      } catch (e) {
        setRevertError(e instanceof Error ? e.message : "Failed to revert url.");
      }
    });
  }

  function handleDeleteHistory(historySlug: string) {
    setDeleteError(null);
    startTransition(async () => {
      try {
        if (entityType === "post") {
          await deletePostSlugHistory(entityId, historySlug);
        } else {
          await deleteUserSlugHistory(entityId, historySlug);
        }
        setRows((prev) => prev.filter((r) => r.slug !== historySlug));
        setConfirmingDeleteSlug(null);
        router.refresh();
      } catch (e) {
        setDeleteError(e instanceof Error ? e.message : "Failed to delete history entry.");
      }
    });
  }

  return (
    <div style={{ fontFamily: "sans-serif" }}>
      <p>
        Current url:{" "}
        <Link href={`${urlPrefix}/${slug}`}>
          <strong>
            {urlPrefix}/{slug}
          </strong>
        </Link>
        {!editing && (
          <>
            {" "}
            <button type="button" onClick={startEditing} style={{ marginLeft: 4 }}>
              Change…
            </button>
          </>
        )}
      </p>
      <p style={{ color: "#666", fontSize: "0.9rem", marginTop: "0.5em" }}>
        Auto-generated url: {urlPrefix}/{standardSlug}
        {standardSlug === slug ? (
          " — matches the current url."
        ) : (
          <>
            {" "}
            <button type="button" onClick={handleUseStandard} disabled={pending}>
              Use this url
            </button>
          </>
        )}
      </p>
      <p style={{ color: "#666", fontSize: "0.85rem", marginTop: "1em" }}>
        Urls may contain lowercase letters, numbers, and hyphens. Anything else — spaces,
        punctuation, uppercase — is converted automatically, and repeated or leading/trailing
        hyphens are trimmed.
      </p>

      {editing && (
        <div style={{ margin: "8px 0" }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={pending}
            style={{ padding: "4px 6px", width: 280 }}
          />{" "}
          <button type="button" onClick={handleSave} disabled={pending}>
            Save
          </button>{" "}
          <button type="button" onClick={cancelEditing} disabled={pending}>
            Cancel
          </button>
          {changeError && <p style={{ color: "crimson", fontSize: "0.85rem" }}>{changeError}</p>}
        </div>
      )}

      <h2 style={{ fontSize: "1rem", marginTop: 24 }}>Past urls</h2>
      {rows.length === 0 ? (
        <p style={{ color: "#666" }}>No past urls.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th style={{ padding: "4px 8px 4px 0" }}>Url</th>
              <th style={{ padding: "4px 8px 4px 0" }}>Changed on</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.slug} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: "4px 8px 4px 0" }}>
                  {urlPrefix}/{row.slug}
                </td>
                <td style={{ padding: "4px 8px 4px 0", color: "#666" }}>{new Date(row.createdAt).toLocaleString()}</td>
                <td style={{ padding: "4px 8px 4px 0" }}>
                  {i === rows.length - 1 && (
                    <button type="button" onClick={handleRevert} disabled={pending}>
                      Revert
                    </button>
                  )}
                </td>
                <td style={{ padding: "4px 0" }}>
                  {confirmingDeleteSlug === row.slug ? (
                    <span style={{ color: "#666" }}>
                      Delete?{" "}
                      <button
                        type="button"
                        onClick={() => handleDeleteHistory(row.slug)}
                        disabled={pending}
                        style={{ fontWeight: "bold", color: "#006400" }}
                      >
                        Yes
                      </button>{" "}
                      /{" "}
                      <button
                        type="button"
                        onClick={() => setConfirmingDeleteSlug(null)}
                        disabled={pending}
                        style={{ fontWeight: "bold", color: "#8b0000" }}
                      >
                        No
                      </button>
                    </span>
                  ) : (
                    <button type="button" onClick={() => setConfirmingDeleteSlug(row.slug)} disabled={pending} style={{ color: "#c00" }}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {revertError && <p style={{ color: "crimson", fontSize: "0.85rem" }}>{revertError}</p>}
      {deleteError && <p style={{ color: "crimson", fontSize: "0.85rem" }}>{deleteError}</p>}
    </div>
  );
}
