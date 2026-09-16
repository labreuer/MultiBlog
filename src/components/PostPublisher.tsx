"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { publishPostFromDoc, schedulePostFromDoc, unpublishPost } from "@/app/actions/posts";
import { useLocalTime } from "./LocalTime";
import PostSnapshotScrubBar, { type ScrubSelection } from "./PostSnapshotScrubBar";
import PostSettingsPanel, { type EligibleUser } from "./PostSettingsPanel";
import DocTagOffer from "./tags/DocTagOffer";
import type { TagOption } from "@/lib/tag-data";
import type { ModerationPolicy } from "@/generated/prisma/enums";
import type { PostStatus } from "@/lib/post-status";
import { postPath } from "@/lib/post-path";
import proseStyles from "@/styles/prose.module.css";
import styles from "./PostPublisher.module.css";

export type EditableDoc = { id: string; slug: string; title: string };

type Props = {
  postId: string;
  /** For the live URL behind "Published …" (PLAN.md §21i). */
  slug: string;
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
  /** When the live version went live — the live event's createdAt (PLAN.md §15c). */
  liveEventAt: Date | null;
  /**
   * The post's tag strip, rendered on the server and handed across (PLAN.md
   * §20d) — TagChips queries Postgres, which this client component can't.
   */
  tags: ReactNode;
  /**
   * PLAN.md §20m — the source doc's terms that aren't on this post yet, for
   * the offer below the strip. Already gated on the *doc's* read rule by the
   * page (see its comment); empty means either nothing to offer or a viewer
   * who may not see the doc's tags, and the two are deliberately the same
   * rendering.
   */
  docTagOffer: TagOption[];
  /** The title of `docId`'s doc, for that offer to name its source. */
  sourceDocTitle: string;
  /**
   * PLAN.md §15i — `docId`'s doc's own slug and this viewer's rights over it.
   * Passed rather than looked up in `editableDocs`, which omits a PRIVATE doc
   * this viewer is not on the byline of.
   */
  sourceDocSlug: string;
  canReadSourceDoc: boolean;
  canEditSourceDoc: boolean;
  /**
   * PLAN.md §15i — the post's stored content, rendered on the server. Non-null
   * only when `canEditSourceDoc` is false and the post has published something:
   * it stands in for the scrub bar's replay, which cannot load without
   * doc-edit rights.
   */
  storedBody: ReactNode;
};

