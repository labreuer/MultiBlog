"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  bulkRevokeJoinCards,
  mintJoinBatchAction,
  revokeJoinBatchAction,
  revokeJoinCardAction,
} from "@/app/actions/join-codes";
import {
  buildJoinCodesQueryString,
  JOIN_CODE_STATUSES,
  type JoinCodesFilters,
  type JoinCodeStatus,
} from "@/lib/join-codes-query";
import { sameCols, type TablePrefs } from "@/lib/table-query";
import { useTableFilters } from "@/components/table/use-table-filters";
import { useRowStatus } from "@/components/table/use-row-status";
import { useRowSelection } from "@/components/table/use-row-selection";
import { BulkToolbar, SelectAllHeader, SelectRowCheckbox, type BulkAction } from "@/components/table/BulkToolbar";
import { FilterHelp } from "@/components/table/FilterHelp";
import { ColumnPicker } from "@/components/table/ColumnPicker";
import { ColumnCells, ColumnHeaderRow } from "@/components/table/ColumnizedRows";
import { registryColumns, resolveColumns, type ColumnBody, type ColumnSpec } from "@/components/table/column-spec";
import type { AdminColumnKey } from "@/lib/admin-table-columns";
import { saveTableColumns } from "@/app/actions/table-preferences";
import { CellError, EmptyRow, MultiSelectDropdown, PaginationBar, SearchBox } from "@/components/table/TableControls";
import LocalTime from "@/components/LocalTime";
import adminStyles from "@/components/table/AdminTable.module.css";

// docs/EMAIL.md §10, "Minting and printing" — /join-codes, built from the
// shared table kit as every admin table is (CLAUDE.md, "Admin tables are one
// kit"). One row per card. Above the table, the mint form, and the batch
// picker; with a batch picked, its Print and Revoke. Each row revokes its own
// card, and a selection is revoked in bulk.

export type JoinCodeRow = {
  id: string;
  batchId: string;
  batchLabel: string;
  serial: number;
  /** Null only when the view wrote something this build doesn't know; `rawStatus` is then shown. */
  status: JoinCodeStatus | null;
  rawStatus: string;
  pendingEmail: string | null;
  claimedBy: { name: string; email: string; deleted: boolean } | null;
  claimedAt: Date | null;
  sends: number;
  lastSentAt: Date | null;
  expiresAt: Date;
  mintedAt: Date;
};

export type JoinBatchOption = {
  id: string;
  label: string;
  createdAt: Date;
  createdByName: string;
  expiresAt: Date;
  state: "live" | "expired" | "revoked";
  cards: number;
  claimed: number;
};

const SORTABLE_KEYS = [
  "batch",
  "serial",
  "status",
  "pendingEmail",
  "claimedBy",
  "claimedAt",
  "sends",
  "lastSent",
  "expires",
  "minted",
] as const;

const STATUS_LABELS: Record<JoinCodeStatus, string> = {
  unclaimed: "Unclaimed",
  pending: "Claim pending",
  "sends-used": "Sends used up",
  claimed: "Claimed",
  expired: "Expired",
  revoked: "Revoked",
};

/** What a revoke still changes: a card that is neither claimed nor revoked, its batch's revoke included. */
function revocable(row: JoinCodeRow): boolean {
  return row.status !== null && row.status !== "claimed" && row.status !== "revoked";
}

function batchOptionText(batch: JoinBatchOption): string {
  const state = batch.state === "live" ? "" : batch.state === "expired" ? ", expired, not revoked" : ", revoked";
  return `${batch.label} (${batch.claimed}/${batch.cards} claimed${state})`;
}

