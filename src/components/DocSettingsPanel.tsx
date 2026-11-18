"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type * as Y from "yjs";
import Link from "next/link";
import { updateDocVisibility, updateDocAuthor, updateDocAuthorOrder, deleteDoc, restoreDoc } from "@/app/actions/docs";
import { loadTaggerState, type TaggerState } from "@/app/actions/tags";
import TagStrip from "@/components/tags/TagStrip";
import { CitationStyleSelect, MentionStyleSelect } from "@/components/ChipStyleSettings";
import type { DocVisibility, Role } from "@/generated/prisma/enums";
import { allowedVisibilities, PUBLIC_VISIBILITY_NOTE } from "@/lib/doc-visibility";
import type { WikiAddressHistoryEntry } from "@/lib/wiki-rename";
import DeleteAddressesConfirm from "@/components/wiki/DeleteAddressesConfirm";
import styles from "./DocSettingsPanel.module.css";

/** What the panel says on the commons' PUBLIC Front Page (docs/WIKI.md "The front page"). */
const FRONT_PAGE_SETTINGS_NOTE =
  "This page's text is the landing page's preamble. Lowering it from PUBLIC, or deleting it, takes the preamble off the landing page.";

export type EligibleUser = {
  id: string;
  /** What the byline picker shows: staffDisplayNameOf, decided on the server. */
  label: string;
  role: Role;
};

type Props = {
  docId: string;
  visibility: DocVisibility;
  /**
   * A wiki page's name, owner and address, null for a doc that isn't one:
   * which visibilities it may take (allowedVisibilities), the Url row, and
   * where Delete and Undelete go on to (docs/WIKI.md "Deleting a page").
   * `frontPage`: it is the commons' Front Page, whose text is the landing
   * page's preamble while it is PUBLIC (docs/WIKI.md "The front page").
   */
  wiki: { name: string; ownerUserId: string | null; path: string; frontPage: boolean } | null;
  /**
   * The doc's past wiki addresses, newest first, which Delete lists before it
   * deletes them with the doc (docs/WIKI.md "Deleting a page").
   */
  addressHistory: WikiAddressHistoryEntry[];
  /** Told each visibility the server accepts, for the editor's address line and PUBLIC notice. */
  onVisibilityChange?: (visibility: DocVisibility) => void;
  /** The viewer, whom allowedVisibilities asks about on a person's page. */
  viewerId: string;
  createdAt: Date;
  authorIds: string[];
  eligibleUsers: EligibleUser[];
  deleted: boolean;
  onDeletedChange: (deleted: boolean) => void;
  /**
   * The doc's own ydoc, once the editor is connected: where its chip styles
   * live (docs/ENTITY_CHIPS.md, "Styling"). Null before that, and the style
   * row waits for it.
   */
  ydoc: Y.Doc | null;
};

