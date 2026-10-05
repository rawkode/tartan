// Vitest config for the SPA (`web` project; WP18).
//
// SPA tests do not need workerd, so this config is standalone: it does NOT
// extend the root config (whose `cloudflareTest` plugin targets the Worker).
// No DOM library is a dependency, so components mount with an in-memory Vue
// renderer (`test/support/renderer.ts`: real lifecycle, `v-model`, events)
// or render to strings with `@vue/server-renderer`; DOM-facing modules (the
// fragment hand-off, the live socket, timers) take their globals as explicit
// dependencies so tests pass fakes. Run: `node node_modules/vitest/vitest.mjs run --config
// web/vitest.config.ts` (or `--project web` once the root config lists this
// file in `test.projects`).

import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromHere = (path: string): string =>
	fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
	root: fromHere("."),
	plugins: [vue()],
	resolve: {
		alias: [
			{
				find: /^@tartan\/contract\/(.*)$/,
				replacement: fromHere("../packages/contract/src/$1"),
			},
		],
	},
	test: {
		name: "web",
		// Node, but modules are transformed as for the browser (client SFCs).
		environment: fromHere("./test/support/client-environment.ts"),
		include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
		exclude: ["**/node_modules/**"],
	},
});
