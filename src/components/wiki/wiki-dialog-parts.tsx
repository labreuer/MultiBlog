"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Role } from "@/generated/prisma/enums";
import type { WikiAddressPreview } from "@/lib/wiki-fork";
import { isWikiVariant, wikiPagePath, type WikiOwner } from "@/lib/wiki-address";
import { checkWikiName } from "@/lib/wiki-name";
import styles from "@/components/DocActionsMenu.module.css";

// What the doc view's Fork dialog and "Move into the wiki…" share
// (docs/WIKI.md "The Actions menu"): which namespaces the viewer may claim
// in, the name and variant fields, the address the server would pick, and a
// refusal with a link to the page at a taken address.

export type WikiNamespace = "person" | "commons";

/**
 * Where a viewer may put a page, as wikiNamespacesFor answers it on the
 * server: their own namespace (null, with the reason, when they may not) and
 * the commons for an ADMIN or EDITOR. `viewer` is who is asking, whose role
 * decides whether a dialog offers `PUBLIC` (canMakePagesPublic).
 */
export type WikiNamespaces = {
  viewer: { id: string; role: Role };
  person: { slug: string } | null;
  personRefusal: string | null;
  commons: boolean;
};

/** The first namespace the viewer may claim in: theirs, else the commons; null for neither. */
export function firstNamespace(namespaces: WikiNamespaces): WikiNamespace | null {
  return namespaces.person ? "person" : namespaces.commons ? "commons" : null;
}

export function ownerOf(where: WikiNamespace, namespaces: WikiNamespaces): WikiOwner {
  return where === "person" && namespaces.person ? { kind: "person", slug: namespaces.person.slug } : { kind: "commons" };
}

/**
 * A doc's title as a name's default: the rules' normal form when they accept
 * it, else as it is, for the dialog to say what to change before anything is
 * claimed ("Forking into the wiki").
 */
export function defaultWikiName(title: string): string {
  const checked = checkWikiName(title);
  return checked.ok ? checked.name : title;
}

/** The namespace radios, one per namespace the viewer may claim in, with the reason their own is refused. */
export function NamespaceRadios({
  namespaces,
  where,
  onChange,
}: {
  namespaces: WikiNamespaces;
  where: string | null;
  onChange: (where: WikiNamespace) => void;
}) {
  return (
    <>
      <label>
        <input
          type="radio"
          name="where"
          value="person"
          checked={where === "person"}
          disabled={!namespaces.person}
          onChange={() => onChange("person")}
        />{" "}
        Your wiki pages{namespaces.person ? ` (@${namespaces.person.slug})` : ""}
      </label>
      {!namespaces.person && namespaces.personRefusal && <span className={styles.note}>{namespaces.personRefusal}</span>}
      {namespaces.commons && (
        <label>
          <input type="radio" name="where" value="commons" checked={where === "commons"} onChange={() => onChange("commons")} /> The
          commons
        </label>
      )}
    </>
  );
}

/**
 * The address a claim with no variant typed would get, asked of the server
 * after a pause in typing and only while `enabled`: the dialogs are mounted
 * whenever their item is offered, and a lookup from a closed one would be a
 * server action on every load of the page. Undefined while it is being
 * asked. Only a preview, read without the address lock: the server picks
 * again when the form is sent, so of two claims of one default the second
 * gets the next ("Claiming an address"). `lookup` must keep its identity
 * across renders.
 */
export function useDefaultAddress(
  lookup: (where: WikiNamespace, name: string) => Promise<WikiAddressPreview>,
  where: WikiNamespace | null,
  name: string,
  enabled: boolean,
): WikiAddressPreview | undefined {
  const [answer, setAnswer] = useState<{ key: string; preview: WikiAddressPreview } | null>(null);
  const key = `${where}\n${name}`;
  const nameOk = checkWikiName(name).ok;
  useEffect(() => {
    if (!enabled || where === null || !nameOk) return;
    let live = true;
    const timer = setTimeout(() => {
      lookup(where, name).then(
        (preview) => live && setAnswer({ key, preview }),
        () => live && setAnswer({ key, preview: { ok: false, error: "Couldn't ask the server where it would go." } }),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [lookup, where, name, nameOk, enabled, key]);
  return answer?.key === key ? answer.preview : undefined;
}

/**
 * The name and variant fields, each checked by the rules as it is typed,
 * and the address the form would claim: a typed variant as typed, or the
 * server's default. The name's normal form is what is sent and shown.
 */
export function NameFields({
  owner,
  name,
  onName,
  variant,
  onVariant,
  preview,
}: {
  owner: WikiOwner;
  name: string;
  onName: (name: string) => void;
  variant: string;
  onVariant: (variant: string) => void;
  preview: WikiAddressPreview | undefined;
}) {
  const checked = checkWikiName(name);
  const typed = variant.trim();
  const variantOk = typed === "" || isWikiVariant(typed);
  let address: string;
  if (!checked.ok) address = "Its address needs a name the rules accept.";
  else if (!variantOk) address = "Its address needs a variant the rules accept.";
  else if (typed !== "") address = wikiPagePath({ owner, name: checked.name, variant: typed });
  else if (preview === undefined) address = `${wikiPagePath({ owner, name: checked.name, variant: "" })} …`;
  else address = preview.ok ? preview.path : preview.error;
  return (
    <>
      <label className={styles.field}>
        Name
        <input name="name" required value={name} onChange={(e) => onName(e.target.value)} />
      </label>
      {name !== "" && !checked.ok && <p className={styles.error}>{checked.message}</p>}
      <label className={styles.field}>
        Variant (optional)
        <input name="variant" value={variant} onChange={(e) => onVariant(e.target.value)} />
      </label>
      {!variantOk && <p className={styles.error}>A variant is lowercase letters, digits and single dashes.</p>}
      <p className={styles.note} data-wiki-dialog-address="">
        {address}
      </p>
    </>
  );
}

/** Whether the fields hold a name and a variant the rules accept, which the submit waits for. */
export function nameFieldsOk(name: string, variant: string): boolean {
  const typed = variant.trim();
  return checkWikiName(name).ok && (typed === "" || isWikiVariant(typed));
}

export function ClaimError({ state }: { state: { error?: string; takenPath?: string } }) {
  if (!state.error) return null;
  return (
    <p className={styles.error}>
      {state.error}
      {state.takenPath && (
        <>
          {" "}
          <Link href={state.takenPath}>The page there</Link>.
        </>
      )}
    </p>
  );
}
