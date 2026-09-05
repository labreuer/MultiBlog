// The machinery behind `npm run check-ports` and `npm run stop:all`: which
// processes are listening on this slot's ports, whose they are, and (for
// stop:all) the process tree above each one.
//
// Why this exists rather than `wait-on` and `kill-port`. Those answer "is
// something listening" and "free this port"; the question here is "is the
// thing listening *ours*", and neither asks it. playwright.config.ts sets
// `reuseExistingServer: true`, and Playwright's readiness test is any HTTP
// response at all — so a stranger's app on :3002 is adopted as the web server,
// and the suite dies a minute later inside auth.setup.ts looking exactly like
// an auth regression. `kill-port` has the mirror problem: it kills whatever
// holds the port, and only the leaf, so a supervisor (`concurrently`, `tsx
// watch`) restarts the child a moment later. Readiness itself is not a gap —
// Playwright's webServer already waits — so there is nothing `wait-on` would
// add.
//
// The question matters more here than in a repo one person runs by hand.
// Several Claude sessions share this machine, some in separate worktrees on
// their own ports (docs/DEV_SLOTS.md) and some in the same tree, and a session
// has no terminal tabs to glance at: it cannot see what another session
// started, has no memory of what it started itself an hour ago, and reasons
// only from what a command prints. So the check has to be automated and has
// to *name the process*, and stop:all has to be able to clear this
// checkout's servers without taking down the neighbours'. The test is per
// checkout, not per branch or per session: two sessions in one tree share
// ports and both count as ours, and reuseExistingServer lets them sabotage
// each other's runs. That is a known gap, not one this file closes.
//
// **The ownership rule**: a process listening on one of our ports
// is ours if its command line mentions this repo's absolute path. The real
// leaf processes always do — scripts/dev-web.ts spawns next's bin by absolute
// path, `tsx watch` runs its child with absolute `--import` paths into
// node_modules, and npm's `.bin` shims are invoked by full path — which is what
// keeps an unrelated project squatting on :3000 from being adopted (check-ports)
// or killed (stop-all). On Linux the process's cwd (readable from /proc) is
// accepted as well: it is the stronger signal, and one a command line built
// from relative paths can't lose.
//
// Per-OS plumbing, kept behind three functions so nothing above them cares:
//
//   listeners(port)   Linux: `ss -ltnpH` (iproute2, always present)
//                     macOS: `lsof -iTCP:<port> -sTCP:LISTEN`
//                     Windows: `netstat -ano`, last column is the PID
//   processInfo(pid)  Linux: /proc/<pid>/cmdline, /proc/<pid>/stat, /proc/<pid>/cwd
//                     macOS: `ps -o ppid=,command=`
//                     Windows: Win32_Process via powershell.exe — Windows
//                     PowerShell 5.1, which every Windows install has, not a
//                     pwsh to install.
//
// Everything shells out synchronously. These run as a prestep in front of the
// suite or as a one-shot stop, and a handful of 20 ms spawns is not where the
// time goes. A tool that is *missing* throws rather than reading as "nothing
// listening": the latter would let check-ports pass and stop:all report
// "Nothing to stop" with the servers still up.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { COLLAB_PORT, E2E_WEB_PORT, WEB_PORT } from "./dev-ports";

/**
 * Both spellings of the repo root, so a symlinked checkout matches either way.
 * Anchored on cwd rather than this file's location, the same way dev-web.ts
 * anchors on `process.cwd()`: npm scripts always run from the root, and
 * dev-ports.ts's `dotenv/config` already reads `.env` from cwd — so the slot
 * these ports came from is cwd's slot whatever this file's path is.
 */
const REPO_ROOT = resolve(process.cwd());
const REPO_ROOT_REAL = realpathSync(REPO_ROOT);

/**
 * The ports these scripts answer for: the dev server, the e2e prod target and
 * collab. WEB_PROD_PORT (WEB_PORT + 1) is deliberately absent — that one
 * belongs to the preview tool, which has to start and stop it itself
 * (CACHING.md), and Playwright never contends for it.
 */
export const SLOT_PORTS = [WEB_PORT, E2E_WEB_PORT, COLLAB_PORT];

export interface ProcessInfo {
  pid: number;
  ppid: number | undefined;
  commandLine: string;
  /** Linux only; undefined elsewhere. */
  cwd?: string;
}

