"use client";

import { useActionState, useState, type RefObject } from "react";
import type { DocVisibility } from "@/generated/prisma/enums";
import { moveWikiPageAction, previewWikiMoveAddressAction, type WikiClaimState } from "@/app/actions/wiki";
import { PUBLIC_VISIBILITY_NOTE } from "@/lib/doc-visibility";
import { ClaimError, NameFields, nameFieldsOk, ownerOf, useDefaultAddress, type WikiNamespace, type WikiNamespaces } from "./wiki-dialog-parts";
import styles from "@/components/DocActionsMenu.module.css";

const initialState: WikiClaimState = {};

/** Where a page can go from where it is: the one other namespace the viewer may take it to, or out of the wiki. */
export type WikiPageMoveTargets = {
  /** The namespace offered, the viewer's own for a commons page and the commons for theirs; null when neither is theirs to enter. */
  namespace: WikiNamespace | null;
  /** Why the viewer's own namespace isn't offered for a commons page, when it isn't. */
  namespaceRefusal: string | null;
};

type Where = WikiNamespace | "out";

/**
 * docs/WIKI.md "The Actions menu", "Renaming" and "Moving out of the wiki" —
 * "Move…" on a wiki page: to the other namespace its mover may take it to,
 * under a name (its own by default) and a variant, or out of the wiki, as a
 * doc. A `PRIVATE` page entering the commons is asked for `SHARED` or
 * `PUBLIC`, and a `PUBLIC` page leaving the wiki for `SHARED` or `PRIVATE`;
 * every other move keeps the page's visibility. The front page says that
 * moving it takes the preamble off the landing page. The action lands on the
 * page at its new address, or on the doc.
 */
export default function MoveWikiPageDialog({
  dialogRef,
  open,
  onClose,
  docId,
  name: pageName,
  visibility: pageVisibility,
  namespaces,
  targets,
  frontPage,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  /** Whether it is showing: only then does it ask the server for its default address. */
  open: boolean;
  onClose: () => void;
  docId: string;
  /** The page's name, the name's default where it goes. */
  name: string;
  visibility: DocVisibility;
  namespaces: WikiNamespaces;
  targets: WikiPageMoveTargets;
  /** Whether this is the commons' `Front Page` while it is `PUBLIC`, the landing page's preamble. */
  frontPage: boolean;
}) {
  const [state, formAction, pending] = useActionState(moveWikiPageAction, initialState);
  const [where, setWhere] = useState<Where>(() => targets.namespace ?? "out");
  const [name, setName] = useState(pageName);
  const [variant, setVariant] = useState("");
  const [visibility, setVisibility] = useState<DocVisibility>("SHARED");

  const namespace = where === "out" ? null : where;
  const preview = useDefaultAddress(previewWikiMoveAddressAction, namespace, name, open && variant.trim() === "");
  const asksVisibility = (where === "commons" && pageVisibility === "PRIVATE") || (where === "out" && pageVisibility === "PUBLIC");
  const ready = where === "out" || nameFieldsOk(name, variant);

  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="move-wiki-page-title" onClose={onClose}>
      <form action={formAction} className={styles.form}>
        <h2 id="move-wiki-page-title" className={styles.title}>
          Move this page
        </h2>
        <input type="hidden" name="docId" value={docId} />
        <input type="hidden" name="namespace" value={where} />
        <fieldset className={styles.fieldset}>
          <legend>Where</legend>
          {targets.namespace === "person" && (
            <label>
              <input type="radio" name="where" value="person" checked={where === "person"} onChange={() => setWhere("person")} /> Your
              wiki pages{namespaces.person ? ` (@${namespaces.person.slug})` : ""}
            </label>
          )}
          {targets.namespace === "commons" && (
            <label>
              <input type="radio" name="where" value="commons" checked={where === "commons"} onChange={() => setWhere("commons")} /> The
              commons
            </label>
          )}
          {targets.namespace === null && targets.namespaceRefusal && <span className={styles.note}>{targets.namespaceRefusal}</span>}
          <label>
            <input type="radio" name="where" value="out" checked={where === "out"} onChange={() => setWhere("out")} /> Out of the wiki, as
            a doc
          </label>
        </fieldset>
        {namespace !== null ? (
          <>
            <NameFields
              owner={ownerOf(namespace, namespaces)}
              name={name}
              onName={setName}
              variant={variant}
              onVariant={setVariant}
              preview={preview}
            />
            <p className={styles.note}>
              The names it holds where it is now are freed at once. Its old addresses lead to it while nothing else is there.
            </p>
          </>
        ) : (
          <p className={styles.note}>
            This page becomes a doc again. Its name becomes its title, written into its text as an edit of yours, and its doc url is
            its URL again. Its old addresses lead to the doc while nothing else is there, and their names are freed at once. It keeps
            its notes, tags, links, history and forks, and can be published as a blog post.
          </p>
        )}
        {asksVisibility &&
          (where === "commons" ? (
            <>
              <label className={styles.field}>
                Who can read it
                <select name="visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as DocVisibility)}>
                  <option value="SHARED">SHARED: everyone who can read docs here</option>
                  <option value="PUBLIC">PUBLIC: anyone, signed out included</option>
                </select>
              </label>
              <p className={styles.note}>
                A commons page is never PRIVATE.{visibility === "PUBLIC" && <> {PUBLIC_VISIBILITY_NOTE}</>}
              </p>
            </>
          ) : (
            <>
              <label className={styles.field}>
                Who can read it
                <select name="visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as DocVisibility)}>
                  <option value="SHARED">SHARED: everyone who can read docs here</option>
                  <option value="PRIVATE">PRIVATE: its byline only</option>
                </select>
              </label>
              <p className={styles.note}>Only a wiki page can be PUBLIC, so the doc is read signed in.</p>
            </>
          ))}
        {frontPage && (
          <p className={styles.note}>This page is the landing page&apos;s preamble: moving it takes the preamble off the landing page.</p>
        )}
        <ClaimError state={state} />
        <div className={styles.buttons}>
          <button type="button" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
          <button type="submit" disabled={pending || !ready}>
            {pending ? "Moving..." : "Move"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
