import { cache } from "react";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";

// The envelope every per-viewer-gated page shares, and nothing else.
//
// **Why this exists at all: `generateMetadata` is evaluated independently of
// the page body.** Nothing the body does reaches back, so a route whose title
// comes from gated data cannot lean on the body's own check — a bare
// `doc.title` in `generateMetadata` would put a PRIVATE doc's title in the tab
// of the very viewer the body answers with "Forbidden" (docs/PERMISSIONS.md).
// Writing the gate a second time inside `generateMetadata` closes that, but
// leaves two copies free to drift apart, with the metadata copy being the one
// no test looks at. So both callers go through one loader, and `titleWhenOk`
// below is what turns "don't leak a gated title" from a convention every route
// has to remember into a signature that cannot express the mistake.
//
// **What is shared is the envelope, never the gate** — the same split
// src/lib/anchors/ makes between a target arc and a selector. Each route keeps
// its own select, its own resolver and its own permission rule in its own
// file, because those are three entities (Doc, StoredFile, Post), two
// resolvers and four different rules; a module that tried to own them would be
// a place for a check to end up attached to the wrong thing. Nothing
// entity-specific belongs in here.
//
// Server-only by construction (it calls `auth()`), in the sense avatar.ts is —
// there is no `server-only` package in this project to say so with.

export type Access<T> =
  | { status: "signed-out" }
  | { status: "not-found" }
  /** Resolved to a different canonical URL — an old slug, say. */
  | { status: "redirect"; to: string }
  | { status: "forbidden" }
  | { status: "ok"; value: T; user: Session["user"] };

/** What a route's own `load` returns when it has no value to hand back. */
export type AccessRejection = "not-found" | "forbidden" | { redirect: string };

/**
 * Wraps a route's own resolve-and-gate in the session preamble and a
 * per-request memo, so `generateMetadata` and the page body share one pass
 * instead of running the whole thing twice.
 *
 * `cache()` here is React's **per-request** memo, not a data cache: it dedupes
 * within one render pass and nothing survives it, so a route using this stays
 * exactly as dynamic and as uncached as it was. Measured on /doc/[slug] — the
 * loader body runs once for a request that calls it twice, saving one whole
 * `resolveDocParam` (which is two queries, id-then-slug).
 *
 * Call it once at module scope per route: the memo lives on the function it
 * returns, and it keys on **all** arguments, which is what lets a two-document
 * route (/side-by-side) use the same envelope as a one-document one.
 *
 * `T extends object` is what makes the string rejections unambiguous — a route
 * whose value were itself a string could not be told apart from "forbidden".
 */
export function gated<A extends unknown[], T extends object>(
  load: (user: Session["user"], ...args: A) => Promise<T | AccessRejection>,
): (...args: A) => Promise<Access<T>> {
  return cache(async (...args: A): Promise<Access<T>> => {
    const session = await auth();
    if (!session?.user) {
      return { status: "signed-out" };
    }
    const result = await load(session.user, ...args);
    // Checked one at a time, and returning the literal rather than `result`:
    // with a generic T, TypeScript cannot prove `Awaited<T>` isn't itself the
    // string, so a combined test leaves the union unnarrowed.
    if (result === "not-found") {
      return { status: "not-found" };
    }
    if (result === "forbidden") {
      return { status: "forbidden" };
    }
    if ("redirect" in result && typeof result.redirect === "string") {
      return { status: "redirect", to: result.redirect };
    }
    return { status: "ok", value: result as T, user: session.user };
  });
}

/**
 * The only supported way to get a title out of an `Access`. Anything short of
 * "ok" yields `{}`, which falls back to the root layout's SITE_TITLE — what
 * someone who may not read this thing should see in their tab.
 *
 * Deliberately not a general-purpose `isOk()`: taking the title *function*
 * rather than returning the value is what stops a call site from unwrapping
 * the access and building a title beside the check rather than behind it.
 */
export function titleWhenOk<T>(access: Access<T>, title: (value: T) => string): { title?: string } {
  return access.status === "ok" ? { title: title(access.value) } : {};
}
