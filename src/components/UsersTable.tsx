"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { JSONContent } from "@tiptap/core";
import { type DateFormat, formatDate } from "@/lib/format-date";
import { extractText } from "@/lib/diff";
import {
  updateUserRole,
  updateUserModerationPolicy,
  updateUserRowsPerPage,
  updateUserColor,
  updateUserName,
  updateUserAdminInitials,
  updateUserIsListedContributor,
  updateUserContributorOrder,
  updateUserOrcid,
  updateUserWebsite,
  sendUserInvite,
  deleteUser,
  restoreUser,
  bulkDeleteUsers,
  bulkRestoreUsers,
  bulkSetUserRole,
  bulkSetUserModerationPolicy,
} from "@/app/actions/users";
import { Role, ModerationPolicy } from "@/generated/prisma/enums";
import { PAGE_SIZE_OPTIONS, sameCols, type PageSize, type TablePrefs } from "@/lib/table-query";
import { type UsersFilters, buildUsersQueryString } from "@/lib/users-query";
import { useTableFilters } from "@/components/table/use-table-filters";
import { useRevealedRows } from "@/components/table/use-revealed-rows";
import { useRowStatus, type RowStatus } from "@/components/table/use-row-status";
import { useRowSelection } from "@/components/table/use-row-selection";
import {
  BulkToolbar,
  SelectAllHeader,
  SelectRowCheckbox,
  softDeleteBulkActions,
  type BulkAction,
} from "@/components/table/BulkToolbar";
import { FilterHelp } from "@/components/table/FilterHelp";
import { ColumnPicker } from "@/components/table/ColumnPicker";
import { ColumnCells, ColumnHeaderRow } from "@/components/table/ColumnizedRows";
import { resolveColumns, type ColumnSpec } from "@/components/table/column-spec";
import { saveTableColumns } from "@/app/actions/table-preferences";
import {
  CellError,
  DateFormatSelect,
  DeletedSortHeader,
  EmptyRow,
  PaginationBar,
  RowActionButton,
  SearchBox,
  ShowDeletedToggle,
} from "@/components/table/TableControls";
import adminStyles from "@/components/table/AdminTable.module.css";

export type UserRow = {
  id: string;
  slug: string;
  name: string | null;
  email: string;
  emailVerified: Date | null;
  adminInitials: string;
  role: Role;
  moderationPolicy: ModerationPolicy;
  rowsPerPage: PageSize;
  color: string;
  /** Resolved avatar src — self-hosted upload, else the adapter's remote URL, else null (PLAN.md §17n). */
  avatarSrc: string | null;
  isListedContributor: boolean;
  contributorBlurb: JSONContent | null;
  contributorOrder: number | null;
  orcid: string | null;
  website: string | null;
  createdAt: Date;
  postCount: number;
  inviteCount: number;
  lastInvite: {
    /** Absolute /invite?token=… URL, resolved server-side; null once consumed. */
    url: string | null;
    sentAt: Date;
    clickedAt: Date | null;
    acceptedAt: Date | null;
    expiresAt: Date;
    revokedAt: Date | null;
  } | null;
  deletedAt: Date | null;
  deleted: boolean;
};

// Every editable cell reports what it's doing through the row's left border
// (PLAN.md §16f) rather than each owning its own indicator: `onEdit` paints
// gray the moment a field diverges locally, and `run` wraps the server call
// in saving → saved/error.
type CellProps = {
  userId: string;
  onEdit: () => void;
  run: (action: () => Promise<void>) => Promise<void>;
};

