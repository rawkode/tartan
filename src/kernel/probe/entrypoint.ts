// RepoProbe: a stateless WorkerEntrypoint for
// CPU-heavy, cacheable git reads (the one K17 lane-range diff per push, read
// in the repo that holds the head; hash-pruned tree diff, hunks, merge3,
// project graph at a commit, affected closure, subtree hashes, added lines),
// keeping CPU off RepoDO and ExtensionDO. Kernel callers reach it as
// `loopback(ctx).RepoProbe` (`src/exports.ts`); methods take repo-scoped
// arguments (`GitSource`, repo id), never an Artifacts name.
//
// A thin adapter (house style): every RPC method is a prototype method that
// delegates to `createRepoProbe(probeDepsFromEnv(env))` (probe.ts).

import { WorkerEntrypoint } from "cloudflare:workers";
import type { RepoProbeApi } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { probeDepsFromEnv } from "./env.ts";
import { createRepoProbe } from "./probe.ts";

type Api<K extends keyof RepoProbeApi> = RepoProbeApi[K];

export class RepoProbe extends WorkerEntrypoint<Env> implements RepoProbeApi {
	#api: RepoProbeApi | null = null;

	#probe(): RepoProbeApi {
		return this.#api ??= createRepoProbe(probeDepsFromEnv(this.env));
	}

	laneDiff(...args: Parameters<Api<"laneDiff">>): ReturnType<Api<"laneDiff">> {
		return this.#probe().laneDiff(...args);
	}

	diffPaths(
		...args: Parameters<Api<"diffPaths">>
	): ReturnType<Api<"diffPaths">> {
		return this.#probe().diffPaths(...args);
	}

	hunks(...args: Parameters<Api<"hunks">>): ReturnType<Api<"hunks">> {
		return this.#probe().hunks(...args);
	}

	merge3(...args: Parameters<Api<"merge3">>): ReturnType<Api<"merge3">> {
		return this.#probe().merge3(...args);
	}

	diff(...args: Parameters<Api<"diff">>): ReturnType<Api<"diff">> {
		return this.#probe().diff(...args);
	}

	projectGraph(
		...args: Parameters<Api<"projectGraph">>
	): ReturnType<Api<"projectGraph">> {
		return this.#probe().projectGraph(...args);
	}

	affected(...args: Parameters<Api<"affected">>): ReturnType<Api<"affected">> {
		return this.#probe().affected(...args);
	}

	treeHash(...args: Parameters<Api<"treeHash">>): ReturnType<Api<"treeHash">> {
		return this.#probe().treeHash(...args);
	}

	addedLines(
		...args: Parameters<Api<"addedLines">>
	): ReturnType<Api<"addedLines">> {
		return this.#probe().addedLines(...args);
	}
}
