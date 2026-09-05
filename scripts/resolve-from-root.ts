// Resolve a module specifier from the project root — a dependency's CLI entry
// point (`next/dist/bin/next`, `prisma/build/index.js`) or its package.json —
// so a script can run that dependency as `node <entry>` rather than through
// the shell.
//
// **This is the one way the scripts here spawn a package's binary.** Not
// `npx <bin>` and not `shell: true`: a shell wrapper adds a layer to the
// process tree, and on Windows every npm bin is a `.cmd` shim that needs one,
// with argument quoting that is its own problem (a checkout path with a space
// breaks it). Spawning `process.execPath` on the resolved entry sidesteps all
// of that, and keeps this repo's absolute path in the child's command line,
// which is what scripts/dev-servers.ts's ownership test reads. The single
// exception is `npm run <script>` itself — prod-web.ts builds through it so
// `prebuild` still runs — and that spawn keeps a win32-only `shell: true`
// because npm is `npm.cmd` there.
//
// Two things here look odd and have one cause: package.json has no
// `"type": "module"`, so tsx compiles these scripts as CommonJS, where
// `import.meta` is unavailable (and so is top-level await — stop-all.ts uses
// `.then()` for the same reason). Hence `createRequire` anchored on
// `process.cwd()` rather than on this file's URL. npm scripts always run from
// the root, and dev-ports.ts's `dotenv/config` already reads `.env` from cwd,
// so cwd is the project by construction.
import { createRequire } from "node:module";
import { join } from "node:path";

const projectRequire = createRequire(join(process.cwd(), "package.json"));

/** Absolute path of `specifier` as resolved from the project root. */
export function resolveFromRoot(specifier: string): string {
  return projectRequire.resolve(specifier);
}
