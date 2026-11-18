"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { actorFromSessionUser } from "@/lib/actor";
import { ApiError } from "@/lib/api/errors";
import { createWikiPage } from "@/lib/wiki-create";
import { deleteWikiAddressRow, renameWikiPage, revertWikiAddress, type WikiRenameResult } from "@/lib/wiki-rename";
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

/** A rename's or revert's answer: where the page now lives, or a refusal in words, with the taken address's path. */
export type WikiRenameState = { ok: true; result: WikiRenameResult } | { ok: false; error: string; takenPath?: string };

async function renameAs(run: (actor: ReturnType<typeof actorFromSessionUser>) => Promise<WikiRenameResult>, docId: string): Promise<WikiRenameState> {
  const session = await auth();
  if (!session?.user) redirect(signInPath());
  let result: WikiRenameResult;
  try {
    result = await run(actorFromSessionUser(session.user));
  } catch (err) {
    if (err instanceof ApiError) {
      return { ok: false, error: err.message, ...(typeof err.details.path === "string" ? { takenPath: err.details.path } : {}) };
    }
    throw err;
  }
  revalidateRenamed(docId);
  return { ok: true, result };
}

// Every route under /wiki/ answers from the address columns and their
// history, and /doc/<id>/slug lists them.
function revalidateRenamed(docId: string): void {
  revalidatePath("/wiki", "layout");
  revalidatePath(`/doc/${docId}/slug`);
}

/**
 * The editor's name field, and /doc/<slug>/slug's Rename, which also takes
 * the variant (docs/WIKI.md "Renaming"). The caller goes on to the page's
 * new address.
 */
export async function renameWikiPageAction(docId: string, name: string, variant?: string): Promise<WikiRenameState> {
  return renameAs((actor) => renameWikiPage(actor, docId, { name, variant }), docId);
}

/** /doc/<slug>/slug's Revert: back to the most recent reserved address. */
export async function revertWikiAddressAction(docId: string): Promise<WikiRenameState> {
  return renameAs((actor) => revertWikiAddress(actor, docId), docId);
}

/** /doc/<slug>/slug's delete on a past address: its redirect ends, and a reserved one's address is freed. */
export async function deleteWikiAddressRowAction(docId: string, rowId: string): Promise<{ error?: string }> {
  const session = await auth();
  if (!session?.user) redirect(signInPath());
  try {
    await deleteWikiAddressRow(actorFromSessionUser(session.user), docId, rowId);
  } catch (err) {
    // Words, not a throw: a production build hides a thrown error's message.
    if (err instanceof ApiError) return { error: err.message };
    throw err;
  }
  revalidateRenamed(docId);
  return {};
}