/**
 * stdout of `cmd`, or "" when it exited non-zero (which `ss`/`lsof` do for
 * "no match" on some versions). A spawn *failure* — the tool isn't installed,
 * or isn't on PATH — is a different thing and throws: spawnSync reports it as
 * `status: null` with `error` set, and silently mapping that to "" is how a
 * port guard passes on a box that can't see ports at all.
 */
function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
  if (r.error) throw new Error(`Could not run ${cmd} (${(r.error as NodeJS.ErrnoException).code ?? r.error.message}); is it installed and on PATH?`);
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout : "";
}

/**
 * Whether `pid` is still running. Signal 0 is an existence probe, not a kill —
 * but it also succeeds on a zombie, a process that has exited and whose parent
 * hasn't reaped it yet, so on Linux the state field of /proc/<pid>/stat is
 * consulted too: `Z` is dead for every purpose here, and SIGKILL can't help it.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      return state !== "Z";
    } catch {
      return false;
    }
  }
  return true;
}

function signal(pid: number, sig: NodeJS.Signals, log: (line: string) => void): void {
  try {
    process.kill(pid, sig);
  } catch (e) {
    log(`WARNING: Could not send ${sig} to ${pid} (already gone?): ${(e as Error).message}`);
  }
}

/** How long stopAll waits for SIGTERM to work before falling back to SIGKILL. */
const GRACE_MS = 5000;

/** PIDs with a TCP socket in LISTEN state on `port`, deduplicated. */
export function listeners(port: number): number[] {
  const pids = new Set<number>();
  switch (process.platform) {
    case "linux": {
      // users:(("node",pid=12345,fd=21)) — possibly several per line.
      const out = run("ss", ["-ltnpH", `sport = :${port}`]);
      for (const m of out.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]));
      break;
    }
    case "darwin": {
      const out = run("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]);
      for (const line of out.split(/\r?\n/)) if (/^\d+$/.test(line)) pids.add(Number(line));
      break;
    }
    case "win32": {
      // No `-p tcp`: that lists IPv4 sockets only, and Node binds `::`
      // (dual-stack) by default, which netstat prints as `TCP [::]:3000`
      // under the same Proto column — so filter on the column, not the flag.
      const out = run("netstat", ["-ano"]);
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
        if (m && Number(m[1]) === port) pids.add(Number(m[2]));
      }
      break;
    }
    default:
      throw new Error(`Unsupported platform ${process.platform}`);
  }
  return [...pids];
}

/** Command line and parent of `pid`, or undefined once the process is gone. */
export function processInfo(pid: number): ProcessInfo | undefined {
  switch (process.platform) {
    case "linux": {
      let commandLine: string;
      let stat: string;
      try {
        commandLine = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+$/, "").replaceAll("\0", " ");
        stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      } catch {
        return undefined;
      }
      // /proc/<pid>/stat: `pid (comm) state ppid …`; comm may contain spaces
      // and parens, so split after the *last* `)`.
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || undefined;
      let cwd: string | undefined;
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {
        // A process owned by another user hides its cwd; the command line still decides.
      }
      return { pid, ppid, commandLine, cwd };
    }
    case "darwin": {
      const out = run("ps", ["-o", "ppid=,command=", "-p", String(pid)]).trim();
      if (!out) return undefined;
      const m = out.match(/^(\d+)\s+([\s\S]*)$/);
      if (!m) return undefined;
      return { pid, ppid: Number(m[1]) || undefined, commandLine: m[2] };
    }
    case "win32":
      return windowsProcessTable().get(pid);
    default:
      throw new Error(`Unsupported platform ${process.platform}`);
  }
}

/**
 * Windows reads the whole process table once, in one powershell.exe start,
 * rather than one CIM query per PID: each start costs ~0.5-1 s, and stop-all's
 * ancestor walk asks for a dozen. Windows PowerShell 5.1 ships with every
 * Windows install, so this needs nothing installed. Snapshot semantics are
 * fine here — the walk happens within a second of the listing.
 */
