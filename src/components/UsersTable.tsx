"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSortableRows } from "@/lib/use-sortable-rows";
import {
  updateUserRole,
  updateUserModerationPolicy,
  updateUserColor,
  updateUserName,
  updateUserAdminInitials,
} from "@/app/actions/users";
import { Role, ModerationPolicy } from "@/generated/prisma/enums";
import styles from "./UsersTable.module.css";

export type UserRow = {
  id: string;
  name: string | null;
  email: string;
  emailVerified: Date | null;
  adminInitials: string;
  role: Role;
  moderationPolicy: ModerationPolicy;
  color: string;
  image: string | null;
  createdAt: Date;
  postCount: number;
};

const DATE_FORMATS = ["yyyy-MM-dd HH:mm", "yyyy-MM-dd", "M/d/yyyy h:mm", "M/d/yyyy"] as const;
type DateFormat = (typeof DATE_FORMATS)[number];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDate(date: Date, format: DateFormat): string {
  const yyyy = date.getFullYear();
  const MM = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const M = date.getMonth() + 1;
  const d = date.getDate();
  const HH = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  let h = date.getHours() % 12;
  if (h === 0) h = 12;

  switch (format) {
    case "yyyy-MM-dd HH:mm":
      return `${yyyy}-${MM}-${dd} ${HH}:${mm}`;
    case "yyyy-MM-dd":
      return `${yyyy}-${MM}-${dd}`;
    case "M/d/yyyy h:mm":
      return `${M}/${d}/${yyyy} ${h}:${mm}`;
    case "M/d/yyyy":
      return `${M}/${d}/${yyyy}`;
  }
}

type SortKey = "name" | "email" | "adminInitials" | "role" | "moderationPolicy" | "posts" | "createdAt";

// Schema declaration order (Role enum) is already privilege order, so reuse
// it for sorting rather than falling back to alphabetical.
const ROLE_ORDER: Role[] = [Role.ADMIN, Role.EDITOR, Role.AUTHOR, Role.COMMENTER];

function compareByKey(key: SortKey, a: UserRow, b: UserRow): number {
  switch (key) {
    case "name":
      return (a.name ?? a.email).localeCompare(b.name ?? b.email);
    case "email":
      return a.email.localeCompare(b.email);
    case "adminInitials":
      return a.adminInitials.localeCompare(b.adminInitials);
    case "role":
      return ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
    case "moderationPolicy":
      return a.moderationPolicy.localeCompare(b.moderationPolicy);
    case "posts":
      return a.postCount - b.postCount;
    case "createdAt":
      return a.createdAt.getTime() - b.createdAt.getTime();
  }
}

const th: React.CSSProperties = { padding: "6px 12px", borderBottom: "2px solid #ddd" };
const td: React.CSSProperties = { padding: "6px 12px", verticalAlign: "top" };
const sortableTh: React.CSSProperties = { ...th, cursor: "pointer", userSelect: "none" };

function NameCell({
  userId,
  name,
  onSaved,
}: {
  userId: string;
  name: string | null;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState(name ?? "");

  function commit() {
    const trimmed = value.trim();
    if (trimmed === (name ?? "")) return;
    setError(null);
    startTransition(async () => {
      try {
        await updateUserName(userId, trimmed);
        setValue(trimmed);
        onSaved();
        router.refresh();
      } catch (err) {
        setValue(name ?? "");
        setError(err instanceof Error ? err.message : "Failed to update name.");
      }
    });
  }

  return (
    <>
      <input
        type="text"
        value={value}
        disabled={pending}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        style={{ width: "100%", padding: "2px 4px" }}
      />
      {error && (
        <div style={{ color: "crimson", fontSize: "0.8rem" }}>{error}</div>
      )}
    </>
  );
}

function AdminInitialsCell({
  userId,
  adminInitials,
  onSaved,
}: {
  userId: string;
  adminInitials: string;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState(adminInitials);

  function commit() {
    const trimmed = value.trim();
    if (trimmed === adminInitials) return;
    if (!trimmed) {
      setValue(adminInitials);
      setError("Initials can't be empty.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await updateUserAdminInitials(userId, trimmed);
        setValue(trimmed);
        onSaved();
        router.refresh();
      } catch (err) {
        setValue(adminInitials);
        setError(err instanceof Error ? err.message : "Failed to update initials.");
      }
    });
  }

  return (
    <>
      <input
        type="text"
        value={value}
        disabled={pending}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        style={{ width: 60, padding: "2px 4px" }}
      />
      {error && (
        <div style={{ color: "crimson", fontSize: "0.8rem" }}>{error}</div>
      )}
    </>
  );
}

function RoleCell({ userId, role, onSaved }: { userId: string; role: Role; onSaved: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <select
        value={role}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value as Role;
          setError(null);
          startTransition(async () => {
            try {
              await updateUserRole(userId, next);
              onSaved();
              router.refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Failed to update role.");
            }
          });
        }}
      >
        {Object.values(Role).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {error && (
        <div style={{ color: "crimson", fontSize: "0.8rem" }}>{error}</div>
      )}
    </>
  );
}

function ModerationPolicyCell({
  userId,
  moderationPolicy,
  onSaved,
}: {
  userId: string;
  moderationPolicy: ModerationPolicy;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <select
        value={moderationPolicy}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value as ModerationPolicy;
          setError(null);
          startTransition(async () => {
            try {
              await updateUserModerationPolicy(userId, next);
              onSaved();
              router.refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Failed to update moderation policy.");
            }
          });
        }}
      >
        {Object.values(ModerationPolicy).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {error && (
        <div style={{ color: "crimson", fontSize: "0.8rem" }}>{error}</div>
      )}
    </>
  );
}

