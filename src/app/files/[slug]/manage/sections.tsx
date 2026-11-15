"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  manageFileDeleted,
  manageFileVisibility,
  updateFileOwners,
  updateFileTitle,
} from "@/app/actions/files";
import LocalTime from "@/components/LocalTime";
import type { DocVisibility } from "@/generated/prisma/enums";
import styles from "./page.module.css";

// docs/PDF.md §14, "What the page holds" — the sections of a file's manage
// page that write. Each calls an action that answers a refusal rather than
// throwing one, and shows that refusal in its own words.
//
// This page is server-rendered and behind no `ssr: false` boundary, so after
// an act `router.refresh()` delivers the new state; a section's own state (an
// edit in progress, a restore's notice) outlives that refresh because the
// component stays mounted.

export type OwnerEntry = {
  id: string;
  label: string;
  /** Why this owner could not be added today, where that is so: their account was deleted, or moved to a role outside FILE_MANAGER_ROLES. */
  note: string | null;
};

function ErrorLine({ message }: { message: string | null }) {
  return message ? (
    <p className={styles.error} role="alert">
      {message}
    </p>
  ) : null;
}

export function FileTitleSection({ fileId, title }: { fileId: string; title: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const answer = await updateFileTitle(fileId, draft);
      if (!answer.ok) {
        setError(answer.error);
        return;
      }
      setDraft(answer.value.title);
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <section className={styles.section} aria-labelledby="file-title">
      <h2 id="file-title">Title</h2>
      <form
        className={styles.row}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <input
          className={styles.wide}
          aria-label="Title"
          value={draft}
          maxLength={500}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
        />
        <button type="submit" disabled={pending || draft === title}>
          {pending ? "Saving…" : "Save"}
        </button>
      </form>
      {saved && <p className={styles.muted}>Saved.</p>}
      <ErrorLine message={error} />
      <p className={styles.help}>A title keeps no history, so a rename can&apos;t be undone except by typing the old title back.</p>
    </section>
  );
}

