"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useEditor, EditorContent, type JSONContent } from "@tiptap/react";
import { blurbExtensions, toPlainJSON } from "@/lib/tiptap-schema";
import {
  updateContributorProfile,
  optOutAsContributor,
  uploadContributorAvatar,
  removeContributorAvatar,
} from "@/app/actions/contributor";
import EditorToolbar from "./EditorToolbar";
import ContributorCard from "./ContributorCard";
import AvatarCropper from "./AvatarCropper";
import { AVATAR_SIZE } from "@/lib/avatar-url";
import styles from "./ContributorPanel.module.css";

const EMPTY_BLURB: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

export type ContributorPanelProps = {
  name: string;
  slug: string;
  color: string;
  adminInitials: string;
  /** Resolved by the dashboard (resolveAvatarSrc) — a self-hosted path, a remote adapter URL, or null. */
  avatarSrc: string | null;
  /** Whether the current src is this app's own upload, i.e. whether "Remove" has anything to remove. */
  hasUploadedAvatar: boolean;
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
  avatarSrc,
  hasUploadedAvatar,
  contributorBlurb,
  contributorOrder,
  orcid,
  website,
}: ContributorPanelProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentAvatarSrc, setCurrentAvatarSrc] = useState(avatarSrc);
  const [uploaded, setUploaded] = useState(hasUploadedAvatar);
  const [avatarPending, startAvatarTransition] = useTransition();
  const [avatarError, setAvatarError] = useState<string | null>(null);
  // The picked file, held while the cropper is open. Nothing is uploaded until
  // the crop is confirmed, so this is also "is the cropper showing".
  const [pendingFile, setPendingFile] = useState<File | null>(null);
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

  // Picking a file no longer uploads it — it opens the cropper, and what gets
  // uploaded is that component's export (PLAN.md §17n).
  function handleAvatarPick(file: File | undefined) {
    // Cleared immediately, not after the upload: the input's value is only
    // needed to *notice* the pick, and leaving it set means re-picking the
    // same file after a Cancel fires no onChange and appears to do nothing.
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;
    setAvatarError(null);
    // No size check: the cropper uploads a fixed-size square whatever the
    // source was, so a large pick costs the server nothing, and a file the
    // browser can't decode reports itself through the cropper's onError.
    setPendingFile(file);
  }

  function handleCroppedUpload(cropped: File) {
    setAvatarError(null);
    startAvatarTransition(async () => {
      try {
        const formData = new FormData();
        formData.append("file", cropped);
        const { src } = await uploadContributorAvatar(formData);
        setCurrentAvatarSrc(src);
        setUploaded(true);
        setPendingFile(null);
        router.refresh();
      } catch (e) {
        // The cropper stays open on failure, with the crop intact — a retry
        // shouldn't cost the user their positioning.
        setAvatarError(e instanceof Error ? e.message : "Failed to upload that image.");
      }
    });
  }

  function handleAvatarRemove() {
    setAvatarError(null);
    startAvatarTransition(async () => {
      try {
        await removeContributorAvatar();
        setCurrentAvatarSrc(null);
        setUploaded(false);
        router.refresh();
      } catch (e) {
        setAvatarError(e instanceof Error ? e.message : "Failed to remove the image.");
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
    <div>

      <div className={styles.field}>
        <label htmlFor="contributor-avatar">Photo</label>
        <input
          id="contributor-avatar"
          ref={fileInputRef}
          type="file"
          accept="image/*"
          disabled={avatarPending}
          onChange={(e) => handleAvatarPick(e.target.files?.[0])}
        />
        <p className={styles.hint}>
          Stored on this site, resized to {AVATAR_SIZE}px square. Location data and other metadata are removed.
          {uploaded && !pendingFile && (
            <>
              {" "}
              <button type="button" onClick={handleAvatarRemove} disabled={avatarPending} className={styles.linkButton}>
                Remove photo
              </button>
            </>
          )}
        </p>
        {pendingFile && (
          <AvatarCropper
            // Keyed by the file so picking a second photo remounts rather than
            // reusing the first one's zoom and offset, which would otherwise
            // be applied to a completely different image.
            key={`${pendingFile.name}:${pendingFile.size}:${pendingFile.lastModified}`}
            file={pendingFile}
            busy={avatarPending}
            onCancel={() => {
              setPendingFile(null);
              setAvatarError(null);
            }}
            onConfirm={handleCroppedUpload}
          />
        )}
        {avatarPending && !pendingFile && <p className={styles.hint}>Working…</p>}
        {avatarError && <p className={styles.error}>{avatarError}</p>}
      </div>

      <div className={styles.field}>
        <label>Blurb</label>
        <div className={styles.editorFrame}>
          {editor && <EditorToolbar editor={editor} tools={["bold", "italic"]} />}
          <EditorContent editor={editor} className={styles.editorContent} />
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
          avatarSrc={currentAvatarSrc}
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
