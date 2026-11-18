"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { renameWikiPageAction } from "@/app/actions/wiki";
import { checkWikiName } from "@/lib/wiki-name";

// docs/WIKI.md "The name is the title" — the name above a wiki page's text in
// its editor, where a doc has its title field, and the page's rename
// control: a field holding the name, checked by the rules as it is typed,
// with a Rename button once it differs. A rename goes on to the editor at the
// new address. The variant changes on /doc/<slug>/slug, and the namespace
// through Move… (PR 5). The server asks every rule again (wiki-rename.ts).

type Props = {
  docId: string;
  name: string;
  /** False on a deleted page, which is renamed after it is restored. */
  editable: boolean;
  /** The editor's title-field class, so the name sits where a doc's title does. */
  className: string;
};

export default function WikiNameField({ docId, name, editable, className }: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<{ message: string; takenPath?: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const checked = checkWikiName(draft);
  const changed = draft !== name;

  function rename() {
    if (!checked.ok || checked.name === name) return;
    setError(null);
    startTransition(async () => {
      const answer = await renameWikiPageAction(docId, checked.name);
      if (!answer.ok) {
        setError({ message: answer.error, takenPath: answer.takenPath });
        return;
      }
      router.replace(answer.result.editPath);
    });
  }

  function reset() {
    setDraft(name);
    setError(null);
  }

  return (
    <div data-wiki-name-field="">
      <input
        className={className}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            rename();
          } else if (e.key === "Escape") {
            reset();
          }
        }}
        disabled={!editable || pending}
        aria-label="Page name"
        data-wiki-name=""
        style={{ fontFamily: "inherit" }}
      />
      {changed && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline", marginTop: -6, marginBottom: 12 }}>
          <button type="button" onClick={rename} disabled={pending || !checked.ok || checked.name === name}>
            Rename
          </button>
          <button type="button" onClick={reset} disabled={pending}>
            Cancel
          </button>
          {!checked.ok && draft !== "" && (
            <span style={{ color: "var(--error)", fontSize: "0.85rem" }}>{checked.message}</span>
          )}
          {error && (
            <span style={{ color: "var(--error)", fontSize: "0.85rem" }} role="alert">
              {error.message}
              {error.takenPath && (
                <>
                  {" "}
                  <Link href={error.takenPath}>See the page there.</Link>
                </>
              )}
            </span>
          )}
          {checked.ok && !error && (
            <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
              Links to the old name will still reach this page.
            </span>
          )}
        </div>
      )}
    </div>
  );
}
