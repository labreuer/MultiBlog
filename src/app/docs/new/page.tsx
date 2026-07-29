"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createDocAction, type CreateDocState } from "@/app/actions/docs";

const initialState: CreateDocState = {};

export default function NewDocPage() {
  const [state, formAction, pending] = useActionState(createDocAction, initialState);

  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>New doc</h1>
      <form action={formAction} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label>
          Title
          <input name="title" type="text" required autoFocus />
        </label>
        {state.error && <p style={{ color: "crimson" }}>{state.error}</p>}
        <button type="submit" disabled={pending}>
          {pending ? "Creating..." : "Create doc"}
        </button>
      </form>
      <p>
        <Link href="/docs">Back to docs</Link>
      </p>
    </main>
  );
}
