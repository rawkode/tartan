// Reading CI policy at the change's base on trunk (K13; ADR repo config):
// the pipeline is `tartan.ci`'s repo policy in the
// repository's package `tartan` (`extensions: "tartan.ci": settings:
// pipeline`), read through `caps.repo.policy` at the **base** (a trunk
// commit), plus the project graph at the base; in zero-config mode the test
// scripts it would use are read at the base too. Nothing here ever reads the
// lane, revision or candidate, and nothing here runs CUE.
//
// - no Tartan config, or no pipeline in it → zero-config detection;
// - `pending` (the base's config is still evaluating) → the check waits
//   (lands of the repo are held anyway, K13.1);
// - `exact: false` (the base's config does not evaluate) → the last good
//   pipeline, said so in the check detail: failing instead would also fail
//   the change that fixes the config, which is tested with its base;
//   review routes such changes to a person;
// - `expired` (a base older than the kept history) → invalid: sync the lane.

import type {
	ExtCtx,
	ProjectGraph,
	RepoPolicyAnswer,
	RepoRef,
} from "@tartan/contract";
import {
	type Pipeline,
	PIPELINE_LOCATION,
	PIPELINE_POLICY_KEY,
	validatePipeline,
	type ZeroConfig,
	zeroConfigOf,
	zeroPipeline,
} from "./pipeline/index.ts";
import type { TestCommand } from "./store.ts";

/** Manifests larger than this are not read for zero-config scripts. */
const MANIFEST_MAX_BYTES = 256 * 1024;

export type Policy =
	| {
		readonly mode: "pipeline";
		readonly sha: string;
		readonly graph: ProjectGraph;
		readonly pipeline: Pipeline;
		/** Set when the base's config does not evaluate (the last good pipeline). */
		readonly lastGood?: string;
	}
	| {
		readonly mode: "zero";
		readonly sha: string;
		readonly graph: ProjectGraph;
		readonly pipeline: Pipeline;
		readonly zero: ZeroConfig;
		readonly lastGood?: string;
	}
	| {
		readonly mode: "invalid";
		readonly sha: string;
		readonly graph: ProjectGraph;
		readonly errors: readonly string[];
	}
	| {
		/** The base's Tartan config is still evaluating: plan again once it resolves. */
		readonly mode: "pending";
		readonly sha: string;
		readonly graph: ProjectGraph;
	};

const decoder = new TextDecoder();

/** A file at `sha` as text; null when absent or larger than `max`. */
export const readText = async (
	x: ExtCtx,
	repo: RepoRef,
	sha: string,
	path: string,
	max: number,
): Promise<string | null> => {
	const bytes = await x.caps.repo.readFile(repo, sha, path, max + 1);
	if (bytes === null || bytes.length > max) return null;
	return decoder.decode(bytes);
};

/** The check-detail line of a not-exact answer (the last good pipeline is used). */
export const lastGoodNote = (
	answer: Extract<RepoPolicyAnswer, { state: "ok" }>,
): string | undefined => {
	if (answer.exact) return undefined;
	const failed = answer.failed;
	const where = failed?.issues[0]?.pos[0];
	const what = failed === undefined
		? "does not evaluate"
		: `does not evaluate${where ? `: ${where}` : ""} ${failed.message}`;
	return `tartan config at ${
		failed?.sha.slice(0, 12) ?? "trunk"
	} ${what}; using the pipeline from ${answer.configSha.slice(0, 12)}`
		.slice(0, 500);
};

/**
 * The policy at `base` (a trunk commit). `graph` reuses a graph the caller
 * already read at `base`; `only` limits zero-config script reads to those
 * projects (the affected ones: one manifest read each).
 */
export const loadPolicy = async (
	x: ExtCtx,
	repo: RepoRef,
	base: string,
	options: {
		readonly graph?: ProjectGraph;
		readonly only?: ReadonlySet<string>;
	} = {},
): Promise<Policy> => {
	const [answer, graph] = await Promise.all([
		x.caps.repo.policy(repo, base),
		options.graph ?? x.caps.repo.projectGraph(repo, base),
	]);
	if (answer.state === "pending") return { mode: "pending", sha: base, graph };
	if (answer.state === "expired") {
		return {
			mode: "invalid",
			sha: base,
			graph,
			errors: [
				"the change's base is older than the trunk config history kept by the forge; sync the lane onto trunk",
			],
		};
	}
	const lastGood = answer.state === "ok" ? lastGoodNote(answer) : undefined;
	const value = answer.state === "ok"
		? answer.values[PIPELINE_POLICY_KEY]
		: undefined;
	if (value !== undefined) {
		const checked = validatePipeline(value);
		return checked.ok
			? {
				mode: "pipeline",
				sha: base,
				graph,
				pipeline: checked.pipeline,
				...(lastGood === undefined ? {} : { lastGood }),
			}
			: {
				mode: "invalid",
				sha: base,
				graph,
				errors: checked.errors.map((e) => `${PIPELINE_LOCATION}: ${e}`),
			};
	}
	const only = options.only;
	const zero = await zeroConfigOf(
		only === undefined
			? graph.projects
			: graph.projects.filter((p) => only.has(p.name)),
		(path) => readText(x, repo, base, path, MANIFEST_MAX_BYTES),
		{
			workspace: graph.projects.length > 0,
			pnpmLock: graph.projects.length === 0 &&
				(await x.caps.repo.readFile(repo, base, "pnpm-lock.yaml", 1)) !== null,
		},
	);
	return {
		mode: "zero",
		sha: base,
		graph,
		pipeline: zeroPipeline(zero),
		zero,
		...(lastGood === undefined ? {} : { lastGood }),
	};
};

/** Per-project test commands of a policy (context@1 "test-commands"). */
export const testCommandsOf = (policy: Policy): TestCommand[] => {
	if (policy.mode === "invalid" || policy.mode === "pending") return [];
	const jobs = policy.pipeline.jobs.filter((j) =>
		policy.pipeline.on.change.includes(j.id)
	);
	const out: TestCommand[] = [];
	for (
		const p of [...policy.graph.projects].sort((a, b) =>
			a.name.localeCompare(b.name)
		)
	) {
		const commands = jobs
			.filter((j) =>
				j.project === p.name ||
				(j.project === undefined && j.each !== undefined)
			)
			.map((j) => {
				const sub = (s: string) =>
					s.replace(
						/\{\{\s*project\.(root|name)\s*\}\}/g,
						(_, k: string) => (k === "root" ? p.root : p.name),
					);
				const cwd = j.cwd === undefined ? undefined : sub(j.cwd);
				return {
					context: `${j.name ?? j.id}:${p.name}`,
					run: sub(j.run),
					...(cwd ? { cwd } : {}),
				};
			});
		if (commands.length > 0) {
			out.push({ project: p.name, root: p.root, commands });
		}
	}
	return out;
};
