"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { actorFromSessionUser } from "@/lib/actor";
import { ApiError } from "@/lib/api/errors";
import { createWikiPage, type WikiNamespaceChoice } from "@/lib/wiki-create";
import { forkIntoWiki, previewWikiForkAddress, type WikiAddressPreview } from "@/lib/wiki-fork";
import { moveDocIntoWiki, moveWikiPage, previewWikiMoveAddress, type WikiPageMoveResult } from "@/lib/wiki-move";
import { deleteWikiAddressRow, renameWikiPage, revertWikiAddress, type WikiRenameResult } from "@/lib/wiki-rename";
import { signInPath } from "@/lib/sign-in-redirect";
import { revalidateFrontPage, revalidateFrontPageFor } from "@/lib/front-page-revalidate";
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
  await revalidateRenamed(docId);
  return { ok: true, result };
}

// Every route under /wiki/ answers from the address columns and their
// history, and /doc/<id>/slug lists them. `/` too for a commons page, which
// a rename can put at the front page's address or take off it.
async function revalidateRenamed(docId: string): Promise<void> {
  revalidatePath("/wiki", "layout");
  revalidatePath(`/doc/${docId}/slug`);
  await revalidateFrontPageFor(docId);
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
  await revalidateRenamed(docId);
  return {};
}

/** The Fork dialog's and the Move dialog's answer: a refusal in words, with the taken address's path. */
export type WikiClaimState = { error?: string; takenPath?: string };

function claimRefusal(err: unknown): WikiClaimState {
  if (err instanceof ApiError) {
    return { error: err.message, ...(typeof err.details.path === "string" ? { takenPath: err.details.path } : {}) };
  }
  throw err;
}

/** A form's namespace field: the commons when it says so, the viewer's own otherwise. */
function namespaceOf(form: FormData): WikiNamespaceChoice {
  return form.get("namespace") === "commons" ? "commons" : "person";
}

/** A form's variant field: null when left empty, for the server to pick the default it showed. */
function typedVariant(form: FormData): string | null {
  const variant = String(form.get("variant") ?? "").trim();
  return variant === "" ? null : variant;
}

/**
 * The Fork dialog with a namespace for its Where (docs/WIKI.md "The Actions
 * menu"); with "a doc" it calls main's forkDocAction. Lands on the fork's
 * wiki editor.
 */
export async function forkIntoWikiAction(_prev: WikiClaimState, form: FormData): Promise<WikiClaimState> {
  const session = await auth();
  if (!session?.user) redirect(signInPath());
  const visibility = String(form.get("visibility") ?? "");
  if (!VISIBILITIES.includes(visibility)) return { error: "Choose who can read it." };
  const revision = form.get("revision");
  let editPath: string;
  const namespace = namespaceOf(form);
  try {
    ({ editPath } = await forkIntoWiki(actorFromSessionUser(session.user), {
      parentId: String(form.get("parentId") ?? ""),
      // "" is the hidden field's way of saying the doc as it is now.
      revision: typeof revision === "string" && revision !== "" ? revision : null,
      namespace,
      name: String(form.get("name") ?? ""),
      variant: typedVariant(form),
      visibility: visibility as DocVisibility,
    }));
  } catch (err) {
    return claimRefusal(err);
  }
  revalidatePath("/wiki", "layout");
  revalidatePath("/docs");
  if (namespace === "commons") revalidateFrontPage();
  redirect(editPath);
}

/**
 * "Move into the wiki…" (docs/WIKI.md "Moving a doc into the wiki"). Lands on
 * the page at its address.
 */
export async function moveDocIntoWikiAction(_prev: WikiClaimState, form: FormData): Promise<WikiClaimState> {
  const session = await auth();
  if (!session?.user) redirect(signInPath());
  const visibility = String(form.get("visibility") ?? "");
  let moved: { path: string; commons: boolean };
  try {
    moved = await moveDocIntoWiki(actorFromSessionUser(session.user), {
      docId: String(form.get("docId") ?? ""),
      namespace: namespaceOf(form),
      name: String(form.get("name") ?? ""),
      variant: typedVariant(form),
      visibility: VISIBILITIES.includes(visibility) ? (visibility as DocVisibility) : null,
    });
  } catch (err) {
    return claimRefusal(err);
  }
  revalidatePath("/wiki", "layout");
  revalidatePath("/docs");
  if (moved.commons) revalidateFrontPage();
  redirect(moved.path);
}

/**
 * "Move…" on a wiki page (docs/WIKI.md "Renaming", "Moving out of the
 * wiki"): to another namespace, or out of the wiki. Lands on the page at its
 * new address, or on the doc.
 */
export async function moveWikiPageAction(_prev: WikiClaimState, form: FormData): Promise<WikiClaimState> {
  const session = await auth();
  if (!session?.user) redirect(signInPath());
  const docId = String(form.get("docId") ?? "");
  const visibility = String(form.get("visibility") ?? "");
  let moved: WikiPageMoveResult;
  try {
    moved = await moveWikiPage(actorFromSessionUser(session.user), {
      docId,
      to:
        form.get("namespace") === "out"
          ? { kind: "out" }
          : { kind: "namespace", namespace: namespaceOf(form), name: String(form.get("name") ?? ""), variant: typedVariant(form) },
      visibility: VISIBILITIES.includes(visibility) ? (visibility as DocVisibility) : null,
    });
  } catch (err) {
    return claimRefusal(err);
  }
  revalidatePath("/wiki", "layout");
  revalidatePath("/docs");
  revalidatePath(`/doc/${docId}/slug`);
  if (moved.commons) revalidateFrontPage();
  redirect(moved.path);
}

/**
 * The address a fork into the wiki would get with no variant typed, asked by
 * the Fork dialog only while it is open, after a pause in typing.
 */
export async function previewWikiForkAddressAction(parentId: string, namespace: WikiNamespaceChoice, name: string): Promise<WikiAddressPreview> {
  const session = await auth();
  if (!session?.user) return { ok: false, error: "Sign in again to fork this doc." };
  return previewWikiForkAddress(actorFromSessionUser(session.user), {
    parentId,
    namespace: namespace === "commons" ? "commons" : "person",
    name,
  });
}

/** The address a move into the wiki would get with no variant typed, for the Move dialog. */
export async function previewWikiMoveAddressAction(namespace: WikiNamespaceChoice, name: string): Promise<WikiAddressPreview> {
  const session = await auth();
  if (!session?.user) return { ok: false, error: "Sign in again to move this doc." };
  return previewWikiMoveAddress(actorFromSessionUser(session.user), {
    namespace: namespace === "commons" ? "commons" : "person",
    name,
  });
}
