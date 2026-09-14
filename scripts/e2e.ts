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
//   npm run e2e:firefox / npm run e2e:webkit
//                      the prod target on one of the two engines that are off
//                      by default (playwright.config.ts says why, and
//                      e2e/README.md what each is for).
//
// All of them do the same two things:
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

const args = process.argv.slice(3);

// The firefox and webkit projects only exist when their env var is set
// (playwright.config.ts says why they are off by default), so asking for one
// by `--project` alone used to fail with "Project(s) 'webkit' not found" —
// a flag that names the thing you want and then denies it exists. Reading the
// flag back here closes that: `npm run e2e -- --project=webkit` is the whole
// command. Both spellings, because Playwright accepts both.
const projects = args.flatMap((arg, i) => {
  if (arg.startsWith("--project=")) return [arg.slice("--project=".length)];
  if (arg === "--project" && args[i + 1]) return [args[i + 1]];
  return [];
});
const engineEnv: Record<string, string> = {};
if (projects.includes("firefox")) engineEnv.E2E_FIREFOX = "1";
if (projects.includes("webkit")) engineEnv.E2E_WEBKIT = "1";

const child = spawn(process.execPath, [resolveFromRoot("@playwright/test/cli"), "test", ...args], {
  stdio: "inherit",
  env: { ...process.env, ...engineEnv, E2E_TARGET: target },
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
