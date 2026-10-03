// Import a claude.ai data export's conversations as docs. Each session becomes
// Markdown, and its doc is created as /docs' own "Import Markdown" creates one
// (docs/DOC_IMPORT.md): the same parse, then the same createDocWithContent
// (src/lib/doc-create.ts) for the ydoc seeding, the row and the slug — called
// directly, as the importing account, with no web server involved.
//
// Then, per doc:
//   - the byline becomes BYLINE_EMAILS in that order (what updateDocAuthor +
//     updateDocAuthorOrder would leave);
//   - createdAt/updatedAt become the session's first and last message activity.
//     The export's times are UTC, and so are these columns (Prisma writes UTC);
//     the tables render them in local time (src/lib/format-date.ts), so no
//     timezone shift happens here — one would be applied twice.
//
// A session whose claude.ai link already heads a doc is not imported again, so a
// re-run, or an older export overlapping this one, doesn't duplicate anything.
// Instead it is compared with that doc, and one that differs — a session that
// has grown since, say — is listed, or with --update edited in place. Never
// replaced: other docs' anchored links point into these docs, and deleting one
// deletes those anchors.
// A session with no text at all is skipped — the export has some whose
// messages are empty.
//
// Usage:
//   npx tsx scripts/import-claude-chats.ts --export <conversations.json> [--frames <dir>] [--out <dir>]
//     [--dry-run | --update | --plan] [<uuid>...]
//   npx tsx scripts/import-claude-chats.ts --markdown [--update | --plan] <file.md>...
// No uuids means every conversation. --dry-run writes <out>/<uuid>.md and stops.
// --update also updates differing docs in place (see "In-place update" below),
// through the running collab server. --plan says what --update would do and
// writes nothing.
// --frames is the export's frames-000.zip, unzipped: a Claude Docs document a
// session made (artifacts/<id>/page.md) goes into that session's doc.
//
// --markdown takes Markdown files instead — an analysis or a summary written
// elsewhere — and gives each the same treatment as a session: imported once,
// then compared, and with --update edited in place. A file is matched to its
// doc by title (see markdownSources), and its doc keeps the dates the import
// gives it, since a file has no activity to date it by.
// Env: MB_EMAIL (the importing account, default the Claude one; it needs
// canManageDocs), BYLINE_EMAILS (comma-separated), HUMAN_NAME. --update writes
// through the collab server, so that has to be running for it; nothing else
// does.
//
// Against a deployed instance, run this in that instance's checkout: the
// database, the collab port and the token secret all come from its .env.

import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as Y from "yjs";
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { prisma } from "../src/lib/prisma";
import type { Prisma } from "../src/generated/prisma/client";
import type { Role } from "../src/generated/prisma/enums";
import { markdownToDocContent, MAX_MARKDOWN_BYTES } from "../src/lib/markdown-import";
import { createDocWithContent } from "../src/lib/doc-create";
import { canManageDocs } from "../src/lib/role-checks";
import { contentExtensions, docContentExtensions, pmDocContentSchema } from "../src/lib/tiptap-schema";
import { docContentFromYdoc } from "../src/lib/doc-content";
import { ydocIdForDoc, DOC_APPLY_UPDATE_PATH } from "../src/lib/ydoc-names";
import { signYdocToken } from "../src/lib/ydoc-token";
import { collabHttpOrigin } from "../src/lib/collab-http-origin";
import { captureAnchorInYdoc } from "../src/lib/anchors/capture";
import { ydocStore, UNAVAILABLE } from "../server/ydoc-store";

type Block = {
  type: string;
  text?: string;
  title?: string;
  name?: string;
  input?: {
    query?: string;
    url?: string;
    type?: string;
    title?: string;
    content?: string;
    md_citations?: { end_index?: number; url?: string }[];
  };
  content?: unknown;
  citations?: { end_index?: number; details?: { url?: string } }[];
  start_timestamp?: string | null;
  stop_timestamp?: string | null;
};
type Message = {
  uuid: string;
  sender: "human" | "assistant";
  content: Block[];
  created_at: string;
  updated_at: string;
  parent_message_uuid: string;
  attachments?: { file_name: string; extracted_content?: string }[];
  files?: ({ file_name: string | null } | null)[];
};
type Conversation = { uuid: string; name: string; created_at: string; updated_at: string; chat_messages: Message[] };

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
const exportPath = flag("--export");
const outDir = flag("--out");
const framesDir = flag("--frames");
const dryRun = args.includes("--dry-run");
const plan = args.includes("--plan");
const update = plan || args.includes("--update");
const markdownMode = args.includes("--markdown");
// Session uuids, or with --markdown the files.
const ids = args.filter((a) => !["--dry-run", "--plan", "--update", "--markdown"].includes(a));
if (markdownMode ? exportPath || framesDir || outDir || dryRun || !ids.length : !exportPath || (dryRun && !outDir)) {
  console.error(
    [
      "Usage: npx tsx scripts/import-claude-chats.ts --export <conversations.json> [--frames <dir>] [--out <dir>] [--dry-run | --update | --plan] [<uuid>...]",
      "       npx tsx scripts/import-claude-chats.ts --markdown [--update | --plan] <file.md>...",
    ].join("\n"),
  );
  process.exit(1);
}

