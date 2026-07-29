"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { updateDocVisibility, updateDocAuthor, updateDocAuthorOrder, deleteDoc, restoreDoc } from "@/app/actions/docs";
import { DocVisibility, type Role } from "@/generated/prisma/enums";
import styles from "./DocSettingsPanel.module.css";

export type EligibleUser = {
  id: string;
  name: string | null;
  email: string;
  role: Role;
};

type Props = {
  docId: string;
  visibility: DocVisibility;
  createdAt: Date;
  authorIds: string[];
  eligibleUsers: EligibleUser[];
  deleted: boolean;
  onDeletedChange: (deleted: boolean) => void;
};

// A smaller sibling of PostSettingsPanel (PLAN.md §12k) — no revisions
// table (a doc has none), no moderation policy (annotations are never
// moderated), no changelog. Authors + reorder + delete/restore are lifted
// straight from PostSettingsPanel's identical rationale.
export default function DocSettingsPanel({
  docId,
  visibility,
  createdAt,
  authorIds,
  eligibleUsers,
  deleted,
  onDeletedChange,
}: Props) {
  const router = useRouter();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [visibilityValue, setVisibilityValue] = useState(visibility);
  const [authors, setAuthors] = useState(new Set(authorIds));
  const [order, setOrder] = useState<string[]>(() => {
    const rest = eligibleUsers.map((u) => u.id).filter((id) => !authorIds.includes(id));
    return [...authorIds, ...rest];
  });
  const usersById = useMemo(() => new Map(eligibleUsers.map((u) => [u.id, u])), [eligibleUsers]);
  const dragIdRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  function handleVisibilityChange(next: DocVisibility) {
    const prev = visibilityValue;
    setVisibilityValue(next);
    setError(null);
    startTransition(async () => {
      try {
        await updateDocVisibility(docId, next);
        router.refresh();
      } catch (e) {
        setVisibilityValue(prev);
        setError(e instanceof Error ? e.message : "Failed to update visibility.");
      }
    });
  }

  function handleAuthorToggle(userId: string, included: boolean) {
    const prev = new Set(authors);
    const next = new Set(authors);
    if (included) next.add(userId);
    else next.delete(userId);
    setAuthors(next);
    setError(null);
    const checkedOrder = order.filter((id) => next.has(id));
    startTransition(async () => {
      try {
        await updateDocAuthor(docId, userId, included);
        await updateDocAuthorOrder(docId, checkedOrder);
        router.refresh();
      } catch (e) {
        setAuthors(prev);
        setError(e instanceof Error ? e.message : "Failed to update authors.");
      }
    });
  }

  function handleDrop(targetId: string) {
    const dragId = dragIdRef.current;
    dragIdRef.current = null;
    setDragOverId(null);
    if (!dragId || dragId === targetId || !authors.has(dragId) || !authors.has(targetId)) return;

    const next = [...order];
    const from = next.indexOf(dragId);
    const to = next.indexOf(targetId);
    next.splice(from, 1);
    next.splice(to, 0, dragId);
    setOrder(next);

    const checkedOrder = next.filter((id) => authors.has(id));
    setError(null);
    startTransition(async () => {
      try {
        await updateDocAuthorOrder(docId, checkedOrder);
        router.refresh();
      } catch (e) {
        setOrder(order);
        setError(e instanceof Error ? e.message : "Failed to reorder authors.");
      }
    });
  }

  function handleDeleteToggle() {
    setError(null);
    startTransition(async () => {
      try {
        if (deleted) {
          await restoreDoc(docId);
          onDeletedChange(false);
        } else {
          await deleteDoc(docId);
          onDeletedChange(true);
        }
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update doc.");
      }
    });
  }

  return (
    <details
      ref={detailsRef}
      className={styles.details}
      onToggle={(e) => {
        if (e.currentTarget.open) e.currentTarget.scrollIntoView({ block: "start", behavior: "smooth" });
      }}
    >
      <summary className={styles.summary}>Settings</summary>
      <div className={styles.body}>
        <fieldset className={styles.field}>
          <legend className={styles.label}>Authors</legend>
          <div className={styles.checkboxList}>
            {order.map((userId) => {
              const user = usersById.get(userId);
              if (!user) return null;
              const checked = authors.has(userId);
              return (
                <label
                  key={userId}
                  className={`${styles.checkboxRow} ${checked ? styles.draggableRow : ""} ${dragOverId === userId ? styles.dragOver : ""}`}
                  draggable={checked && !pending && !deleted}
                  onDragStart={() => {
                    dragIdRef.current = userId;
                  }}
                  onDragOver={(e) => {
                    if (!checked || !dragIdRef.current) return;
                    e.preventDefault();
                    setDragOverId(userId);
                  }}
                  onDragLeave={() => setDragOverId((id) => (id === userId ? null : id))}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleDrop(userId);
                  }}
                  onDragEnd={() => {
                    dragIdRef.current = null;
                    setDragOverId(null);
                  }}
                >
                  {checked && <span className={styles.dragHandle}>⠿</span>}
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={pending || deleted}
                    onChange={(e) => handleAuthorToggle(userId, e.target.checked)}
                  />
                  {user.name ?? user.email} <span className={styles.roleTag}>({user.role})</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <table className={styles.detailsTable}>
          <tbody>
            <tr>
              <td className={styles.label}>Visibility</td>
              <td>
                <select
                  value={visibilityValue}
                  disabled={pending || deleted}
                  onChange={(e) => handleVisibilityChange(e.target.value as DocVisibility)}
                  className={styles.visibilitySelect}
                >
                  {Object.values(DocVisibility).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
            <tr>
              <td className={styles.label}>Url</td>
              <td>
                <Link href={`/doc/${docId}/slug`}>Change…</Link>
              </td>
            </tr>
            <tr>
              <td className={styles.label}>Created</td>
              <td>{createdAt.toString()}</td>
            </tr>
          </tbody>
        </table>

        <button type="button" onClick={handleDeleteToggle} disabled={pending} className={styles.deleteButton}>
          {deleted ? "Undelete" : "Delete"}
        </button>

        {error && <p className={styles.errorMessage}>{error}</p>}
      </div>
    </details>
  );
}
