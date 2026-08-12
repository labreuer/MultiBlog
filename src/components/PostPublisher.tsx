"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { publishPostFromDoc, schedulePostFromDoc, unpublishPost } from "@/app/actions/posts";
import { useLocalTime } from "./LocalTime";
import PostSnapshotScrubBar, { type ScrubSelection } from "./PostSnapshotScrubBar";
import PostSettingsPanel, { type EligibleUser } from "./PostSettingsPanel";
import type { ModerationPolicy } from "@/generated/prisma/enums";
import type { PostStatus } from "@/lib/post-status";
import proseStyles from "@/styles/prose.module.css";
import styles from "./PostPublisher.module.css";

export type EditableDoc = { id: string; slug: string; title: string };

type Props = {
  postId: string;
  postTitle: string;
  docId: string;
  editableDocs: EditableDoc[];
  postStatus: PostStatus;
  publishedAt: Date | null;
  moderationPolicy: ModerationPolicy;
  createdAt: Date;
  authorIds: string[];
  eligibleUsers: EligibleUser[];
  initialDeleted: boolean;
  /** The presently published/scheduled version's own snapshot mark — see PostSnapshotScrubBar. */
  initialThroughUpdateId: string | null;
};

// PLAN.md §15c — replaces PostEditor as the whole /posts/[id]/edit UI. No
// collaborative editing happens here any more: this page publishes a point
// in a doc's history, it doesn't edit content. Layout top to bottom: title,
// source-doc line, publish controls, the snapshot-economy line, a read-only
// render of the selected point, then the settings panel, with the scrub bar
// itself pinned to the viewport bottom (PostSnapshotScrubBar.module.css).
export default function PostPublisher({
  postId,
  postTitle,
  docId,
  editableDocs,
  postStatus,
  publishedAt,
  moderationPolicy,
  createdAt,
  authorIds,
  eligibleUsers,
  initialDeleted,
  initialThroughUpdateId,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedDocId, setSelectedDocId] = useState(docId);
  const [title, setTitle] = useState(postTitle);
  const [selection, setSelection] = useState<ScrubSelection | null>(null);
  const [scheduleInput, setScheduleInput] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(initialDeleted);

  // Unconditionally, above every branch — the two uses below are conditional
  // and a hook can't be. useLocalTime returns "" for a null value, which is
  // exactly the case those branches already guard against anyway.
  const publishedAtLocal = useLocalTime(publishedAt);

  const currentDoc = useMemo(
    () => editableDocs.find((d) => d.id === selectedDocId) ?? { id: selectedDocId, slug: selectedDocId, title: "" },
    [editableDocs, selectedDocId],
  );

  function handleDocChange(newDocId: string) {
    setSelectedDocId(newDocId);
    // Cleared eagerly rather than waiting for the remounted scrub bar's own
    // load — otherwise the read-only view below would keep rendering the
    // previous doc's content until the new fetch resolves.
    setSelection(null);
  }

  function handlePublish() {
    if (!selection) return;
    setError(null);
    setStatus(null);
    startTransition(async () => {
      try {
        await publishPostFromDoc(postId, {
          docId: selectedDocId,
          title: title.trim() || undefined,
          throughUpdateId: selection.throughUpdateId,
        });
        setStatus("Published.");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to publish.");
      }
    });
  }

  function handleSchedule() {
    if (!selection || !scheduleInput) return;
    setError(null);
    setStatus(null);
    startTransition(async () => {
      try {
        await schedulePostFromDoc(postId, {
          docId: selectedDocId,
          title: title.trim() || undefined,
          throughUpdateId: selection.throughUpdateId,
          scheduledFor: new Date(scheduleInput),
        });
        setStatus("Scheduled.");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to schedule.");
      }
    });
  }

  function handleUnpublish() {
    setError(null);
    setStatus(null);
    startTransition(async () => {
      try {
        await unpublishPost(postId);
        setStatus(postStatus === "scheduled" ? "Schedule canceled." : "Unpublished.");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to unpublish.");
      }
    });
  }

  const docTitleForDefault = selection?.title || currentDoc.title || "Untitled";
  const titleMatchesDoc = title.trim() === docTitleForDefault.trim();

  return (
    <div className={styles.container}>
      <input
        className={styles.titleInput}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={docTitleForDefault}
        disabled={deleted}
        aria-label="Post title"
      />
      {!titleMatchesDoc && (
        <p>
          <button
            type="button"
            className={styles.useDocTitleButton}
            onClick={() => setTitle(docTitleForDefault)}
          >
            Use doc title (&ldquo;{docTitleForDefault}&rdquo;)
          </button>
        </p>
      )}

      <p className={styles.statusLine}>
        From doc: <Link href={`/doc/${currentDoc.slug}/edit`}>{currentDoc.title || "Untitled"} (edit)</Link>
        {editableDocs.length > 1 && (
          <>
            {" "}
            ·{" "}
            <label>
              Change doc:{" "}
              <select
                className={styles.docSelect}
                value={selectedDocId}
                disabled={pending || deleted}
                onChange={(e) => handleDocChange(e.target.value)}
              >
                {editableDocs.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title || "Untitled"}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </p>

      <div className={styles.actionsRow}>
        <button
          type="button"
          className={styles.actionButton}
          onClick={handlePublish}
          disabled={pending || !selection || deleted}
        >
          Publish
        </button>
        {postStatus !== "draft" && (
          <button type="button" className={styles.actionButton} onClick={handleUnpublish} disabled={pending || deleted}>
            {postStatus === "scheduled" ? "Cancel schedule" : "Unpublish"}
          </button>
        )}
        {postStatus !== "published" && (
          <>
            <input
              type="datetime-local"
              aria-label="Schedule for"
              value={scheduleInput}
              disabled={pending || deleted}
              onChange={(e) => setScheduleInput(e.target.value)}
            />
            <button
              type="button"
              className={styles.actionButton}
              onClick={handleSchedule}
              disabled={pending || !selection || !scheduleInput || deleted}
            >
              {postStatus === "scheduled" ? "Reschedule" : "Schedule"}
            </button>
          </>
        )}
      </div>

      {status && <p className={styles.statusMessage}>{status}</p>}
      {error && <p className={styles.errorMessage}>{error}</p>}

      <p className={styles.revisionNote}>
        {postStatus === "published" && publishedAt && `Published ${publishedAtLocal}. `}
        {postStatus === "scheduled" && publishedAt && `Scheduled for ${publishedAtLocal}. `}
        {postStatus === "draft" && "Not published yet. "}
        <Link href={`/posts/${postId}/history`}>Publication history</Link>
      </p>

      <p className={styles.readOnlyLabel}>Doc content at the selected point:</p>
      <div className={`${styles.readOnlyView} ${proseStyles.prose}`}>
        {selection?.render.body ?? <p>Loading…</p>}
      </div>

      <PostSettingsPanel
        postId={postId}
        moderationPolicy={moderationPolicy}
        createdAt={createdAt}
        publishedAt={publishedAt}
        authorIds={authorIds}
        eligibleUsers={eligibleUsers}
        deleted={deleted}
        onDeletedChange={setDeleted}
      />

      <PostSnapshotScrubBar
        key={selectedDocId}
        docId={selectedDocId}
        onChange={setSelection}
        initialThroughUpdateId={initialThroughUpdateId}
      />
    </div>
  );
}
