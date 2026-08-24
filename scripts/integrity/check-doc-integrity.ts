// Verifies that a Doc row's cached columns still agree with the ydoc they are
// cached from. A doc's ydoc is canonical (PLAN.md §3d/§12d, docs/YDOC.md is
// explicit that a doc's ydoc row IS the doc); `doc.title`, `doc.prose_json` and
// `doc.prose_json_length` are all derived copies, written by
// server/doc-cache.ts on the collab server's store debounce and by the
// doc_sync_prose_json_length trigger. Nothing re-derives them on read, so a
// copy that stops matching stays wrong until someone happens to open the doc.
//
// Scope, and why this is a separate script from check-ydoc-integrity.ts: that
// one asks whether `ydoc.ydoc` matches `ydoc_update` — the ydoc's internal
// consistency, upstream of anything here. This one takes the stored blob as
// given and asks whether the Doc columns match *it*. Together they cover the
// whole chain, one link each:
//
//     ydoc_update  →  ydoc.ydoc  →  doc.title / prose_json / prose_json_length
//     └─ check-ydoc-integrity ─┘    └────── check-doc-integrity ──────┘
//
// Comparing against the blob rather than a replay is deliberate: the blob is
// what a live editing session actually loads and what doc-cache actually reads,
// so it is the honest reference for "should the column look like this?". If the
// blob itself is wrong, that is the other script's finding to report, and
// duplicating it here would just double-count one fault.
//
// Usage:
//   npx tsx scripts/integrity/check-doc-integrity.ts             # every doc
//   npx tsx scripts/integrity/check-doc-integrity.ts --doc=<idOrSlug>
//   ... --verbose        also print docs that pass, and report ordinary
//                        debounce lag (see title-cache/body-cache below)
//
// Soft-deleted docs are checked too — a doc in the trash can be restored, and
// restoring one with a silently wrong body is exactly the failure worth
// catching early.
//
// Exits non-zero if any ERROR-level finding is reported, so it can gate a
// deploy or run from cron. WARN-level findings do not affect the exit code.
//
// WHAT IT CHECKS
//   1. title-cache   — Doc.title vs the ydoc's `title` fragment.
//      server/doc-cache.ts writes the fragment through on every store debounce,
//      deliberately including the empty case (§12n). So a ydoc with no title
//      fragment at all and a non-empty Doc.title is a title scheduled for
//      deletion the next time anyone opens the doc — a WARN, since nothing is
//      corrupt yet. An ordinary difference is only reported with --verbose.
//   2. body-cache    — Doc.proseJson vs the ydoc's `default` (body) fragment,
//      decoded exactly the way doc-cache decodes it (both call
//      docContentFromYdoc, so they cannot disagree about the derivation).
//      Two cases are reported without --verbose because they persist rather
//      than settle: a NULL prose_json behind a non-empty ydoc (the cache was
//      never written, so /docs reads the doc as 0 characters), and content in
//      prose_json behind an empty ydoc (the next store will wipe it).
//      Everything else is ordinary lag, --verbose only. A NULL prose_json
//      behind an *empty* ydoc is not a finding at all — that is the honest
//      state of a doc created but never edited.
//   3. length-cache  — Doc.proseJsonLength vs doc_length(prose_json). ERROR,
//      not WARN, and this is the asymmetry worth understanding: 1 and 2 compare
//      a cache against a *newer* source, so a mismatch is usually just debounce
//      lag and self-corrects. This one compares a column against a pure
//      function of another column in the same row — there is no lag to explain
//      it. The value is kept current by a trigger rather than a generated
//      column (add_doc_prose_json_length explains why), and a trigger can be
//      bypassed by DISABLE TRIGGER, a COPY, or a restore. Nothing self-corrects
//      that, so it fails loudly.
//
// RUNNING THIS WHILE PEOPLE ARE EDITING will show title/body differences that
// are not faults — the cache legitimately trails the ydoc by up to the store
// debounce. That is the whole reason those two default to --verbose-only for
// the ordinary case. length-cache is unaffected, since it never involves the
// ydoc at all.

import "dotenv/config";
import * as Y from "yjs";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { prismaIncludingDeleted as prisma } from "../../src/lib/prisma";
import { ydocIdForDoc } from "../../src/lib/ydoc-names";
import { docContentExtensions, titleAuthorHighlightExtensions } from "../../src/lib/tiptap-schema";
import { extractText } from "../../src/lib/diff";

type Level = "error" | "warn";
type Finding = { level: Level; docId: string; slug: string; check: string; detail: string };

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function truncate(s: string, n = 80): string {
  return s.length <= n ? s : `${s.slice(0, n)}…(${s.length} chars)`;
}

