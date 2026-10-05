// Vite config for the Tartan SPA (WP18).
//
// Run from the repo root: `deno task build:web` (→ `vite build web`), which makes
// `web/` the Vite root, so this file is picked up and output lands in `web/dist`.
// The Worker serves `web/dist` as static assets with `run_worker_first: true` and
// `not_found_handling: "single-page-application"`: the
// router claims `/-/api`, git, MCP and the other kernel paths first, and every
// other path falls back to `index.html`, where vue-router takes over.
//
// CSP on the shell forbids inline scripts, so the build
// emits module scripts only, and `cspGuard` FAILS the build if the emitted
// index.html carries an inline script, an inline event handler or a `style`
// attribute. `vite preview` serves the same CSP header as the Worker so a
// local run exercises it. Hashed bundles go under `/assets/` (a reserved root
// slug, so it can never collide with a user or group path).
//
// `@tartan/contract` is imported for TYPES (web/tsconfig.json `paths`), plus
// VALUES from the zod-free modules in `CONTRACT_RUNTIME` only (the slot
// catalogue and the slot ctx rule, which the SPA must share with the kernel).
// `contractRuntime` resolves those and FAILS the build on any other value
// import from the contract, and on any contract module that would pull zod
// into the browser bundle.
//
// `VITE_TARTAN_MOCK=1` builds against the in-browser mock API
// (`src/api/mock`); production builds tree-shake it away.

import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { cspProblems, SHELL_CSP } from "./csp.ts";

const CONTRACT_SRC = fileURLToPath(
	new URL("../packages/contract/src/", import.meta.url),
);

/** Contract modules the SPA may import values from: zod-free by design. */
const CONTRACT_RUNTIME: ReadonlySet<string> = new Set([
	"paths.ts",
	"slots.ts",
	"slot-ctx.ts",
]);

const contractRuntime = (): Plugin => ({
	name: "tartan-contract-runtime",
	enforce: "pre",
	resolveId(source, importer) {
		const m = /^@tartan\/contract\/(.+)$/.exec(source);
		if (m) {
			if (!CONTRACT_RUNTIME.has(m[1]!)) {
				this.error(
					`value import of @tartan/contract/${m[1]}: only ${
						[...CONTRACT_RUNTIME].join(", ")
					} are zod-free; import types with \`import type\``,
				);
			}
			return `${CONTRACT_SRC}${m[1]}`;
		}
		if (
			(source === "zod" || source.startsWith("zod/")) &&
			importer?.startsWith(CONTRACT_SRC)
		) {
			this.error(`${importer} would pull zod into the browser bundle`);
		}
		return null;
	},
});

const cspGuard = (): Plugin => ({
	name: "tartan-csp-guard",
	apply: "build",
	transformIndexHtml: {
		order: "post",
		handler: (html) => {
			const problems = cspProblems(html);
			if (problems.length > 0) {
				throw new Error(
					`index.html violates the shell CSP: ${problems.join(", ")}`,
				);
			}
			return html;
		},
	},
});

const SECURITY_HEADERS = {
	"Content-Security-Policy": SHELL_CSP,
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "same-origin",
};

export default defineConfig({
	base: "/",
	plugins: [contractRuntime(), vue(), cspGuard()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
		assetsDir: "assets",
		sourcemap: false,
	},
	preview: {
		headers: SECURITY_HEADERS,
	},
});