function NameCell({ userId, name, onEdit, run }: CellProps & { name: string | null }) {
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
        await run(async () => {
          await updateUserName(userId, trimmed);
        });
        setValue(trimmed);
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
        onChange={(e) => {
          setValue(e.target.value);
          if (e.target.value.trim() !== (name ?? "")) onEdit();
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        style={{ width: "100%", padding: "2px 4px" }}
      />
      <CellError message={error} />
    </>
  );
}

function AdminInitialsCell({ userId, adminInitials, onEdit, run }: CellProps & { adminInitials: string }) {
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
        await run(async () => {
          await updateUserAdminInitials(userId, trimmed);
        });
        setValue(trimmed);
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
        onChange={(e) => {
          setValue(e.target.value);
          if (e.target.value.trim() !== adminInitials) onEdit();
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        style={{ width: 60, padding: "2px 4px" }}
      />
      <CellError message={error} />
    </>
  );
}

// A plain text cell that allows an empty value (unlike AdminInitialsCell),
// used for the two contributor link fields — server-side validation
// (normalizeOrcid/normalizeWebsite, shared with the self-service panel) is
// what rejects a bad value; this just displays whatever error comes back.
function TextFieldCell({
  userId,
  value,
  placeholder,
  width,
  save,
  failureMessage,
  onEdit,
  run,
}: CellProps & { value: string; placeholder?: string; width?: number; save: (userId: string, next: string) => Promise<void>; failureMessage: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(value);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === value) return;
    setError(null);
    startTransition(async () => {
      try {
        await run(async () => {
          await save(userId, trimmed);
        });
        setDraft(trimmed);
        router.refresh();
      } catch (err) {
        setDraft(value);
        setError(err instanceof Error ? err.message : failureMessage);
      }
    });
  }

  return (
    <>
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        disabled={pending}
        onChange={(e) => {
          setDraft(e.target.value);
          if (e.target.value.trim() !== value) onEdit();
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        style={{ width: width ?? "100%", padding: "2px 4px" }}
      />
      <CellError message={error} />
    </>
  );
}

// contributorOrder is a nullable Int — an empty field means "unset" (sorts
// to the tail, PLAN.md §17e), not zero.
function ContributorOrderCell({ userId, order, onEdit, run }: CellProps & { order: number | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const initial = order !== null ? String(order) : "";
  const [draft, setDraft] = useState(initial);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === initial) return;
    const next = trimmed === "" ? null : Number(trimmed);
    if (next !== null && !Number.isInteger(next)) {
      setDraft(initial);
      setError("Order must be a whole number.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await run(async () => {
          await updateUserContributorOrder(userId, next);
        });
        setDraft(trimmed);
        router.refresh();
      } catch (err) {
        setDraft(initial);
        setError(err instanceof Error ? err.message : "Failed to update order.");
      }
    });
  }

  return (
    <>
      <input
        type="number"
        step={1}
        value={draft}
        disabled={pending}
        onChange={(e) => {
          setDraft(e.target.value);
          if (e.target.value.trim() !== initial) onEdit();
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        style={{ width: 70, padding: "2px 4px" }}
      />
      <CellError message={error} />
    </>
  );
}

// A <select> commits on change, so unlike the text cells it never passes
// through the gray "edited" state — it goes straight to saving.
function SelectCell<T extends string | number>({
  value,
  options,
  optionLabel,
  disabled,
  save,
  failureMessage,
  run,
}: {
  value: T;
  options: readonly T[];
  optionLabel?: (option: T) => string;
  disabled?: boolean;
  save: (next: T) => Promise<void>;
  failureMessage: string;
  run: (action: () => Promise<void>) => Promise<void>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <select
        value={value}
        disabled={disabled || pending}
        onChange={(e) => {
          const raw = e.target.value;
          const next = (typeof value === "number" ? Number(raw) : raw) as T;
          setError(null);
          startTransition(async () => {
            try {
              await run(async () => {
                await save(next);
              });
              router.refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : failureMessage);
            }
          });
        }}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabel ? optionLabel(option) : option}
          </option>
        ))}
      </select>
      <CellError message={error} />
    </>
  );
}

function ColorCell({ userId, color, run }: CellProps & { color: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The native listener below is added once and closes over whatever `run`
  // was current then; a ref keeps it calling the live one. Written from an
  // effect, not during render — the parent passes a fresh arrow each render,
  // so this is a real re-assignment, not a one-time initialization.
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);

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
          await runRef.current(async () => {
            await updateUserColor(userId, next);
          });
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to update color.");
        }
      });
    };
    el.addEventListener("change", handleChange);
    return () => el.removeEventListener("change", handleChange);
  }, [userId, router]);

  return (
    <>
      <input
        ref={inputRef}
        key={color}
        type="color"
        defaultValue={color}
        disabled={pending}
        style={{ width: 40, height: 24, padding: 0, border: "1px solid var(--border)", cursor: "pointer" }}
      />
      <CellError message={error} />
    </>
  );
}

