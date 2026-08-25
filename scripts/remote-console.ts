// A JS console on a *real* mobile browser, over the LAN — no Xcode, no
// WebDriver, no device toolchain of any kind.
//
// Why this exists: two testing paths that would normally cover a real iPhone
// are both fenced off on this machine, for the same reason.
// `playwright.config.ts` records the first (Playwright's WebKit will not launch
// on macOS 14). The second is Appium/WebDriverAgent, which has to *build and
// install* onto the device: the max Xcode on macOS 14 is 16.2, shipping iOS
// 18.2 device support, and the phone is on 18.6.2. A 2019 MacBook Air cannot
// run macOS 15, so neither fence moves.
//
// What is left is the thing that needs no toolchain at all: the phone already
// runs our JavaScript. This serves a page (or a script injected into the app),
// which long-polls for code, evaluates it, and posts the result back. That is
// enough to *measure* — feature-detect built-ins in both realms, read bounding
// rects and computed styles, dispatch clicks, read text back.
//
//   Terminal A:  npx tsx scripts/remote-console.ts
//   Phone:       open the printed http://<lan-ip>:4322/?token=… URL
//   Terminal B:  curl -s --data-binary 'document.title' localhost:4322/eval
//
// `/eval` blocks until the phone answers, so it composes with ordinary shell
// scripting rather than needing a REPL.
//
// **Two realms, because one of them is where the bug lives.** pdfjs runs a
// worker, which inherits nothing from the main thread's prototypes, and
// docs/PDF.md §10 records that the surviving WebKit gap is used on both sides.
// `?realm=worker` evaluates inside a module worker instead; `?realm=both`
// returns one result per realm. Same discipline as scripts/probe-engine.ts,
// whose checks this can run verbatim.
//
// **Reaching the *app's* DOM needs the client in the app's origin.** A
// standalone page on :4322 is a different origin from the dev server on :3000,
// so it can measure the engine but cannot see a single one of our elements.
// Hence /client.js, which is CORS-open and injectable: src/app/layout.tsx
// renders a <script> for it when REMOTE_CONSOLE_SRC is set, dev builds only.
// Set that and every page of the app carries the console, navigation included.
//
// **Security, stated plainly rather than assumed.** This is an arbitrary-code
// channel into a browser, so:
//   - `/eval` and `/status` are refused from anything but loopback. Only this
//     machine can submit code.
//   - Every device-facing endpoint requires a token, freshly generated each
//     run and printed once. It stops another device or page on the subnet from
//     picking up commands meant for the phone (which would both leak what we
//     evaluate and impersonate the device).
//   - The token is embedded in the script URL, so anything that can fetch
//     /client.js has it. That is the deliberate limit of this design: it is a
//     dev tool for a trusted LAN, defended to the same standard as
//     next.config.ts's `allowedDevOrigins`, and no further.
//   - Nothing is written to disk and no state outlives the process. Ctrl+C is
//     the whole teardown. Do not leave it running.
//
// Known limits, none of which a bigger implementation would fix:
//   - It cannot see the screen. Numbers only.
//   - It cannot produce a *native* gesture. iOS text selection is WebKit's
//     gesture recognizer plus UIKit drag handles above the page, reachable by
//     no amount of dispatchEvent — the class docs/PDF.md §10 already calls
//     unreproducible. A synthetic `selectionchange` is not the same evidence.
//   - A command that navigates kills its own client. The phone does navigate;
//     the /eval that told it to reports a timeout, then the next page's client
//     registers a moment later. Expected, not a fault.
//   - iOS suspends a backgrounded or locked tab, which looks exactly like a
//     hang. Keep the tab foreground and set Auto-Lock to Never.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

const PORT = Number(process.env.REMOTE_CONSOLE_PORT ?? 4322);
/**
 * Fresh per run unless pinned. Pinning is what makes REMOTE_CONSOLE_SRC in
 * `.env` survive a relay restart — otherwise every restart invalidates the
 * script URL baked into the app and the phone silently stops reporting, which
 * looks like the relay hanging rather than like a stale token. Pin it for a
 * working session, and leave it unset anywhere the value might outlive the
 * session.
 */
const TOKEN = process.env.REMOTE_CONSOLE_TOKEN || randomBytes(12).toString("hex");
const POLL_HOLD_MS = 25_000;
const DEFAULT_EVAL_TIMEOUT_MS = 15_000;
const WAIT_FOR_DEVICE_MS = 5_000;

/**
 * Result values have to survive JSON, and the interesting ones do not: a DOM
 * element, an Error, a circular object, `undefined`, `NaN`. Returning "{}" for
 * all of them would make every measurement ambiguous, so this flattens each to
 * something a reader can act on. Shared verbatim with the worker realm — the
 * same reason src/lib/pdfjs-webkit-polyfills.ts is a source string.
 */
