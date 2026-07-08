"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useEditor, EditorContent, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { saveDraft, publishPost } from "@/app/actions/posts";

type Props = {
  postId: string;
  initialTitle: string;
  initialDoc: JSONContent;
  revisionNumber: number;
};

export default function PostEditor({ postId, initialTitle, initialDoc, revisionNumber }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changelog, setChangelog] = useState("");
  const [pending, startTransition] = useTransition();

  const editor = useEditor({
    extensions: [StarterKit],
    content: initialDoc,
    immediatelyRender: false,
  });

  const handleSaveDraft = () => {
    if (!editor) return;
    setError(null);
    startTransition(async () => {
      try {
        const doc = editor.getJSON();
        const result = await saveDraft(postId, title, doc);
        setStatus(`Saved as revision #${result.revisionNumber}`);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to save.");
      }
    });
  };

  const handlePublish = () => {
    if (!editor) return;
    setError(null);
    startTransition(async () => {
      try {
        const doc = editor.getJSON();
        const result = await publishPost(postId, title, doc, changelog);
        setStatus(`Published as revision #${result.revisionNumber}`);
        setChangelog("");
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to publish.");
      }
    });
  };

  if (!editor) {
    return null;
  }

  return (
    <div style={{ maxWidth: 720, margin: "2rem auto", fontFamily: "sans-serif" }}>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        aria-label="Title"
        style={{ fontSize: "1.5rem", width: "100%", marginBottom: 12, padding: 4 }}
      />
      <div style={{ border: "1px solid #ccc", borderRadius: 4 }}>
        <Toolbar editor={editor} />
        <EditorContent editor={editor} style={{ minHeight: 300, padding: 12 }} />
      </div>
      <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
        <button type="button" onClick={handleSaveDraft} disabled={pending}>
          Save draft
        </button>
        <input
          placeholder="Changelog (optional)"
          value={changelog}
          onChange={(e) => setChangelog(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="button" onClick={handlePublish} disabled={pending}>
          Publish
        </button>
      </div>
      {status && <p style={{ color: "green" }}>{status}</p>}
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <p style={{ color: "#666", fontSize: "0.9rem" }}>Currently viewing revision #{revisionNumber}.</p>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  return (
    <div style={{ display: "flex", gap: 4, padding: 8, borderBottom: "1px solid #ccc" }}>
      <button type="button" onClick={() => editor.chain().focus().toggleBold().run()}>
        Bold
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()}>
        Italic
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        H2
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()}>
        Bullets
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        Numbered
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        Quote
      </button>
    </div>
  );
}
