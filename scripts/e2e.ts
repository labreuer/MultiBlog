// The Playwright suite, against one of two targets (playwright.config.ts):
//
//   npm run e2e        `tsx scripts/e2e.ts prod`
//                      the full suite against a production build on
//                      WEB_PORT + 2 (E2E_TARGET=prod), the machine-derived
//                      worker count;
//   npm run e2e:dev    `tsx scripts/e2e.ts dev`
//                      the dev-server target on WEB_PORT, one worker — the
//                      loop for iterating on a single spec against a
//                      `dev:all` you already have running.
//
// Both do the same two things:
//
//   1. the read-only port guard (scripts/dev-servers.ts) — refuses to run if a
//      process from another project holds one of this slot's ports, because
//      Playwright would otherwise adopt it silently;
//   2. `playwright test` with E2E_TARGET set, every extra argument forwarded,
//      so `npm run e2e -- --reporter=list,json` and
//      `npm run e2e:dev -- e2e/doc.spec.ts -g title` both work.
//
// The exit code is Playwright's: this process ends with the child's status, so
// `npm run e2e > e2e.log 2>&1` still reports pass/fail through `$?` the way
// CLAUDE.md's capture recipe relies on. Setting the env var here rather than
// in the npm script is what makes the one command line work on every OS —
// `VAR=x cmd` is a POSIX-shell construct and `$env:VAR` a PowerShell one.
import { spawn } from "node:child_process";
import { checkPorts } from "./dev-servers";
import { resolveFromRoot } from "./resolve-from-root";

const target = process.argv[2];
if (target !== "prod" && target !== "dev") {
  console.error("usage: tsx scripts/e2e.ts <prod|dev> [playwright args]");
  process.exit(2);
}

if (!checkPorts()) process.exit(1);

const child = spawn(process.execPath, [resolveFromRoot("@playwright/test/cli"), "test", ...process.argv.slice(3)], {
  stdio: "inherit",
  env: { ...process.env, E2E_TARGET: target },
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
