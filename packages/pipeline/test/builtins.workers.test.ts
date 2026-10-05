/// <reference types="@cloudflare/vitest-pool-workers/types" />
// tartan.ci and tartan.review as bundled builtins in the real ExtensionDO
// (workerd, vitest-pool-workers): their migrations on DO SQLite through the
// host's SQL guard, the real KernelCaps (grants, CiJobGraph parsing, K10
// payload validation of every checks.* and review.* event they emit) over
// WP7b's fake kernel ports, and the event chain submit → CI run → checks →
// review → land testing → land.report.

import { runInDurableObject } from "cloudflare:test";
import {
	type Envelope,
	extDoName,
	type GateInput,
	type ProjectGraph,
	type RunStatus,
	SESSION_BOUNDS,
} from "@tartan/contract";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../../../test/env.ts";
import { builtins } from "../../../src/builtins.ts";
import type { KernelPorts } from "../../../src/kernel/caps/ports.ts";
import { ExtensionDO } from "../../../src/kernel/exthost/host/do.ts";
import { createModuleRuntime } from "../../../src/kernel/exthost/host/runtime.ts";
import {
	agentActor,
	createFakeInstallations,
	createFakeKernel,
	type FakeKernel,
	fixedUlid,
	LANE_ID,
	NODES,
	OTHER_INSTALLATION_ID,
	PRINCIPALS,
} from "../../../src/kernel/exthost/host/testing/fakes.ts";

const REPO = NODES.router.id;
const STREAM = `repo:${REPO}` as const;
const BASE = "1".repeat(40);
/** The fake kernel's trunk tip (`caps.repo.info().trunkSha`). */
const TIP = "c".repeat(40);
const HEAD = "2".repeat(40);
const CANDIDATE = "3".repeat(40);
const LANE = LANE_ID;
const CHANGE = "k".repeat(32);
const BATCH = `lb_${fixedUlid(320)}`;

/**
 * tartan.ci's repo policy at BASE and at the trunk tip (package tartan, ADR
 * repo config): a change check reads the tip's.
 */
const PIPELINE = {
	jobs: {
		install: { run: "pnpm install --frozen-lockfile" },
		test: {
			needs: ["install"],
			each: "affected",
			cwd: "{{project.root}}",
			run: "pnpm test",
		},
	},
};

const GRAPH: ProjectGraph = {
	sha: BASE,
	manifestsTreeSha: "0".repeat(64),
	projects: ["api", "web"].map((name) => ({
		name,
		root: name === "api" ? "services/api" : "apps/web",
		deps: [],
		dependents: [],
		owners: [],
		sensitive: false,
		source: "tartan-config" as const,
	})),
	globalFiles: [{ glob: "*.cue", source: "detector-default" }],
};

type Started = { graph: { jobs: { id: string }[]; sha: string } };

/** WP7b's fake kernel with repo reads, runs and land answering for this flow. */
const kernelFor = () => {
	const kernel: FakeKernel = createFakeKernel();
	const policyReads: { at: string; extId: string; keys: string[] }[] = [];
	const starts: Started[] = [];
	const statuses = new Map<string, RunStatus>();
	const base = kernel.ports;
	const ports: KernelPorts = {
		...base,
		probe: {
			...base.probe,
			projectGraph: () => Promise.resolve(GRAPH),
			diffPaths: () =>
				Promise.resolve({
					paths: [{ path: "services/api/src/limit.ts", change: "modified" }],
					truncated: false,
				}),
			diff: () =>
				Promise.resolve([{
					path: "services/api/src/limit.ts",
					change: "modified",
					binary: false,
					additions: 3,
					deletions: 1,
					hunks: [],
				}]),
			// The api subtree is the same in the head and the candidate.
			treeHash: (_source: unknown, sha: string, path: string) =>
				Promise.resolve(
					(path === "services/api" ? "a" : path === "" ? sha.slice(0, 1) : "b")
						.repeat(40),
				),
		},
		repo: (repoId: string) => {
			const r = base.repo(repoId);
			return {
				...r,
				// caps.repo.policy: only the caller's repo-policy keys, at a trunk commit.
				repoconfig: {
					policy: (at: string, extId: string, keys: readonly string[]) => {
						policyReads.push({ at, extId, keys: [...keys] });
						return Promise.resolve(
							at === BASE || at === TIP
								? {
									state: "ok" as const,
									configSha: at,
									inputKey: "f".repeat(64),
									exact: true,
									values: extId === "tartan.ci" && keys.includes("pipeline")
										? { pipeline: PIPELINE }
										: {},
								}
								: { state: "none" as const },
						);
					},
				},
				runs: {
					...r.runs,
					start: (input: unknown) => {
						starts.push(input as unknown as Started);
						return Promise.resolve({ runId: `run_${starts.length}` });
					},
					get: (runId: string) => Promise.resolve(statuses.get(runId) ?? null),
				},
			};
		},
	};
	return { kernel, ports, starts, statuses, policyReads };
};