const IMPORTER_EMAIL = process.env.MB_EMAIL || "claude@multiblog.invalid";
const BYLINE_EMAILS = (process.env.BYLINE_EMAILS || "labreuer@gmail.com,claude@multiblog.invalid").split(",");
const HUMAN = process.env.HUMAN_NAME || "Luke Breuer";
const ASSISTANT = "Claude";
const chatUrl = (uuid: string) => `https://claude.ai/chat/${uuid}`;

// ---------------------------------------------------------------- Markdown

// For text that is plain rather than Markdown (a quoted excerpt, a file name, a
// search query): every character that means something to Markdown is escaped,
// so the doc shows exactly that text.
const escapeInline = (s: string) => s.replace(/[\\`*_[\]<>#~|$&]/g, "\\$&");

function escapeLine(line: string): string {
  return escapeInline(line.trim())
    .replace(/^([-+=])/, "\\$1")
    .replace(/^(\d+)([.)])/, "$1\\$2");
}

// Blank lines separate paragraphs; a single newline stays a line break
// (backslash-newline is CommonMark's hard break).
function plainToMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n\s*\n/)
    .map((para) => para.split("\n").map(escapeLine).filter(Boolean).join("\\\n"))
    .filter(Boolean)
    .join("\n\n");
}

// Applies fn to every line outside fenced code; fences and their contents pass
// through. A fence can be indented any amount, or sit in a blockquote — Claude
// nests them in list items.
const FENCE = /^(?:\s*>)*\s*(`{3,}|~{3,})/;
function mapOutsideFences(md: string, fn: (line: string, next: string | undefined) => string): string {
  let fence: string | null = null;
  const lines = md.split("\n");
  return lines
    .map((line, i) => {
      const f = line.match(FENCE);
      if (f) {
        if (!fence) fence = f[1];
        else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^(?:\s*>)*\s*[`~]+\s*$/.test(line)) fence = null;
        return line;
      }
      return fence ? line : fn(line, lines[i + 1]);
    })
    .join("\n");
}

// Headings drop two levels so they nest under the "## Claude" / "## <human>"
// turn heading.
function demoteHeadings(md: string, by = 2): string {
  return mapOutsideFences(md, (line) =>
    line.replace(/^( {0,3})(#{1,6})(?=\s|$)/, (_, sp: string, h: string) => sp + "#".repeat(Math.min(6, h.length + by))),
  );
}

// Markdown as claude.ai shows it, for prompts and Claude's text alike: a single
// newline is a line break, where CommonMark would run the lines together. So a
// line followed by another gets the two-space hard break, unless there is
// nothing for a break to separate: the next line starts a block of its own
// (any list item, a heading, a fence), the line is one that can't end in a
// break (a heading, a table row, a rule), or the next line
// opens a deeper blockquote. (An unquoted line after a quoted one continues the
// quote, lazily, so it still gets the break.) Where that misses, the newline
// stays a soft break, which is what CommonMark would have made of it anyway.
// A line ending in a backslash gets the two spaces too, which keeps the
// backslash as text (a Windows path) instead of letting it become the break.
//
// A tag-like "<name" is escaped. The import shows HTML as literal text anyway
// (docs/DOC_IMPORT.md §3), but as an HTML token it also swallows the line breaks
// around it — which is what XML-ish text, like the review-comments block
// claude.ai sends for comments on a document, is made of. Autolinks
// (<https://…>) and code spans are left alone.
const TAG_START = /(`+).*?\1|<(?![a-z][a-z0-9+.-]*:|[^\s<>@]+@)(?=[a-z/!?])/gi;
const QUOTE = /^(?:\s*>)*\s*/;
const quoteDepth = (line: string) => (line.match(QUOTE)![0].match(/>/g) ?? []).length;
const BLOCK_START = /^([-+*]\s|\d{1,9}[.)]\s|#{1,6}(\s|$)|`{3}|~{3})/;
const NO_BREAK_AFTER = /^(#{1,6}(\s|$)|\||([-*_])(\s*\3){2,}\s*$)/;

function withLineBreaks(text: string): string {
  const md = text.replace(/\r\n?/g, "\n").trim();
  return demoteHeadings(
    mapOutsideFences(md, (line, next) => {
      const escaped = line.replace(TAG_START, (m) => (m.startsWith("`") ? m : "\\<"));
      if (next === undefined) return escaped;
      const here = line.replace(QUOTE, "").trimEnd();
      const there = next.replace(QUOTE, "");
      const breaks =
        here &&
        there.trim() &&
        quoteDepth(next) <= quoteDepth(line) &&
        !NO_BREAK_AFTER.test(here) &&
        !BLOCK_START.test(there);
      return breaks ? escaped.replace(/\s+$/, "") + "  " : escaped;
    }),
  );
}

const safeUrl = (u: string) => u.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
const link = (text: string, url: string) => `[${escapeInline(text)}](${safeUrl(url)})`;
const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

// The branch claude.ai shows: from the most recently created leaf back to the root.
function currentBranch(messages: Message[]): Message[] {
  const byId = new Map(messages.map((m) => [m.uuid, m]));
  const parents = new Set(messages.map((m) => m.parent_message_uuid));
  const leaves = messages.filter((m) => !parents.has(m.uuid)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const path: Message[] = [];
  for (let m = leaves.at(-1); m; m = byId.get(m.parent_message_uuid)) path.push(m);
  return path.reverse();
}

const textOf = (m: Message) =>
  m.content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n\n");

function humanTurn(m: Message): string[] {
  const parts: string[] = [];
  const seen = new Set<string>();
  const attached = (name: string) => {
    if (!seen.has(name)) parts.push(`*Attached: ${escapeInline(name)}*`);
    seen.add(name);
  };
  for (const a of m.attachments ?? []) {
    if (a.file_name.startsWith("excerpt_from_previous_claude_message") && a.extracted_content) {
      parts.push(plainToMarkdown(a.extracted_content).replace(/^/gm, "> "));
      seen.add(a.file_name);
    } else {
      attached(a.file_name);
    }
  }
  for (const f of m.files ?? []) if (f?.file_name) attached(f.file_name);
  for (const p of m.content) if (p.type === "document" && p.title) attached(p.title);
  const text = textOf(m);
  if (text.trim()) parts.push(withLineBreaks(text));
  return parts;
}

// Claude Docs documents from the frames export, by artifact id. page.md wraps
// the document in an "# Untitled" heading and a tab marker (an HTML comment,
// which the import would keep as literal text), and writes the byline's
// mention of the user as "@someone".
function loadDocsPages(dir: string): Map<string, string> {
  const pages = new Map<string, string>();
  const root = join(dir, "artifacts");
  for (const id of readdirSync(root)) {
    const file = join(root, id, "page.md");
    if (!existsSync(file)) continue;
    const md = readFileSync(file, "utf8")
      .replace(/^# Untitled\s*\n+(?=<!-- tab:)/, "")
      .replace(/^<!-- tab: .*? -->[ \t]*$/gm, "")
      .replace(/(^|\s)@someone\b/g, `$1${HUMAN}`)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    pages.set(id, md);
  }
  return pages;
}
const docsPages = framesDir ? loadDocsPages(framesDir) : new Map<string, string>();

// `placed` is per conversation: a document goes in once, at the end of the
// first Claude turn whose tool calls name it — the turn that wrote it.
// A cited span gets its sources right after it, where claude.ai draws its
// chips: " ([ccel.org](…), [newadvent.org](…))". The citations are offsets
// into the raw text, so this runs before anything trims or rewrites it. An end
// point that falls mid-word or between emphasis delimiters (a handful do)
// moves to the end of the word or the delimiter run.
const domainOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return shortUrl(url);
  }
};

function withInlineCitations(text: string, cites: { end?: number; url?: string }[]): string {
  const at = new Map<number, string[]>();
  for (const c of cites) {
    if (c.end === undefined || !c.url) continue;
    let e = Math.min(c.end, text.length);
    while (e < text.length && /\w/.test(text[e - 1] ?? "") && /\w/.test(text[e])) e++;
    while (e < text.length && /[*_]/.test(text[e - 1] ?? "") && /[*_]/.test(text[e])) e++;
    const urls = at.get(e) ?? [];
    if (!urls.includes(c.url)) urls.push(c.url);
    at.set(e, urls);
  }
  let out = text;
  for (const e of [...at.keys()].sort((a, b) => b - a)) {
    const chip = ` (${at.get(e)!.map((u) => link(domainOf(u), u)).join(", ")})`;
    out = out.slice(0, e) + chip + out.slice(e);
  }
  return out;
}

function assistantTurn(m: Message, placed: Set<string>): string[] {
  const parts: string[] = [];

  // Consecutive web searches/fetches collapse into one italic line. A Markdown
  // artifact (a research report) goes in whole, where it was created. Other
  // tools (memory, bash, files) are left out, as is thinking.
  let searches: string[] = [];
  let fetches: string[] = [];
  const flushTools = () => {
    const bits: string[] = [];
    if (searches.length) bits.push(`Searched the web for ${searches.map((q) => `“${escapeInline(q)}”`).join(", ")}`);
    if (fetches.length) bits.push(`${bits.length ? "fetched" : "Fetched"} ${fetches.map((u) => link(shortUrl(u), u)).join(", ")}`);
    if (bits.length) parts.push(`*${bits.join("; ")}*`);
    searches = [];
    fetches = [];
  };

  for (const p of m.content) {
    if (p.type === "tool_use") {
      if (p.name?.startsWith("web_search") && p.input?.query) searches.push(p.input.query);
      else if (p.name === "web_fetch" && p.input?.url) fetches.push(p.input.url);
      else if (p.name === "artifacts" && p.input?.type === "text/markdown" && p.input.content?.trim()) {
        flushTools();
        // Its sources are kept beside the text, as md_citations.
        const cites = (p.input.md_citations ?? []).map((c) => ({ end: c.end_index, url: c.url }));
        const body = withInlineCitations(p.input.content, cites).trim();
        // Its own leading heading becomes the section heading; failing one, its title does.
        if (!/^#{1,6}\s/.test(body) && p.input.title) parts.push(`### ${escapeInline(p.input.title)}`);
        parts.push(withLineBreaks(body));
      }
    } else if (p.type === "text" && p.text?.trim()) {
      flushTools();
      const cites = (p.citations ?? []).map((c) => ({ end: c.end_index, url: c.details?.url }));
      parts.push(withLineBreaks(withInlineCitations(p.text, cites)));
    }
  }
  flushTools();

  const raw = JSON.stringify(m.content);
  for (const [id, page] of docsPages) {
    if (placed.has(id) || !raw.includes(id)) continue;
    parts.push(withLineBreaks(page));
    placed.add(id);
  }
  return parts;
}

// An unnamed session is titled by its first prompt's opening, which is what
// it's recognisable by; failing that, "Untitled chat".
// Names can hold line breaks ("💬 Roy Bhaskar writes:\n\n> …"), which a heading can't.
function titleFor(conv: Conversation, branch: Message[]): string {
  const name = conv.name.replace(/\s+/g, " ").trim();
  if (name) return name;
  const first = branch.map(textOf).find((t) => t.trim());
  if (!first) return "Untitled chat";
  const line = first.trim().split("\n")[0];
  return line.length <= 80 ? line : line.slice(0, 80).replace(/\s+\S*$/, "") + "…";
}

// Null for a session with nothing in it to show.
function conversationToMarkdown(conv: Conversation): string | null {
  const url = chatUrl(conv.uuid);
  const branch = currentBranch(conv.chat_messages);
  const blocks = [`# ${escapeInline(titleFor(conv, branch))}`, `[${url}](${url})`];
  const placed = new Set<string>();
  let turns = 0;
  for (const m of branch) {
    const human = m.sender === "human";
    const body = human ? humanTurn(m) : assistantTurn(m, placed);
    if (!body.length) continue;
    blocks.push(`## ${human ? HUMAN : ASSISTANT}`, ...body);
    turns++;
  }
  return turns ? blocks.join("\n\n") + "\n" : null;
}

// First and last activity: every timestamp on the messages and their blocks.
// Not the conversation's own updated_at, which moves without any message
// changing (renames and the like) — up to weeks after the last one.
type Span = { first: Date; last: Date };
function activitySpan(conv: Conversation): Span {
  const stamps: string[] = [];
  for (const m of conv.chat_messages) {
    stamps.push(m.created_at, m.updated_at);
    for (const p of m.content) {
      if (p.start_timestamp) stamps.push(p.start_timestamp);
      if (p.stop_timestamp) stamps.push(p.stop_timestamp);
    }
  }
  if (!stamps.length) stamps.push(conv.created_at, conv.updated_at); // a session with no messages
  const ms = stamps.filter(Boolean).map((s) => Date.parse(s));
  return { first: new Date(Math.min(...ms)), last: new Date(Math.max(...ms)) };
}

// ------------------------------------------------------------------- Import

// The importing account: docs are created as it, and an update is written as
// it — its token is who the collab server attributes the new blocks to.
let account: { id: string; role: Role } | null = null;
async function importingAccount() {
  account ??= await prisma.user.findUniqueOrThrow({ where: { email: IMPORTER_EMAIL }, select: { id: true, role: true } });
  return account;
}

// Looked up on the first import: whether the importing account may create docs
// at all — the check /docs' import action makes on its session, since
// createDocWithContent makes none — and the byline's accounts.
let byline: string[] | null = null;
async function bylineForImports(): Promise<string[]> {
  if (byline) return byline;
  const { role } = await importingAccount();
  if (!canManageDocs(role)) throw new Error(`${IMPORTER_EMAIL} is ${role}, which can't create docs`);
  const database = new URL(process.env.DATABASE_URL!).pathname.slice(1);
  console.log(`importing into ${database} as ${IMPORTER_EMAIL} (${role})`);
  const users = await prisma.user.findMany({ where: { email: { in: BYLINE_EMAILS } }, select: { id: true, email: true } });
  byline = BYLINE_EMAILS.map((e) => {
    const u = users.find((x) => x.email === e);
    if (!u) throw new Error(`no user ${e}`);
    return u.id;
  });
  return byline;
}

// Creates the doc as /docs' import action would, under the same size limit,
// then sets its byline and dates; returns its slug. The action's
// revalidatePath("/docs") has no equivalent here and needs none: /docs reads
// the session, so it renders per request.
async function importDoc(md: string, span?: Span): Promise<string> {
  const bytes = Buffer.byteLength(md, "utf8");
  if (bytes > MAX_MARKDOWN_BYTES) {
    throw new Error(`${Math.round(bytes / 1024)} KB is over the import limit of ${Math.round(MAX_MARKDOWN_BYTES / 1024)} KB`);
  }
  const bylineIds = await bylineForImports();
  const { id: userId } = await importingAccount();
  const { title, body } = markdownToDocContent(md);
  const doc = await createDocWithContent(userId, title ?? "", body);
  await finishDoc(doc.id, bylineIds, span);
  return doc.slug;
}

// The byline, and for a session the dates; a file's doc keeps the import's.
async function finishDoc(docId: string, bylineIds: string[], span?: Span) {
  await prisma.$transaction([
    ...bylineIds.map((userId, bylineOrder) =>
      prisma.docAuthor.upsert({
        where: { docId_userId: { docId, userId } },
        create: { docId, userId, bylineOrder },
        update: { bylineOrder },
      }),
    ),
    // Last, and with updatedAt named explicitly, so @updatedAt doesn't stamp now().
    ...(span ? [prisma.doc.update({ where: { id: docId }, data: { createdAt: span.first, updatedAt: span.last } })] : []),
  ]);
}

// What an import of this Markdown would store: the parse, then the same Yjs
// round trip, so the attribute defaults it fills in match the stored cache.
// The ydoc is returned too, for the in-place update to copy blocks from.
function importedDoc(md: string): { title: string; body: JSONContent; ydoc: Y.Doc } {
  const { title, body } = markdownToDocContent(md);
  const ydoc = TiptapTransformer.toYdoc(body, "default", contentExtensions);
  return { title: title ?? "", body: docContentFromYdoc(ydoc).proseJson, ydoc };
}

// JSON equality regardless of key order — jsonb doesn't keep it.
function canonical(v: unknown): string {
  const canon = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(canon)
      : x && typeof x === "object"
        ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon((x as Record<string, unknown>)[k])]))
        : x;
  return JSON.stringify(canon(v));
}

// ------------------------------------------------------------ In-place update
//
// A doc that differs from its session is updated in place rather than
// re-imported, because re-importing deletes the doc and with it every anchor
// other docs hold into it (anchored_link_anchor cascades).
//
// The stored doc and a fresh conversion of the session are aligned block by
// block. Blocks that are the same stay exactly as they are in the ydoc, Yjs
// identity and all; each run of blocks that differs is replaced by the
// conversion's, as one Yjs update the collab server applies to the live doc
// (/admin/doc-apply-update), so anyone with it open sees the edit arrive.
// The plan is made against the stored checkpoint, and the server refuses the
// update if the live doc has moved past it. An anchor in an unchanged block
// just moves with it. An anchor in a replaced run moves only
// if the run's positions still line up one for one — its text the same, with
// at most a newline become a line break, which is one position either way;
// otherwise the doc is reported and left alone rather than the anchor guessed.

type Plan = {
  docId: string;
  ydoc: Y.Doc;
  before: Uint8Array; // the stored state vector: what the update is built on
  anchors: { id: string; from: number; to: number; quotedText: string }[];
  blocksChanged: number;
};

// Longest common subsequence of two block lists by canonical JSON; returns the
// edit script in document order.
type Step = { kind: "keep"; a: number; b: number } | { kind: "del"; a: number } | { kind: "add"; b: number };
function alignBlocks(a: string[], b: string[]): Step[] {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) steps.push({ kind: "keep", a: i++, b: j++ });
    else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) steps.push({ kind: "add", b: j++ });
    else steps.push({ kind: "del", a: i++ });
  }
  return steps;
}

// One token per document position, so two runs of blocks line up position for
// position exactly when their token lists are equal. A newline inside text and
// a hard break are the same token: each takes one position.
function positionTokens(nodes: PMNode[]): string[] {
  const out: string[] = [];
  const walk = (n: PMNode) => {
    if (n.isText) for (const ch of n.text!) out.push(ch);
    else if (n.isLeaf) out.push(n.type.name === "hardBreak" ? "\n" : `<${n.type.name}/>`);
    else {
      out.push(`<${n.type.name}>`);
      n.forEach(walk);
      out.push(`</${n.type.name}>`);
    }
  };
  nodes.forEach(walk);
  return out;
}

// Stored-doc position → new-doc position, per stretch of the document.
type Stretch = { aFrom: number; aTo: number; bFrom: number; aligned: boolean };

async function planInPlace(docId: string, docTitle: string, md: string): Promise<Plan | string> {
  const ydocId = ydocIdForDoc(docId);
  const loaded = await ydocStore.load(ydocId);
  if (!loaded || loaded === UNAVAILABLE) return "its ydoc couldn't be loaded";
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, loaded.ydoc);
  const before = Y.encodeStateVector(ydoc);

  const schema = pmDocContentSchema;
  const A = schema.nodeFromJSON(docContentFromYdoc(ydoc).proseJson);
  const fresh = importedDoc(md);
  const C = schema.nodeFromJSON(fresh.body);
  if (fresh.title !== docTitle) return `its title differs (${JSON.stringify(fresh.title)})`;

  const keysOf = (n: PMNode) => Array.from({ length: n.childCount }, (_, i) => canonical(n.child(i).toJSON()));
  const steps = alignBlocks(keysOf(A), keysOf(C));

  // Stretches: each kept block, and each maximal run of removed and added
  // blocks between them.
  const stretches: Stretch[] = [];
  let aPos = 0;
  let bPos = 0;
  for (let s = 0; s < steps.length; ) {
    const step = steps[s];
    if (step.kind === "keep") {
      const size = A.child(step.a).nodeSize;
      stretches.push({ aFrom: aPos, aTo: aPos + size, bFrom: bPos, aligned: true });
      aPos += size;
      bPos += size;
      s++;
      continue;
    }
    const removed: PMNode[] = [];
    const added: PMNode[] = [];
    for (; s < steps.length && steps[s].kind !== "keep"; s++) {
      const r = steps[s];
      if (r.kind === "del") removed.push(A.child(r.a));
      else if (r.kind === "add") added.push(C.child(r.b));
    }
    const aSize = removed.reduce((n, x) => n + x.nodeSize, 0);
    const bSize = added.reduce((n, x) => n + x.nodeSize, 0);
    const aligned = aSize === bSize && positionTokens(removed).join("\u0000") === positionTokens(added).join("\u0000");
    stretches.push({ aFrom: aPos, aTo: aPos + aSize, bFrom: bPos, aligned });
    aPos += aSize;
    bPos += bSize;
  }
  // assoc 1: a position on a stretch boundary belongs to the later stretch
  // (an anchor's start); -1: to the earlier one (its end).
  const map = (pos: number, assoc: 1 | -1): number | null => {
    const hit = stretches.find((t) => (assoc === 1 ? pos >= t.aFrom && pos < t.aTo : pos > t.aFrom && pos <= t.aTo));
    return hit && hit.aligned ? hit.bFrom + (pos - hit.aFrom) : null;
  };

  // The ydoc: drop the stored blocks that go, then copy in the conversion's.
  const fragment = ydoc.getXmlFragment("default");
  const freshFragment = fresh.ydoc.getXmlFragment("default");
  ydoc.transact(() => {
    const dropped = steps.flatMap((s) => (s.kind === "del" ? [s.a] : []));
    for (const a of dropped.sort((x, y) => y - x)) fragment.delete(a, 1);
    steps
      .flatMap((s) => (s.kind === "del" ? [] : [s]))
      .forEach((s, k) => {
        if (s.kind === "add") fragment.insert(k, [(freshFragment.get(s.b) as Y.XmlElement).clone()]);
      });
  });
  fresh.ydoc.destroy();
  if (!schema.nodeFromJSON(docContentFromYdoc(ydoc).proseJson).eq(C)) return "the ydoc edit didn't reproduce the conversion";

  const rows = await prisma.anchoredLinkAnchor.findMany({
    where: { docId },
    select: { id: true, anchorFrom: true, anchorTo: true, quotedText: true },
  });
  const anchors: Plan["anchors"] = [];
  for (const r of rows) {
    if (r.anchorFrom === null || r.anchorTo === null) return `anchor ${r.id} has no offsets`;
    if (A.textBetween(r.anchorFrom, r.anchorTo, " ") !== r.quotedText) return `anchor ${r.id} doesn't match the stored doc`;
    const from = map(r.anchorFrom, 1);
    const to = map(r.anchorTo, -1);
    if (from === null || to === null || to <= from) return `anchor ${r.id} is in a passage whose text changed`;
    anchors.push({ id: r.id, from, to, quotedText: C.textBetween(from, to, " ") });
  }

  return { docId, ydoc, before, anchors, blocksChanged: steps.filter((s) => s.kind !== "keep").length };
}

