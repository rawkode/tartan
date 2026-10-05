// KernelCaps (K12): the capability surface for `js`/`wasm` extensions, minted
// per call as `loopback(ctx).KernelCaps({ props })` and passed to the facet
// method as an RPC argument, never placed in a Dynamic Worker's `env` (that env
// is frozen with the cached isolate, so the first caller's actor would
// stick). A stub passed this way is opaque to the extension and valid only for
// the call it was passed into. The props (`CapsProps`) are invisible to
// the extension; every method re-checks them through `createKernelCaps`
// (grants, mode, read-only, K12 confinement, the actor).
//
// Each namespace is a method returning an `RpcTarget` (`caps.repo().info(…)`
// pipelines in one round trip). workerd does not pipeline a call through a
// getter of an entrypoint stub ("The RPC receiver does not implement the
// method", measured in the vitest pool), so namespaces are methods, and
// `capsOverStub` gives the `KernelCaps` shape back on the caller's side (the
// facet shim, M2). Timers are not served here: the shim buffers `set-timer`
// and the host applies it after the export returns.

import { WorkerEntrypoint } from "cloudflare:workers";
import {
	type CapsNamespace,
	type CapsProps,
	createUlid,
	FORGE_DO_NAME,
	type KernelCaps as KernelCapsApi,
	type Manifest,
} from "@tartan/contract";
import { type ForgeDoApi, systemClock } from "@tartan/contract/kernel.ts";
import { withRpc } from "../../do/dispose.ts";
import { rpcFacade } from "../../do/rpc.ts";
import type { Env } from "../../env.ts";
import { createKernelCaps } from "./caps.ts";
import { createKernelPorts } from "./ports.ts";

const ids = { ulid: createUlid() };

/** Every namespace of `KernelCaps`, in contract order. */
export const CAPS_NAMESPACES = [
	"repo",
	"lanes",
	"land",
	"runs",
	"notes",
	"events",
	"notify",
	"authz",
	"principals",
	"interfaces",
	"timers",
	"agents",
	"ai",
	"clock",
	"ids",
] as const satisfies readonly CapsNamespace[];

/** A KernelCaps stub as RPC exposes it: one method per namespace. */
export type KernelCapsStub = {
	readonly [N in CapsNamespace]: () => KernelCapsApi[N];
};

/**
 * The `KernelCaps` shape over an entrypoint stub, so code written against
 * the contract (`caps.repo.info(…)`) runs unchanged; each call still
 * pipelines `namespace().method(…)` into one RPC and disposes the
 * namespace stub once the call settles.
 */
export const capsOverStub = (stub: KernelCapsStub): KernelCapsApi =>
	Object.fromEntries(
		CAPS_NAMESPACES.map((ns) => [
			ns,
			new Proxy({}, {
				// `then` and symbols stay undefined: a namespace is not a thenable.
				get: (_target, method) =>
					typeof method !== "string" || method === "then"
						? undefined
						: (...args: unknown[]) =>
							withRpc(
								() =>
									stub[ns]() as unknown as Record<
										string,
										(...a: unknown[]) => unknown
									>,
								(facade) => facade[method](...args),
							),
			}),
		]),
	) as unknown as KernelCapsApi;

export class KernelCaps extends WorkerEntrypoint<Env, CapsProps> {
	#caps: KernelCapsApi | undefined;

	#api(): KernelCapsApi {
		if (this.#caps === undefined) {
			const props = this.ctx.props;
			const env = this.env;
			// K10 needs the manifest's `provides` and `caps.repo.policy` its
			// `config.repoPolicy`, which CapsProps does not carry: one lookup.
			let manifest: Promise<Manifest | null> | undefined;
			const manifestOf = () =>
				manifest ??= (async () => {
					const forge = env.FORGE.getByName(FORGE_DO_NAME) as unknown as Pick<
						ForgeDoApi,
						"registry"
					>;
					const packages = await withRpc(
						() => forge.registry(),
						(registry) => registry.packages(props.extId),
					);
					return packages.find((p) => p.version === props.version)?.manifest ??
						null;
				})();
			this.#caps = createKernelCaps(props, createKernelPorts(env, this.ctx), {
				clock: systemClock,
				ids,
				provides: async () => (await manifestOf())?.provides ?? [],
				repoPolicyKeys: async () =>
					(await manifestOf())?.config?.repoPolicy ?? [],
			});
		}
		return this.#caps;
	}

	repo() {
		return rpcFacade("caps.repo", this.#api().repo);
	}

	lanes() {
		return rpcFacade("caps.lanes", this.#api().lanes);
	}

	land() {
		return rpcFacade("caps.land", this.#api().land);
	}

	runs() {
		return rpcFacade("caps.runs", this.#api().runs);
	}

	notes() {
		return rpcFacade("caps.notes", this.#api().notes);
	}

	events() {
		return rpcFacade("caps.events", this.#api().events);
	}

	notify() {
		return rpcFacade("caps.notify", this.#api().notify);
	}

	authz() {
		return rpcFacade("caps.authz", this.#api().authz);
	}

	principals() {
		return rpcFacade("caps.principals", this.#api().principals);
	}

	interfaces() {
		return rpcFacade("caps.interfaces", this.#api().interfaces);
	}

	timers() {
		return rpcFacade("caps.timers", this.#api().timers);
	}

	agents() {
		return rpcFacade("caps.agents", this.#api().agents);
	}

	ai() {
		return rpcFacade("caps.ai", this.#api().ai);
	}

	clock() {
		return rpcFacade("caps.clock", this.#api().clock);
	}

	ids() {
		return rpcFacade("caps.ids", this.#api().ids);
	}
}
