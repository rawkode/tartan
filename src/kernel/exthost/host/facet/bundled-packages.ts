// The components this Worker bundles for the `wasm-bundled` fallback. Empty by
// default: a deploy that builds them (`deno task build:ext <name>` writes
// `extensions/<name>/dist/bundled.js`) lists them here through the build's
// module alias; until then a `wasm` installation needs the dynamic runtime
// (`EXT_DYNAMIC_ENABLED`).

import type { BundledWasm } from "./bundled.ts";

export const BUNDLED_WASM: readonly BundledWasm[] = [];
