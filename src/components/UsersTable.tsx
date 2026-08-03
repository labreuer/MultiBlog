"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { type DateFormat, formatDate } from "@/lib/format-date";
import {
  updateUserRole,
  updateUserModerationPolicy,
  updateUserRowsPerPage,
  updateUserColor,
  updateUserName,
  updateUserAdminInitials,
  deleteUser,
  restoreUser,
  bulkDeleteUsers,
  bulkRestoreUsers,
  bulkSetUserRole,
  bulkSetUserModerationPolicy,
} from "@/app/actions/users";
import { Role, ModerationPolicy } from "@/generated/prisma/enums";
import { PAGE_SIZE_OPTIONS, type PageSize } from "@/lib/table-query";
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
import {
  CellError,
  DateFormatSelect,
  DeletedSortHeader,
  EmptyRow,
  PaginationBar,
  RowActionButton,
  SearchBox,
  ShowDeletedToggle,
  SortHeader,
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
  image: string | null;
  createdAt: Date;
  postCount: number;
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
        style={{ width: 40, height: 24, padding: 0, border: "1px solid #ddd", cursor: "pointer" }}
      />
      <CellError message={error} />
    </>
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
  "createdAt",
  "deleted",
] as const;
const COLUMN_COUNT = 14;

export default function UsersTable({
  rows,
  totalCount,
  filters,
  defaultPageSize,
}: {
  rows: UserRow[];
  totalCount: number;
  filters: UsersFilters;
  defaultPageSize: PageSize;
}) {
  const router = useRouter();
  const [dateFormat, setDateFormat] = useState<DateFormat>("yyyy-MM-dd");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort, searchParams } = useTableFilters({
    filters,
    build: (next, extra) => buildUsersQueryString(next, extra, defaultPageSize),
  });
  const { displayRows, revealRow, revealRows } = useRevealedRows(rows, searchParams);
  const { rowStatusClass, setStatus, runWithStatus } = useRowStatus();
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

  return (
    <>
      <div className={adminStyles.filterRow}>
        <SearchBox
          value={searchDraft}
          onChange={onSearchChange}
          placeholder="Search name, email or initials …"
          label="Search users"
        />
      </div>

      <BulkToolbar
        selectedRows={selectedRows}
        actions={bulkActions}
        onDeleted={revealRows}
        onDone={() => {
          clearSelection();
          router.refresh();
        }}
      />

      <table className={adminStyles.table}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <SelectAllHeader checked={allVisibleSelected} onChange={toggleSelectAll} />
            <SortHeader sortKey="name" sort={filters.sort} onSort={handleSort} className={adminStyles.nameColumn}>
              Name
            </SortHeader>
            <SortHeader sortKey="email" sort={filters.sort} onSort={handleSort}>
              Email
            </SortHeader>
            <SortHeader sortKey="adminInitials" sort={filters.sort} onSort={handleSort}>
              Initials
            </SortHeader>
            <SortHeader sortKey="role" sort={filters.sort} onSort={handleSort}>
              Role
            </SortHeader>
            <th className={adminStyles.headerCell}>Image</th>
            <SortHeader sortKey="moderationPolicy" sort={filters.sort} onSort={handleSort}>
              Moderation policy
            </SortHeader>
            <SortHeader sortKey="rowsPerPage" sort={filters.sort} onSort={handleSort} nowrap title="Default rows per page in every admin table">
              Rows/page
            </SortHeader>
            <th className={adminStyles.headerCell}>Color</th>
            <SortHeader sortKey="createdAt" sort={filters.sort} onSort={handleSort} nowrap>
              Created at
            </SortHeader>
            <SortHeader sortKey="posts" sort={filters.sort} onSort={handleSort}>
              Posts
            </SortHeader>
            <th className={adminStyles.headerCell}>Comments</th>
            <th className={adminStyles.headerCell}></th>
            <DeletedSortHeader sortKey="deleted" sort={filters.sort} onSort={handleSort} />
          </tr>
        </thead>
        <tbody>
          {displayRows.length === 0 && <EmptyRow colSpan={COLUMN_COUNT} message="No users matching the criteria." />}
          {displayRows.map((row) => {
            const cellProps = {
              userId: row.id,
              onEdit: () => setStatus(row.id, "edited" as RowStatus),
              run: (action: () => Promise<void>) => runWithStatus(row.id, action),
            };
            return (
              <tr key={row.id} className={`${adminStyles.row} ${row.deleted ? adminStyles.rowDeleted : ""}`}>
                <td className={`${adminStyles.cell} ${rowStatusClass(row.id)}`}>
                  <SelectRowCheckbox
                    checked={selectedIds.has(row.id)}
                    onChange={() => toggleRow(row.id)}
                    label={`user ${row.email}`}
                  />
                </td>
                <td className={adminStyles.cell}>
                  <NameCell {...cellProps} name={row.name} />
                </td>
                <td className={adminStyles.cell}>
                  <span
                    style={{ color: row.emailVerified ? "#0a5" : "#c00" }}
                    title={row.emailVerified ? `Verified: ${formatDate(row.emailVerified, dateFormat)}` : undefined}
                  >
                    {row.email}
                  </span>
                </td>
                <td className={adminStyles.cell}>
                  <AdminInitialsCell {...cellProps} adminInitials={row.adminInitials} />
                </td>
                <td className={adminStyles.cell}>
                  <SelectCell
                    value={row.role}
                    options={Object.values(Role)}
                    save={(next) => updateUserRole(row.id, next)}
                    failureMessage="Failed to update role."
                    run={cellProps.run}
                  />
                </td>
                <td className={adminStyles.cell}>
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
                <td className={adminStyles.cell}>
                  <SelectCell
                    value={row.moderationPolicy}
                    options={Object.values(ModerationPolicy)}
                    save={(next) => updateUserModerationPolicy(row.id, next)}
                    failureMessage="Failed to update moderation policy."
                    run={cellProps.run}
                  />
                </td>
                <td className={adminStyles.cell}>
                  <SelectCell
                    value={row.rowsPerPage}
                    options={PAGE_SIZE_OPTIONS}
                    save={(next) => updateUserRowsPerPage(row.id, next)}
                    failureMessage="Failed to update rows per page."
                    run={cellProps.run}
                  />
                </td>
                <td className={adminStyles.cell}>
                  <ColorCell {...cellProps} color={row.color} />
                </td>
                <td className={adminStyles.nowrapCell}>{formatDate(row.createdAt, dateFormat)}</td>
                <td className={adminStyles.cell}>
                  {row.postCount > 0 ? <Link href={`/authors/${row.slug}`}>posts</Link> : ""}
                </td>
                <td className={adminStyles.cell}></td>
                <td className={adminStyles.cell}>
                  <Link href={`/users/${row.id}/slug`}>url</Link>
                </td>
                <td className={adminStyles.cell}>
                  <RowActionButton
                    deleted={row.deleted}
                    noun="user"
                    disabled={pending}
                    onClick={() => handleDeleteToggle(row)}
                  />
                </td>
              </tr>
            );
          })}
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
        defaultPageSize={defaultPageSize}
        searchDescription="Free-text search over name, email and admin initials."
        notes={
          <p style={{ marginTop: 8 }}>
            <strong>Rows/page</strong> is that account&apos;s own default page size for every admin table. A{" "}
            <code>?pageSize=</code> in the URL overrides it for that navigation only, without changing the stored
            preference (PLAN.md §16b).
          </p>
        }
      />
    </>
  );
}
