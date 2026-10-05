// Side effect only, and the config's first import: e2e telemetry is off in
// every process that loads `e2e.config.ts` (the CLI and each worker), even
// when someone runs the e2e CLI directly instead of `deno task e2e`. ES
// modules evaluate their imports in order, so this runs before
// `@e2e-dev/web` and the rest of the config are evaluated. The CLI decides
// whether to send at the end of the command and reads `process.env` then,
// so a run that started without these variables still sends nothing
// (`scripts/e2e/no-model.test.ts` checks this offline with
// `E2E_TELEMETRY_DEBUG=1`).

import process from "node:process";

process.env.E2E_TELEMETRY_DISABLED = "1";
process.env.DO_NOT_TRACK = "1";
