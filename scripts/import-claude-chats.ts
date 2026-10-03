// Import a claude.ai data export's conversations as docs, through /docs'
// own "Import Markdown" form (docs/DOC_IMPORT.md) — the multipart POST a
// browser without JS sends — signed in as a real account. Each session becomes
// Markdown first; the form does the parse, the ydoc seeding and the slug.
//
// Then, per doc, directly in the database:
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
// No uuids means every conversation. --dry-run writes <out>/<uuid>.md and stops.
// --update also updates differing docs in place (see "In-place update" below);
// it needs the collab server stopped. --plan says what --update would do and
// writes nothing.
// --frames is the export's frames-000.zip, unzipped: a Claude Docs document a
// session made (artifacts/<id>/page.md) goes into that session's doc.
// Env: MB_EMAIL/MB_PASSWORD (the importing account, default the Claude one),
// BYLINE_EMAILS (comma-separated), HUMAN_NAME. Importing goes through the dev
// server, so it must be running when there is anything new to import.

import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import * as Y from "yjs";
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TiptapTransformer } from "@hocuspocus/transformer";
import { prisma } from "../src/lib/prisma";
import type { Prisma } from "../src/generated/prisma/client";
import { markdownToDocContent } from "../src/lib/markdown-import";
import { contentExtensions, docContentExtensions, pmDocContentSchema } from "../src/lib/tiptap-schema";
import { docContentFromYdoc } from "../src/lib/doc-content";
import { ydocIdForDoc } from "../src/lib/ydoc-names";
import { captureAnchorInYdoc } from "../src/lib/anchors/capture";
import { ydocStore, drainAppends, encodeYdocState, UNAVAILABLE } from "../server/ydoc-store";
import { updateDocCache } from "../server/doc-cache";
import { webUrl, WEB_PORT, COLLAB_PORT } from "./dev-ports";

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
const ids = args.filter((a) => !["--dry-run", "--plan", "--update"].includes(a));
if (!exportPath || (dryRun && !outDir)) {
  console.error(
    "Usage: npx tsx scripts/import-claude-chats.ts --export <conversations.json> [--frames <dir>] [--out <dir>] [--dry-run | --update | --plan] [<uuid>...]",
  );
  process.exit(1);
}

