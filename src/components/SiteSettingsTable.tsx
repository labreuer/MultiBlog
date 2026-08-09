"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateSiteDefaultModerationPolicy, updateSiteTrustThreshold } from "@/app/actions/site-settings";
import { useRowStatus } from "@/components/table/use-row-status";
import { CellError } from "@/components/table/TableControls";
import { DefaultColumnsEditor } from "@/components/DefaultColumnsEditor";
import type { AdminTableName } from "@/lib/column-order";
import type { ColumnMeta } from "@/lib/admin-table-columns";
import adminStyles from "@/components/table/AdminTable.module.css";

export type SiteSettingsRow = {
  defaultModerationPolicy: "ALWAYS" | "AUTO";
  trustThreshold: number;
};

export type ConfigRow = {
  name: string;
  value: string;
};

// Not a row-collection table (PLAN.md §16a) — a fixed pair of settings and a
// read-only config list, with nothing to page, select or sort. It takes the
// row-status border from the kit and none of the rest.
const POLICY_ROW = "defaultModerationPolicy";
const THRESHOLD_ROW = "trustThreshold";

function PolicyCell({
  value,
  run,
}: {
  value: "ALWAYS" | "AUTO";
  run: (action: () => Promise<void>) => Promise<void>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <select
        value={value}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value as "ALWAYS" | "AUTO";
          setError(null);
          startTransition(async () => {
            try {
              await run(async () => {
                await updateSiteDefaultModerationPolicy(next);
              });
              router.refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Failed to update moderation policy.");
            }
          });
        }}
      >
        <option value="ALWAYS">ALWAYS (queue for approval)</option>
        <option value="AUTO">AUTO (publish immediately)</option>
      </select>
      <CellError message={error} />
    </>
  );
}

function TrustThresholdCell({
  value,
  onEdit,
  run,
}: {
  value: number;
  onEdit: () => void;
  run: (action: () => Promise<void>) => Promise<void>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState(String(value));

  function commit() {
    const trimmed = text.trim();
    const parsed = Number(trimmed);
    if (trimmed === String(value)) return;
    if (!Number.isInteger(parsed) || parsed < 0) {
      setText(String(value));
      setError("Must be a non-negative whole number.");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await run(async () => {
          await updateSiteTrustThreshold(parsed);
        });
        setText(String(parsed));
        router.refresh();
      } catch (err) {
        setText(String(value));
        setError(err instanceof Error ? err.message : "Failed to update trust threshold.");
      }
    });
  }

  return (
    <>
      <input
        type="number"
        min={0}
        step={1}
        value={text}
        disabled={pending}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() !== String(value)) onEdit();
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        style={{ width: 80, padding: "2px 4px" }}
      />
      <CellError message={error} />
    </>
  );
}

export type DefaultColumnsRow = {
  table: AdminTableName;
  label: string;
  columns: ColumnMeta[];
  /** The keys currently in the effective default (site override, or the code default if none), in order. */
  initialChecked: string[];
};

export default function SiteSettingsTable({
  siteSettings,
  configRows,
  configLocation,
  configToChange,
  defaultColumns,
}: {
  siteSettings: SiteSettingsRow;
  configRows: ConfigRow[];
  configLocation: string;
  configToChange: string;
  defaultColumns: DefaultColumnsRow[];
}) {
  const { rowStatusClass, setStatus, runWithStatus } = useRowStatus();

  return (
    <>
      <h2 style={{ marginTop: "2rem" }}>DB settings</h2>
      <p style={{ color: "var(--text-secondary)" }}>
        Stored in the database (<code>SiteSettings</code>) — edits below save immediately and take effect on the
        next request, no deploy needed.
      </p>
      <table className={adminStyles.table}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th className={adminStyles.headerCell}>Setting</th>
            <th className={adminStyles.headerCell}>Value</th>
            <th className={adminStyles.headerCell}>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr className={adminStyles.row}>
            <td className={`${adminStyles.cell} ${rowStatusClass(POLICY_ROW)}`}>Default moderation policy</td>
            <td className={adminStyles.cell}>
              <PolicyCell
                value={siteSettings.defaultModerationPolicy}
                run={(action) => runWithStatus(POLICY_ROW, action)}
              />
            </td>
            <td className={adminStyles.cell} style={{ color: "var(--text-secondary)" }}>
              Moderation policy when neither author nor post overrides it.
            </td>
          </tr>
          <tr className={adminStyles.row}>
            <td className={`${adminStyles.cell} ${rowStatusClass(THRESHOLD_ROW)}`}>Trust threshold</td>
            <td className={adminStyles.cell}>
              <TrustThresholdCell
                value={siteSettings.trustThreshold}
                onEdit={() => setStatus(THRESHOLD_ROW, "edited")}
                run={(action) => runWithStatus(THRESHOLD_ROW, action)}
              />
            </td>
            <td className={adminStyles.cell} style={{ color: "var(--text-secondary)" }}>
              Number of approved comments before a commenter is auto-approved, when a comment&apos;s resolved
              moderation policy is ALWAYS. Otherwise, this setting is inert.
            </td>
          </tr>
        </tbody>
      </table>

      <h2 style={{ marginTop: "2rem" }}>Default columns per table</h2>
      <p style={{ color: "var(--text-secondary)" }}>
        Which columns each admin table shows when nobody has picked their own (PLAN.md §16i) — an admin&apos;s own
        &quot;Save as my default&quot; in a table&apos;s own Columns picker still overrides this. Order always
        follows the table&apos;s own column order; only visibility is configurable here.
      </p>
      <table className={adminStyles.table}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th className={adminStyles.headerCell}>Table</th>
            <th className={adminStyles.headerCell}>Default columns</th>
          </tr>
        </thead>
        <tbody>
          {defaultColumns.map((row) => (
            // Each row is its own table's whole section (a checkbox/drag list, potentially several lines
            // tall now that it's not height-capped) — the plain 1px `.row` divider disappears next to that
            // much content, so this borrows the same 2px rule the header row uses to separate itself from
            // the body, applied here between one table's section and the next.
            <tr key={row.table} className={adminStyles.row} style={{ borderBottom: "2px solid var(--border)" }}>
              <td className={adminStyles.cell}>
                <strong>{row.label}</strong>
              </td>
              <td className={adminStyles.cell}>
                <DefaultColumnsEditor table={row.table} columns={row.columns} initialChecked={row.initialChecked} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: "2rem" }}>Config-file settings</h2>
      <p style={{ color: "var(--text-secondary)" }}>
        Defined as plain constants in source, not the database — read-only here.
      </p>
      <table className={adminStyles.table}>
        <thead>
          <tr style={{ textAlign: "left" }}>
            <th className={adminStyles.headerCell}>Setting</th>
            <th className={adminStyles.headerCell}>Value</th>
          </tr>
        </thead>
        <tbody>
          {configRows.map((row) => (
            <tr key={row.name} className={adminStyles.row}>
              <td className={adminStyles.cell}>{row.name}</td>
              <td className={adminStyles.cell}>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: "var(--text-secondary)", marginTop: "0.5em" }}>
        Location: <code>{configLocation}</code>
      </p>
      <p style={{ color: "var(--text-secondary)", marginTop: "0.25em" }}>To change: {configToChange}</p>
    </>
  );
}
