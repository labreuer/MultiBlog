"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  updatePostModerationPolicy,
  updatePostAuthor,
  updatePostAuthorOrder,
  deletePost,
  restorePost,
} from "@/app/actions/posts";
import { ModerationPolicy, type Role } from "@/generated/prisma/enums";
import { formatDate } from "@/lib/format-date";
import styles from "./PostSettingsPanel.module.css";

export type EligibleUser = {
  id: string;
  name: string | null;
  email: string;
  role: Role;
};

export type RevisionRow = {
  revisionNumber: number;
  title: string;
  editorName: string;
  changelog: string | null;
  createdAt: Date;
};

type Props = {
  postId: string;
  moderationPolicy: ModerationPolicy;
  createdAt: Date;
  publishedAt: Date | null;
  authorIds: string[];
  eligibleUsers: EligibleUser[];
  deleted: boolean;
  onDeletedChange: (deleted: boolean) => void;
  revisions: RevisionRow[];
  publishedRevisionNumber: number | null;
  scheduledRevisionNumber: number | null;
};

export default function PostSettingsPanel({
  postId,
  moderationPolicy,
  createdAt,
  publishedAt,
  authorIds,
  eligibleUsers,
  deleted,
  onDeletedChange,
  revisions,
  publishedRevisionNumber,
  scheduledRevisionNumber,
}: Props) {
  const router = useRouter();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [policy, setPolicy] = useState(moderationPolicy);
  const [authors, setAuthors] = useState(new Set(authorIds));
  // Checked-first (in bylineOrder, as authorIds already arrives sorted),
  // then the rest of eligibleUsers in their given (name-sorted) order.
  // Computed once and frozen — later checkbox toggles change `authors` but
  // deliberately never reshuffle this list; see the no-live-resort request.
  const [order, setOrder] = useState<string[]>(() => {
    const rest = eligibleUsers.map((u) => u.id).filter((id) => !authorIds.includes(id));
    return [...authorIds, ...rest];
  });
  const usersById = useMemo(() => new Map(eligibleUsers.map((u) => [u.id, u])), [eligibleUsers]);
  const dragIdRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const sortedRevisions = useMemo(
    () => [...revisions].sort((a, b) => a.revisionNumber - b.revisionNumber),
    [revisions],
  );

  function handlePolicyChange(next: ModerationPolicy) {
    const prev = policy;
    setPolicy(next);
    setError(null);
    startTransition(async () => {
      try {
        await updatePostModerationPolicy(postId, next);
        router.refresh();
      } catch (e) {
        setPolicy(prev);
        setError(e instanceof Error ? e.message : "Failed to update moderation policy.");
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
    // Reset bylineOrder to match the checkbox list's present (frozen) order
    // rather than leaving a newly-added author appended at the end — the
    // same renumbering handleDrop does after a reorder.
    const checkedOrder = order.filter((id) => next.has(id));
    startTransition(async () => {
      try {
        await updatePostAuthor(postId, userId, included);
        await updatePostAuthorOrder(postId, checkedOrder);
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
        await updatePostAuthorOrder(postId, checkedOrder);
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
          await restorePost(postId);
          onDeletedChange(false);
        } else {
          await deletePost(postId);
          onDeletedChange(true);
        }
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update post.");
      }
    });
  }

  return (
    <details
      ref={detailsRef}
      className={styles.details}
      onToggle={(e) => {
        // block: "start" aligns the panel's top edge to the viewport's top;
        // the browser clamps this to the document's actual max scroll, so a
        // panel shorter than the viewport just scrolls as far as it can
        // without overshooting rather than being forced flush to the top.
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
              <td className={styles.label}>Moderation policy</td>
              <td>
                <select
                  value={policy}
                  disabled={pending || deleted}
                  onChange={(e) => handlePolicyChange(e.target.value as ModerationPolicy)}
                  className={styles.policySelect}
                >
                  {Object.values(ModerationPolicy).map((option) => (
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
                <Link href={`/posts/${postId}/slug`}>Change…</Link>
              </td>
            </tr>
            <tr>
              <td className={styles.label}>Created</td>
              <td>{createdAt.toString()}</td>
            </tr>
            <tr>
              <td className={styles.label}>Published</td>
              <td>{publishedAt ? publishedAt.toString() : "—"}</td>
            </tr>
          </tbody>
        </table>

        <p className={styles.label}>Revisions:</p>

        <table className={styles.revisionsTable}>
          <thead>
            <tr>
              <th>#</th>
              <th>Title</th>
              <th>Editor</th>
              <th>Changelog</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {sortedRevisions.map((revision) => (
              <tr
                key={revision.revisionNumber}
                className={
                  revision.revisionNumber === scheduledRevisionNumber
                    ? styles.scheduledRevisionRow
                    : revision.revisionNumber === publishedRevisionNumber
                      ? styles.publishedRevisionRow
                      : undefined
                }
              >
                <td>{revision.revisionNumber}</td>
                <td>{revision.title}</td>
                <td>{revision.editorName}</td>
                <td>{revision.changelog ?? ""}</td>
                <td>{formatDate(revision.createdAt, "yyyy-MM-dd HH:mm")}</td>
              </tr>
            ))}
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