let windowsProcesses: Map<number, ProcessInfo> | undefined;
function windowsProcessTable(): Map<number, ProcessInfo> {
  if (windowsProcesses) return windowsProcesses;
  const table = new Map<number, ProcessInfo>();
  const out = run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
  ]).trim();
  try {
    const rows = JSON.parse(out) as Array<{ ProcessId: number; ParentProcessId?: number; CommandLine?: string | null }>;
    for (const r of Array.isArray(rows) ? rows : [rows]) {
      table.set(r.ProcessId, { pid: r.ProcessId, ppid: r.ParentProcessId || undefined, commandLine: r.CommandLine ?? "" });
    }
  } catch {
    // Unparseable or empty: every lookup misses, and the callers treat a
    // missing process as "gone or unreadable" rather than as ours.
  }
  windowsProcesses = table;
  return table;
}

/** The ownership test: does this process belong to this checkout? */
export function isOurs(info: ProcessInfo): boolean {
  if (info.commandLine.includes(REPO_ROOT) || info.commandLine.includes(REPO_ROOT_REAL)) return true;
  if (info.cwd) {
    const cwd = info.cwd;
    return cwd === REPO_ROOT || cwd === REPO_ROOT_REAL || cwd.startsWith(REPO_ROOT + "/") || cwd.startsWith(REPO_ROOT_REAL + "/");
  }
  return false;
}

/**
 * Tripwire for next dev's prerender-manifest corruption (vercel/next.js#96664,
 * docs/playwright-flakiness.html class 3): the RMW race's *sticky* variant
 * leaves the file unparseable, after which every dev route 500s until the dev
 * server restarts — a state otherwise indistinguishable from "the suite broke".
 * Only the dev server's copy matters; a prod build writes its manifest once.
 * TODO.md says when this can go: once an installed Next carries a fix.
 */
export function devManifestIsTorn(): string | undefined {
  const manifest = resolve(REPO_ROOT, ".next", "dev", "prerender-manifest.json");
  if (!existsSync(manifest)) return undefined;
  try {
    JSON.parse(readFileSync(manifest, "utf8"));
    return undefined;
  } catch {
    return manifest;
  }
}

/**
 * Read-only guard for `npm run e2e`. playwright.config.ts sets
 * `reuseExistingServer: true` unconditionally (a dev server we didn't start is
 * not ours to kill), and webServer.url treats *any* HTTP response as "ready" —
 * a 404 from a completely different app included. If some other project is
 * squatting on one of our ports, Playwright silently adopts it and the suite
 * dies deep inside auth.setup.ts, which reads exactly like an auth regression
 * and isn't one. Ports with nothing listening are fine (Playwright starts
 * them); ports already ours are fine (Playwright reuses them); anything else
 * fails fast with the PID and command line instead of a 60 s timeout.
 *
 * Returns true when it is safe to run.
 */
export function checkPorts(log: (line: string) => void = console.log): boolean {
  const torn = devManifestIsTorn();
  if (torn) {
    log(`WARNING: ${torn} is not valid JSON.`);
    log("That's vercel/next.js#96664's sticky tear: every dev route will 500 until the dev server restarts.");
    log("\nStop the dev server (npm run stop:all), delete .next, and start it again before running e2e.");
    return false;
  }

  let foreign = false;
  for (const port of SLOT_PORTS) {
    const pids = listeners(port);
    if (pids.length === 0) {
      log(`Port ${port} -- nothing listening, Playwright will start it.`);
      continue;
    }
    for (const pid of pids) {
      const info = processInfo(pid);
      if (info && isOurs(info)) {
        log(`Port ${port} -- owned by this repo (PID ${pid}), Playwright will reuse it.`);
      } else {
        log(`WARNING: Port ${port} is held by PID ${pid}, whose command line doesn't mention this repo:`);
        log(`  ${info?.commandLine ?? "(process gone or unreadable)"}`);
        foreign = true;
      }
    }
  }

  if (foreign) {
    log("\nRefusing to run e2e -- a required port is held by a process from another project.");
    log("Stop it yourself, or run `npm run stop:all` if it's safe to kill.");
    return false;
  }
  log(`\nPorts ${SLOT_PORTS.join(", ")} are clear or already ours.`);
  return true;
}

/**
 * Patterns an *ancestor* must match to be included in the kill list. The leaf
 * (the process actually listening) must pass `isOurs`; each parent added above
 * it must match one of these, and the walk stops at the first that doesn't —
 * so it can never climb past this project's process tree into an unrelated
 * parent shell. `npm run dev` is a tsx wrapper (scripts/dev-web.ts) that
 * spawns next's bin by absolute path, so its leaf carries the repo path and
 * 'dev-web.ts' rather than a literal `next dev`.
 */