const SERIALIZE_SRC = `
function __rcSerialize(value, depth) {
  depth = depth || 0;
  var seen = arguments[2] || [];
  if (value === undefined) return { __t: "undefined" };
  if (value === null) return null;
  var t = typeof value;
  if (t === "number") return Number.isFinite(value) ? value : { __t: String(value) };
  if (t === "string" || t === "boolean") return value;
  if (t === "bigint") return { __t: "bigint", v: String(value) };
  if (t === "symbol") return { __t: "symbol", v: String(value) };
  if (t === "function") return { __t: "function", v: value.name || "(anonymous)" };
  if (value instanceof Error) return { __t: "error", name: value.name, message: value.message, stack: String(value.stack || "").split("\\n").slice(0, 6).join("\\n") };
  if (typeof Element !== "undefined" && value instanceof Element) {
    var r = value.getBoundingClientRect();
    return { __t: "element", tag: value.tagName.toLowerCase(), id: value.id || undefined,
             cls: value.className && value.className.baseVal === undefined ? String(value.className) : undefined,
             rect: { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) },
             text: (value.textContent || "").trim().slice(0, 120) || undefined };
  }
  if (seen.indexOf(value) !== -1) return { __t: "circular" };
  if (depth >= 4) return { __t: "maxdepth" };
  seen = seen.concat([value]);
  if (Array.isArray(value)) {
    var out = value.slice(0, 100).map(function (v) { return __rcSerialize(v, depth + 1, seen); });
    if (value.length > 100) out.push({ __t: "truncated", of: value.length });
    return out;
  }
  if (typeof value === "object") {
    if (typeof value.length === "number" && typeof value.item === "function") {
      return { __t: "collection", len: value.length,
               items: Array.prototype.slice.call(value, 0, 30).map(function (v) { return __rcSerialize(v, depth + 1, seen); }) };
    }
    var o = {}, keys = Object.keys(value).slice(0, 60);
    for (var i = 0; i < keys.length; i++) { try { o[keys[i]] = __rcSerialize(value[keys[i]], depth + 1, seen); } catch (e) { o[keys[i]] = { __t: "threw" }; } }
    return o;
  }
  return String(value);
}
`;

/**
 * Expression first, statements as the fallback. `document.title` and
 * `const a = 1; return a` are both things you want to type, and only the
 * second one parses as a function body — so try to build the expression form
 * and let its SyntaxError at construction time (not at run time) pick the
 * other. `await` works in both because the body is an async arrow either way.
 */
const RUN_SRC = `
async function __rcRun(code) {
  var fn;
  try { fn = new Function("return (async () => (" + code + "))()"); }
  catch (e) { fn = new Function("return (async () => { " + code + " })()"); }
  return await fn();
}
`;

const WORKER_SRC = `${SERIALIZE_SRC}${RUN_SRC}
self.onmessage = async function (e) {
  var id = e.data.id;
  try { self.postMessage({ id: id, ok: true, value: __rcSerialize(await __rcRun(e.data.code)) }); }
  catch (err) { self.postMessage({ id: id, ok: false, value: __rcSerialize(err instanceof Error ? err : new Error(String(err))) }); }
};
`;

const CLIENT_SRC = `(function () {
  "use strict";
  if (window.__rcActive) return;
  window.__rcActive = true;
  var script = document.currentScript;
  var base, token;
  try {
    var u = new URL(script && script.src ? script.src : location.href);
    base = u.origin;
    token = u.searchParams.get("token") || "";
  } catch (e) { return; }

${SERIALIZE_SRC}
${RUN_SRC}

  var worker = null;
  var workerWaiters = {};
  function ensureWorker() {
    if (worker) return worker;
    var src = ${JSON.stringify(WORKER_SRC)};
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })), { type: "module" });
    worker.onmessage = function (e) {
      var w = workerWaiters[e.data.id];
      if (w) { delete workerWaiters[e.data.id]; w(e.data); }
    };
    return worker;
  }
  function runInWorker(id, code) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve({ ok: false, value: { __t: "error", name: "Timeout", message: "worker did not answer in 10s" } }); }, 10000);
      workerWaiters[id] = function (d) { clearTimeout(t); resolve(d); };
      try { ensureWorker().postMessage({ id: id, code: code }); }
      catch (err) { clearTimeout(t); resolve({ ok: false, value: { __t: "error", name: "WorkerError", message: String(err && err.message || err) } }); }
    });
  }

  function post(path, body) {
    return fetch(base + path + "?token=" + encodeURIComponent(token), {
      method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(body), keepalive: true,
    });
  }

  function setStatus(text) {
    var el = document.getElementById("__rc_status");
    if (el) el.textContent = text;
  }

  post("/hello", { ua: navigator.userAgent, href: location.href,
                   screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
                   viewport: { w: innerWidth, h: innerHeight } }).catch(function () {});
  setStatus("connected");

  async function loop() {
    for (;;) {
      var cmd = null;
      try {
        var res = await fetch(base + "/poll?token=" + encodeURIComponent(token) + "&href=" + encodeURIComponent(location.href));
        if (res.status === 204) continue;
        if (!res.ok) { setStatus("relay refused (" + res.status + ")"); await new Promise(function (r) { setTimeout(r, 3000); }); continue; }
        cmd = await res.json();
      } catch (e) {
        setStatus("relay unreachable — retrying");
        await new Promise(function (r) { setTimeout(r, 2000); });
        continue;
      }
      setStatus("running…");
      var out;
      if (cmd.realm === "worker") {
        out = await runInWorker(cmd.id, cmd.code);
      } else {
        try { out = { ok: true, value: __rcSerialize(await __rcRun(cmd.code)) }; }
        catch (err) { out = { ok: false, value: __rcSerialize(err instanceof Error ? err : new Error(String(err))) }; }
      }
      setStatus("connected");
      post("/result", { id: cmd.id, ok: out.ok, value: out.value, href: location.href }).catch(function () {});
    }
  }
  loop();
})();
`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>remote console</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; padding: 2rem 1.25rem; margin: 0; }
  h1 { font-size: 1.1rem; margin: 0 0 .75rem; }
  code { font-family: ui-monospace, monospace; font-size: .85em; }
  #__rc_status { font-weight: 600; }
  p { margin: .5rem 0; }
