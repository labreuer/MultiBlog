"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Editor } from "@tiptap/react";
import { saveDraft, publishPost, unpublishPost, schedulePost, updatePostTitle } from "@/app/actions/posts";
import { extractText, diffText } from "@/lib/diff";
import { toPlainJSON } from "@/lib/tiptap-schema";
import { perfMeasure } from "@/lib/perf-monitor";
import type { PostStatus } from "@/lib/post-status";
import type { ModerationPolicy } from "@/generated/prisma/enums";
import CollabEditorBody, { type AuthorStat } from "./CollabEditorBody";
import CollabTitleField from "./CollabTitleField";
import PostSettingsPanel, { type EligibleUser, type RevisionRow } from "./PostSettingsPanel";
import styles from "./PostEditor.module.css";

type Props = {
  postId: string;
  slug: string;
  initialTitle: string;
  revisionNumber: number;
  publishedRevisionNumber: number | null;
  publishedTitle: string | null;
  scheduledRevisionNumber: number | null;
  postStatus: PostStatus;
  publishedAt: Date | null;
  lastRevisionDoc: unknown;
  userId: string;
  userName: string;
  userColor: string;
  moderationPolicy: ModerationPolicy;
  createdAt: Date;
  authorIds: string[];
  eligibleUsers: EligibleUser[];
  initialDeleted: boolean;
  revisions: RevisionRow[];
};

// Formats a Date as the local-time value a <input type="datetime-local">
// expects (YYYY-MM-DDTHH:mm) — toISOString() would convert to UTC first,
// shifting the displayed time away from what the user actually picked.
function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type ConnectionStatus = "connecting" | "connected" | "disconnected";
type RevisionDiff = { added: number; removed: number };
type ConnectedAuthor = { authorId: string; name: string; color: string };
type DisplayAuthor = { authorId: string; name: string; color: string; chars: number };

// See PERFORMANCE.md — the revision diff is O(document size squared) word-level
// LCS; debouncing keeps it off the per-keystroke path.
const REVISION_DIFF_DEBOUNCE_MS = 400;

// Longer than the revision-diff/author-stats debounces above: those are local
// recomputations, this is a network write, so it's fine (and better, fewer
// requests) to wait a bit longer for typing to actually settle.
const TITLE_AUTOSAVE_DEBOUNCE_MS = 1000;

// Author-highlight marks live in the working Yjs doc, not in the saved
// revision — but nothing else ever removes them, so without this they'd
// keep accumulating across every future revision instead of reflecting only
// what's changed *since* the one just saved. Clearing them here (a real
// transaction, synced like any edit) propagates to every connected client
// and persists into the doc, so a later viewer sees the same reset state.
function clearAuthorHighlights(editor: Editor) {
  const markType = editor.schema.marks.authorHighlight;
  if (!markType) return;
  const { tr } = editor.state;
  editor.view.dispatch(tr.removeMark(0, tr.doc.content.size, markType));
}

