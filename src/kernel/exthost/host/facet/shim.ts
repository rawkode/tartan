// The host-authored main module of every js/wasm Dynamic Worker: it imports the
// package (a js module, or the jco glue and its core modules), embeds
// `facetCore` (core.ts) as source text and exports `ExtFacet`, the Durable
// Object class the installation's ExtensionDO runs as its facet `main`. `env`
// carries nothing; every call receives its capabilities as an argument.

import { facetCore } from "./core.ts";

export const SHIM_MODULE = "shim.js";
export const FACET_CLASS = "ExtFacet";

export type ShimSpec =
	| { readonly kind: "js"; readonly entry: string }
	| {
		readonly kind: "wasm";
		readonly glue: string;
		readonly cores: readonly string[];
	};

const MODULE_PATH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

const modulePath = (path: string): string => {
	const segments = path.split("/");
	if (
		!MODULE_PATH_RE.test(path) ||
		segments.some((s) => s === "" || s === "." || s === "..")
	) {
		throw new Error(`not a package module path: ${path}`);
	}
	return JSON.stringify(`./${path}`);
};

/** The shim's source for a package. */
export const facetShimSource = (spec: ShimSpec): string => {
	const imports = spec.kind === "js"
		? [`import * as main from ${modulePath(spec.entry)};`]
		: [
			`import { instantiate } from ${modulePath(spec.glue)};`,
			...spec.cores.map((path, i) =>
				`import core${i} from ${modulePath(path)};`
			),
		];
	const program = spec.kind === "js"
		? `() => ({ kind: "js", module: main.default ?? main.extension ?? main })`
		: `() => ({ kind: "wasm", instantiate, getCoreModule: (path) => {
		const core = CORES[path];
		if (core === undefined) throw new Error("no core module " + path);
		return core;
	} })`;
	const cores = spec.kind === "wasm"
		? `const CORES = { ${
			spec.cores.map((path, i) => `${JSON.stringify(path)}: core${i}`).join(
				", ",
			)
		} };`
		: "";
	return `// Tartan extension facet (host-authored shim).
import { DurableObject } from "cloudflare:workers";
${imports.join("\n")}

// The bundler may name functions through a helper; the embedded core needs none.
const __name = (target) => target;
const facetCore = ${facetCore.toString()};
const core = facetCore();
${cores}

export class ${FACET_CLASS} extends DurableObject {
	#runtime;
	constructor(ctx, env) {
		super(ctx, env);
		this.#runtime = core.facetRuntime(ctx.storage, ${program});
	}
	hooks() {
		return this.#runtime.hooks();
	}
	migrate(migrations, now) {
		return this.#runtime.migrate(migrations, now);
	}
	invoke(hook, args, env, caps) {
		return this.#runtime.invoke(hook, args, env, caps);
	}
	query(sql, bindings) {
		return this.#runtime.query(sql, ...(bindings ?? []));
	}
}

export default {
	fetch() {
		return new Response("not found", { status: 404 });
	},
};
`;
};
