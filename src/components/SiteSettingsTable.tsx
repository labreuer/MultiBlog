"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateSiteDefaultModerationPolicy, updateSiteTrustThreshold } from "@/app/actions/site-settings";
import { useRowStatus } from "@/components/table/use-row-status";
import { CellError } from "@/components/table/TableControls";
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

export default function SiteSettingsTable({
  siteSettings,
  configRows,
  configLocation,
  configToChange,
}: {
  siteSettings: SiteSettingsRow;
  configRows: ConfigRow[];
  configLocation: string;
  configToChange: string;
}) {
  const { rowStatusClass, setStatus, runWithStatus } = useRowStatus();

  return (
    <>
      <h2 style={{ marginTop: "2rem" }}>DB settings</h2>
      <p style={{ color: "#666" }}>
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
            <td className={adminStyles.cell} style={{ color: "#666" }}>
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
            <td className={adminStyles.cell} style={{ color: "#666" }}>
              Number of approved comments before a commenter is auto-approved, when a comment&apos;s resolved
              moderation policy is ALWAYS. Otherwise, this setting is inert.
            </td>
          </tr>
        </tbody>
      </table>

      <h2 style={{ marginTop: "2rem" }}>Config-file settings</h2>
      <p style={{ color: "#666" }}>
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
      <p style={{ color: "#666", marginTop: "0.5em" }}>
        Location: <code>{configLocation}</code>
      </p>
      <p style={{ color: "#666", marginTop: "0.25em" }}>To change: {configToChange}</p>
    </>
  );
}
