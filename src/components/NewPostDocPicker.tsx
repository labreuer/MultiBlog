"use client";

import { useActionState } from "react";
import { createPostFromDocAction, type CreatePostFromDocState } from "@/app/actions/posts";
import type { ReadableDoc } from "@/lib/doc-authz";

const initialState: CreatePostFromDocState = {};

// The client half of /posts/new (PLAN.md §15d) — a plain <select> inside a
// useActionState form, same redirect-safe shape the old title-only form used.
export default function NewPostDocPicker({ docs }: { docs: ReadableDoc[] }) {
  const [state, formAction, pending] = useActionState(createPostFromDocAction, initialState);

  return (
    <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <label>
        Doc
        <select name="docId" defaultValue={docs[0]?.id ?? ""} required>
          {docs.map((doc) => (
            <option key={doc.id} value={doc.id}>
              {doc.title || "Untitled"}
            </option>
          ))}
        </select>
      </label>
      {state.error && <p style={{ color: "crimson" }}>{state.error}</p>}
      <button type="submit" disabled={pending}>
        {pending ? "Creating..." : "Create post"}
      </button>
    </form>
  );
}