// Key-order-insensitive JSON comparison. Necessary rather than fastidious:
// prose_json comes back from Postgres as jsonb, which normalises key order and
// drops duplicates, while TiptapTransformer builds plain JS objects in
// insertion order. A literal JSON.stringify comparison of the two would report
// every single doc as drifted. Undefined-valued keys are dropped on both sides
// for the same reason — jsonb cannot represent them, so they are never a real
// difference.
function canonical(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, norm(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/** The doc's title as doc-cache would compute it, or null if there's no fragment at all. */
function titleTextOf(doc: Y.Doc): string | null {
  if (doc.getXmlFragment("title").length === 0) return null;
  try {
    return extractText(TiptapTransformer.extensions(titleAuthorHighlightExtensions).fromYdoc(doc, "title"));
  } catch {
    return null;
  }
}

async function main() {
  const docArg = arg("doc");
  const verbose = process.argv.includes("--verbose");

  // --doc= takes an id or a slug, since both are things you have in hand (a
  // slug from a URL, an id from another script's output).
  const docs = await prisma.doc.findMany({
    where: docArg ? { OR: [{ id: docArg }, { slug: docArg }] } : undefined,
    orderBy: { id: "asc" },
    select: { id: true, slug: true, title: true, proseJson: true, proseJsonLength: true, deletedAt: true },
  });

  if (docs.length === 0) {
    console.log(docArg ? `\nNo doc matching ${JSON.stringify(docArg)}.\n` : "\nNo docs at all.\n");
    return 0;
  }

  console.log(`\nChecking ${docs.length} doc(s)...\n`);

  const findings: Finding[] = [];
  let passed = 0;

  for (const doc of docs) {
    const before = findings.length;
    const ydocRow = await prisma.ydoc.findUnique({
      where: { id: ydocIdForDoc(doc.id) },
      select: { ydoc: true },
    });

    // No ydoc row is normal for a doc created but never opened —
    // ydocOnLoadDocument creates it on first connect. It is only notable if
    // the doc already has cached content, which would then have no source.
    if (!ydocRow) {
      if (doc.title !== "" || doc.proseJson !== null) {
        findings.push({
          level: "warn",
          docId: doc.id,
          slug: doc.slug,
          check: "no-ydoc",
          detail:
            "no ydoc row, but the doc has cached title/prose_json — the cache has nothing behind it, and " +
            "opening the doc will seed an empty ydoc and then overwrite both.",
        });
      } else if (verbose) {
        console.log(`  OK    ${doc.id}  (no ydoc row yet, no cached content — never opened)`);
      }
      if (findings.length === before) passed += 1;
      continue;
    }

    const ydoc = new Y.Doc();
    try {
      Y.applyUpdate(ydoc, new Uint8Array(ydocRow.ydoc));
    } catch (err) {
      findings.push({
        level: "error",
        docId: doc.id,
        slug: doc.slug,
        check: "blob-decode",
        detail:
          `ydoc.ydoc is not a valid Yjs update: ${err instanceof Error ? err.message : String(err)} — ` +
          "run check-ydoc-integrity.ts, which owns this failure.",
      });
      ydoc.destroy();
      continue;
    }

    // --- 1. title-cache ---------------------------------------------------
    const fragmentTitle = titleTextOf(ydoc);
    if (fragmentTitle === null && doc.title !== "") {
      findings.push({
        level: "warn",
        docId: doc.id,
        slug: doc.slug,
        check: "title-cache",
        detail:
          `ydoc has no title fragment but Doc.title is ${JSON.stringify(doc.title)} — ` +
          "server/doc-cache.ts will overwrite it with an empty string on the next store debounce.",
      });
    } else if (fragmentTitle !== null && fragmentTitle !== doc.title && verbose) {
      findings.push({
        level: "warn",
        docId: doc.id,
        slug: doc.slug,
        check: "title-cache",
        detail:
          `Doc.title ${JSON.stringify(doc.title)} is stale against the ydoc's ` +
          `${JSON.stringify(fragmentTitle)} — the cache self-corrects on the next store.`,
      });
    }

    // --- 2. body-cache ----------------------------------------------------
    // docContentExtensions, matching server/doc-cache.ts exactly: it is the
    // doc-side schema that includes the annotation mark, and decoding with a
    // narrower set would silently drop marks and report drift that isn't there
    // (docs/TIPTAP.md's note on picking the wrong schema variant).
    let bodyJSON: unknown;
    let bodyDecodeError: string | null = null;
    try {
      bodyJSON = TiptapTransformer.extensions(docContentExtensions).fromYdoc(ydoc, "default");
    } catch (err) {
      bodyDecodeError = err instanceof Error ? err.message : String(err);
    }

    const ydocBodyEmpty = ydoc.getXmlFragment("default").length === 0;

    // Order matters: equality is tested *before* the two shape-based cases,
    // because "cached empty body behind an empty ydoc" is agreement, not
    // drift. Testing nullness first instead reported every freshly created
    // doc as about to be wiped — every doc creator now writes the cache at
    // creation, so an empty doc legitimately has an empty cached body rather
    // than a NULL one.
    if (bodyDecodeError !== null) {
      findings.push({
        level: "warn",
        docId: doc.id,
        slug: doc.slug,
        check: "body-cache",
        detail:
          `the ydoc's body fragment isn't TipTap-decodable (${bodyDecodeError}) — doc-cache logs the same and ` +
          "leaves prose_json unchanged, so this doc's cache is frozen wherever it was.",
      });
    } else if (doc.proseJson === null) {
      // NULL with an empty ydoc is the honest state of a doc created but never
      // edited: there is nothing to cache yet, so nothing is wrong.
      if (!ydocBodyEmpty) {
        findings.push({
          level: "warn",
          docId: doc.id,
          slug: doc.slug,
          check: "body-cache",
          detail:
            "prose_json is NULL but the ydoc has body content — the store debounce has never written this " +
            "doc's cache, so /docs reads it as 0 characters until someone opens it.",
        });
      }
    } else if (canonical(doc.proseJson) !== canonical(bodyJSON)) {
      if (ydocBodyEmpty) {
        findings.push({
          level: "warn",
          docId: doc.id,
          slug: doc.slug,
          check: "body-cache",
          detail:
            `prose_json holds ${doc.proseJsonLength} character(s) but the ydoc's body fragment is empty — ` +
            "the next store debounce will replace it with an empty document.",
        });
      } else if (verbose) {
        findings.push({
          level: "warn",
          docId: doc.id,
          slug: doc.slug,
          check: "body-cache",
          detail:
            "prose_json is stale against the ydoc's body — the cache self-corrects on the next store.\n" +
            `        cached: ${truncate(canonical(doc.proseJson))}\n` +
            `        ydoc:   ${truncate(canonical(bodyJSON))}`,
        });
      }
    }

    ydoc.destroy();

    if (findings.length === before) {
      passed += 1;
      if (verbose) console.log(`  OK    ${doc.id}  (/doc/${doc.slug}${doc.deletedAt ? ", deleted" : ""})`);
    }
  }

  // --- 3. length-cache ------------------------------------------------------
  // One query for the whole table rather than per doc: it compares a column
  // against a pure function of another column in the same row, so it needs no
  // ydoc and shouldn't be paid once per document. It ignores --doc
  // deliberately — a bulk rewrite is exactly the case where you are checking
  // one document and want to know the rest drifted too — which is why its
  // result is printed on its own line rather than folded into the per-doc
  // tally above.
  const lengthDrift = await prisma.$queryRaw<{ id: string; slug: string; stored: number; actual: number }[]>`
    SELECT id, slug, prose_json_length AS stored, doc_length(prose_json) AS actual
    FROM doc
    WHERE prose_json_length IS DISTINCT FROM doc_length(prose_json)
    ORDER BY id
  `;
  for (const d of lengthDrift) {
    findings.push({
      level: "error",
      docId: d.id,
      slug: d.slug,
      check: "length-cache",
      detail:
        `Doc.proseJsonLength is ${d.stored} but doc_length(prose_json) is ${d.actual} — the trigger was ` +
        `bypassed for this row. Repair by re-firing it with a no-op write: ` +
        `UPDATE doc SET prose_json = prose_json WHERE id = '${d.id}';`,
    });
  }
  console.log(
    lengthDrift.length === 0
      ? "  OK    length-cache  (whole table: every Doc.proseJsonLength agrees with its body)\n"
      : `  FAIL  length-cache  (whole table: ${lengthDrift.length} doc(s) drifted)\n`,
  );

  const errors = findings.filter((f) => f.level === "error");
  const warnings = findings.filter((f) => f.level === "warn");

  for (const f of findings) {
    console.log(`  ${f.level === "error" ? "FAIL" : "WARN"}  ${f.docId}  (/doc/${f.slug})`);
    console.log(`        [${f.check}] ${f.detail}`);
  }

  console.log(`\n${docs.length} checked — ${passed} clean, ${errors.length} error(s), ${warnings.length} warning(s).`);
  if (!verbose && errors.length === 0 && warnings.length === 0) {
    console.log("Ordinary debounce lag is not reported without --verbose.");
  }
  console.log("");

  return errors.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
