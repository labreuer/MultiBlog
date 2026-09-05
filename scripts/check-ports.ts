// `npm run check-ports` — the read-only port guard, also run in front of every
// `npm run e2e` (scripts/e2e.ts). The reasoning and the ownership rule live
// with the implementation in scripts/dev-servers.ts.
import { checkPorts } from "./dev-servers";

process.exit(checkPorts() ? 0 : 1);