function ColorCell({ userId, color, onSaved }: { userId: string; color: string; onSaved: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // A color input fires "input" continuously while the picker is open —
    // per drag movement, per keystroke in its hex field — and "change" only
    // once, when the picker closes. React's onChange prop is wired to
    // "input" for this element type, so save on a native "change" listener
    // instead, added directly via ref.
    const handleChange = () => {
      const next = el.value;
      setError(null);
      startTransition(async () => {
        try {
          await updateUserColor(userId, next);
          onSaved();
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to update color.");
        }
      });
    };
    el.addEventListener("change", handleChange);
    return () => el.removeEventListener("change", handleChange);
  }, [userId, router, onSaved]);

  return (
    <>
      <input
        ref={inputRef}
        key={color}
        type="color"
        defaultValue={color}
        disabled={pending}
        style={{ width: 40, height: 24, padding: 0, border: "1px solid #ddd", cursor: "pointer" }}
      />
      {error && (
        <div style={{ color: "crimson", fontSize: "0.8rem" }}>{error}</div>
      )}
    </>
  );
}

export default function UsersTable({ rows }: { rows: UserRow[] }) {
  const [dateFormat, setDateFormat] = useState<DateFormat>("yyyy-MM-dd");
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

  const { sortedRows, handleSort, sortState } = useSortableRows(rows, compareByKey);

  // Re-triggers the CSS pulse animation on a row even if it's already mid-
  // pulse (e.g. two fields on the same row saved in quick succession) —
  // toggling a class doesn't replay a running animation, so the class is
  // removed and a reflow forced before re-adding it.
  function pulseRow(rowId: string) {
    const el = rowRefs.current.get(rowId);
    if (!el) return;
    el.classList.remove(styles.savedPulse);
    void el.offsetWidth;
    el.classList.add(styles.savedPulse);
  }

  function sortIndicator(key: SortKey) {
    const state = sortState(key);
    if (!state) return null;
    return (
      <>
        {" "}
        {state.dir === "asc" ? "▲" : "▼"}
        {state.priority > 1 && <sup>{state.priority}</sup>}
      </>
    );
  }

  if (rows.length === 0) {
    return <p>No users yet.</p>;
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1em" }}>
      <thead>
        <tr style={{ textAlign: "left" }}>
          <th style={th}>ID</th>
          <th style={sortableTh} onClick={(e) => handleSort("name", e.ctrlKey)}>
            Name{sortIndicator("name")}
          </th>
          <th style={sortableTh} onClick={(e) => handleSort("email", e.ctrlKey)}>
            Email{sortIndicator("email")}
          </th>
          <th style={sortableTh} onClick={(e) => handleSort("adminInitials", e.ctrlKey)}>
            Initials{sortIndicator("adminInitials")}
          </th>
          <th style={sortableTh} onClick={(e) => handleSort("role", e.ctrlKey)}>
            Role{sortIndicator("role")}
          </th>
          <th style={th}>Image</th>
          <th style={sortableTh} onClick={(e) => handleSort("moderationPolicy", e.ctrlKey)}>
            Moderation policy{sortIndicator("moderationPolicy")}
          </th>
          <th style={th}>Color</th>
          <th style={sortableTh} onClick={(e) => handleSort("createdAt", e.ctrlKey)}>
            Created at{sortIndicator("createdAt")}
          </th>
          <th style={sortableTh} onClick={(e) => handleSort("posts", e.ctrlKey)}>
            Posts{sortIndicator("posts")}
          </th>
          <th style={th}>Comments</th>
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((row) => {
          const onSaved = () => pulseRow(row.id);
          return (
            <tr
              key={row.id}
              ref={(el) => {
                if (el) rowRefs.current.set(row.id, el);
                else rowRefs.current.delete(row.id);
              }}
              onAnimationEnd={(e) => e.currentTarget.classList.remove(styles.savedPulse)}
              style={{ borderBottom: "1px solid #eee" }}
            >
              <td style={td}>{row.id}</td>
              <td style={td}>
                <NameCell userId={row.id} name={row.name} onSaved={onSaved} />
              </td>
              <td style={td}>
                <span
                  style={{ color: row.emailVerified ? "#0a5" : "#c00" }}
                  title={row.emailVerified ? `Verified: ${formatDate(row.emailVerified, dateFormat)}` : undefined}
                >
                  {row.email}
                </span>
              </td>
              <td style={td}>
                <AdminInitialsCell userId={row.id} adminInitials={row.adminInitials} onSaved={onSaved} />
              </td>
              <td style={td}>
                <RoleCell userId={row.id} role={row.role} onSaved={onSaved} />
              </td>
              <td style={td}>
                {row.image ? (
                  <img
                    src={row.image}
                    alt=""
                    width={32}
                    height={32}
                    style={{ borderRadius: "50%", objectFit: "cover" }}
                  />
                ) : (
                  ""
                )}
              </td>
              <td style={td}>
                <ModerationPolicyCell userId={row.id} moderationPolicy={row.moderationPolicy} onSaved={onSaved} />
              </td>
              <td style={td}>
                <ColorCell userId={row.id} color={row.color} onSaved={onSaved} />
              </td>
              <td style={td}>{formatDate(row.createdAt, dateFormat)}</td>
              <td style={td}>{row.postCount > 0 ? <Link href={`/authors/${row.id}`}>posts</Link> : ""}</td>
              <td style={td}></td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={11} style={{ paddingTop: 12 }}>
            <label>
              Date format:{" "}
              <select value={dateFormat} onChange={(e) => setDateFormat(e.target.value as DateFormat)}>
                {DATE_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {format}
                  </option>
                ))}
              </select>
            </label>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