</style></head><body>
<h1>remote console</h1>
<p>status: <span id="__rc_status">starting…</span></p>
<p>This tab is the target. Keep it in the foreground — iOS suspends background
tabs, which looks like a hang. Set Auto-Lock to Never for the session.</p>
<p>To reach the app's own DOM instead of this page, set
<code>REMOTE_CONSOLE_SRC</code> in <code>.env</code>, restart the dev server, and
browse the app here instead.</p>
<script src="/client.js?token=TOKEN_PLACEHOLDER"></script>
</body></html>`;

type Waiter = { resolve: (v: unknown) => void; timer: NodeJS.Timeout };
type Command = { id: string; code: string; realm: "main" | "worker" };

const queue: Command[] = [];
let pollers: Array<(cmd: Command) => void> = [];
const waiters = new Map<string, Waiter>();
let device: { ua: string; href: string; at: number; screen?: unknown; viewport?: unknown } | null = null;
let deviceWaiters: Array<() => void> = [];

function isLoopback(req: http.IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}

function dispatch(cmd: Command): void {
  const poller = pollers.shift();
  if (poller) poller(cmd);
  else queue.push(cmd);
}

function cors(res: http.ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  cors(res);
  if (req.method === "OPTIONS") return void res.writeHead(204).end();

  // The token is accepted from the query *or* as the first path segment. A
  // tablet is the likeliest device to reach this and the worst thing to type a
  // 24-character query string on: dropping the `?` turns the URL into a path
  // and earned a bare "not found" once, which reads as the relay being down
  // rather than as a typo. `/<token>` works, and so does any unmatched path
  // once the token is valid (see the catch-all at the bottom).
  const pathHead = url.pathname.slice(1).split("/")[0];
  const tokenOk = url.searchParams.get("token") === TOKEN || pathHead === TOKEN;

  // ---- control plane: loopback only ------------------------------------
  if (url.pathname === "/eval" || url.pathname === "/status") {
    if (!isLoopback(req)) return void res.writeHead(403).end("control endpoints are loopback-only\n");
  }

  if (url.pathname === "/status") {
    return void res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ connected: !!device, device, queued: queue.length, waitingPollers: pollers.length }, null, 2));
  }

  if (url.pathname === "/eval" && req.method === "POST") {
    const code = await readBody(req);
    if (!code.trim()) return void res.writeHead(400).end("empty body — send JS as the request body\n");
    const realmParam = url.searchParams.get("realm") ?? "main";
    const timeout = Number(url.searchParams.get("timeout") ?? DEFAULT_EVAL_TIMEOUT_MS);

    if (!device) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, WAIT_FOR_DEVICE_MS);
        deviceWaiters.push(() => { clearTimeout(t); resolve(); });
      });
      if (!device) {
        return void res.writeHead(503, { "content-type": "application/json" })
          .end(JSON.stringify({ ok: false, error: "no device connected — open the phone URL first" }));
      }
    }

    const realms: Array<"main" | "worker"> = realmParam === "both" ? ["main", "worker"] : [realmParam === "worker" ? "worker" : "main"];
    const results: Record<string, unknown> = {};
    for (const realm of realms) {
      const id = randomBytes(6).toString("hex");
      const result = await new Promise<unknown>((resolve) => {
        const timer = setTimeout(
          () => { waiters.delete(id); resolve({ ok: false, error: `timed out after ${timeout}ms (did the page navigate, or the tab go to the background?)` }); },
          timeout,
        );
        waiters.set(id, { resolve, timer });
        dispatch({ id, code, realm });
      });
      results[realm] = result;
    }
    return void res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(realms.length === 1 ? results[realms[0]] : results, null, 2));
  }

  // ---- device plane: token required ------------------------------------
  if (url.pathname === "/client.js") {
    if (!tokenOk) return void res.writeHead(403).end("// bad or missing token");
    return void res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" }).end(CLIENT_SRC);
  }

  if (url.pathname === "/hello" && req.method === "POST") {
    if (!tokenOk) return void res.writeHead(403).end();
    try {
      const info = JSON.parse(await readBody(req));
      device = { ua: info.ua, href: info.href, at: Date.now(), screen: info.screen, viewport: info.viewport };
      console.log(`\n  device connected: ${info.ua}`);
      console.log(`  at ${info.href}`);
      if (info.screen) console.log(`  screen ${info.screen.w}x${info.screen.h} @${info.screen.dpr}x, viewport ${info.viewport.w}x${info.viewport.h}\n`);
      deviceWaiters.forEach((f) => f());
      deviceWaiters = [];
    } catch { /* a malformed hello is not worth failing the run over */ }
    return void res.writeHead(204).end();
  }

  if (url.pathname === "/poll") {
    if (!tokenOk) return void res.writeHead(403).end();
    const href = url.searchParams.get("href");
    if (device && href) { device.href = href; device.at = Date.now(); }
    // A poll is enough to count as connected. /hello carries richer detail
    // (screen, dpr) but is sent once at page load, so a relay restarted while
    // a device was already open would otherwise poll forever while /eval kept
    // answering "no device connected" — the device is plainly there, and the
    // UA header on this very request identifies it. Registering here makes the
    // relay recoverable without touching the device.
    if (!device) {
      device = { ua: String(req.headers["user-agent"] ?? "unknown (learned from poll)"), href: href ?? "?", at: Date.now() };
      console.log(`\n  device connected (via poll): ${device.ua}\n  at ${device.href}\n`);
      deviceWaiters.forEach((f) => f());
      deviceWaiters = [];
    }
    const queued = queue.shift();
    if (queued) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(queued));
    const send = (cmd: Command) => {
      clearTimeout(hold);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(cmd));
    };
    const hold = setTimeout(() => {
      pollers = pollers.filter((p) => p !== send);
      res.writeHead(204).end();
    }, POLL_HOLD_MS);
    res.on("close", () => { clearTimeout(hold); pollers = pollers.filter((p) => p !== send); });
    pollers.push(send);
    return;
  }

  if (url.pathname === "/result" && req.method === "POST") {
    if (!tokenOk) return void res.writeHead(403).end();
    try {
      const body = JSON.parse(await readBody(req));
      const waiter = waiters.get(body.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        waiters.delete(body.id);
        waiter.resolve({ ok: body.ok, value: body.value, href: body.href });
      }
    } catch { /* same */ }
    return void res.writeHead(204).end();
  }

  // Catch-all rather than an exact `/` match, so a mistyped path still lands
  // on the console instead of a 404 that looks like a dead server.
  if (tokenOk) {
    return void res
      .writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      .end(PAGE.replace("TOKEN_PLACEHOLDER", TOKEN));
  }

  res
    .writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    .end("remote console is running, but this request carried no valid token.\n" +
         "Open the URL printed when the script started, or just browse the app —\n" +
         "src/app/layout.tsx injects the client on every page when REMOTE_CONSOLE_SRC is set.\n");
});

// 0.0.0.0 on purpose, and the one real difference from scripts/probe-engine.ts,
// which binds 127.0.0.1 and so cannot be reached by the device it is meant to
// measure.
server.listen(PORT, "0.0.0.0", () => {
  const addrs = lanAddresses();
  console.log(`\nremote console on :${PORT} — Ctrl+C stops it and forgets everything.\n`);
  console.log("  On the phone (same Wi-Fi), open:");
  for (const a of addrs) console.log(`    http://${a}:${PORT}/?token=${TOKEN}`);
  console.log("\n  From this machine:");
  console.log(`    curl -s --data-binary 'document.title' localhost:${PORT}/eval`);
  console.log(`    curl -s --data-binary 'typeof Float16Array' 'localhost:${PORT}/eval?realm=both'`);
  console.log("\n  To reach the app's own DOM, put this in .env and restart the dev server:");
  console.log(`    REMOTE_CONSOLE_SRC=http://${addrs[0] ?? "127.0.0.1"}:${PORT}/client.js?token=${TOKEN}\n`);
});