export default function PostEditor({
  postId,
  slug,
  initialTitle,
  revisionNumber,
  publishedRevisionNumber,
  publishedTitle,
  scheduledRevisionNumber,
  postStatus,
  publishedAt,
  lastRevisionDoc,
  userId,
  userName,
  userColor,
  moderationPolicy,
  createdAt,
  authorIds,
  eligibleUsers,
  initialDeleted,
  revisions,
}: Props) {
  const router = useRouter();
  // A mirror of the collaborative title field's text, not the source of truth
  // for it — the title lives in the "title" fragment of the same Y.Doc as the
  // body (see CollabTitleField). Seeded from the last saved revision so the
  // first render matches what the fragment is about to sync in.
  const [title, setTitle] = useState(initialTitle);
  const [providerSynced, setProviderSynced] = useState(false);
  const [deleted, setDeleted] = useState(initialDeleted);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changelog, setChangelog] = useState("");
  const [scheduleInput, setScheduleInput] = useState(() =>
    postStatus === "scheduled" && publishedAt ? toDatetimeLocalValue(publishedAt) : "",
  );
  const [pending, startTransition] = useTransition();
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("connecting");
  const [connectedAuthors, setConnectedAuthors] = useState<ConnectedAuthor[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [titleEditor, setTitleEditor] = useState<Editor | null>(null);
  const [authorStats, setAuthorStats] = useState<AuthorStat[]>([]);
  const [revisionDiff, setRevisionDiff] = useState<RevisionDiff | null>(null);
  const diffDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleAutosaveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks what's actually in Post.title right now (as far as this tab knows),
  // so the autosave effect below can skip firing when the live title already
  // matches it — both on ordinary settling and right after an explicit
  // Save/Publish/Schedule, which stamps the same column itself.
  const lastPersistedTitleRef = useRef(initialTitle);

  const lastRevisionText = useMemo(
    () => (lastRevisionDoc == null ? "" : extractText(lastRevisionDoc)),
    [lastRevisionDoc],
  );

  // Recreate the Y.Doc if postId ever changes under the same mounted instance.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ydoc = useMemo(() => new Y.Doc(), [postId]);

  useEffect(() => {
    let cancelled = false;
    let instance: HocuspocusProvider | null = null;

    // The provider's own reconnect on a dropped/idle connection never
    // re-fetches — the token below would go on retrying with the same
    // now-expired (2-minute) one forever (§10's known gap). Passing a
    // function as `token` instead of a fixed string fixes that: Hocuspocus
    // calls it on every connection attempt, not just the first. The first
    // call reuses the token already fetched below (so the existing
    // fetch-and-catch error UX for the *initial* connection is unchanged);
    // only a second or later call hits the network again.
    async function fetchToken(): Promise<string> {
      if (firstToken !== null) {
        const t = firstToken;
        firstToken = null;
        return t;
      }
      const res = await fetch("/api/collab-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postId }),
      });
      if (!res.ok) {
        throw new Error("Failed to authenticate for live editing.");
      }
      const { token } = await res.json();
      return token;
    }
    let firstToken: string | null = null;

    (async () => {
      try {
        const res = await fetch("/api/collab-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ postId }),
        });
        if (!res.ok) {
          throw new Error("Failed to authenticate for live editing.");
        }
        const { token } = await res.json();
        if (cancelled) return;
        firstToken = token;

        instance = new HocuspocusProvider({
          url: process.env.NEXT_PUBLIC_COLLAB_URL ?? "ws://localhost:1234",
          name: postId,
          document: ydoc,
          token: fetchToken,
          onStatus: ({ status: s }) => setConnectionStatus(s),
          // Not the same signal as the title editor's own first render: with
          // the collab server unreachable, Collaboration happily renders the
          // still-empty fragment and fires onFirstRender straight away. Only
          // once the provider has synced is an empty title actually empty
          // rather than not-yet-arrived. Never reset on a later disconnect —
          // the doc's content is in hand locally from then on.
          onSynced: () => setProviderSynced(true),
          onAuthenticationFailed: ({ reason }) => setError(`Live editing unavailable: ${reason}`),
          onAwarenessUpdate: ({ states }) => {
            // Keyed by user id (not name, and not excluding the local user) so
            // multiple sessions of one account collapse into one entry and
            // everyone presently viewing shows up, including yourself.
            const byId = new Map<string, ConnectedAuthor>();
            for (const state of states) {
              const user = state.user as { id?: string; name?: string; color?: string } | undefined;
              if (!user?.id || !user.name) continue;
              byId.set(user.id, { authorId: user.id, name: user.name, color: user.color ?? "#999" });
            }
            setConnectedAuthors(Array.from(byId.values()));
          },
        });
        setProvider(instance);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to connect.");
      }
    })();

    return () => {
      cancelled = true;
      instance?.destroy();
    };
  }, [postId, ydoc, userName]);

  useEffect(() => {
    if (!editor) return;

    const recompute = () => {
      if (diffDebounceRef.current) clearTimeout(diffDebounceRef.current);
      diffDebounceRef.current = setTimeout(() => {
        const tokens = perfMeasure("revision diff", () => diffText(lastRevisionText, extractText(editor.getJSON())));
        let added = 0;
        let removed = 0;
        for (const token of tokens) {
          if (token.type === "insert") added += token.value.length;
          else if (token.type === "delete") removed += token.value.length;
        }
        setRevisionDiff({ added, removed });
      }, REVISION_DIFF_DEBOUNCE_MS);
    };

    recompute();
    editor.on("update", recompute);
    return () => {
      editor.off("update", recompute);
      if (diffDebounceRef.current) clearTimeout(diffDebounceRef.current);
    };
  }, [editor, lastRevisionText]);

  // Debounced background write of Post.title alone — see updatePostTitle
  // (src/app/actions/posts.ts) for why that's safe to do off a keystroke
  // rather than an explicit save: it never touches Revision or
  // publishRevisionId, so it can't move what's published or grow the
  // revision history. Gated on providerSynced for the same reason the save
  // buttons are (src/components/PostEditor.tsx's `providerSynced` comment
  // above) — before that, `title` is the still-empty fragment, not a real
  // edit. Every tab with the title fragment synced runs this independently;
  // since they're all converging on the same eventual text, redundant writes
  // from multiple open tabs are harmless, just extra idempotent requests.
  useEffect(() => {
    if (!providerSynced || deleted) return;
    const trimmed = title.trim();
    if (!trimmed || trimmed === lastPersistedTitleRef.current) return;

    titleAutosaveDebounceRef.current = setTimeout(() => {
      updatePostTitle(postId, trimmed)
        .then(() => {
          lastPersistedTitleRef.current = trimmed;
        })
        .catch(() => {
          // Best-effort: a failure here just delays the admin listing/history
          // heading catching up. The next successful Save/Publish/Schedule
          // stamps Post.title itself regardless, so nothing is lost.
        });
    }, TITLE_AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (titleAutosaveDebounceRef.current) clearTimeout(titleAutosaveDebounceRef.current);
    };
  }, [title, providerSynced, deleted, postId]);

  // Trimmed only on the way to the server, never written back into the title
  // field — rewriting the field's own text would be a synced edit, landing in
  // every other editor's title mid-keystroke. Empty is rejected here because
  // a contenteditable makes select-all-delete easy, and everything downstream
  // (slug generation, listings, the public <h1>) assumes a real title.
  const resolveTitle = (): string | null => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError("Title is required.");
      return null;
    }
    return trimmed;
  };

  // Both the title and the body carry authorHighlight marks, and both need
  // resetting to "since the last revision" once that revision exists.
  const clearEditHighlights = () => {
    if (editor) clearAuthorHighlights(editor);
    if (titleEditor) clearAuthorHighlights(titleEditor);
  };

  // Called after any explicit save that just stamped `trimmedTitle` into
  // Post.title itself, so the debounce effect above doesn't redundantly
  // repeat that write a moment later — and so a pending autosave that was
  // mid-flight for an *older* title can't land afterward and clobber it.
  const noteTitlePersisted = (trimmedTitle: string) => {
    if (titleAutosaveDebounceRef.current) clearTimeout(titleAutosaveDebounceRef.current);
    lastPersistedTitleRef.current = trimmedTitle;
  };

  const handleSaveDraft = () => {
    if (!editor) return;
    const trimmedTitle = resolveTitle();
    if (trimmedTitle === null) return;
    setError(null);
    startTransition(async () => {
      try {
        const doc = toPlainJSON(editor.getJSON());
        const result = await saveDraft(postId, trimmedTitle, doc);
        noteTitlePersisted(trimmedTitle);
        clearEditHighlights();
        if (!result.created) setStatus(`No changes since revision #${result.revisionNumber}`);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save.");
      }
    });
  };

  const handlePublish = () => {
    if (!editor) return;
    const trimmedTitle = resolveTitle();
    if (trimmedTitle === null) return;
    setError(null);
    startTransition(async () => {
      try {
        const doc = toPlainJSON(editor.getJSON());
        await publishPost(postId, trimmedTitle, doc, changelog);
        noteTitlePersisted(trimmedTitle);
        clearEditHighlights();
        setChangelog("");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to publish.");
      }
    });
  };

  const handleUnpublish = () => {
    setError(null);
    startTransition(async () => {
      try {
        await unpublishPost(postId);
        if (postStatus === "scheduled") setStatus("Schedule canceled");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to unpublish.");
      }
    });
  };

  const handleSchedule = () => {
    if (!editor || !scheduleInput) return;
    const trimmedTitle = resolveTitle();
    if (trimmedTitle === null) return;
    setError(null);
    startTransition(async () => {
      try {
        const doc = toPlainJSON(editor.getJSON());
        const result = await schedulePost(postId, trimmedTitle, doc, new Date(scheduleInput), changelog);
        noteTitlePersisted(trimmedTitle);
        clearEditHighlights();
        setStatus(`Scheduled revision #${result.revisionNumber}`);
        setChangelog("");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to schedule.");
      }
    });
  };

  const hasRevisionDiff = !!revisionDiff && (revisionDiff.added > 0 || revisionDiff.removed > 0);
  // Both title comparisons wait on the "title" fragment having synced *and*
  // arriving non-empty. Either check alone is insufficient: before sync
  // `title` reads as "" (the empty fragment), which would light up TITLE
  // CHANGED and the divergence border on every load; and the provider reports
  // synced a beat before y-prosemirror has rendered that state into the
  // editor. An empty title is never a real one anyway — it's rejected on save
  // and re-seeded server-side (see server/collab.ts) — so treating it as
  // "nothing to compare yet" costs nothing.
  const titleComparable = providerSynced && title !== "";
  const hasTitleChanged = titleComparable && title !== initialTitle;
  const titleDivergesFromPublished = titleComparable && publishedTitle !== null && title !== publishedTitle;
  const isAtPublished = publishedRevisionNumber !== null && revisionNumber === publishedRevisionNumber;
  const showViewingClause = hasRevisionDiff || hasTitleChanged || !isAtPublished;
  const editedLabel = [hasRevisionDiff && "EDITED", hasTitleChanged && "TITLE CHANGED"].filter(Boolean).join(", ");

  // Union of "currently connected" (from awareness, zero edits allowed) and
  // "has made edits" (from authorStats' authorHighlight-mark walk, which can
  // include someone who has since disconnected). For anyone in both, prefer
  // the awareness-sourced name/color — that's the same value the collab
  // caret extension renders their cursor with (CollabEditorBody's
  // renderCaret uses user.color directly, unmodified), so this keeps the
  // status line and the live cursor in sync for anyone actually present.
  const displayAuthors: DisplayAuthor[] = (() => {
    const byId = new Map<string, DisplayAuthor>();
    for (const stat of authorStats) {
      byId.set(stat.authorId, { authorId: stat.authorId, name: stat.name, color: stat.color, chars: stat.chars });
    }
    for (const author of connectedAuthors) {
      const chars = byId.get(author.authorId)?.chars ?? 0;
      byId.set(author.authorId, { ...author, chars });
    }
    return Array.from(byId.values());
  })();

  return (
    <div className={styles.container}>
      {provider ? (
        <CollabTitleField
          ydoc={ydoc}
          userId={userId}
          userName={userName}
          userColor={userColor}
          editable={!deleted}
          className={`${styles.titleInput} ${titleDivergesFromPublished ? styles.titleChanged : ""} ${deleted ? styles.titleInputDisabled : ""}`}
          onTitleChange={setTitle}
          onEditorReady={setTitleEditor}
        />
      ) : (
        // Same shape as the live field so connecting doesn't shift the layout.
        <div className={`${styles.titleInput} ${styles.titleInputDisabled}`}>{title}</div>
      )}
      <p className={styles.statusLine}>
        {connectionStatus === "connected" ? "🟢 Live" : connectionStatus === "connecting" ? "🟡 Connecting…" : "🔴 Disconnected"}
        {(hasRevisionDiff || displayAuthors.length > 0) && " "}
        {hasRevisionDiff && (
          <span>
            {"("}
            {revisionDiff!.added > 0 && <span style={{ color: "green" }}>+{revisionDiff!.added}</span>}
            {revisionDiff!.added > 0 && revisionDiff!.removed > 0 && " "}
            {revisionDiff!.removed > 0 && <span style={{ color: "crimson" }}>−{revisionDiff!.removed}</span>}
            {")"}
          </span>
        )}
        {hasRevisionDiff && displayAuthors.length > 0 && " "}
        {displayAuthors.length > 0 && (
          <span>
            {"("}
            {displayAuthors.map((author, i) => (
              <span key={author.authorId}>
                {i > 0 && ", "}
                <span style={{ color: author.color }}>{author.name}</span>
                {author.chars > 0 && ": "}
                {author.chars > 0 && <span style={{ color: author.color }}>+{author.chars}</span>}
              </span>
            ))}
            {")"}
          </span>
        )}
      </p>
      {provider ? (
        <CollabEditorBody
          provider={provider}
          ydoc={ydoc}
          userId={userId}
          userName={userName}
          userColor={userColor}
          editable={!deleted}
          onEditorReady={setEditor}
          onAuthorStats={setAuthorStats}
        />
      ) : (
        <p>Connecting to live editor…</p>
      )}
      {/* Everything that writes content is gated on providerSynced: before the
          collab handshake completes, both the title fragment and the body doc
          are still empty locally, so a save would persist that emptiness over
          the real content. (Unpublish sends no content, so it stays enabled.) */}
      <div className={styles.actionsRow}>
        <button
          type="button"
          onClick={handleSaveDraft}
          disabled={pending || !editor || !providerSynced || deleted}
          className={styles.actionButton}
        >
          Save draft
        </button>
        <input
          placeholder="Changelog (optional)"
          value={changelog}
          onChange={(e) => setChangelog(e.target.value)}
          className={styles.changelogInput}
          disabled={deleted}
        />
        <button
          type="button"
          onClick={handlePublish}
          disabled={pending || !editor || !providerSynced || deleted}
          className={styles.actionButton}
        >
          Publish
        </button>
        {postStatus !== "draft" && (
          <button type="button" onClick={handleUnpublish} disabled={pending || deleted} className={styles.actionButton}>
            {postStatus === "scheduled" ? "Cancel schedule" : "Unpublish"}
          </button>
        )}
        {postStatus !== "published" && (
          <>
            <input
              type="datetime-local"
              aria-label="Schedule for"
              value={scheduleInput}
              onChange={(e) => setScheduleInput(e.target.value)}
              disabled={deleted}
            />
            <button
              type="button"
              onClick={handleSchedule}
              disabled={pending || !editor || !providerSynced || !scheduleInput || deleted}
              className={styles.actionButton}
            >
              {postStatus === "scheduled" ? "Reschedule" : "Schedule"}
            </button>
          </>
        )}
      </div>
      {status && <p className={styles.statusMessage}>{status}</p>}
      {error && <p className={styles.errorMessage}>{error}</p>}
      <p className={styles.revisionNote}>
        {/* The published-post link is deliberately a plain <a>, not <Link>: a client-side
            navigation can serve that route from the browser's Router Cache, which
            revalidatePath (server-side only) can't purge — Next advertises
            x-nextjs-stale-time: 300 for these prerendered pages, so just-published edits
            stayed invisible here for up to 5 minutes. A hard navigation bypasses that
            cache and shows exactly what a visitor gets. */}
        {postStatus === "published" ? (
          <a href={`/${slug}`} style={{ fontWeight: "bold" }}>
            Published revision #{publishedRevisionNumber}
          </a>
        ) : postStatus === "scheduled" && publishedAt ? (
          `Scheduled for ${publishedAt.toLocaleString()}`
        ) : (
          "Unpublished"
        )}
        {". "}
        {showViewingClause && <>{editedLabel || `Currently viewing revision #${revisionNumber}`}. </>}
        <Link href={`/posts/${postId}/live-history`}>Scrub live history</Link>
      </p>
      <PostSettingsPanel
        postId={postId}
        moderationPolicy={moderationPolicy}
        createdAt={createdAt}
        publishedAt={publishedAt}
        authorIds={authorIds}
        eligibleUsers={eligibleUsers}
        deleted={deleted}
        onDeletedChange={setDeleted}
        revisions={revisions}
        publishedRevisionNumber={publishedRevisionNumber}
        scheduledRevisionNumber={scheduledRevisionNumber}
      />
    </div>
  );
}
