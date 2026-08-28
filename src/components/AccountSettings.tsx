"use client";

import { useState, useTransition, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { updateAccountSettings } from "@/app/actions/account-settings";
import { authorHighlightBackground } from "@/lib/author-colors";
import QuoteThreadHeader from "./QuoteThreadHeader";
import proseStyles from "@/styles/prose.module.css";

export type AccountSettingsProps = {
  name: string;
  adminInitials: string;
  color: string;
  /** AUTHOR+ — whether the initials and color fields render. The server re-checks. */
  canEditAuthorIdentity: boolean;
};

// The highlighted run and the mock comment's blockquote are the same string
// on purpose — the sample depicts a comment quoting the highlighted passage.
const SAMPLE_QUOTE = "the fishermen mend their nets on the quay";

// Prominence without a fill: bold, padded, rounded on a neutral border —
// the same treatment ContributorPanel's .saveButton wears, stated in both
// places because one is inline-styled and the other a module.
const saveButtonStyle: CSSProperties = {
  padding: "0.4rem 1rem",
  fontWeight: "bold",
  border: "1px solid var(--border)",
  borderRadius: 4,
  cursor: "pointer",
};

const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.5rem" };
const labelStyle: CSSProperties = { width: 90 };

// The dashboard Settings card's form (docs/DASHBOARD.md "Settings") —
// distinct from ContributorPanel, which edits the public contributor *card*.
// One combined Save, deliberately not the /users per-field autosave.
export default function AccountSettings({ name, adminInitials, color, canEditAuthorIdentity }: AccountSettingsProps) {
  const router = useRouter();
  const { update: updateSession } = useSession();
  const [nameInput, setNameInput] = useState(name);
  const [initialsInput, setInitialsInput] = useState(adminInitials);
  const [colorInput, setColorInput] = useState(color);
  const [saving, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function handleSave() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      try {
        await updateAccountSettings({
          name: nameInput,
          // Omitted entirely for non-authors: present-but-empty fields
          // would trip the server's tier check.
          ...(canEditAuthorIdentity ? { adminInitials: initialsInput, color: colorInput } : {}),
        });
        setSaved(true);
        // Re-bakes the JWT's name/color, which SessionRefresh (once per
        // mount) has already missed. `{}` and not no-args — only a POST
        // triggers the re-read. docs/DASHBOARD.md "After a save".
        await updateSession({});
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save.");
      }
    });
  }

  return (
    <div>
      <div style={rowStyle}>
        <label htmlFor="settings-name" style={labelStyle}>
          Name
        </label>
        <input
          id="settings-name"
          type="text"
          value={nameInput}
          onChange={(e) => setNameInput(e.target.value)}
          style={{ padding: "2px 4px", flex: 1 }}
        />
      </div>
      {canEditAuthorIdentity && (
        <>
          <div style={rowStyle}>
            <label htmlFor="settings-initials" style={labelStyle}>
              Initials
            </label>
            <input
              id="settings-initials"
              type="text"
              value={initialsInput}
              onChange={(e) => setInitialsInput(e.target.value)}
              style={{ padding: "2px 4px", width: 70 }}
            />
          </div>
          <div style={rowStyle}>
            <label htmlFor="settings-color" style={labelStyle}>
              Author color
            </label>
            <input
              id="settings-color"
              type="color"
              value={colorInput}
              onChange={(e) => setColorInput(e.target.value)}
              style={{ width: 40, height: 24, padding: 0, border: "1px solid var(--border)", cursor: "pointer" }}
            />
          </div>
        </>
      )}
      <div style={rowStyle}>
        <button type="button" onClick={handleSave} disabled={saving} style={{ ...saveButtonStyle, ...(saving ? { opacity: 0.6, cursor: "default" } : {}) }}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span style={{ color: "var(--success)" }}>Saved.</span>}
        {error && <span style={{ color: "var(--danger)" }}>{error}</span>}
      </div>
      {canEditAuthorIdentity && (
        <>
          {/* Live sample of the picked color; both halves reuse the real
              rendering so they can't drift from what readers see.
              docs/DASHBOARD.md "The color sample". */}
          <div
            style={{
              marginTop: "0.75rem",
              border: "1px solid var(--border-subtle)",
              borderRadius: 4,
              padding: "0.75rem",
            }}
          >
            <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
              How your color reads — a highlight in the article, and the quote marker on a comment:
            </p>
            <div className={proseStyles.prose}>
              <p>
                The old harbor keeps its own hours:{" "}
                <span style={{ backgroundColor: authorHighlightBackground(colorInput) }}>{SAMPLE_QUOTE}</span> long
                after the ferries stop running.
              </p>
            </div>
            <div style={{ marginTop: "0.75rem" }}>
              <QuoteThreadHeader
                preview
                threadId="color-preview"
                quotedText={SAMPLE_QUOTE}
                status="ACTIVE"
                context={null}
                color={colorInput}
              />
              <p style={{ fontSize: "0.9rem" }}>Is this detail from the 1936 survey, or observed?</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
