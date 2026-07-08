"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createPostAction, type CreatePostState } from "@/app/actions/posts";

const initialState: CreatePostState = {};

export default function NewPostPage() {
  const [state, formAction, pending] = useActionState(createPostAction, initialState);

  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>New post</h1>
      <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label>
          Title
          <input name="title" type="text" required autoFocus />
        </label>
        {state.error && <p style={{ color: "crimson" }}>{state.error}</p>}
        <button type="submit" disabled={pending}>
          {pending ? "Creating..." : "Create draft"}
        </button>
      </form>
      <p>
        <Link href="/posts">Back to posts</Link>
      </p>
    </main>
  );
}