// PLAN.md §15c — replaces PostEditor as the whole /post/[id]/edit UI. No
// collaborative editing happens here any more: this page publishes a point
// in a doc's history, it doesn't edit content. Layout top to bottom: title,
// source-doc line, publish controls, the snapshot-economy line, a read-only
// render of the selected point, then the settings panel, with the scrub bar
// itself pinned to the viewport bottom (PostSnapshotScrubBar.module.css).
export default function PostPublisher({
  postId,
  slug,
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
  liveEventAt,
  tags,
  docTagOffer,
  sourceDocTitle,
  sourceDocSlug,
  canReadSourceDoc,
  canEditSourceDoc,
  storedBody,
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

  // PLAN.md §15c — two notes about how the live version relates to time.
  //
  // "updated": the live event was created after the publication date, which
  // is exactly a republish — publishPostFromDoc preserves the original
  // go-live date and writes the event's createdAt as the same `now` as a
  // first publish's publishedAt. The second of tolerance is for rows whose
  // createdAt came from the database default instead, a few milliseconds
  // after publishedAt. A scheduled post's event predates its publishedAt,
  // so it never reads as updated.
  const updatedAt =
    postStatus === "published" && publishedAt && liveEventAt && liveEventAt.getTime() - publishedAt.getTime() > 1_000
      ? liveEventAt
      : null;
  const updatedAtLocal = useLocalTime(updatedAt);
  // "the doc has changed": its head is past the live version's mark. Read
  // off the scrub bar's replay rather than a second server query, so it
  // can't disagree with the bar; it is about the head, not the slider, so
  // scrubbing doesn't move it. Moot for a draft, which has no version.
  const docChangedAt =
    postStatus !== "draft" && selection && selection.head.updatesSincePublished > 0 ? selection.head.lastEditedAt : null;
  const docChangedAtLocal = useLocalTime(docChangedAt);

  const currentDoc = useMemo(
    () =>
      editableDocs.find((d) => d.id === selectedDocId) ??
      // PLAN.md §15i — the post's own doc is the one that can be missing from
      // editableDocs, and it is the one we have real values for. The old
      // fallback used the id as a slug, which rendered "Untitled" behind a
      // link to a route that does not exist. Anything *else* missing from the
      // list is unreachable — the select only ever offers what is in it.
      (selectedDocId === docId
        ? { id: docId, slug: sourceDocSlug, title: sourceDocTitle }
        : { id: selectedDocId, slug: selectedDocId, title: "" }),
    [editableDocs, selectedDocId, docId, sourceDocSlug, sourceDocTitle],
  );

  // PLAN.md §15i — what this viewer may do with the doc *currently selected*.
  // `editableDocsFor` is exactly the set they may publish from, so anything
  // chosen from the select is editable by construction; the post's own doc is
  // the only one that might not be. Switching to an editable doc therefore
  // restores the scrub bar and the publish controls, which is right: they may
  // genuinely publish this post from a doc they own.
  const selectedEditable = selectedDocId !== docId || canEditSourceDoc;
  const selectedReadable = selectedDocId !== docId || canReadSourceDoc;

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

  // PLAN.md §15c — Republish is a no-op when the live post already came
  // from this doc at this update with this title, so the button is disabled
  // and says why. Same three inputs publishPostFromDoc compares on the
  // server, which is the real guard; this is the affordance. The title is
  // resolved the way resolvePublishContent resolves a blank one (the doc's
  // title at the selected point, then "Untitled"), and the update ids are
  // one sequence: initialThroughUpdateId is the live event's snapshot mark,
  // and the bar reports the id of the update it sits on. Only a *published*
  // post can be at a no-op — from scheduled, Publish Now moves publishedAt.
  const alreadyPublished =
    postStatus === "published" &&
    selection !== null &&
    selectedDocId === docId &&
    initialThroughUpdateId !== null &&
    selection.throughUpdateId === initialThroughUpdateId &&
    (title.trim() || docTitleForDefault) === postTitle;
  const publishLabel = postStatus === "published" ? "Republish" : postStatus === "scheduled" ? "Publish Now" : "Publish";

  // PLAN.md §15i — why the button is disabled, in the order the reasons
  // actually bite. Without doc-edit rights there is no selection to publish
  // and the server would refuse anyway, so that reason outranks the no-op one.
  const publishBlockedReason = !selectedEditable
    ? "Publishing needs edit access to this post's source doc."
    : alreadyPublished
      ? "Already published at this version with the present title"
      : undefined;

  // PLAN.md §15i — what the stored content *is*, which depends on the post's
  // state rather than on the content. `proseJson` survives an unpublish, so
  // calling it "published" on a post that has been taken down would be a lie.
  const storedBodyLabel =
    postStatus === "published"
      ? "Published content:"
      : postStatus === "scheduled"
        ? "Content scheduled to go live:"
        : "Content from the last publication — no longer live:";

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
        From doc:{" "}
        {/* PLAN.md §15i — the link goes as far as this viewer may go and no
            further: the editor when they may edit it, the reading view when
            they may only read it, and plain text when the doc is a PRIVATE one
            they are not on the byline of. A link that 403s reads as breakage;
            its absence reads as the fact it is. */}
        {selectedEditable ? (
          <Link href={`/doc/${currentDoc.slug}/edit`}>{currentDoc.title || "Untitled"}</Link>
        ) : selectedReadable ? (
          <Link href={`/doc/${currentDoc.slug}`}>{currentDoc.title || "Untitled"}</Link>
        ) : (
          <span>{currentDoc.title || "Untitled"}</span>
        )}
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
                {/* PLAN.md §15i — the post's own doc need not be in
                    editableDocs, and a <select> whose value matches no option
                    displays some *other* doc as chosen. Listed disabled, so
                    the control says what the post is actually from and still
                    offers the docs this viewer could move it to. */}
                {!editableDocs.some((d) => d.id === selectedDocId) && (
                  <option value={selectedDocId} disabled>
                    {currentDoc.title || "Untitled"} (no edit access)
                  </option>
                )}
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
        {/* The tooltip sits on a wrapper: a disabled button fires no mouse
            events in every engine, so a title on the button itself would
            be the one thing a disabled button can't show. */}
        <span title={publishBlockedReason}>
          <button
            type="button"
            className={styles.actionButton}
            onClick={handlePublish}
            disabled={pending || !selection || deleted || alreadyPublished}
          >
            {publishLabel}
          </button>
        </span>
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

      {/* PLAN.md §15i — said once, where the controls it explains are, rather
          than left for the reader to infer from a greyed-out button and a
          content pane that never loads. A post's byline and its doc's byline
          are independent lists (§15d), so this is an ordinary configuration
          and not an error: everything that belongs to the *publication* is
          still available, and only authority over the text is missing. */}
      {!selectedEditable && (
        <p className={styles.sourceDocNote}>
          You don&apos;t have edit access to this post&apos;s source doc, so you can&apos;t choose or publish a
          version of it here. Everything else about the post — its title, byline, tags and settings
          {postStatus !== "draft" && ", and unpublishing it"} — is yours to edit.
        </p>
      )}

      <p className={styles.revisionNote}>
        {/* PLAN.md §21i — the editor's one link out to the post as readers
            see it. publishedAt is a Date across the RSC boundary, so postPath
            takes it as is. */}
        {postStatus === "published" && publishedAt && (
          <>
            <Link href={postPath({ slug, publishedAt })}>Published {publishedAtLocal}</Link>
            {updatedAt && `, updated ${updatedAtLocal}`}
          </>
        )}
        {postStatus === "scheduled" && publishedAt && `Scheduled for ${publishedAtLocal}`}
        {postStatus === "draft" && "Not published yet"}
        {" ("}
        <Link href={`/post/${postId}/history`}>publication history</Link>
        {")"}
      </p>
      {docChangedAt && (
        <p className={styles.revisionNote}>The doc has changed since this version, last edit {docChangedAtLocal}.</p>
      )}

      {/* PLAN.md §20d — the keyword chips sit with the post's own metadata,
          above the rule that separates it from the read-only doc render
          below. The gate is this page's: loadPostForEdit already required
          ownership or canEditAnyPost. */}
      {tags}

      {/* PLAN.md §20m — and immediately under it, whatever the source doc is
          tagged with that this post isn't. It names `sourceDocTitle` rather
          than `currentDoc.title`: "Change doc…" moves the *preview*, and the
          post's own doc only moves when it is published from another one.
          Renders nothing when there is nothing to carry across. */}
      <DocTagOffer postId={postId} docTitle={sourceDocTitle} tags={docTagOffer} />

      {/* PLAN.md §15i — the scrub bar's replay when there is one, and the
          post's own stored content when there isn't. Not an empty pane and not
          an error: without doc-edit rights `/api/doc/[id]/replay` 403s, so the
          bar below is never mounted and this is the only version of the post
          that can honestly be shown. */}
      {selectedEditable ? (
        <>
          <p className={styles.readOnlyLabel}>Doc content at the selected point:</p>
          <div className={`${styles.readOnlyView} ${proseStyles.prose}`}>
            {selection?.render.body ?? <p>Loading…</p>}
          </div>
        </>
      ) : storedBody ? (
        <>
          <p className={styles.readOnlyLabel}>{storedBodyLabel}</p>
          <div className={`${styles.readOnlyView} ${proseStyles.prose}`}>{storedBody}</div>
        </>
      ) : (
        <p className={styles.readOnlyLabel}>Nothing has been published from this post yet.</p>
      )}

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

      {/* Mounted only when its own data route would answer. It is gated on
          canUserEditDoc, so for a viewer without those rights the bar's only
          possible contribution is a 403 and an error line under a control
          that could not have worked anyway (PLAN.md §15i). */}
      {selectedEditable && (
        <PostSnapshotScrubBar
          key={selectedDocId}
          docId={selectedDocId}
          onChange={setSelection}
          initialThroughUpdateId={initialThroughUpdateId}
        />
      )}
    </div>
  );
}