// A smaller sibling of PostSettingsPanel (PLAN.md §12k) — no revisions
// table (a doc has none), no moderation policy (annotations are never
// moderated), no changelog. Authors + reorder + delete/restore are lifted
// straight from PostSettingsPanel's identical rationale.
export default function DocSettingsPanel({
  docId,
  visibility,
  wiki,
  addressHistory,
  onVisibilityChange,
  viewerId,
  createdAt,
  authorIds,
  eligibleUsers,
  deleted,
  onDeletedChange,
  ydoc,
}: Props) {
  const router = useRouter();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [visibilityValue, setVisibilityValue] = useState(visibility);
  const [authors, setAuthors] = useState(new Set(authorIds));
  const [order, setOrder] = useState<string[]>(() => {
    const rest = eligibleUsers.map((u) => u.id).filter((id) => !authorIds.includes(id));
    return [...authorIds, ...rest];
  });
  const usersById = useMemo(() => new Map(eligibleUsers.map((u) => [u.id, u])), [eligibleUsers]);
  const dragIdRef = useRef<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // PLAN.md §20k — the terms already on this doc, fetched when the panel is
  // first opened rather than passed down from edit/page.tsx: a per-viewer read
  // for a panel most editing sessions never open. Same argument TagTagger
  // makes for its own popover.
  const [tags, setTags] = useState<TaggerState | null>(null);

  const visibilityOptions = allowedVisibilities(
    { visibility: visibilityValue, wikiName: wiki?.name ?? null, wikiOwnerUserId: wiki?.ownerUserId ?? null },
    viewerId,
  );

  function handleVisibilityChange(next: DocVisibility) {
    const prev = visibilityValue;
    setVisibilityValue(next);
    setError(null);
    startTransition(async () => {
      try {
        await updateDocVisibility(docId, next);
        onVisibilityChange?.(next);
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

  function loadTags() {
    startTransition(async () => {
      try {
        setTags(await loadTaggerState("doc", docId));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't load tags.");
      }
    });
  }

  // A wiki page's editor is at its address, which deleting gives back: a
  // refresh there would resolve the address again, find nothing and 404,
  // with Undelete gone. So Delete goes on to /doc/<id>/edit, which loads a
  // deleted doc on purpose, and Undelete to wherever the page now lives,
  // which may be the next free variant (docs/WIKI.md "Deleting a page").
  function handleDeleteToggle() {
    setError(null);
    // A doc with past addresses asks first, since deleting it deletes them
    // and a restore doesn't bring them back; one with none doesn't, since
    // Undelete undoes all of it.
    if (!deleted && addressHistory.length > 0 && !confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setConfirmingDelete(false);
    startTransition(async () => {
      try {
        if (deleted) {
          const restored = await restoreDoc(docId);
          onDeletedChange(false);
          if (restored.wikiPath) {
            router.replace(`${restored.wikiPath}/edit`);
            return;
          }
        } else {
          await deleteDoc(docId);
          onDeletedChange(true);
          if (wiki) {
            router.replace(`/doc/${docId}/edit`);
            return;
          }
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
      // Not decoration: EditorChrome.module.css keys the editor's height floor
      // off `[data-doc-settings][open]`, so the body can't overflow on top of
      // this panel and swallow the click that would close it again. A class
      // won't do — CSS Modules hashes those per file, and the rule lives in a
      // different module. See e2e/doc-settings-collapse.spec.ts.
      data-doc-settings=""
      className={styles.details}
      onToggle={(e) => {
        if (!e.currentTarget.open) return;
        e.currentTarget.scrollIntoView({ block: "start", behavior: "smooth" });
        if (tags === null) loadTags();
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
                    // A person's wiki page keeps its owner on its byline
                    // (setDocByline refuses otherwise; docs/WIKI.md "Permissions").
                    disabled={pending || deleted || (checked && wiki?.ownerUserId === userId)}
                    onChange={(e) => handleAuthorToggle(userId, e.target.checked)}
                  />
                  {user.label} <span className={styles.roleTag}>({user.role})</span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* PLAN.md §20k — literally the strip an object page carries, so the
            two cannot drift; the only difference is where the chips come from,
            which is what `onChange` is for. No client-side guard on a deleted
            doc either: canUserTagTarget reads through soft-delete-filtered
            `prisma`, so a binned doc is already untaggable and the tagger says
            so on open. This surface is also the one exception to
            docs/PERMISSIONS.md's "chips are as private as the thing they are
            on" paragraph — see the note under it. */}
        <fieldset className={styles.field}>
          <legend className={styles.label}>Tags</legend>
          {tags === null ? (
            <p className={styles.hint}>Loading…</p>
          ) : (
            <TagStrip
              target={{ kind: "doc", id: docId }}
              chips={tags.applied}
              // "bare" because the <legend> above already says Tags.
              variant="bare"
              onChange={loadTags}
            />
          )}
        </fieldset>

        <table className={styles.detailsTable}>
          <tbody>
            <tr>
              <td className={styles.label}>Visibility</td>
              <td>
                <select
                  aria-label="Visibility"
                  value={visibilityValue}
                  disabled={pending || deleted}
                  onChange={(e) => handleVisibilityChange(e.target.value as DocVisibility)}
                  className={styles.visibilitySelect}
                >
                  {visibilityOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                {visibilityOptions.includes("PUBLIC") && (
                  // Beside every choice that offers PUBLIC (docs/WIKI.md "Public pages").
                  <p className={styles.hint}>{PUBLIC_VISIBILITY_NOTE}</p>
                )}
                {wiki?.frontPage && visibilityValue === "PUBLIC" && !deleted && (
                  <p className={styles.hint} data-front-page-note="">
                    {FRONT_PAGE_SETTINGS_NOTE}
                  </p>
                )}
              </td>
            </tr>
            {ydoc && (
              <tr>
                <td className={styles.label}>Mentions</td>
                <td>
                  {/* Written into the doc itself, through the editor's
                      connection: every open view relabels at once. */}
                  <MentionStyleSelect ydoc={ydoc} disabled={deleted} className={styles.visibilitySelect} />
                </td>
              </tr>
            )}
            {ydoc && (
              <tr>
                <td className={styles.label}>Citations</td>
                <td>
                  <CitationStyleSelect ydoc={ydoc} disabled={deleted} className={styles.visibilitySelect} />
                </td>
              </tr>
            )}
            <tr>
              <td className={styles.label}>Url</td>
              <td>
                {wiki ? (
                  // A wiki page's url is its address; its slug is frozen
                  // while it is in the wiki, and its history is on the slug
                  // page (docs/WIKI.md "URLs").
                  <>
                    <code>{wiki.path}</code> <Link href={`/doc/${docId}/slug`}>History…</Link>
                  </>
                ) : (
                  <Link href={`/doc/${docId}/slug`}>Change…</Link>
                )}
              </td>
            </tr>
            <tr>
              <td className={styles.label}>Created</td>
              <td>{createdAt.toString()}</td>
            </tr>
          </tbody>
        </table>

        {confirmingDelete ? (
          <DeleteAddressesConfirm
            docs={[{ history: addressHistory }]}
            pending={pending}
            onConfirm={handleDeleteToggle}
            onCancel={() => setConfirmingDelete(false)}
          />
        ) : (
          <button type="button" onClick={handleDeleteToggle} disabled={pending} className={styles.deleteButton}>
            {deleted ? "Undelete" : "Delete"}
          </button>
        )}

        {error && <p className={styles.errorMessage}>{error}</p>}
      </div>
    </details>
  );
}