// Sends the plan's update to the collab server, which applies it to the live
// doc and stores it before answering; then, for a session, restores Updated,
// and re-captures each anchor against the version the update became. Returns
// why nothing was written if the doc moved on after it was planned, and throws
// on anything else.
async function applyInPlace(plan: Plan, span?: Span): Promise<string | null> {
  const ydocId = ydocIdForDoc(plan.docId);
  const { id: sub, role } = await importingAccount();
  const token = await signYdocToken({ sub, documentName: ydocId, role });
  const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  const endpoint = `${collabHttpOrigin()}${DOC_APPLY_UPDATE_PATH}`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        documentName: ydocId,
        update: base64(Y.encodeStateAsUpdate(plan.ydoc, plan.before)),
        stateVector: base64(plan.before),
      }),
    });
  } catch {
    throw new Error(`no collab server answers at ${endpoint}`);
  }
  const text = await res.text();
  if (res.status === 409) return "it was edited after the plan was made; run again";
  if (!res.ok) throw new Error(`the collab server refused the update (${res.status}): ${text}`);
  // A collab server older than the endpoint answers every path with a 200
  // "Welcome to Hocuspocus!" and writes nothing.
  let updateId: string | null;
  try {
    ({ updateId } = JSON.parse(text) as { updateId: string | null });
  } catch {
    throw new Error(`the collab server has no ${DOC_APPLY_UPDATE_PATH}; restart it on this code`);
  }
  if (!updateId) throw new Error("the collab server applied the update but has no id for it");
  const lastUpdateId = BigInt(updateId);
  // The server's store stamped Updated with the time of the edit, which a
  // file's doc keeps and a session's gives back to its last activity.
  if (span) await prisma.doc.update({ where: { id: plan.docId }, data: { updatedAt: span.last } });

  for (const a of plan.anchors) {
    const captured = await captureAnchorInYdoc({
      ydocId,
      throughUpdateId: lastUpdateId,
      extensions: docContentExtensions,
      schema: pmDocContentSchema,
      from: a.from,
      to: a.to,
      quotedText: a.quotedText,
    });
    if (!captured || captured.from !== a.from || captured.to !== a.to) throw new Error(`anchor ${a.id} didn't re-capture`);
    await prisma.anchoredLinkAnchor.update({
      where: { id: a.id },
      data: {
        anchorFrom: captured.from,
        anchorTo: captured.to,
        quotedText: captured.quotedText,
        selector: captured.selector as Prisma.InputJsonValue,
        ydocUpdateId: lastUpdateId,
      },
    });
  }
  return null;
}