// Sending real mail to a real person is the one action on this table that
// isn't undoable — every other one (role, policy, delete/restore) reverses.
// window.confirm appears nowhere in this codebase, so the inline two-step
// confirm SlugManager/ContributorPanel use is the pattern here too.
function InviteCell({
  userId,
  email,
  disabled,
  run,
}: {
  userId: string;
  email: string;
  disabled: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  function send() {
    setConfirming(false);
    setError(null);
    startTransition(async () => {
      try {
        await run(async () => {
          await sendUserInvite(userId);
        });
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send invite.");
      }
    });
  }

  if (confirming) {
    return (
      <span style={{ color: "var(--text-secondary)" }}>
        Send to {email}?{" "}
        <button type="button" onClick={send} disabled={pending} style={{ fontWeight: "bold", color: "var(--success)" }}>
          Yes
        </button>{" "}
        /{" "}
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={pending}
          style={{ fontWeight: "bold", color: "var(--danger)" }}
        >
          No
        </button>
      </span>
    );
  }

  return (
    <>
      <button type="button" onClick={() => setConfirming(true)} disabled={disabled || pending}>
        Send invite
      </button>
      <CellError message={error} />
    </>
  );
}

// No component state needed — the raw token is server-sourced (row data), the
// simplification the "store raw until consumed" choice buys (docs/EMAIL.md).
function InviteUrlCell({
  invite,
  count,
  dateFormat,
}: {
  invite: UserRow["lastInvite"];
  count: number;
  dateFormat: DateFormat;
}) {
  if (!invite) return null;

  const title = `${count} sent`;

  if (invite.url) {
    return (
      <input
        readOnly
        value={invite.url}
        title={title}
        onFocus={(e) => e.currentTarget.select()}
        style={{ width: "100%", fontSize: "0.8rem" }}
      />
    );
  }

  let status: { text: string; color: string };
  if (invite.acceptedAt) {
    status = { text: `accepted ${formatDate(invite.acceptedAt, dateFormat)}`, color: "var(--success)" };
  } else if (invite.revokedAt) {
    status = { text: "revoked", color: "var(--text-secondary)" };
  } else if (invite.clickedAt) {
    status = { text: `clicked ${formatDate(invite.clickedAt, dateFormat)}`, color: "var(--text-secondary)" };
  } else if (invite.expiresAt <= new Date()) {
    status = { text: "expired", color: "var(--text-secondary)" };
  } else {
    status = { text: `sent ${formatDate(invite.sentAt, dateFormat)}`, color: "var(--text-secondary)" };
  }

  return (
    <span title={title} style={{ color: status.color }}>
      {status.text}
    </span>
  );
}

const SORTABLE_KEYS = [
  "name",
  "email",
  "adminInitials",
  "role",
  "moderationPolicy",
  "rowsPerPage",
  "posts",
  "isListedContributor",
  "contributorOrder",
  "orcid",
  "website",
  "createdAt",
  "deletedAt",
  "deleted",
] as const;

export default function UsersTable({
  rows,
  totalCount,
  filters,
  prefs,
}: {
  rows: UserRow[];
  totalCount: number;
  filters: UsersFilters;
  prefs: TablePrefs;
}) {
  const router = useRouter();
  const [dateFormat, setDateFormat] = useState<DateFormat>("yyyy-MM-dd");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams } = useTableFilters({
    filters,
    build: (next, extra) => buildUsersQueryString(next, extra, prefs),
  });
  const { displayRows, revealRow, revealRows } = useRevealedRows(rows, searchParams);
  const { rowStatusClass, rowStatusTitle, setStatus, runWithStatus, runWithStatusMany } = useRowStatus();
  const { selectedIds, selectedRows, allVisibleSelected, toggleSelectAll, toggleRow, clearSelection } =
    useRowSelection(displayRows);

  // A deleted user keeps their role and policy: those are edits to an account
  // an admin has already taken out of circulation. The self-protection guards
  // (can't delete your own account, can't drop your own admin role) live in
  // the server actions, which these delegate to per row rather than
  // reimplementing — a bulk path must not be able to sidestep them.
  const bulkActions: BulkAction<UserRow>[] = [
    {
      kind: "select",
      key: "role",
      label: "Set role",
      options: Object.values(Role),
      applicableTo: (row) => !row.deleted,
      run: (ids, value) => bulkSetUserRole(ids, value as Role),
    },
    {
      kind: "select",
      key: "moderationPolicy",
      label: "Set moderation",
      options: Object.values(ModerationPolicy),
      applicableTo: (row) => !row.deleted,
      run: (ids, value) => bulkSetUserModerationPolicy(ids, value as ModerationPolicy),
    },
    ...softDeleteBulkActions<UserRow>("users", bulkDeleteUsers, bulkRestoreUsers),
  ];

  function handleDeleteToggle(row: UserRow) {
    setError(null);
    startTransition(async () => {
      try {
        await runWithStatus(row.id, async () => {
          if (row.deleted) {
            await restoreUser(row.id);
          } else {
            await deleteUser(row.id);
            revealRow(row);
          }
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to update user.");
      }
    });
  }

  // Declared in the order they render by default; `?cols=` reorders and hides
  // the movable ones from here (§16i). Built in the component body rather than
  // at module scope so a cell stays an ordinary React expression closing over
  // dateFormat, the selection and the per-row edit/save wiring.
  //
  // "Comments" (between Posts and the url link) has never had a value — the
  // cell was already always empty before this conversion, not something lost
  // in it. Preserved as-is rather than fixed or dropped, since neither is what
  // was asked for here.
  const columns: ColumnSpec<UserRow>[] = [
    {
      key: "select",
      alwaysVisible: true,
      header: "Select",
      renderHeader: () => <SelectAllHeader checked={allVisibleSelected} onChange={toggleSelectAll} />,
      cell: (row) => (
        <SelectRowCheckbox
          checked={selectedIds.has(row.id)}
          onChange={() => toggleRow(row.id)}
          label={`user ${row.email}`}
        />
      ),
    },
    {
      key: "name",
      header: "Name",
      sortKey: "name",
      headerClassName: adminStyles.nameColumn,
      cell: (row) => (
        <NameCell
          userId={row.id}
          name={row.name}
          onEdit={() => setStatus(row.id, "edited" as RowStatus)}
          run={(action) => runWithStatus(row.id, action)}
        />
      ),
    },
    {
      key: "email",
      header: "Email",
      sortKey: "email",
      cell: (row) => (
        <span
          style={{ color: row.emailVerified ? "var(--success)" : "var(--danger)" }}
          title={row.emailVerified ? `Verified: ${formatDate(row.emailVerified, dateFormat)}` : undefined}
        >
          {row.email}
        </span>
      ),
    },
    {
      key: "adminInitials",
      header: "Initials",
      sortKey: "adminInitials",
      cell: (row) => (
        <AdminInitialsCell
          userId={row.id}
          adminInitials={row.adminInitials}
          onEdit={() => setStatus(row.id, "edited" as RowStatus)}
          run={(action) => runWithStatus(row.id, action)}
        />
      ),
    },
    {
      key: "role",
      header: "Role",
      sortKey: "role",
      cell: (row) => (
        <SelectCell
          value={row.role}
          options={Object.values(Role)}
          save={(next) => updateUserRole(row.id, next)}
          failureMessage="Failed to update role."
          run={(action) => runWithStatus(row.id, action)}
        />
      ),
    },
    {
      key: "image",
      header: "Image",
      cell: (row) =>
        row.avatarSrc ? (
          // eslint-disable-next-line @next/next/no-img-element -- a self-hosted avatar is already one fixed size behind an immutable URL, so the optimizer would only re-derive it; a remote fallback URL would need an images.remotePatterns entry per host. Same rationale as ContributorCard.
          <img src={row.avatarSrc} alt="" width={32} height={32} style={{ borderRadius: "50%", objectFit: "cover" }} loading="lazy" />
        ) : (
          ""
        ),
    },
    {
      key: "moderationPolicy",
      header: "Moderation policy",
      sortKey: "moderationPolicy",
      cell: (row) => (
        <SelectCell
          value={row.moderationPolicy}
          options={Object.values(ModerationPolicy)}
          save={(next) => updateUserModerationPolicy(row.id, next)}
          failureMessage="Failed to update moderation policy."
          run={(action) => runWithStatus(row.id, action)}
        />
      ),
    },
    {
      key: "rowsPerPage",
      header: "Rows/page",
      sortKey: "rowsPerPage",
      nowrap: true,
      // Defaulted hidden (§16m): a per-account preference, not information
      // about the person — an admin scanning /users is almost never looking
      // for it, and it stays one checkbox away in the picker.
      defaultHidden: true,
      headerTitle: "Default rows per page in every admin table",
      cell: (row) => (
        <SelectCell
          value={row.rowsPerPage}
          options={PAGE_SIZE_OPTIONS}
          save={(next) => updateUserRowsPerPage(row.id, next)}
          failureMessage="Failed to update rows per page."
          run={(action) => runWithStatus(row.id, action)}
        />
      ),
    },
    {
      key: "color",
      header: "Color",
      cell: (row) => (
        <ColorCell userId={row.id} color={row.color} onEdit={() => setStatus(row.id, "edited" as RowStatus)} run={(action) => runWithStatus(row.id, action)} />
      ),
    },
    {
      key: "created",
      header: "Created at",
      sortKey: "createdAt",
      nowrap: true,
      cell: (row) => formatDate(row.createdAt, dateFormat),
    },
    {
      key: "posts",
      header: "Posts",
      sortKey: "posts",
      cell: (row) => (row.postCount > 0 ? <Link href={`/authors/${row.slug}`}>posts</Link> : ""),
    },
    // Defaulted hidden (§16m) — it renders nothing at all (no sortKey, a null
    // cell), so it cost a column of width for an empty one every load.
    { key: "comments", header: "Comments", defaultHidden: true, cell: () => null },
    { key: "url", header: "", cell: (row) => <Link href={`/users/${row.id}/slug`}>url</Link> },
    // Landing-page contributor fields (PLAN.md §17i), defaulted hidden below.
    {
      key: "isListedContributor",
      header: "Listed contributor",
      sortKey: "isListedContributor",
      defaultHidden: true,
      cell: (row) => (
        <SelectCell
          value={row.isListedContributor ? "true" : "false"}
          options={["true", "false"] as const}
          optionLabel={(v) => (v === "true" ? "Yes" : "No")}
          save={(next) => updateUserIsListedContributor(row.id, next === "true")}
          failureMessage="Failed to update listed-contributor status."
          run={(action) => runWithStatus(row.id, action)}
        />
      ),
    },
    {
      key: "contributorOrder",
      header: "Contributor order",
      sortKey: "contributorOrder",
      defaultHidden: true,
      cell: (row) => (
        <ContributorOrderCell
          userId={row.id}
          order={row.contributorOrder}
          onEdit={() => setStatus(row.id, "edited" as RowStatus)}
          run={(action) => runWithStatus(row.id, action)}
        />
      ),
    },
    // Json — Prisma's orderBy can't reach it, and a view keyed on this table
    // isn't worth building for an ordering nobody needs (see users-query.ts).
    // Shown as a plain-text excerpt, editable only from /dashboard's own
    // panel — same "shown, not sorted, not inline-editable" shape as `image`.
    {
      key: "contributorBlurb",
      header: "Contributor blurb",
      defaultHidden: true,
      cell: (row) => (row.contributorBlurb ? extractText(row.contributorBlurb).slice(0, 80) : ""),
    },
    {
      key: "orcid",
      header: "ORCID iD",
      sortKey: "orcid",
      defaultHidden: true,
      cell: (row) => (
        <TextFieldCell
          userId={row.id}
          value={row.orcid ?? ""}
          placeholder="0000-0002-1825-0097"
          width={160}
          save={updateUserOrcid}
          failureMessage="Failed to update ORCID iD."
          onEdit={() => setStatus(row.id, "edited" as RowStatus)}
          run={(action) => runWithStatus(row.id, action)}
        />
      ),
    },
    {
      key: "website",
      header: "Website",
      sortKey: "website",
      defaultHidden: true,
      cell: (row) => (
        <TextFieldCell
          userId={row.id}
          value={row.website ?? ""}
          placeholder="https://…"
          save={updateUserWebsite}
          failureMessage="Failed to update website."
          onEdit={() => setStatus(row.id, "edited" as RowStatus)}
          run={(action) => runWithStatus(row.id, action)}
        />
      ),
    },
    // Invites (docs/EMAIL.md), both hidden by default. Neither sorts: one is
    // a button, the other is a URL that only exists while the invite is
    // still live — an action button and a transient value are each, on
    // their own, reasons ColumnSpec's own doc gives for skipping sortKey.
    {
      key: "invite",
      header: "Send invite",
      defaultHidden: true,
      nowrap: true,
      headerTitle: "Emails this user a link to set a password and claim their account",
      cell: (row) => (
        <InviteCell
          userId={row.id}
          email={row.email}
          disabled={row.deleted}
          run={(action) => runWithStatus(row.id, action)}
        />
      ),
    },
    {
      key: "inviteUrl",
      header: "Invite URL",
      defaultHidden: true,
      headerTitle: "The most recent invite's link, until it's accepted or revoked",
      cell: (row) => <InviteUrlCell invite={row.lastInvite} count={row.inviteCount} dateFormat={dateFormat} />,
    },
    // Defaulted hidden (§16l/§16i): the raw timestamp behind the existing
    // Deleted action column's boolean.
    {
      key: "deletedAt",
      header: "Deleted at",
      sortKey: "deletedAt",
      nowrap: true,
      defaultHidden: true,
      cell: (row) => (row.deletedAt ? formatDate(row.deletedAt, dateFormat) : ""),
    },
    {
      key: "deleted",
      alwaysVisible: true,
      header: "Deleted",
      renderHeader: () => <DeletedSortHeader sortKey="deleted" sort={filters.sort} onSort={handleSort} />,
      cell: (row) => (
        <RowActionButton deleted={row.deleted} noun="user" disabled={pending} onClick={() => handleDeleteToggle(row)} />
      ),
    },
  ];
  const visibleColumns = resolveColumns(columns, filters.cols);

  return (
    <>
      <div className={adminStyles.filterRow}>
        <SearchBox
          value={searchDraft}
          onChange={onSearchChange}
          placeholder="Search name, email or initials …"
          label="Search users"
        />
        <ColumnPicker
          columns={columns}
          resolved={visibleColumns}
          onChange={(cols) => navigate({ cols } as Partial<UsersFilters>)}
          onReset={() => navigate({ cols: null } as Partial<UsersFilters>)}
          onSaveDefault={async (cols) => {
            await saveTableColumns("users", cols);
            navigate({ cols: null } as Partial<UsersFilters>);
          }}
          isDefault={sameCols(filters.cols, prefs.cols)}
        />
      </div>

      <BulkToolbar
        selectedRows={selectedRows}
        actions={bulkActions}
        runWithStatus={runWithStatusMany}
        onDeleted={revealRows}
        onDone={(ok) => {
          if (ok) clearSelection();
          router.refresh();
        }}
      />

      <table className={adminStyles.table}>
        <thead>
          <ColumnHeaderRow columns={visibleColumns} sort={filters.sort} onSort={handleSort} />
        </thead>
        <tbody>
          {displayRows.length === 0 && (
            <EmptyRow colSpan={visibleColumns.length} message="No users matching the criteria." />
          )}
          {displayRows.map((row) => (
            <tr key={row.id} className={`${adminStyles.row} ${row.deleted ? adminStyles.rowDeleted : ""}`}>
              <ColumnCells
                row={row}
                columns={visibleColumns}
                statusClass={rowStatusClass(row.id)}
                statusTitle={rowStatusTitle(row.id)}
              />
            </tr>
          ))}
        </tbody>
      </table>
      <CellError message={error} />

      <PaginationBar
        totalCount={totalCount}
        page={filters.page}
        pageSize={filters.pageSize}
        noun="users"
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => updateFilters({ pageSize })}
      />

      <DateFormatSelect value={dateFormat} onChange={setDateFormat} />
      <ShowDeletedToggle checked={filters.deleted} onChange={(deleted) => updateFilters({ deleted })} />

      <FilterHelp
        sortKeys={SORTABLE_KEYS}
        defaultPageSize={prefs.pageSize}
        searchDescription="Free-text search over name, email and admin initials."
        notes={
          <p style={{ marginTop: 8 }}>
            <strong>Rows/page</strong> is that account&apos;s own default page size for every admin table. A{" "}
            <code>?pageSize=</code> in the URL overrides it for that navigation only, without changing the stored
            preference (PLAN.md §16b). <strong>Deleted at</strong>, <strong>Send invite</strong> and{" "}
            <strong>Invite URL</strong> are hidden by default (Columns picker, above). The invite URL disappears
            once that invite is accepted or revoked — re-showing it means sending again.
          </p>
        }
      />
    </>
  );
}
