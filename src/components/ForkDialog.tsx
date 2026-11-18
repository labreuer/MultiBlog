"use client";

import { useActionState, useCallback, useState, type RefObject } from "react";
import type { DocVisibility } from "@/generated/prisma/enums";
import { forkDocAction, type ForkDocState } from "@/app/actions/docs";
import { forkIntoWikiAction, previewWikiForkAddressAction, type WikiClaimState } from "@/app/actions/wiki";
import LocalTime from "@/components/LocalTime";
import type { ScrubPosition } from "@/components/DocScrubContext";
import { allowedVisibilities, PUBLIC_VISIBILITY_NOTE } from "@/lib/doc-visibility";
import { checkWikiName } from "@/lib/wiki-name";
import {
  ClaimError,
  defaultWikiName,
  firstNamespace,
  NameFields,
  nameFieldsOk,
  NamespaceRadios,
  ownerOf,
  useDefaultAddress,
  type WikiNamespace,
  type WikiNamespaces,
} from "@/components/wiki/wiki-dialog-parts";
import styles from "./DocActionsMenu.module.css";

const initialDocState: ForkDocState = {};
const initialWikiState: WikiClaimState = {};

/** Where the fork goes: a doc of the forker's own, or a wiki page in a namespace. */
type Where = "doc" | WikiNamespace;

/**
 * docs/FORKS.md "The doc view: an Actions menu and the Fork dialog", and
 * docs/WIKI.md "The Actions menu" — says what the fork will copy, asks where
 * it goes and who can read it. With "a doc" for its Where it is main's
 * dialog, `PRIVATE` by default whatever the parent's, and calls
 * forkDocAction; with a namespace it asks for a name (the parent's, or its
 * title in the rules' normal form) and a variant, shows the address the
 * server would pick, offers what allowedVisibilities allows there (`PRIVATE`
 * in your namespace and `SHARED` in the commons by default), and calls
 * forkIntoWikiAction. "A doc" is the default on a doc and your namespace on
 * a wiki page.
 *
 * `position` is where the scrub bar's slider was when the dialog opened
 * (DocActionsMenu asks the bar), null for the doc as it is now. The action
 * lands on the fork's editor; a refusal is shown here. A native <dialog>,
 * opened by its owner with `showModal()`, so Escape and the backdrop are the
 * browser's.
 */
export default function ForkDialog({
  dialogRef,
  open,
  onClose,
  parentId,
  position,
  title,
  isWikiPage,
  namespaces,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  /** Whether it is showing: only then does it ask the server for its default address. */
  open: boolean;
  onClose: () => void;
  parentId: string;
  position: ScrubPosition | null;
  /** The doc's title as the view shows it, a wiki page's being its name: the name's default. */
  title: string;
  isWikiPage: boolean;
  namespaces: WikiNamespaces;
}) {
  const [docState, docAction, docPending] = useActionState(forkDocAction, initialDocState);
  const [wikiState, wikiAction, wikiPending] = useActionState(forkIntoWikiAction, initialWikiState);
  const [where, setWhere] = useState<Where>(() => (isWikiPage ? (firstNamespace(namespaces) ?? "doc") : "doc"));
  const [name, setName] = useState(() => defaultWikiName(title));
  const [variant, setVariant] = useState("");
  const [visibility, setVisibility] = useState<DocVisibility>(where === "commons" ? "SHARED" : "PRIVATE");

  const lookup = useCallback((w: WikiNamespace, n: string) => previewWikiForkAddressAction(parentId, w, n), [parentId]);
  const namespace = where === "doc" ? null : where;
  const preview = useDefaultAddress(lookup, namespace, name, open && variant.trim() === "");
  const checked = checkWikiName(name);
  const options: DocVisibility[] =
    namespace === null
      ? ["PRIVATE", "SHARED"]
      : allowedVisibilities(
          { visibility, wikiName: checked.ok ? checked.name : "x", wikiOwnerUserId: namespace === "person" ? namespaces.viewerId : null },
          namespaces.viewerId,
        );
  const pending = docPending || wikiPending;
  const state = namespace === null ? docState : wikiState;

  function chooseWhere(next: Where) {
    setWhere(next);
    setVisibility(next === "commons" ? "SHARED" : "PRIVATE");
  }

  const offersWiki = namespaces.person !== null || namespaces.commons;

  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="fork-dialog-title" onClose={onClose}>
      <form action={namespace === null ? docAction : wikiAction} className={styles.form}>
        <h2 id="fork-dialog-title" className={styles.title}>
          {isWikiPage ? "Fork this page" : "Fork this doc"}
        </h2>
        <input type="hidden" name="parentId" value={parentId} />
        <input type="hidden" name="revision" value={position?.updateId ?? ""} />
        {namespace !== null && <input type="hidden" name="namespace" value={namespace} />}
        <p className={styles.note} data-kind="fork-copies">
          {namespace === null ? "A new doc of your own" : "A new wiki page"}
          {position ? (
            <>
              , starting as a copy of this one as it was at <LocalTime value={position.createdAt} />.
            </>
          ) : (
            ", starting as a copy of this one as it is now."
          )}{" "}
          Its text keeps its authors&apos; colours. Notes, tags, links and posts stay with this {isWikiPage ? "page" : "doc"}.
        </p>
        {(offersWiki || namespaces.personRefusal) && (
          <fieldset className={styles.fieldset}>
            <legend>Where</legend>
            <label>
              <input type="radio" name="where" value="doc" checked={where === "doc"} onChange={() => chooseWhere("doc")} /> A doc
            </label>
            <NamespaceRadios namespaces={namespaces} where={where} onChange={chooseWhere} />
          </fieldset>
        )}
        {namespace !== null && (
          <NameFields
            owner={ownerOf(namespace, namespaces)}
            name={name}
            onName={setName}
            variant={variant}
            onVariant={setVariant}
            preview={preview}
          />
        )}
        <label className={styles.field}>
          Who can read it
          <select name="visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as DocVisibility)}>
            {options.map((option) => (
              <option key={option} value={option}>
                {VISIBILITY_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        {visibility === "PUBLIC" && <p className={styles.note}>{PUBLIC_VISIBILITY_NOTE}</p>}
        <ClaimError state={state} />
        <div className={styles.buttons}>
          <button type="button" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
          <button type="submit" disabled={pending || (namespace !== null && !nameFieldsOk(name, variant))}>
            {pending ? "Forking..." : "Fork"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

const VISIBILITY_LABELS: Record<DocVisibility, string> = {
  PRIVATE: "PRIVATE: you alone, until you add authors",
  SHARED: "SHARED: everyone who can read docs here",
  PUBLIC: "PUBLIC: anyone, signed out included",
};
