"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { updateSiteDefaultModerationPolicy, updateSiteTrustThreshold } from "@/app/actions/site-settings";
import styles from "./SiteSettingsTable.module.css";

export type SiteSettingsRow = {
  defaultModerationPolicy: "ALWAYS" | "AUTO";
  trustThreshold: number;
};

export type ConfigRow = {
  name: string;
  value: string;
};

const th: React.CSSProperties = { padding: "6px 12px", borderBottom: "2px solid #ddd", textAlign: "left" };
const td: React.CSSProperties = { padding: "6px 12px", verticalAlign: "top" };

function PolicyCell({
  value,
  onSaved,
}: {
  value: "ALWAYS" | "AUTO";
  onSaved: () => void;
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
              await updateSiteDefaultModerationPolicy(next);
              onSaved();
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
      {error && <div style={{ color: "crimson", fontSize: "0.8rem" }}>{error}</div>}
    </>
  );
}

function TrustThresholdCell({
  value,
  onSaved,
}: {
  value: number;
  onSaved: () => void;
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
        await updateSiteTrustThreshold(parsed);
        setText(String(parsed));
        onSaved();
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
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        style={{ width: 80, padding: "2px 4px" }}
      />
      {error && <div style={{ color: "crimson", fontSize: "0.8rem" }}>{error}</div>}
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
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

  // Re-triggers the pulse even if a row is already mid-animation — toggling
  // a class doesn't replay a running animation, so it's removed and a
  // reflow forced before re-adding it. Same mechanism as UsersTable.
  function pulseRow(rowId: string) {
    const el = rowRefs.current.get(rowId);
    if (!el) return;
    el.classList.remove(styles.savedPulse);
    void el.offsetWidth;
    el.classList.add(styles.savedPulse);
  }

  return (
    <>
      <h2 style={{ marginTop: "2rem" }}>DB settings</h2>
      <p style={{ color: "#666" }}>
        Stored in the database (<code>SiteSettings</code>) — edits below save immediately and take effect on the
        next request, no deploy needed.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.5em" }}>
        <thead>
          <tr>
            <th style={th}>Setting</th>
            <th style={th}>Value</th>
            <th style={th}>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr
            ref={(el) => {
              if (el) rowRefs.current.set("defaultModerationPolicy", el);
              else rowRefs.current.delete("defaultModerationPolicy");
            }}
            onAnimationEnd={(e) => e.currentTarget.classList.remove(styles.savedPulse)}
            style={{ borderBottom: "1px solid #eee" }}
          >
            <td style={td}>Default moderation policy</td>
            <td style={td}>
              <PolicyCell
                value={siteSettings.defaultModerationPolicy}
                onSaved={() => pulseRow("defaultModerationPolicy")}
              />
            </td>
            <td style={{ ...td, color: "#666" }}>
              Moderation policy when neither author nor post overrides it.
            </td>
          </tr>
          <tr
            ref={(el) => {
              if (el) rowRefs.current.set("trustThreshold", el);
              else rowRefs.current.delete("trustThreshold");
            }}
            onAnimationEnd={(e) => e.currentTarget.classList.remove(styles.savedPulse)}
            style={{ borderBottom: "1px solid #eee" }}
          >
            <td style={td}>Trust threshold</td>
            <td style={td}>
              <TrustThresholdCell value={siteSettings.trustThreshold} onSaved={() => pulseRow("trustThreshold")} />
            </td>
            <td style={{ ...td, color: "#666" }}>
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
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "0.5em" }}>
        <thead>
          <tr>
            <th style={th}>Setting</th>
            <th style={th}>Value</th>
          </tr>
        </thead>
        <tbody>
          {configRows.map((row) => (
            <tr key={row.name} style={{ borderBottom: "1px solid #eee" }}>
              <td style={td}>{row.name}</td>
              <td style={td}>{row.value}</td>
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