// --------------------------------------------------------------------- Main

type ExistingDoc = { id: string; slug: string; title: string; body: unknown };

// One thing to bring into step with its doc: a session, or a Markdown file.
type Source = {
  label: string; // what the run's messages call it
  md: string;
  span?: Span; // a session's first and last activity
  doc: ExistingDoc | null; // the doc it was imported as, if it has been
};

// Each chosen session, matched to its doc by the link the doc opens with (see
// conversationToMarkdown). A dry run writes the Markdown and stops here.
async function sessionSources(): Promise<{ sources: Source[]; empty: number } | null> {
  const all: Conversation[] = JSON.parse(readFileSync(exportPath!, "utf8"));
  const chosen = ids.length ? ids.map((id) => all.find((c) => c.uuid === id) ?? id) : all;
  if (outDir) mkdirSync(outDir, { recursive: true });

  const existing = new Map<string, ExistingDoc>();
  if (!dryRun) {
    const rows = await prisma.$queryRaw<(ExistingDoc & { href: string | null })[]>`
      SELECT prose_json->'content'->0->'content'->0->'marks'->0->'attrs'->>'href' AS href,
             id, slug, title, prose_json AS body
        FROM doc`;
    for (const r of rows) if (r.href) existing.set(r.href, r);
  }

  const sources: Source[] = [];
  let empty = 0;
  for (const conv of chosen) {
    if (typeof conv === "string") {
      console.error(`${conv}: not in export`);
      process.exitCode = 1;
      continue;
    }
    const md = conversationToMarkdown(conv);
    if (!md) {
      empty++;
      continue;
    }
    if (outDir) writeFileSync(join(outDir, `${conv.uuid}.md`), md);
    sources.push({
      label: `${conv.uuid} ${JSON.stringify(conv.name)}`,
      md,
      span: activitySpan(conv),
      doc: existing.get(chatUrl(conv.uuid)) ?? null,
    });
  }
  if (dryRun) {
    console.log(`wrote ${sources.length} file(s) to ${outDir}; ${empty} empty session(s) left out`);
    return null;
  }
  return { sources, empty };
}

