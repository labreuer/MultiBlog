"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { actorFromSessionUser } from "@/lib/actor";
import { ApiError } from "@/lib/api/errors";
import { createWikiPage } from "@/lib/wiki-create";
import { signInPath } from "@/lib/sign-in-redirect";
import type { DocVisibility } from "@/generated/prisma/enums";

// The wiki's actions (docs/WIKI.md): each the session, the call into
// src/lib/, and the UI's own revalidation and navigation. Named apart from
// main's forkDoc, forkDocAction and ForkDocState.

export type CreateWikiPageState = { error?: string; takenPath?: string };

const VISIBILITIES: readonly string[] = ["PRIVATE", "SHARED", "PUBLIC"];

/** /wiki/new's form, for useActionState: a refusal comes back as words, a taken address with a link to the page there. */
export async function createWikiPageAction(_prev: CreateWikiPageState, form: FormData): Promise<CreateWikiPageState> {
  const session = await auth();
  if (!session?.user) {
    // No callbackUrl: this guards a mutation, and a POST can't be replayed by
    // arriving at a URL.
    redirect(signInPath());
  }
  const field = (key: string) => String(form.get(key) ?? "");
  const visibility = field("visibility");
  if (!VISIBILITIES.includes(visibility)) return { error: "Choose who can read it." };
  let editPath: string;
  try {
    ({ editPath } = await createWikiPage(actorFromSessionUser(session.user), {
      namespace: field("namespace") === "commons" ? "commons" : "person",
      name: field("name"),
      variant: field("variant").trim(),
      visibility: visibility as DocVisibility,
    }));
  } catch (err) {
    if (err instanceof ApiError) {
      return { error: err.message, ...(typeof err.details.path === "string" ? { takenPath: err.details.path } : {}) };
    }
    throw err;
  }
  revalidatePath("/wiki", "layout");
  redirect(editPath);
}
