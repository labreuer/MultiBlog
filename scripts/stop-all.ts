// `npm run stop:all` — stops this slot's dev:all tree and its e2e prod web
// server, after checking each port's owner really is this checkout. The
// ownership rule and the ancestor walk live in scripts/dev-servers.ts.
import { stopAll } from "./dev-servers";

// No top-level await: without `"type": "module"` tsx runs these scripts as
// CommonJS (scripts/dev-web.ts notes the same constraint around import.meta).
stopAll().then((code) => process.exit(code));
