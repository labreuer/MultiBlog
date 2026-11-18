"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import type { DocVisibility, Role } from "@/generated/prisma/enums";
import { createWikiPageAction, type CreateWikiPageState } from "@/app/actions/wiki";
import { newPageVisibilities, PUBLIC_VISIBILITY_NOTE } from "@/lib/doc-visibility";
import { isWikiVariant, wikiPagePath, type WikiOwner } from "@/lib/wiki-address";
import { checkWikiName } from "@/lib/wiki-name";
import styles from "../wiki.module.css";

const initialState: CreateWikiPageState = {};

/**
 * docs/WIKI.md "Creating a page" — where, a name, a variant and who can read
 * it. The name is the page's title, checked by the rules as it is typed, with
 * their messages; the server checks it again. The variant is empty unless
 * typed, and the visibility starts PRIVATE in your namespace and SHARED in
 * the commons, which is never PRIVATE; PUBLIC is offered to an ADMIN or
 * EDITOR alone (newPageVisibilities).
 */
export default function NewWikiPageForm({
  viewer,
  person,
  personRefusal,
  commons,
  initial,
}: {
  viewer: { id: string; role: Role };
  person: { id: string; slug: string } | null;
  personRefusal: string | null;
  commons: boolean;
  initial: { where: "person" | "commons"; name: string; variant: string };
}) {
  const [state, formAction, pending] = useActionState(createWikiPageAction, initialState);
  const [where, setWhere] = useState(initial.where);
  const [name, setName] = useState(initial.name);
  const [variant, setVariant] = useState(initial.variant);
  const [visibility, setVisibility] = useState<DocVisibility>(initial.where === "commons" ? "SHARED" : "PRIVATE");

  const owner: WikiOwner = where === "person" && person ? { kind: "person", slug: person.slug } : { kind: "commons" };
  const checked = checkWikiName(name);
  const variantOk = isWikiVariant(variant);
  const options = newPageVisibilities(where === "person" ? (person?.id ?? null) : null, viewer);

  function chooseWhere(next: "person" | "commons") {
    setWhere(next);
    setVisibility(next === "commons" ? "SHARED" : "PRIVATE");
  }

  return (
    <form action={formAction} className={styles.form}>
      <fieldset className={styles.fieldset}>
        <legend>Where</legend>
        <label>
          <input
            type="radio"
            name="namespace"
            value="person"
            checked={where === "person"}
            disabled={!person}
            onChange={() => chooseWhere("person")}
          />{" "}
          Your pages{person ? ` (@${person.slug})` : ""}
        </label>
        {!person && personRefusal && <span className={styles.address}>{personRefusal}</span>}
        {commons && (
          <label>
            <input type="radio" name="namespace" value="commons" checked={where === "commons"} onChange={() => chooseWhere("commons")} />{" "}
            The commons
          </label>
        )}
      </fieldset>
      <label>
        Name
        <input name="name" required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {name !== "" && !checked.ok && <p className={styles.error}>{checked.message}</p>}
      <label>
        Variant (optional)
        <input name="variant" value={variant} onChange={(e) => setVariant(e.target.value)} />
      </label>
      {!variantOk && <p className={styles.error}>A variant is lowercase letters, digits and single dashes.</p>}
      <p className={styles.address} data-wiki-new-address="">
        {checked.ok && variantOk ? wikiPagePath({ owner, name: checked.name, variant }) : "Its address needs a name the rules accept."}
      </p>
      <label>
        Who can read it
        <select name="visibility" value={visibility} onChange={(e) => setVisibility(e.target.value as DocVisibility)}>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      {options.includes("PUBLIC") && <p className={styles.address}>{PUBLIC_VISIBILITY_NOTE}</p>}
      {state.error && (
        <p className={styles.error}>
          {state.error}
          {state.takenPath && (
            <>
              {" "}
              <Link href={state.takenPath}>The page there</Link>.
            </>
          )}
        </p>
      )}
      <button type="submit" disabled={pending || !checked.ok || !variantOk}>
        {pending ? "Creating..." : "Create page"}
      </button>
    </form>
  );
}