export function FileVisibilitySection({
  fileId,
  visibility,
  viewerIsOwner,
  viewerManagesAnyShared,
}: {
  fileId: string;
  visibility: DocVisibility;
  viewerIsOwner: boolean;
  viewerManagesAnyShared: boolean;
}) {
  const router = useRouter();
  const [choice, setChoice] = useState<DocVisibility>(visibility);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // A viewer who manages the file without owning it manages a SHARED file by
  // their role alone, and a PRIVATE one not at all (canUserManageFile).
  const losesFile = choice === "PRIVATE" && visibility !== "PRIVATE" && !viewerIsOwner && viewerManagesAnyShared;

  function save() {
    setError(null);
    if (losesFile && !confirming) {
      setConfirming(true);
      return;
    }
    startTransition(async () => {
      const answer = await manageFileVisibility(fileId, choice);
      setConfirming(false);
      if (!answer.ok) {
        setError(answer.error);
        return;
      }
      if (losesFile) router.push("/files");
      else router.refresh();
    });
  }

  return (
    <section className={styles.section} aria-labelledby="file-visibility">
      <h2 id="file-visibility">Visibility</h2>
      <div role="radiogroup" aria-labelledby="file-visibility" className={styles.choices}>
        <label>
          <input
            type="radio"
            name="visibility"
            value="SHARED"
            checked={choice === "SHARED"}
            onChange={() => {
              setChoice("SHARED");
              setConfirming(false);
            }}
          />{" "}
          SHARED: anyone who may read files can read it.
        </label>
        <label>
          <input
            type="radio"
            name="visibility"
            value="PRIVATE"
            checked={choice === "PRIVATE"}
            onChange={() => {
              setChoice("PRIVATE");
              setConfirming(false);
            }}
          />{" "}
          PRIVATE: only the owners listed below can read it.
        </label>
      </div>
      {choice === "PRIVATE" && visibility !== "PRIVATE" && (
        <p className={styles.warning}>
          Everyone who is not one of its owners will stop being able to read this file, its notes and the links into it.
        </p>
      )}
      {losesFile && (
        <p className={styles.warning}>
          You aren&apos;t one of its owners, so you will lose this page and the file too.
        </p>
      )}
      <div className={styles.row}>
        {confirming ? (
          <>
            <button type="button" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Yes, make it private"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" onClick={save} disabled={pending || choice === visibility}>
            {pending ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      <ErrorLine message={error} />
    </section>
  );
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function listInWords(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The owner list, edited and then saved once (docs/PDF.md §14, item 5), so a
 * hand-over (add someone, take yourself off) is one transaction.
 *
 * **`startedFrom` is the list the edit started from, and a refresh replaces
 * neither it nor the edit.** It is the `expected` the save sends. Every other
 * save on the page refreshes it; were `startedFrom` taken from the refreshed
 * list, a change someone else made meanwhile would arrive with it and the save
 * would overwrite that change, which is what `expected` is there to refuse.
 * Only an untouched list follows a refresh, since no edit has started from it.
 * Where the stored list differs from the one the edit started from, it is
 * shown beside the edit, to start again from.
 */
export function FileOwnersSection({
  fileId,
  slug,
  isPdf,
  visibility,
  viewerId,
  viewerManagesAnyShared,
  owners,
  eligible,
}: {
  fileId: string;
  slug: string;
  isPdf: boolean;
  visibility: DocVisibility;
  viewerId: string;
  viewerManagesAnyShared: boolean;
  owners: OwnerEntry[];
  eligible: { id: string; label: string }[];
}) {
  const router = useRouter();
  const stored = owners.map((owner) => owner.id);
  const storedKey = stored.join(",");
  const [startedFrom, setStartedFrom] = useState(stored);
  const [draft, setDraft] = useState(stored);
  const [seenKey, setSeenKey] = useState(storedKey);
  // Every person this section has been told about, so one taken off the
  // stored list meanwhile is still named in the edit.
  const [known, setKnown] = useState(() => new Map(owners.map((owner) => [owner.id, owner])));
  const [adding, setAdding] = useState("");
  const [dragged, setDragged] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Set by a save that worked, until the refresh it asked for brings the list it wrote.
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A refresh's new list, taken in during render rather than in an effect.
  if (seenKey !== storedKey) {
    setSeenKey(storedKey);
    setKnown((previous) => new Map([...previous, ...owners.map((owner) => [owner.id, owner] as const)]));
    if (justSaved || sameList(draft, startedFrom)) {
      setStartedFrom(stored);
      setDraft(stored);
      setJustSaved(false);
    }
  }

  const entryOf = (id: string): OwnerEntry =>
    owners.find((owner) => owner.id === id) ??
    known.get(id) ?? { id, label: eligible.find((person) => person.id === id)?.label ?? "An account no longer listed", note: null };
  const removed = startedFrom.filter((id) => !draft.includes(id));
  const removesSelf = removed.includes(viewerId);
  // An ADMIN or EDITOR manages a SHARED file without being on its list.
  const selfLosesPage = removesSelf && !(visibility === "SHARED" && viewerManagesAnyShared);
  const othersLosingRead = visibility === "PRIVATE" ? removed.filter((id) => id !== viewerId).map((id) => entryOf(id).label) : [];
  const addable = eligible.filter((person) => !draft.includes(person.id));
  const dirty = !justSaved && !sameList(draft, startedFrom);

  function move(from: number, to: number) {
    if (to < 0 || to >= draft.length || from === to) return;
    setDraft((list) => {
      const next = [...list];
      const [id] = next.splice(from, 1);
      next.splice(to, 0, id);
      return next;
    });
    setConfirming(false);
  }

  function save() {
    setError(null);
    if (selfLosesPage && !confirming) {
      setConfirming(true);
      return;
    }
    startTransition(async () => {
      const answer = await updateFileOwners(fileId, draft, startedFrom);
      setConfirming(false);
      if (!answer.ok) {
        setError(answer.error);
        // Fetches the list as it now is, which is then shown beside the edit.
        router.refresh();
        return;
      }
      if (selfLosesPage) {
        // A PDF of a SHARED file is still theirs to read; anything else isn't, or has no page to read it on.
        router.push(visibility === "SHARED" && isPdf ? `/pdf/${slug}` : "/files");
        return;
      }
      setJustSaved(true);
      router.refresh();
    });
  }

  return (
    <section className={styles.section} aria-labelledby="file-owners">
      <h2 id="file-owners">Owners</h2>
      <p className={styles.help}>
        Owners manage the file{visibility === "PRIVATE" ? ", and are the only people who can read it while it is PRIVATE" : ""}.
        Drag to reorder. Nothing is changed until you save.
      </p>
      <ol className={styles.owners} aria-label="Owners">
        {draft.map((id, index) => {
          const entry = entryOf(id);
          return (
            <li
              key={id}
              draggable
              className={`${styles.owner} ${dragOver === index ? styles.dragOver : ""}`}
              onDragStart={(event) => {
                setDragged(index);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                if (dragged === null) return;
                event.preventDefault();
                setDragOver(index);
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(event) => {
                event.preventDefault();
                if (dragged !== null) move(dragged, index);
                setDragged(null);
                setDragOver(null);
              }}
              onDragEnd={() => {
                setDragged(null);
                setDragOver(null);
              }}
            >
              <span className={styles.ownerName}>
                {entry.label}
                {id === viewerId && <span className={styles.muted}> (you)</span>}
                {entry.note && <span className={styles.muted}> ({entry.note})</span>}
              </span>
              <button type="button" aria-label={`Move ${entry.label} up`} onClick={() => move(index, index - 1)} disabled={index === 0}>
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${entry.label} down`}
                onClick={() => move(index, index + 1)}
                disabled={index === draft.length - 1}
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft((list) => list.filter((other) => other !== id));
                  setConfirming(false);
                }}
                disabled={draft.length === 1}
                title={draft.length === 1 ? "A file must have at least one owner." : undefined}
              >
                Remove
              </button>
            </li>
          );
        })}
      </ol>
      <div className={styles.row}>
        <select aria-label="Add an owner" value={adding} onChange={(event) => setAdding(event.target.value)}>
          <option value="">Add an owner…</option>
          {addable.map((person) => (
            <option key={person.id} value={person.id}>
              {person.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!adding}
          onClick={() => {
            setDraft((list) => [...list, adding]);
            setAdding("");
            setConfirming(false);
          }}
        >
          Add
        </button>
      </div>

      {othersLosingRead.length > 0 && (
        <p className={styles.warning}>
          The file is PRIVATE, so {listInWords(othersLosingRead)} will no longer be able to read it, its notes or the links
          into it.
        </p>
      )}
      {selfLosesPage && (
        <p className={styles.warning}>
          You are taking yourself off, so you will lose this page
          {visibility === "PRIVATE" ? ", and the file as well, since it is PRIVATE" : ""}.
        </p>
      )}

      <div className={styles.row}>
        {confirming ? (
          <>
            <button type="button" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Yes, save and leave"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={save} disabled={pending || !dirty}>
              {pending ? "Saving…" : "Save owners"}
            </button>
            {dirty && (
              <button
                type="button"
                onClick={() => {
                  setDraft(startedFrom);
                  setError(null);
                }}
                disabled={pending}
              >
                Discard changes
              </button>
            )}
          </>
        )}
      </div>
      <ErrorLine message={error} />

      {!justSaved && !sameList(stored, startedFrom) && (
        <div className={styles.current}>
          <p>The owners as they are now:</p>
          <ol aria-label="Owners as they are now">
            {owners.map((owner) => (
              <li key={owner.id}>
                {owner.label}
                {owner.note && <span className={styles.muted}> ({owner.note})</span>}
              </li>
            ))}
          </ol>
          <button
            type="button"
            onClick={() => {
              setStartedFrom(stored);
              setDraft(stored);
              setError(null);
            }}
          >
            Start again from this list
          </button>
        </div>
      )}
    </section>
  );
}

export function FileDeleteSection({
  fileId,
  deleted,
  deletedAt,
  deletedBy,
}: {
  fileId: string;
  deleted: boolean;
  deletedAt: string | null;
  deletedBy: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  // Held here, so it outlives the refresh the restore ends with.
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(nextDeleted: boolean) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const answer = await manageFileDeleted(fileId, nextDeleted);
      if (!answer.ok) {
        setError(answer.error);
        return;
      }
      if (!nextDeleted) {
        const { slug, renamedFrom } = answer.value;
        setNotice(
          renamedFrom
            ? `Restored. Its url “${renamedFrom}” was taken by another file while it was deleted, so it came back as “${slug}”.`
            : "Restored.",
        );
      }
      router.refresh();
    });
  }

  return (
    <section className={styles.section} aria-labelledby="file-delete">
      <h2 id="file-delete">{deleted ? "Restore" : "Delete"}</h2>
      {deleted ? (
        <>
          <p>
            Deleted{deletedAt && <> <LocalTime value={deletedAt} /></>}
            {deletedBy && <> by {deletedBy}</>}. Restoring it brings back everything it had. If another file took its
            url meanwhile, it comes back under a new one.
          </p>
          <div className={styles.row}>
            <button type="button" onClick={() => run(false)} disabled={pending}>
              {pending ? "Restoring…" : "Restore this file"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className={styles.help}>
            Deleting hides the file and frees its url for another file, and can be undone from this page or from Files.
          </p>
          <div className={styles.row}>
            <button type="button" className={styles.danger} onClick={() => run(true)} disabled={pending}>
              {pending ? "Deleting…" : "Delete this file"}
            </button>
          </div>
        </>
      )}
      {notice && <p className={styles.notice}>{notice}</p>}
      <ErrorLine message={error} />
    </section>
  );
}
