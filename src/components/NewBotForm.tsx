"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Role } from "@/generated/prisma/enums";
import { botRolesFor } from "@/lib/bot-rules";
import { createBot } from "@/app/actions/users";
import { CellError } from "@/components/table/TableControls";
import { personLabel, type BotPerson } from "@/components/UsersTable";
import styles from "./NewBotForm.module.css";

// docs/MCP.md §21, "Whose account" — /users' way to make a bot: a name, the
// person it works for, and a role no higher than theirs. Only the people a
// bot may work for are offered, and only the roles it may have under the one
// chosen; createBot (src/lib/bots.ts) holds it to the same rules regardless.
// Its address is made from its slug, `<slug>@multiblog.invalid`.

/** Claude's account is an AUTHOR (docs/MCP.md §3), so a bot starts as one where its person allows. */
const DEFAULT_ROLE: Role = "AUTHOR";

export default function NewBotForm({ people }: { people: BotPerson[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [personId, setPersonId] = useState("");
  const [role, setRole] = useState<Role>(DEFAULT_ROLE);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);

  const person = people.find((p) => p.id === personId) ?? null;
  const roles = person ? botRolesFor(person.role) : [];
  // The role chosen if this person allows it, else the default, else the
  // highest they allow: picking a person never leaves an impossible role set.
  const chosen = roles.includes(role) ? role : roles.includes(DEFAULT_ROLE) ? DEFAULT_ROLE : roles[0];

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!person || !chosen) return;
    setError(null);
    setMade(null);
    startTransition(async () => {
      try {
        const bot = await createBot(name, person.id, chosen);
        setMade(`${name.trim()} (${bot.email}), working for ${personLabel(person)}`);
        setName("");
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to make the bot.");
      }
    });
  }

  return (
    <details className={styles.panel}>
      <summary className={styles.summary}>+ New bot</summary>
      <p className={styles.lead}>
        A bot is an AI agent&apos;s account, such as Claude&apos;s. It has no password and works for one person, who
        issues its tokens and approves its connections; it can rank no higher than they do (docs/MCP.md §21).
      </p>
      {people.length === 0 ? (
        <p className={styles.lead}>No account can have a bot yet: a bot works only for someone with a password who isn&apos;t a COMMENTER.</p>
      ) : (
        <form onSubmit={submit} className={styles.form}>
          <label className={styles.field}>
            Name
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} placeholder="Claude" />
          </label>
          <label className={styles.field}>
            Works for
            <select value={personId} onChange={(e) => setPersonId(e.target.value)} required>
              <option value="" disabled>
                Choose a person…
              </option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {personLabel(p)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            Role
            <select value={chosen ?? ""} onChange={(e) => setRole(e.target.value as Role)} disabled={!person}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={pending || !person || !name.trim()}>
            Make bot
          </button>
        </form>
      )}
      {made && <p className={styles.made}>Made {made}.</p>}
      <CellError message={error} />
    </details>
  );
}