const wire = async (
	extId: "tartan.ci" | "tartan.review",
	installationId: string,
	ports: KernelPorts,
) => {
	const pkg = builtins.get(extId)!;
	const installations = createFakeInstallations(pkg.manifest, {
		id: installationId,
		nodeId: REPO,
		nodePath: NODES.router.path,
		config: pkg.manifest.config?.default ?? {},
	});
	const stub = env.EXT.getByName(
		extDoName(installationId, { kind: "repo", repoId: REPO }),
	);
	await runInDurableObject(stub, async (instance) => {
		await ExtensionDO.rewire(instance, (defaults) => ({
			...defaults,
			kernel: ports,
			installations,
			packages: () =>
				Promise.resolve({
					runtime: createModuleRuntime(() => pkg.module),
					migrations: pkg.migrations,
				}),
		}));
	});
	return stub;
};

const appendedOf = (kernel: FakeKernel, type: string) =>
	kernel.appended.filter((a) => a.type === type).map((a) =>
		a.data as Record<string, unknown>
	);

describe("tartan.ci + tartan.review builtins in the ExtensionDO (workerd)", () => {
	it("runs submit → affected CI → checks → auto review → cached land test → land.report", async () => {
		const { kernel, ports, starts, statuses } = kernelFor();
		const ci = await wire("tartan.ci", `i_${fixedUlid(401)}`, ports);
		const review = await wire("tartan.review", `i_${fixedUlid(402)}`, ports);

		kernel.addEvent(REPO, {
			type: "changes.submitted",
			actor: agentActor(PRINCIPALS.agent, PRINCIPALS.dev),
			source: {
				kind: "installation",
				id: OTHER_INSTALLATION_ID,
				ext: "tartan.changes@0.1.0",
			},
			data: {
				changeId: CHANGE,
				laneId: LANE,
				revision: 1,
				head: HEAD,
				base: BASE,
				affected: ["api"],
			},
		});
		await ci.poke({ stream: STREAM, head: kernel.head(REPO) });
		expect(starts).toHaveLength(1);
		expect(starts[0].graph.jobs.map((j) => j.id)).toEqual([
			"install",
			"test-api",
		]);
		expect(starts[0].graph.sha).toBe(HEAD);
		// K13: the pipeline was read at the base.
		expect(
			kernel.called("reader").length,
		).toBeGreaterThan(0);
		expect(appendedOf(kernel, "checks.updated").map((d) => d.context)).toEqual([
			"install",
			"test:api",
		]);

		statuses.set("run_1", {
			runId: "run_1",
			repoId: REPO,
			kind: "ci",
			state: "success",
			sha: HEAD,
			requestedBy: "x",
			createdAt: 0,
			jobs: [
				{ jobId: "install", state: "success" },
				{ jobId: "test-api", state: "success" },
			],
		});
		kernel.addEvent(REPO, {
			type: "run.completed",
			data: { runId: "run_1", state: "success" },
		});
		await ci.poke({ stream: STREAM, head: kernel.head(REPO) });
		const completed = appendedOf(kernel, "checks.completed");
		expect(completed).toHaveLength(1);
		expect(completed[0]).toMatchObject({
			subject: { kind: "change", id: CHANGE },
			sha: HEAD,
			state: "success",
			cached: false,
		});

		// Review sees the change and its checks in the same log.
		await review.poke({ stream: STREAM, head: kernel.head(REPO) });
		const decided = appendedOf(kernel, "review.decided");
		expect(decided).toHaveLength(1);
		expect(decided[0]).toMatchObject({
			changeId: CHANGE,
			revision: 1,
			head: HEAD,
			decision: "approve",
			route: "auto",
		});
		expect(kernel.called("land.contributeNote")).toHaveLength(1);
		const gateInput: GateInput = {
			point: "ref.advance",
			repo: REPO,
			ref: "refs/heads/main",
			base: BASE,
			head: HEAD,
			changeId: CHANGE,
			changedPaths: [],
			addedLines: [],
			truncated: false,
			workRefs: [],
			actor: { kind: "system", id: "sys_kernel" },
		};
		expect(
			(await review.gate("ref.advance", gateInput, {
				node: REPO,
				repo: REPO,
				entity: { kind: "change", id: CHANGE },
				mode: "enforce",
			})).decision,
		).toBe(
			"allow",
		);

		// The candidate has the tested api subtree: cached, no run, verdict echoes K14.
		kernel.addEvent(REPO, {
			type: "land.testing",
			data: {
				batchId: BATCH,
				attempt: 1,
				candidateSha: CANDIDATE,
				base: BASE,
				affected: ["api"],
			},
		});
		await ci.poke({ stream: STREAM, head: kernel.head(REPO) });
		expect(starts).toHaveLength(1);
		const reports = kernel.called("land.report");
		expect(reports).toHaveLength(1);
		expect(reports[0].args[1]).toBe(BATCH);
		expect(reports[0].args[2]).toMatchObject({
			attempt: 1,
			candidateSha: CANDIDATE,
			state: "success",
			runIds: ["run_1"],
		});

		// Nothing the builtins appended was refused by caps' K10 validation.
		const types = kernel.appended.map((a) => a.type);
		expect(new Set(types)).toEqual(
			new Set(["checks.updated", "checks.completed", "review.decided"]),
		);
		expect(await ci.deadLetters(10)).toEqual([]);
		expect(await review.deadLetters(10)).toEqual([]);
	});

	it("serves checks_get and renders the Runs tab as valid tartan-ui", async () => {
		const { kernel, ports } = kernelFor();
		const ci = await wire("tartan.ci", `i_${fixedUlid(403)}`, ports);
		kernel.addEvent(
			REPO,
			{
				type: "changes.submitted",
				actor: agentActor(PRINCIPALS.agent, PRINCIPALS.dev),
				data: {
					changeId: CHANGE,
					laneId: LANE,
					revision: 1,
					head: HEAD,
					base: BASE,
					affected: [],
				},
			} as Partial<Envelope> & Pick<Envelope, "type">,
		);
		await ci.poke({ stream: STREAM, head: kernel.head(REPO) });
		const out = await ci.callTool("checks_get", {
			repo: REPO,
			changeId: CHANGE,
		}, {
			node: REPO,
			repo: REPO,
			scope: NODES.router.path,
			actor: { kind: "user", id: PRINCIPALS.dev },
			mode: "enforce",
		}, SESSION_BOUNDS) as { checks: { context: string; state: string }[] };
		expect(out.checks.map((c) => [c.context, c.state])).toEqual([
			["install", "pending"],
			["test:api", "pending"],
		]);
		const doc = await ci.render("ci", {
			slot: "repo.tab",
			node: REPO,
			repo: REPO,
			mode: "enforce",
		}, { actor: { kind: "user", id: PRINCIPALS.dev }, role: 30, kind: "user" });
		expect(JSON.stringify(doc)).toContain("run_1");
		expect(JSON.stringify(doc)).not.toContain("error");
	});
});