export default function JoinCodesTable({
  rows,
  totalCount,
  filters,
  prefs,
  batches,
  maxBatchCards,
}: {
  rows: JoinCodeRow[];
  totalCount: number;
  filters: JoinCodesFilters;
  prefs: TablePrefs;
  batches: JoinBatchOption[];
  maxBatchCards: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { navigate, updateFilters, searchDraft, onSearchChange, handleSort } = useTableFilters({
    filters,
    build: (next, extra) => buildJoinCodesQueryString(next, extra, prefs),
  });
  const { rowStatusClass, rowStatusTitle, runWithStatus, runWithStatusMany } = useRowStatus();
  const { selectedIds, selectedRows, allVisibleSelected, toggleSelectAll, toggleRow, clearSelection } =
    useRowSelection(rows);

  const selectedBatch = filters.batch ? (batches.find((batch) => batch.id === filters.batch) ?? null) : null;

  const bulkActions: BulkAction<JoinCodeRow>[] = [
    {
      kind: "button",
      key: "revoke",
      label: "Revoke selected",
      separated: true,
      applicableTo: revocable,
      run: bulkRevokeJoinCards,
    },
  ];

  function handleRevoke(row: JoinCodeRow) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      try {
        await runWithStatus(row.id, async () => {
          const answer = await revokeJoinCardAction(row.id);
          if (!answer.ok) throw new Error(answer.error);
        });
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to revoke the card.");
      }
    });
  }

  function handleRevokeBatch(batch: JoinBatchOption) {
    const unclaimed = batch.cards - batch.claimed;
    if (
      !window.confirm(
        `Revoke the batch "${batch.label}"? Its ${unclaimed} unclaimed card(s) stop working, and any claim waiting on one is dropped. Accounts already made from it are kept.`,
      )
    ) {
      return;
    }
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const answer = await revokeJoinBatchAction(batch.id);
      if (!answer.ok) {
        setError(answer.error);
        return;
      }
      setNotice(`Revoked "${batch.label}".`);
      router.refresh();
    });
  }

  const columnBodies: Record<AdminColumnKey<"join-codes">, ColumnBody<JoinCodeRow>> = {
    batch: {
      sortKey: "batch",
      // The whole table narrowed to this card's batch, where its Print and
      // Revoke are.
      cell: (row) =>
        filters.batch === row.batchId ? (
          row.batchLabel
        ) : (
          <a
            href={`?batch=${encodeURIComponent(row.batchId)}`}
            onClick={(e) => {
              e.preventDefault();
              updateFilters({ batch: row.batchId } as Partial<JoinCodesFilters>);
            }}
          >
            {row.batchLabel}
          </a>
        ),
    },
    serial: { sortKey: "serial", cell: (row) => row.serial },
    status: {
      sortKey: "status",
      nowrap: true,
      cell: (row) => (row.status ? STATUS_LABELS[row.status] : row.rawStatus),
    },
    pendingEmail: { sortKey: "pendingEmail", cell: (row) => row.pendingEmail ?? "" },
    claimedBy: {
      sortKey: "claimedBy",
      // /users filtered to the account's email, deleted rows included, since
      // the account may have been deleted since.
      cell: (row) =>
        row.claimedBy ? (
          <>
            <Link href={`/users?q=${encodeURIComponent(row.claimedBy.email)}&deleted=1`}>{row.claimedBy.name}</Link>
            {row.claimedBy.deleted && <em> · deleted</em>}
          </>
        ) : (
          ""
        ),
    },
    claimedAt: {
      sortKey: "claimedAt",
      nowrap: true,
      cell: (row) => (row.claimedAt ? <LocalTime value={row.claimedAt} /> : ""),
    },
    sends: { sortKey: "sends", cell: (row) => row.sends },
    lastSent: {
      sortKey: "lastSent",
      nowrap: true,
      cell: (row) => (row.lastSentAt ? <LocalTime value={row.lastSentAt} /> : ""),
    },
    expires: { sortKey: "expires", nowrap: true, cell: (row) => <LocalTime value={row.expiresAt} /> },
    minted: { sortKey: "minted", nowrap: true, cell: (row) => <LocalTime value={row.mintedAt} /> },
  };
  const columns: ColumnSpec<JoinCodeRow>[] = [
    {
      key: "select",
      alwaysVisible: true,
      header: "Select",
      renderHeader: () => <SelectAllHeader checked={allVisibleSelected} onChange={toggleSelectAll} />,
      cell: (row) => (
        <SelectRowCheckbox
          checked={selectedIds.has(row.id)}
          onChange={() => toggleRow(row.id)}
          label={`card ${row.serial} of ${row.batchLabel}`}
        />
      ),
    },
    ...registryColumns("join-codes", columnBodies),
    {
      key: "revoke",
      alwaysVisible: true,
      header: "Revoke",
      cell: (row) =>
        revocable(row) ? (
          <button type="button" disabled={pending} onClick={() => handleRevoke(row)}>
            Revoke
          </button>
        ) : (
          ""
        ),
    },
  ];
  const visibleColumns = resolveColumns(columns, filters.cols);

  return (
    <>
      <MintForm
        maxBatchCards={maxBatchCards}
        onMinted={(batchId, count) => {
          setError(null);
          setNotice(`Minted ${count} card(s). Print them from the batch below.`);
          updateFilters({ batch: batchId, status: "ALL", q: "" } as Partial<JoinCodesFilters>);
        }}
      />

      <div className={adminStyles.filterRow}>
        <label>
          Batch:{" "}
          <select
            value={filters.batch ?? ""}
            onChange={(e) => updateFilters({ batch: e.target.value || null } as Partial<JoinCodesFilters>)}
          >
            <option value="">All batches</option>
            {filters.batch && !selectedBatch && <option value={filters.batch}>No such batch</option>}
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batchOptionText(batch)}
              </option>
            ))}
          </select>
        </label>
        <MultiSelectDropdown
          label="Status"
          options={JOIN_CODE_STATUSES}
          selected={filters.status}
          onChange={(next) => updateFilters({ status: next } as Partial<JoinCodesFilters>)}
        />
        <SearchBox
          value={searchDraft}
          onChange={onSearchChange}
          placeholder="Search emails, names, labels or a card's number…"
          label="Search join cards"
        />
        <ColumnPicker
          columns={columns}
          resolved={visibleColumns}
          onChange={(cols) => navigate({ cols } as Partial<JoinCodesFilters>)}
          onReset={() => navigate({ cols: null } as Partial<JoinCodesFilters>)}
          onSaveDefault={async (cols) => {
            await saveTableColumns("join-codes", cols);
            navigate({ cols: null } as Partial<JoinCodesFilters>);
          }}
          isDefault={sameCols(filters.cols, prefs.cols)}
        />
      </div>

      {selectedBatch && (
        <BatchBar batch={selectedBatch} pending={pending} onRevoke={() => handleRevokeBatch(selectedBatch)} />
      )}
      <CellError message={notice} tone="notice" />

      <BulkToolbar
        selectedRows={selectedRows}
        actions={bulkActions}
        runWithStatus={runWithStatusMany}
        onDone={(ok) => {
          if (ok) clearSelection();
          router.refresh();
        }}
      />

      <div className={adminStyles.tableScroll}>
        <table className={adminStyles.table}>
          <thead>
            <ColumnHeaderRow columns={visibleColumns} sort={filters.sort} onSort={handleSort} />
          </thead>
          <tbody>
            {rows.length === 0 && (
              <EmptyRow
                colSpan={visibleColumns.length}
                message={batches.length === 0 ? "No join cards yet. Mint a batch above." : "No join cards match."}
              />
            )}
            {rows.map((row) => (
              <tr key={row.id} className={adminStyles.row}>
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
      </div>
      <CellError message={error} />

      <PaginationBar
        totalCount={totalCount}
        page={filters.page}
        pageSize={filters.pageSize}
        noun="cards"
        onPageChange={(page) => navigate({ page })}
        onPageSizeChange={(pageSize) => updateFilters({ pageSize })}
      />

      <FilterHelp
        sortKeys={SORTABLE_KEYS}
        defaultPageSize={prefs.pageSize}
        searchDescription="Free-text search over a pending claim's email and name, the batch's label, and the claiming account's name and email; a number also matches a card's No."
        filters={[
          {
            param: "batch",
            meaning: <>One batch&apos;s id; omitted means every batch. A batch picked shows its Print and Revoke.</>,
            control: "Batch dropdown",
          },
          {
            param: "status",
            meaning: <>Comma-separated {JOIN_CODE_STATUSES.join(", ")}; omitted means all.</>,
            control: "Status dropdown",
          },
        ]}
        notes={
          <p style={{ marginTop: 8 }}>
            One row per card (docs/EMAIL.md §10). <strong>Unclaimed</strong>: never claimed, or its claim was dropped.{" "}
            <strong>Claim pending</strong>: someone scanned it and gave the <strong>Pending email</strong>, and its
            confirmation waits; a second scan replaces the claim. <strong>Sends used up</strong>: five confirmation
            mails were delivered, and the card asks its holder for another. <strong>Claimed</strong>: an account was
            made from it. <strong>Expired</strong>: its batch is past its expiry and not revoked, so a pending
            claim&apos;s password hash is still kept; revoking the batch drops it. <strong>Revoked</strong>: the card
            or its batch. Revoking leaves a claimed card and its account as they are; the account is managed on
            /users. The sheet prints a batch&apos;s live cards (unclaimed, pending and sends used up), drawn again
            from the database each time, so close it once printed.
          </p>
        }
      />
    </>
  );
}

/** One batch's facts, its sheet and its revoke. */
function BatchBar({ batch, pending, onRevoke }: { batch: JoinBatchOption; pending: boolean; onRevoke: () => void }) {
  return (
    <section
      aria-label={`Batch ${batch.label}`}
      style={{ margin: "0.75rem 0", padding: "0.75rem", border: "1px solid var(--border)", borderRadius: 4 }}
    >
      <p>
        <strong>{batch.label}</strong>: {batch.cards} card(s), {batch.claimed} claimed. Minted{" "}
        <LocalTime value={batch.createdAt} /> by {batch.createdByName}; expires <LocalTime value={batch.expiresAt} />.
        {batch.state === "expired" && (
          <>
            {" "}
            <strong>Expired, not revoked</strong>: revoke it to drop the password hashes of claims still waiting.
          </>
        )}
        {batch.state === "revoked" && (
          <>
            {" "}
            <strong>Revoked.</strong>
          </>
        )}
      </p>
      {batch.state === "live" && (
        // A plain GET to the Route Handler, in a tab of its own: the sheet is
        // a whole document to print, not a page of this site.
        <form
          action="/join-codes/print"
          method="get"
          target="_blank"
          style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap", marginTop: "0.5rem" }}
        >
          <input type="hidden" name="batch" value={batch.id} />
          <label>
            Extra line on each card (optional):{" "}
            <input type="text" name="line" maxLength={120} size={40} />
          </label>
          <button type="submit">Print live cards</button>
        </form>
      )}
      {batch.state !== "revoked" && (
        <p style={{ marginTop: "0.5rem" }}>
          <button type="button" disabled={pending} onClick={onRevoke}>
            Revoke batch
          </button>
        </p>
      )}
    </section>
  );
}

/** Mints a batch; the cards are printed from the batch it then picks. */
function MintForm({
  maxBatchCards,
  onMinted,
}: {
  maxBatchCards: number;
  onMinted: (batchId: string, count: number) => void;
}) {
  const [label, setLabel] = useState("");
  const [count, setCount] = useState("");
  const [expires, setExpires] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const answer = await mintJoinBatchAction({ label, count: Number(count), expires });
      if (!answer.ok) {
        setError(answer.error);
        return;
      }
      setLabel("");
      setCount("");
      setExpires("");
      onMinted(answer.value.batchId, answer.value.count);
    });
  }

  return (
    <details style={{ margin: "1rem 0" }}>
      <summary>Mint a batch</summary>
      <form
        onSubmit={submit}
        style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap", marginTop: "0.5rem" }}
      >
        <label>
          Label
          <br />
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
            maxLength={200}
            size={30}
            placeholder="Only admins see it"
          />
        </label>
        <label>
          Cards
          <br />
          <input
            type="number"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            required
            min={1}
            max={maxBatchCards}
            step={1}
            style={{ width: "6em" }}
          />
        </label>
        <label>
          Expires at the end of (UTC)
          <br />
          <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} required />
        </label>
        <button type="submit" disabled={pending}>
          {pending ? "Minting…" : "Mint"}
        </button>
      </form>
      <p style={{ marginTop: "0.5rem", color: "var(--text-secondary)" }}>
        Every card makes a trusted AUTHOR. A claim confirmed after the expiry is refused, so set it well past the event,
        and revoke the batch once the event is over.
      </p>
      <CellError message={error} />
    </details>
  );
}