const ANCESTOR_MARKERS = [
  REPO_ROOT,
  REPO_ROOT_REAL,
  "concurrently",
  "npm run dev:all",
  "npm:dev",
  "npm:collab",
  "npm run dev",
  "npm run collab",
  "npm-cli.js",
  "next dev",
  "tsx watch",
  "dev-web.ts",
  "npm run e2e:web",
  "prod-web.ts",
  "next start",
];

/**
 * `npm run stop:all`: stops every server this repo runs locally — the
 * `dev:all` tree (next dev on WEB_PORT, Hocuspocus on COLLAB_PORT) and the e2e
 * prod web server (`next start` on WEB_PORT + 2) — in one shot, so a restart
 * doesn't need a discover/trace/kill round trip. A port whose owner fails the
 * ownership test is left alone and reported.
 *
 * Returns the process exit code: 0 when every port is clear afterwards.
 */
export async function stopAll(log: (line: string) => void = console.log): Promise<number> {
  const toKill = new Map<number, string>();
  let aborted = false;

  for (const port of SLOT_PORTS) {
    const pids = listeners(port);
    if (pids.length === 0) {
      log(`Port ${port} -- nothing listening.`);
      continue;
    }
    for (const leaf of pids) {
      const info = processInfo(leaf);
      if (!info || !isOurs(info)) {
        log(`WARNING: Port ${port} is owned by PID ${leaf}, but its command line doesn't mention this repo:`);
        log(`  ${info?.commandLine ?? "(process gone or unreadable)"}`);
        log("Refusing to touch it -- looks like a different process.");
        aborted = true;
        continue;
      }
      toKill.set(leaf, info.commandLine);

      // Walk up the parent chain, only including ancestors that match.
      let current = info;
      while (current.ppid && current.ppid > 1) {
        const parent = processInfo(current.ppid);
        if (!parent || !ANCESTOR_MARKERS.some((m) => parent.commandLine.includes(m))) break;
        toKill.set(parent.pid, parent.commandLine);
        current = parent;
      }
    }
  }

  if (toKill.size === 0) {
    if (aborted) {
      log("Nothing killed -- see warnings above.");
      return 1;
    }
    log("Nothing to stop.");
    return 0;
  }

  log(`\nAbout to stop ${toKill.size} process(es):`);
  for (const [pid, cmd] of toKill) log(`  ${pid}  ${cmd}`);

  // Parents first, so a supervisor (concurrently, tsx watch, npm) can't
  // restart a child we stopped a moment earlier. The map is leaf-then-ancestors
  // in insertion order, so reverse it.
  //
  // SIGTERM first, SIGKILL only for what survives the grace period. `next dev`
  // has a shutdown handler, and killing it outright is one way to leave
  // `.next/dev` in the state CLAUDE.md's Checks section describes — the next
  // start hangs mid-compile and every spec dies in auth.setup.ts. (On Windows
  // both signals are an unconditional terminate; the ladder is then just a
  // second attempt.)
  const order = [...toKill.keys()].reverse();
  for (const pid of order) signal(pid, "SIGTERM", log);

  const deadline = Date.now() + GRACE_MS;
  let alive = order.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(100);
    alive = alive.filter(isAlive);
  }
  if (alive.length > 0) {
    log(`Still running ${GRACE_MS} ms after SIGTERM, sending SIGKILL: ${alive.join(", ")}`);
    for (const pid of alive) signal(pid, "SIGKILL", log);
    // SIGKILL is asynchronous in effect; give the kernel a moment to reap the
    // sockets before deciding whether anything is still bound.
    await sleep(500);
  }
  for (const pid of order) if (!isAlive(pid)) log(`Stopped ${pid}`);

  const still = SLOT_PORTS.filter((port) => listeners(port).length > 0);
  if (still.length > 0) {
    log(`WARNING: Still listening after kill attempt: ${still.join(", ")}`);
    return 1;
  }
  if (aborted) {
    log("\nDone, but one port was left alone -- see warnings above.");
    return 1;
  }
  log(`\nPorts ${SLOT_PORTS.join(", ")} are clear.`);
  return 0;
}