const BASE = webUrl(WEB_PORT);
const IMPORTER_EMAIL = process.env.MB_EMAIL || "claude@multiblog.invalid";
const IMPORTER_PASSWORD = process.env.MB_PASSWORD || "testpass123";
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
function activitySpan(conv: Conversation): { first: Date; last: Date } {
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

// ------------------------------------------------------------------- Upload

const jar = new Map<string, string>();
function keep(res: Response): Response {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return res;
}
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const get = (path: string) => fetch(BASE + path, { headers: { cookie: cookie() }, redirect: "manual" }).then(keep);
const post = (path: string, body: BodyInit) =>
  fetch(BASE + path, { method: "POST", body, headers: { cookie: cookie(), origin: BASE }, redirect: "manual" }).then(keep);

async function signIn(email: string, password: string) {
  const { csrfToken } = await (await get("/api/auth/csrf")).json();
  await post("/api/auth/callback/credentials", new URLSearchParams({ email, password, csrfToken, callbackUrl: BASE + "/" }));
  const session = await (await get("/api/auth/session")).json();
  if (session?.user?.email !== email) throw new Error(`sign-in as ${email} failed`);
  return session.user as { email: string; role: string };
}

// The import form is the one whose server action carries bound state
// ($ACTION_REF_n — useActionState). Its hidden fields are replayed verbatim.
async function importFormFields(): Promise<[string, string][]> {
  const html = await (await get("/docs")).text();
  const forms = html.match(/<form[^>]*>[\s\S]*?<\/form>/g) ?? [];
  const form = forms.find((f) => /name="\$ACTION_REF_/.test(f) && /name="file"/.test(f));
  if (!form) throw new Error("no import form on /docs (not signed in as a doc manager?)");
  const unescape = (s: string) =>
    s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return [...form.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/?>/g)].map(([, n, v]) => [
    n,
    unescape(v ?? ""),
  ]);
}

async function importMarkdown(fields: [string, string][], filename: string, markdown: string): Promise<string> {
  const fd = new FormData();
  for (const [n, v] of fields) fd.append(n, v);
  fd.append("file", new Blob([markdown], { type: "text/markdown" }), filename);
  const res = await post("/docs", fd);
  const location = res.headers.get("location");
  const slug = location?.match(/^\/doc\/([^/]+)\/edit$/)?.[1];
  if (!slug) throw new Error(`import returned ${res.status} with no doc redirect: ${(await res.text()).slice(0, 300)}`);
  return decodeURIComponent(slug);
}

async function finishDoc(slug: string, bylineIds: string[], span: { first: Date; last: Date }) {
  const doc = await prisma.doc.findUniqueOrThrow({ where: { slug }, select: { id: true } });
  await prisma.$transaction([
    ...bylineIds.map((userId, bylineOrder) =>
      prisma.docAuthor.upsert({
        where: { docId_userId: { docId: doc.id, userId } },
        create: { docId: doc.id, userId, bylineOrder },
        update: { bylineOrder },
      }),
    ),
    // Last, and with updatedAt named explicitly, so @updatedAt doesn't stamp now().
    prisma.doc.update({ where: { id: doc.id }, data: { createdAt: span.first, updatedAt: span.last } }),
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
// conversion's, written the way the collab server writes an edit. An anchor in
// an unchanged block just moves with it. An anchor in a replaced run moves only
// if the run's positions still line up one for one — its text the same, with
// at most a newline become a line break, which is one position either way;
// otherwise the doc is reported and left alone rather than the anchor guessed.

type Plan = {
  docId: string;
  ydoc: Y.Doc;
  before: Uint8Array; // the stored state vector, for the update to append
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

async function planInPlace(docId: string, docTitle: string, conv: Conversation): Promise<Plan | string> {
  const ydocId = ydocIdForDoc(docId);
  const loaded = await ydocStore.load(ydocId);
  if (!loaded || loaded === UNAVAILABLE) return "its ydoc couldn't be loaded";
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, loaded.ydoc);
  const before = Y.encodeStateVector(ydoc);

  const schema = pmDocContentSchema;
  const A = schema.nodeFromJSON(docContentFromYdoc(ydoc).proseJson);
  const md = conversationToMarkdown(conv);
  if (!md) return "the session is empty now";
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

// Writes the plan the way the collab server writes an edit (append the update,
// wait for it to land, checkpoint the state, refresh the doc's cache), then
// restores Updated and re-captures each anchor against the new version.
async function applyInPlace(plan: Plan, span: { first: Date; last: Date }): Promise<void> {
  const ydocId = ydocIdForDoc(plan.docId);
  await ydocStore.appendUpdate(ydocId, Y.encodeStateAsUpdate(plan.ydoc, plan.before));
  const lastUpdateId = await drainAppends(ydocId);
  if (lastUpdateId === null) throw new Error("the update didn't land");
  const { ydoc: state, stateVector } = encodeYdocState(plan.ydoc);
  await ydocStore.storeState(ydocId, state, stateVector, lastUpdateId);
  await updateDocCache(ydocId, plan.ydoc, undefined, lastUpdateId);
  await prisma.doc.update({ where: { id: plan.docId }, data: { updatedAt: span.last } });

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
}

// The update writes ydocs directly, which is only safe with no collab server
// holding any of them in memory to write back over it.
function collabIsUp(): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port: COLLAB_PORT });
    socket.once("connect", () => (socket.destroy(), done(true)));
    socket.once("error", () => done(false));
  });
}

// --------------------------------------------------------------------- Main

