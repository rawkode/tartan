// The platform side of the dynamic runtimes: the
// ExtensionDO's facet `main` over `ctx.facets` and the Worker Loader, the
// package files in R2 and the tail sink. Worker code only (it names
// platform types; the logic it feeds is in dynamic.ts).

import type { InstallationSnapshot } from "../installation.ts";
import type { ExtTailProps } from "../tail-lines.ts";
import type {
	FacetCode,
	FacetPort,
	FacetStub,
	PackageFiles,
} from "./dynamic.ts";
import { FACET_CLASS } from "./shim.ts";

export const FACET_NAME = "main";

/** Host kv key of the Dynamic Worker generation (bumped by `reset`). */
export const FACET_GENERATION_KEY = "_tartan:facet-generation";

/** `<loader id>` for generation 0, else `<loader id>:g<n>`. */
export const generationLoaderId = (loaderId: string, generation: number) =>
	generation > 0 ? `${loaderId}:g${generation}` : loaderId;

/**
 * The installation's facet: synthetic id `ext:<instId>` [E B4]. `reset`
 * moves the installation to a fresh Dynamic Worker (the generation lives in
 * the ExtensionDO's own kv, so a restart keeps it).
 */
export const platformFacetPort = (
	facets: DurableObjectFacets,
	loader: WorkerLoader,
	installationId: () => string,
	kv: Pick<SyncKvStorage, "get" | "put">,
): FacetPort => {
	const abort = (reason: string) => {
		try {
			facets.abort(FACET_NAME, new Error(`extension aborted: ${reason}`));
		} catch {
			// Not running: nothing to abort.
		}
	};
	return {
		get: (loaderId, code, cpuMs) =>
			facets.get(FACET_NAME, () => ({
				class: loader.get(
					generationLoaderId(
						loaderId,
						kv.get<number>(FACET_GENERATION_KEY) ?? 0,
					),
					code as unknown as () => Promise<WorkerLoaderWorkerCode>,
				).getDurableObjectClass(
					FACET_CLASS,
					cpuMs === undefined ? undefined : { limits: { cpuMs } },
				),
				id: `ext:${installationId()}`,
			})) as unknown as FacetStub,
		abort,
		reset: (reason) => {
			kv.put(
				FACET_GENERATION_KEY,
				(kv.get<number>(FACET_GENERATION_KEY) ?? 0) + 1,
			);
			abort(reason);
		},
		delete: () => {
			abort("extension data deleted");
			facets.delete(FACET_NAME);
		},
	};
};

/** A package's files under its R2 prefix. */
export const r2PackageFiles =
	(blobs: Pick<R2Bucket, "get">) =>
	(prefix: string): PackageFiles =>
	async (path) => {
		const object = await blobs.get(`${prefix}${path}`);
		return object === null ? null : new Uint8Array(await object.arrayBuffer());
	};

/** The tail sink of one installation's Dynamic Worker (props frozen per loader id). */
export const tailFor =
	(exports: unknown) => (snapshot: InstallationSnapshot): unknown => {
		const props: ExtTailProps = {
			inst: snapshot.installation.id,
			extId: snapshot.manifest.id,
			version: snapshot.installation.version,
			scopeKey: snapshot.installation.storageScope,
		};
		const sink = (exports as {
			readonly ExtTail?: (o: { props: ExtTailProps }) => unknown;
		}).ExtTail;
		return sink === undefined ? undefined : sink({ props });
	};

export type { FacetCode };
