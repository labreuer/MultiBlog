// Feature-probes a real browser engine for the built-ins pdfjs-dist assumes,
// in **both** realms — main thread and module worker.
//
// Why this exists: `src/lib/pdfjs-webkit-polyfills.ts` patches built-ins WebKit
// ships late or not at all, and every one of those patches is invisible to
// `npx tsc`, `npx eslint` and the e2e suite, which run chromium. The suite
// covers them by *deleting* each built-in (e2e/pdf-webkit-gaps.spec.ts), which
// proves the polyfill works but says nothing about whether it is still needed.
// This answers the other half: what does the engine actually have today.
//
// Playwright's webkit is not a substitute — it will not launch on every
// machine (playwright.config.ts records the macOS 14 pin), and it is a bundled
// build rather than the Safari a reader will use. This drives the real one.
//
// Usage:
//   npx tsx scripts/probe-engine.ts              # opens Safari (macOS default)
//   BROWSER="Google Chrome" npx tsx scripts/probe-engine.ts
//   PROBE_PORT=4321 npx tsx scripts/probe-engine.ts
//
// Prints a two-realm table and exits. Nothing is written to disk and no state
// outlives the run; close the tab it opens. Record results in docs/PDF.md §10's
// *Engine coupling* table, whose measured column comes from exactly this.
//
// Adding a check: append one line to PROBE. Keep it a `typeof` test with no
// side effects — it runs in a worker realm too, where most DOM globals are
// absent, so guard anything not defined in both (see the ReadableStream lines).

import http from "node:http";
import { execFile } from "node:child_process";

const PORT = Number(process.env.PROBE_PORT ?? 4321);
const BROWSER = process.env.BROWSER ?? "Safari";

/** One source string, run in both realms — same discipline as the polyfill file. */
const PROBE = `
const has = {};
has["Iterator (global)"]                 = typeof Iterator !== "undefined";
has["Iterator.prototype.join"]           = typeof Iterator !== "undefined" && typeof Iterator.prototype.join === "function";
has["Map.prototype.getOrInsert"]         = typeof Map.prototype.getOrInsert === "function";
has["Map.prototype.getOrInsertComputed"] = typeof Map.prototype.getOrInsertComputed === "function";
has["ReadableStream[asyncIterator]"]     = typeof ReadableStream !== "undefined" && typeof ReadableStream.prototype[Symbol.asyncIterator] === "function";
has["ReadableStream.prototype.values"]   = typeof ReadableStream !== "undefined" && typeof ReadableStream.prototype.values === "function";
has["URL.parse"]                         = typeof URL.parse === "function";
has["URL.canParse"]                      = typeof URL.canParse === "function";
has["Response.prototype.bytes"]          = typeof Response !== "undefined" && typeof Response.prototype.bytes === "function";
has["Uint8Array.fromBase64"]             = typeof Uint8Array.fromBase64 === "function";
has["Uint8Array.prototype.toBase64"]     = typeof Uint8Array.prototype.toBase64 === "function";
has["Uint8Array.prototype.toHex"]        = typeof Uint8Array.prototype.toHex === "function";
has["Float16Array"]                      = typeof Float16Array !== "undefined";
has["Promise.withResolvers"]             = typeof Promise.withResolvers === "function";
has["AbortSignal.any"]                   = typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function";
has["Set.prototype.intersection"]        = typeof Set.prototype.intersection === "function";
has["DecompressionStream"]               = typeof DecompressionStream !== "undefined";
`;

// The worker is built as a Blob module for the same reason ensurePdfWorker does
// it (src/lib/pdfjs-client.ts): it needs no bundler and no file on disk.
const PAGE = `<!doctype html><meta charset=utf-8><title>engine probe</title>
<body style="font:14px system-ui;padding:2rem">Probing…
<script type="module">
${PROBE}
const src = ${JSON.stringify(PROBE + "\nself.postMessage(has);\n")};
const w = new Worker(URL.createObjectURL(new Blob([src], {type:"text/javascript"})), {type:"module"});
const worker = await new Promise((res) => {
  w.onmessage = (e) => res(e.data);
  w.onerror = (e) => res({ ERROR: String(e.message || e) });
});
await fetch("/results", { method:"POST", headers:{"content-type":"application/json"},
  body: JSON.stringify({ ua: navigator.userAgent, main: has, worker }) });
document.body.textContent = "Done — you can close this tab.";
</script>`;

type Realm = Record<string, boolean>;

function report({ ua, main, worker }: { ua: string; main: Realm; worker: Realm }): void {
  console.log(`\n${ua}\n`);
  const width = Math.max(...Object.keys(main).map((k) => k.length));
  const cell = (v: boolean | undefined) => (v === undefined ? "?  " : v ? "yes" : "NO ");
  console.log(`${"".padEnd(width)}  main  worker`);
  for (const key of Object.keys(main)) {
    console.log(`${key.padEnd(width)}  ${cell(main[key])}   ${cell(worker[key])}`);
  }
  const missing = Object.keys(main).filter((k) => !main[k] || !worker[k]);
  console.log(
    missing.length
      ? `\nAbsent (a polyfill for each of these still does real work):\n  ${missing.join("\n  ")}`
      : "\nEvery probed built-in is present in both realms.",
  );
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/results") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(204).end();
      server.close();
      report(JSON.parse(body));
      process.exit(0);
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`probe listening on ${url} — opening ${BROWSER}`);
  execFile("open", ["-a", BROWSER, url], (err) => {
    if (err) console.log(`couldn't open ${BROWSER} automatically; visit ${url} yourself`);
  });
});

setTimeout(() => {
  console.error("timed out waiting for the browser to report back");
  process.exit(1);
}, 120_000);