// Each file, matched to its doc by title: the doc titled exactly as the
// file's leading heading, not in the trash, with the importing account on its
// byline — the import puts it there. A file has nothing else to be matched
// by, so a file whose heading changes imports as a new doc. One with no
// heading is refused, because the app would title it from the file's name and
// nothing could match it afterwards; so is one whose title two docs share.
async function markdownSources(): Promise<{ sources: Source[]; empty: number }> {
  const importer = await importingAccount();
  const sources: Source[] = [];
  for (const file of ids) {
    const md = readFileSync(file, "utf8");
    const { title } = markdownToDocContent(md);
    if (!title) {
      console.error(`${file}: no leading heading to title the doc by`);
      process.exitCode = 1;
      continue;
    }
    const docs = await prisma.doc.findMany({
      where: { title, deletedAt: null, authors: { some: { userId: importer.id } } },
      select: { id: true, slug: true, title: true, proseJson: true },
    });
    if (docs.length > 1) {
      console.error(`${file}: ${docs.length} docs are titled ${JSON.stringify(title)}: ${docs.map((d) => `/doc/${d.slug}`).join(", ")}`);
      process.exitCode = 1;
      continue;
    }
    const [doc] = docs;
    sources.push({
      label: file,
      md,
      doc: doc ? { id: doc.id, slug: doc.slug, title: doc.title, body: doc.proseJson } : null,
    });
  }
  return { sources, empty: 0 };
}

