"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
import { blurbExtensions, toPlainJSON } from "@/lib/tiptap-schema";
import { updateContributorProfile, optOutAsContributor } from "@/app/actions/contributor";
import EditorToolbar from "./EditorToolbar";
import ContributorCard from "./ContributorCard";
import proseStyles from "@/styles/prose.module.css";
import styles from "./ContributorPanel.module.css";

const EMPTY_BLURB: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

export type ContributorPanelProps = {
  name: string;
  slug: string;
  color: string;
  adminInitials: string;
  image: string | null;
  contributorBlurb: JSONContent | null;
  contributorOrder: number | null;
  orcid: string | null;
  website: string | null;
};

// The dashboard's self-service editing surface for the contributor-card
// fields (PLAN.md §17g) — rendered by /dashboard only when the signed-in
// user's isListedContributor is true. One combined Save for the whole
// panel, not a per-field autosave: there's no live session for a blurb
// edit to debounce into the way a doc edit does.
export default function ContributorPanel({
  name,
  slug,
  color,
  adminInitials,
  image,
  contributorBlurb,
  contributorOrder,
  orcid,
  website,
}: ContributorPanelProps) {
  const router = useRouter();
  const [imageInput, setImageInput] = useState(image ?? "");
  const [orderInput, setOrderInput] = useState(contributorOrder !== null ? String(contributorOrder) : "");
  const [orcidInput, setOrcidInput] = useState(orcid ?? "");
  const [websiteInput, setWebsiteInput] = useState(website ?? "");
  const [blurbJSON, setBlurbJSON] = useState<JSONContent>(contributorBlurb ?? EMPTY_BLURB);
  const [saving, startSaveTransition] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmingOptOut, setConfirmingOptOut] = useState(false);
  const [optOutPending, startOptOutTransition] = useTransition();
  const [optOutError, setOptOutError] = useState<string | null>(null);

  const editor = useEditor({
    extensions: blurbExtensions,
    content: contributorBlurb ?? EMPTY_BLURB,
    editorProps: { attributes: { "aria-label": "Contributor blurb" } },
    immediatelyRender: false,
    onUpdate: ({ editor }) => setBlurbJSON(editor.getJSON()),
  });

  function handleSave() {
    setSaveError(null);
    setSaved(false);
    startSaveTransition(async () => {
      try {
        await updateContributorProfile({
          image: imageInput,
          // Round-tripped through JSON, not the raw getJSON() output: React's
          // Server Action encoder treats a null-prototype attrs object (which
          // ProseMirror's Node/Mark#toJSON can produce) as opaque and silently
          // replaces it — see toPlainJSON's own comment in tiptap-schema.ts.
          blurb: toPlainJSON(blurbJSON),
          order: orderInput,
          orcid: orcidInput,
          website: websiteInput,
        });
        setSaved(true);
        router.refresh();
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : "Failed to save.");
      }
    });
  }

  function handleOptOut() {
    setOptOutError(null);
    startOptOutTransition(async () => {
      try {
        await optOutAsContributor();
        router.refresh();
      } catch (e) {
        setOptOutError(e instanceof Error ? e.message : "Failed to remove you from the contributor list.");
      }
    });
  }

  return (
    <div className={styles.panel}>
      <h2 className={styles.heading}>Contributor profile</h2>

      <div className={styles.field}>
        <label htmlFor="contributor-image">Image URL</label>
        <input id="contributor-image" type="url" value={imageInput} onChange={(e) => setImageInput(e.target.value)} placeholder="https://…" />
      </div>

      <div className={styles.field}>
        <label>Blurb</label>
        <div className={styles.editorFrame}>
          {editor && <EditorToolbar editor={editor} tools={["bold", "italic"]} />}
          <EditorContent editor={editor} className={`${styles.editorContent} ${proseStyles.prose}`} />
        </div>
      </div>

      <div className={styles.field}>
        <label htmlFor="contributor-order">Order (lower shows first; leave blank for last)</label>
        <input id="contributor-order" type="number" step={1} value={orderInput} onChange={(e) => setOrderInput(e.target.value)} />
      </div>

      <div className={styles.field}>
        <label htmlFor="contributor-orcid">ORCID iD</label>
        <input id="contributor-orcid" type="text" value={orcidInput} onChange={(e) => setOrcidInput(e.target.value)} placeholder="0000-0002-1825-0097" />
      </div>

      <div className={styles.field}>
        <label htmlFor="contributor-website">Website</label>
        <input id="contributor-website" type="url" value={websiteInput} onChange={(e) => setWebsiteInput(e.target.value)} placeholder="https://…" />
      </div>

      <div className={styles.actions}>
        <button type="button" onClick={handleSave} disabled={saving} className={styles.saveButton}>
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && !saving && <span>Saved.</span>}
      </div>
      {saveError && <p className={styles.error}>{saveError}</p>}

      <p className={styles.previewHeading}>Preview</p>
      <div className={styles.previewCard}>
        <ContributorCard
          name={name}
          slug={slug}
          image={imageInput.trim() || null}
          color={color}
          adminInitials={adminInitials}
          orcid={orcidInput.trim() || null}
          website={websiteInput.trim() || null}
          blurb={blurbJSON}
        />
      </div>

      <div className={styles.optOutRow}>
        {!confirmingOptOut && (
          <button type="button" onClick={() => setConfirmingOptOut(true)} className={styles.optOutButton}>
            Remove me from the contributor list
          </button>
        )}
        {confirmingOptOut && (
          <span className={styles.confirmPrompt}>
            Are you sure? You will need an admin to put you back.{" "}
            <button type="button" onClick={handleOptOut} disabled={optOutPending}>
              {optOutPending ? "Removing…" : "Yes, remove me"}
            </button>{" "}
            /{" "}
            <button type="button" onClick={() => setConfirmingOptOut(false)} disabled={optOutPending}>
              Cancel
            </button>
          </span>
        )}
        {optOutError && <p className={styles.error}>{optOutError}</p>}
      </div>
    </div>
  );
}
