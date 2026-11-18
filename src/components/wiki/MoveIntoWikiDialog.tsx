"use client";

import { useActionState, useState, type RefObject } from "react";
import type { DocVisibility } from "@/generated/prisma/enums";
import { moveDocIntoWikiAction, previewWikiMoveAddressAction, type WikiClaimState } from "@/app/actions/wiki";
import { PUBLIC_VISIBILITY_NOTE } from "@/lib/doc-visibility";
import { canMakePagesPublic } from "@/lib/role-checks";
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
} from "./wiki-dialog-parts";
import styles from "@/components/DocActionsMenu.module.css";

const initialState: WikiClaimState = {};

/**
 * docs/WIKI.md "Moving a doc into the wiki" — where, a name (the title in the
 * rules' normal form, edited where they refuse it) and a variant, empty
 * unless the address is taken, and then `2`, `3`, …, since there is no parent
 * to name. A `PRIVATE` doc moving into the commons, which is never
 * `PRIVATE`, is asked for `SHARED` or `PUBLIC`, `PUBLIC` being offered to a
 * viewer who may make pages public (canMakePagesPublic); every other move
 * keeps the doc's visibility. The action lands on the page at its address.
 */
export default function MoveIntoWikiDialog({
  dialogRef,
  open,
  onClose,
  docId,
  title,
  visibility: docVisibility,
  namespaces,
}: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  /** Whether it is showing: only then does it ask the server for its default address. */
  open: boolean;
  onClose: () => void;
  docId: string;
  title: string;
  visibility: DocVisibility;
  namespaces: WikiNamespaces;
}) {
  const [state, formAction, pending] = useActionState(moveDocIntoWikiAction, initialState);
  const [where, setWhere] = useState<WikiNamespace | null>(() => firstNamespace(namespaces));
  const [name, setName] = useState(() => defaultWikiName(title));
  const [variant, setVariant] = useState("");
  const [visibility, setVisibility] = useState<DocVisibility>("SHARED");

  const preview = useDefaultAddress(previewWikiMoveAddressAction, where, name, open && variant.trim() === "");
  const asksVisibility = where === "commons" && docVisibility === "PRIVATE";
  const offersPublic = canMakePagesPublic(namespaces.viewer.role);

  return (
    <dialog ref={dialogRef} className={styles.dialog} aria-labelledby="move-into-wiki-title" onClose={onClose}>
      <form action={formAction} className={styles.form}>
        <h2 id="move-into-wiki-title" className={styles.title}>
          Move into the wiki
        </h2>
        <input type="hidden" name="docId" value={docId} />
        {where !== null && <input type="hidden" name="namespace" value={where} />}
        <p className={styles.note}>
          This doc becomes a wiki page: its name is its title, and its address is its URL. It keeps its notes, tags, links and
          history, and its old URL leads to the page. A wiki page can&apos;t be published as a blog post.
        </p>
        <fieldset className={styles.fieldset}>
          <legend>Where</legend>
          <NamespaceRadios namespaces={namespaces} where={where} onChange={setWhere} />
        </fieldset>
        {where !== null && (
          <>
            <NameFields
              owner={ownerOf(where, namespaces)}
              name={name}
              onName={setName}
              variant={variant}
              onVariant={setVariant}
              preview={preview}
            />
            {asksVisibility && (
              <>
                <label className={styles.field}>
                  Who can read it
                  <select name="visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as DocVisibility)}>
                    <option value="SHARED">SHARED: everyone who can read docs here</option>
                    {offersPublic && <option value="PUBLIC">PUBLIC: anyone, signed out included</option>}
                  </select>
                </label>
                <p className={styles.note}>
                  A commons page is never PRIVATE.{visibility === "PUBLIC" && <> {PUBLIC_VISIBILITY_NOTE}</>}
                </p>
              </>
            )}
          </>
        )}
        <ClaimError state={state} />
        <div className={styles.buttons}>
          <button type="button" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
          <button type="submit" disabled={pending || where === null || !nameFieldsOk(name, variant)}>
            {pending ? "Moving..." : "Move"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