async function main() {
  const all: Conversation[] = JSON.parse(readFileSync(exportPath!, "utf8"));
  const chosen = ids.length ? ids.map((id) => all.find((c) => c.uuid === id) ?? id) : all;
  if (outDir) mkdirSync(outDir, { recursive: true });
  if (update && !plan && (await collabIsUp())) {
    console.error(`The collab server is up on :${COLLAB_PORT}; stop it before --update (or use --plan).`);
    process.exit(1);
  }

  // The link every imported doc opens with (see conversationToMarkdown).
  const existing = new Map<string, { id: string; slug: string; title: string; body: unknown }>();
  if (!dryRun) {
    const rows = await prisma.$queryRaw<{ href: string | null; id: string; slug: string; title: string; body: unknown }[]>`
      SELECT prose_json->'content'->0->'content'->0->'marks'->0->'attrs'->>'href' AS href,
             id, slug, title, prose_json AS body
        FROM doc`;
    for (const r of rows) if (r.href) existing.set(r.href, r);
  }

  // Signed in on the first import only, so a run with nothing to import needs
  // no web server.
  let form: { fields: [string, string][]; bylineIds: string[] } | null = null;
  const signedIn = async () => {
    if (form) return form;
    const user = await signIn(IMPORTER_EMAIL, IMPORTER_PASSWORD);
    console.log(`signed in as ${user.email} (${user.role})`);
    const users = await prisma.user.findMany({ where: { email: { in: BYLINE_EMAILS } }, select: { id: true, email: true } });
    const bylineIds = BYLINE_EMAILS.map((e) => {
      const u = users.find((x) => x.email === e);
      if (!u) throw new Error(`no user ${e}`);
      return u.id;
    });
    form = { fields: await importFormFields(), bylineIds };
    return form;
  };

  let imported = 0;
  let upToDate = 0;
  let updated = 0;
  let empty = 0;
  const differing: string[] = [];
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
    if (dryRun) continue;
    const doc = existing.get(chatUrl(conv.uuid));
    if (doc) {
      const fresh = importedDoc(md);
      fresh.ydoc.destroy();
      if (fresh.title === doc.title && canonical(fresh.body) === canonical(doc.body)) {
        upToDate++;
        continue;
      }
      if (!update) {
        differing.push(`/doc/${doc.slug}  ${conv.uuid}`);
        continue;
      }
      const result = await planInPlace(doc.id, doc.title, conv);
      if (typeof result === "string") {
        differing.push(`/doc/${doc.slug}  ${conv.uuid}  (not updated: ${result})`);
        continue;
      }
      const summary = `${result.blocksChanged} block(s) replaced or added, ${result.anchors.length} anchor(s) moved`;
      if (!plan) await applyInPlace(result, activitySpan(conv));
      result.ydoc.destroy();
      updated++;
      console.log(`${plan ? "would update" : "updated"} /doc/${doc.slug}: ${summary}`);
      continue;
    }
    if (plan) {
      console.log(`would import ${conv.uuid} ${JSON.stringify(conv.name)}`);
      continue;
    }
    try {
      const { fields, bylineIds } = await signedIn();
      const slug = await importMarkdown(fields, `${conv.uuid}.md`, md);
      await finishDoc(slug, bylineIds, activitySpan(conv));
      imported++;
      console.log(`${slug}  (${Math.round(Buffer.byteLength(md) / 1024)} KB)`);
    } catch (err) {
      console.error(`${conv.uuid} ${JSON.stringify(conv.name)}: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  }
  if (differing.length) {
    console.log(`\n${differing.length} existing doc(s) differ from this export's session, left as they are:`);
    for (const d of differing) console.log(`  ${d}`);
  }
  console.log(
    dryRun
      ? `wrote ${chosen.length - empty} file(s) to ${outDir}; ${empty} empty session(s) left out`
      : `imported ${imported}; already present: ${upToDate} up to date, ${updated} ${plan ? "to update" : "updated"}, ${differing.length} differing; ${empty} empty`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