async function main() {
  const found = markdownMode ? await markdownSources() : await sessionSources();
  if (!found) return;
  const { sources, empty } = found;

  let imported = 0;
  let upToDate = 0;
  let updated = 0;
  const differing: string[] = [];
  for (const source of sources) {
    const { doc, md, label, span } = source;
    if (doc) {
      const fresh = importedDoc(md);
      fresh.ydoc.destroy();
      if (fresh.title === doc.title && canonical(fresh.body) === canonical(doc.body)) {
        upToDate++;
        continue;
      }
      if (!update) {
        differing.push(`/doc/${doc.slug}  ${label}`);
        continue;
      }
      const result = await planInPlace(doc.id, doc.title, md);
      if (typeof result === "string") {
        differing.push(`/doc/${doc.slug}  ${label}  (not updated: ${result})`);
        continue;
      }
      const summary = `${result.blocksChanged} block(s) replaced or added, ${result.anchors.length} anchor(s) moved`;
      const refused = plan ? null : await applyInPlace(result, span);
      result.ydoc.destroy();
      if (refused) {
        differing.push(`/doc/${doc.slug}  ${label}  (not updated: ${refused})`);
        continue;
      }
      updated++;
      console.log(`${plan ? "would update" : "updated"} /doc/${doc.slug}: ${summary}`);
      continue;
    }
    if (plan) {
      console.log(`would import ${label}`);
      continue;
    }
    try {
      const slug = await importDoc(md, span);
      imported++;
      console.log(`${slug}  (${Math.round(Buffer.byteLength(md) / 1024)} KB)`);
    } catch (err) {
      console.error(`${label}: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  }
  if (differing.length) {
    const from = markdownMode ? "their file" : "this export's session";
    console.log(`\n${differing.length} existing doc(s) differ from ${from}, left as they are:`);
    for (const d of differing) console.log(`  ${d}`);
  }
  console.log(
    `imported ${imported}; already present: ${upToDate} up to date, ${updated} ${plan ? "to update" : "updated"}, ${differing.length} differing` +
      (markdownMode ? "" : `; ${empty} empty`),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
