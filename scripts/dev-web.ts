// `npm run dev` — the Next dev server on this slot's WEB_PORT.
//
// A wrapper rather than a plain `"dev": "next dev"` because **a WEB_PORT or
// PORT line in .env cannot reach it**. Next's CLI wires --port to commander's
// `.default(3000).env('PORT')`, which is read while argv is parsed, and Next
// loads its own .env files later, inside next/dist/cli/next-dev.js. So by the
// time .env exists in process.env the port has already been decided. This was
// not a theoretical worry: the second checkout carried APP_URL=…:3002 for a
// while and still bound :3000 every time, because APP_URL only builds absolute
// links in email and nothing binds from it.
//
// Spawned straight onto next's bin with node — no `npx`, no `shell: true` — so
// the tree stays one layer deep and every process in it still carries this
// repo's absolute path in its command line. That is exactly what
// scripts/dev-servers.ts (behind `npm run stop:all` and `check-ports`) matches
// on to decide whether a process listening on one of our ports is ours to
// stop, so an extra shell wrapper would be a real cost, not a style question.
// scripts/resolve-from-root.ts is where the bin path comes from, and says why
// it resolves from cwd.
import { spawn } from "node:child_process";
import { DEV_HOST, WEB_PORT, webUrl } from "./dev-ports";
import { resolveFromRoot } from "./resolve-from-root";

const nextBin = resolveFromRoot("next/dist/bin/next");

// Printed because the port is no longer a constant anyone can assume: Next's
// own banner reports the port but not which slot's .env chose it.
console.log(`[dev-web] slot host ${DEV_HOST} — starting next dev on ${webUrl(WEB_PORT)}`);

const child = spawn(process.execPath, [nextBin, "dev", "-p", String(WEB_PORT)], {
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 1));
