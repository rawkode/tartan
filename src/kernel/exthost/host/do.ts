// ExtensionDO (`ext:<instId>:node` | `ext:<instId>:repo:<repoUlid>`): hosts one
// installation scope. A thin adapter over `createExtensionHost` (host.ts),
// wired to this DO's storage, the kernel facades (`createKernelPorts`),
// ForgeDO's registry and the bundled builtins. It does not use the kernel DO
// host: a builtin extension's own tables share this database, so only
// `_`-prefixed host tables exist here (no `meta`); the host keeps its timers on
// `_timers` with the `host` and `ext` modules.

import { DurableObject } from "cloudflare:workers";
import { createUlid, FORGE_DO_NAME } from "@tartan/contract";
import { type ExtensionHostApi, systemClock } from "@tartan/contract/kernel.ts";
import { builtins } from "../../../builtins.ts";
import { EXT_DYNAMIC_ENABLED } from "../../../constants.ts";
import type { Env } from "../../../env.ts";
import { createKernelPorts } from "../../caps/ports.ts";
import { createBundledWasmLoader } from "./facet/bundled.ts";
import { BUNDLED_WASM } from "./facet/bundled-packages.ts";
import { createDynamicLoader } from "./facet/dynamic.ts";
import {
	platformFacetPort,
	r2PackageFiles,
	tailFor,
} from "./facet/platform.ts";
import { rpcBridge } from "./facet/rpc.ts";
import {
	createExtensionHost,
	type ExtensionHost,
	type HostDeps,
	type HostStorage,
	parseExtDoName,
} from "./host.ts";
import { registryInstallationSource } from "./installation.ts";
import { builtinPackageLoader, packageLoader } from "./runtime.ts";

export { EXT_TIMER_MODULES } from "./host.ts";

type Api<K extends keyof ExtensionHostApi> = ExtensionHostApi[K];

/**
 * The runtimes of one ExtensionDO: bundled builtins; js/wasm packages from
 * R2 as this DO's facet `main` (Worker Loader, `EXT_DYNAMIC_ENABLED`); the
 * `wasm-bundled` fallback for components this Worker bundles.
 */
export const extensionPackages = (ctx: DurableObjectState, env: Env) => {
	const name = ctx.id.name ?? "";
	return packageLoader({
		builtin: builtinPackageLoader(builtins),
		dynamic: createDynamicLoader({
			enabled: EXT_DYNAMIC_ENABLED,
			facets: platformFacetPort(
				ctx.facets,
				env.LOADER,
				() => parseExtDoName(name)?.installationId ?? "unknown",
				ctx.storage.kv,
			),
			files: r2PackageFiles(env.BLOBS),
			bridge: rpcBridge,
			tail: tailFor(ctx.exports),
			clock: systemClock,
		}),
		wasmBundled: createBundledWasmLoader(BUNDLED_WASM, systemClock),
		dynamicEnabled: EXT_DYNAMIC_ENABLED,
	});
};

/** The production wiring of one ExtensionDO's host. */
export const extensionHostDeps = (
	ctx: DurableObjectState,
	env: Env,
): HostDeps => ({
	name: ctx.id.name ?? "",
	storage: ctx.storage as unknown as HostStorage,
	clock: systemClock,
	ids: { ulid: createUlid() },
	kernel: createKernelPorts(env, ctx),
	installations: registryInstallationSource(() =>
		env.FORGE.getByName(FORGE_DO_NAME).registry()
	),
	packages: extensionPackages(ctx, env),
	log: (level, line) => {
		if (level === "error" || level === "warn") console.error(line);
		else console.log(line);
	},
});

export class ExtensionDO extends DurableObject<Env>
	implements ExtensionHostApi {
	#host: ExtensionHost;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#host = createExtensionHost(extensionHostDeps(ctx, env));
		void ctx.blockConcurrencyWhile(() => this.#host.ready());
	}

	/**
	 * Rewires a live instance with other ports (workerd tests, through
	 * `runInDurableObject`). Static, so it is not part of the RPC surface.
	 */
	static rewire(
		instance: ExtensionDO,
		overrides: (defaults: HostDeps) => HostDeps,
	): Promise<void> {
		instance.#host = createExtensionHost(
			overrides(extensionHostDeps(instance.ctx, instance.env)),
		);
		return instance.#host.ready();
	}

	poke(...args: Parameters<Api<"poke">>): ReturnType<Api<"poke">> {
		return this.#host.poke(...args);
	}

	render(...args: Parameters<Api<"render">>): ReturnType<Api<"render">> {
		return this.#host.render(...args);
	}

	action(...args: Parameters<Api<"action">>): ReturnType<Api<"action">> {
		return this.#host.action(...args);
	}

	/** `chain`: the `interfaces.call` chain (installation ids, outermost first). */
	callTool(
		...args: Parameters<ExtensionHost["callTool"]>
	): ReturnType<Api<"callTool">> {
		return this.#host.callTool(...args);
	}

	context(...args: Parameters<Api<"context">>): ReturnType<Api<"context">> {
		return this.#host.context(...args);
	}

	gate(...args: Parameters<Api<"gate">>): ReturnType<Api<"gate">> {
		return this.#host.gate(...args);
	}

	echo(...args: Parameters<Api<"echo">>): ReturnType<Api<"echo">> {
		return this.#host.echo(...args);
	}

	abort(...args: Parameters<Api<"abort">>): ReturnType<Api<"abort">> {
		return this.#host.abort(...args);
	}

	console(...args: Parameters<Api<"console">>): ReturnType<Api<"console">> {
		return this.#host.console(...args);
	}

	deadLetters(
		...args: Parameters<Api<"deadLetters">>
	): ReturnType<Api<"deadLetters">> {
		return this.#host.deadLetters(...args);
	}

	breaker(): ReturnType<Api<"breaker">> {
		return this.#host.breaker();
	}

	resetBreaker(
		...args: Parameters<Api<"resetBreaker">>
	): ReturnType<Api<"resetBreaker">> {
		return this.#host.resetBreaker(...args);
	}

	deleteData(): ReturnType<Api<"deleteData">> {
		return this.#host.deleteData();
	}

	override async alarm(): Promise<void> {
		await this.#host.alarm();
	}
}
