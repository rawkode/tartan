// The read-side kernel tools (WP11; K15): repo
// listing and reads by SHA (a lane id reads its lane's repo), the project
// graph and affected sets, `context_get` through WP7b's assembler, events,
// runs and why, each on its owner's port and authorized at the repo.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	createUlid,
	type GitSource,
	REPO_READ_MAX_BYTES,
} from "@tartan/contract";
import type { SourceReader } from "../caps/ports.ts";
import { createMcpFixture, valueOf } from "./testing/fixture.ts";

const ulid = createUlid();
const TIP = "c".repeat(40);
const T1 = "d".repeat(40);
const T2 = "e".repeat(40);
const LANE = `ln_${ulid()}`;
const R = "rawkode/platform/router";

/** A two-level tree at TIP; files by path. */
const readerFor = (
	files: Record<string, Uint8Array>,
	seen: GitSource[],
) =>
(source: GitSource): Promise<SourceReader> => {
	seen.push(source);
	return Promise.resolve({
		commit: (sha) =>
			Promise.resolve(
				sha === TIP
					? {
						sha,
						treeSha: T1,
						subject: "s",
						message: "s",
						author: { name: "a", email: "a@x" },
						committer: { name: "a", email: "a@x" },
						parents: [],
						authoredAt: 0,
						committedAt: 0,
						trailers: [],
					}
					: null,
			),
		tree: (sha) =>
			Promise.resolve(
				sha === T1
					? [
						{
							name: "README.md",
							mode: "100644",
							hash: "1".repeat(40),
							type: "blob",
						},
						{ name: "src", mode: "040000", hash: T2, type: "tree" },
					]
					: sha === T2
					? [{
						name: "main.ts",
						mode: "100644",
						hash: "2".repeat(40),
						type: "blob",
					}]
					: null,
			),
		file: (_commit, path) => Promise.resolve(files[path] ?? null),
		log: () => Promise.resolve([]),
	});
};

const setup = () => {
	const fx = createMcpFixture();
	const seen: GitSource[] = [];
	const refs: string[] = [];
	fx.forge.setRepo(fx.router, {
		core: {
			resolveRef: (ref: string) => {
				refs.push(ref);
				return Promise.resolve(ref === "nope" ? null : TIP);
			},
		} as never,
	});
	fx.forge.override({
		reader: readerFor({
			"README.md": new TextEncoder().encode("# router\n"),
			"logo.png": new Uint8Array([137, 80, 78, 71, 0, 0]),
			"big.txt": new TextEncoder().encode("x".repeat(REPO_READ_MAX_BYTES + 10)),
		}, seen),
	});
	return { fx, seen, refs };
};

Deno.test("repo_tree and repo_read resolve the ref in RepoDO and read by SHA; a lane id reads its lane's repo", async () => {
	const { fx, seen, refs } = setup();
	const session = await fx.open(fx.claude, "rawkode/platform/router");
	const root = valueOf<
		{ sha: string; entries: { path: string; type: string }[] }
	>(
		await fx.call(session, "repo_tree", { repo: R }),
	);
	equal(root.sha, TIP);
	deepStrictEqual(root.entries.map((e) => [e.path, e.type]), [
		["README.md", "blob"],
		["src", "tree"],
	]);
	const src = valueOf<{ entries: { path: string }[] }>(
		await fx.call(session, "repo_tree", { repo: R, path: "src/" }),
	);
	deepStrictEqual(src.entries.map((e) => e.path), ["src/main.ts"]);
	const readme = await fx.call(session, "repo_read", {
		repo: R,
		path: "README.md",
		ref: LANE,
	});
	equal(readme.content[0].text, "# router\n");
	deepStrictEqual(refs, ["HEAD", "HEAD", LANE]);
	deepStrictEqual(seen.at(-1), { repoId: fx.router, laneId: LANE });
	const binary = valueOf(
		await fx.call(session, "repo_read", { repo: R, path: "logo.png" }),
	);
	equal(binary.binary, true);
	const big = valueOf<{ truncated: boolean; text: string }>(
		await fx.call(session, "repo_read", { repo: R, path: "big.txt" }),
	);
	equal(big.truncated, true);
	equal(big.text.length, REPO_READ_MAX_BYTES);
	equal(
		valueOf(await fx.call(session, "repo_read", { repo: R, path: "missing" }))
			.error,
		"not_found",
	);
	equal(
		valueOf(await fx.call(session, "repo_tree", { repo: R, ref: "nope" }))
			.error,
		"not_found",
	);
});

Deno.test("repo_list lists the readable repos under a node; an unknown or invisible subtree lists nothing", async () => {
	const { fx } = setup();
	fx.forge.addNode("secret", "group");
	fx.forge.addNode("secret/vault", "repo");
	const session = await fx.open(fx.claude);
	const all = valueOf<{ repos: { path: string }[] }>(
		await fx.call(session, "repo_list"),
	);
	deepStrictEqual(all.repos.map((r) => r.path).sort(), [
		"rawkode/docs/site",
		"rawkode/platform/router",
	]);
	const under = valueOf<{ repos: { path: string }[] }>(
		await fx.call(session, "repo_list", { under: "rawkode/docs" }),
	);
	deepStrictEqual(under.repos.map((r) => r.path), ["rawkode/docs/site"]);
	for (const hidden of ["secret", "nowhere"]) {
		deepStrictEqual(
			valueOf(await fx.call(session, "repo_list", { under: hidden })).repos,
			[],
		);
	}
});

Deno.test("repo_projects and repo_affected go to RepoProbe at resolved SHAs", async () => {
	const { fx } = setup();
	const calls: unknown[][] = [];
	fx.forge.override({
		probe: {
			projectGraph: (repoId, sha) => {
				calls.push(["graph", repoId, sha]);
				return Promise.resolve({ projects: [] } as never);
			},
			affected: (repoId, base, head) => {
				calls.push(["affected", repoId, base, head]);
				return Promise.resolve(
					{ projects: ["router"], global: false } as never,
				);
			},
		},
	});
	const session = await fx.open(fx.claude, "rawkode/platform/router");
	await fx.call(session, "repo_projects", { repo: "rawkode/platform/router" });
	const affected = valueOf(
		await fx.call(session, "repo_affected", {
			repo: "rawkode/platform/router",
			base: "main",
			head: LANE,
		}),
	);
	deepStrictEqual(affected.projects, ["router"]);
	deepStrictEqual(calls, [
		["graph", fx.router, TIP],
		["affected", fx.router, TIP, TIP],
	]);
});

Deno.test("context_get goes to WP7b's assembler with the repo, the actor and the token's bounds; its markdown is the text", async () => {
	const { fx } = setup();
	const requests: unknown[][] = [];
	fx.forge.override({
		dispatch: {
			...fx.forge.ports.dispatch,
			context: (req, bounds) => {
				requests.push([req, bounds]);
				return Promise.resolve({
					md: "## Protocol\n\nSwarm\n",
					sections: [],
					budgetTokens: 2000,
					truncated: false,
				});
			},
		},
	});
	const session = await fx.open(fx.claude, "rawkode/platform");
	const result = await fx.call(session, "context_get", {
		repo: "rawkode/platform/router",
		laneId: LANE,
		budgetTokens: 2000,
	});
	equal(result.content[0].text, "## Protocol\n\nSwarm\n");
	const [req, bounds] = requests[0] as [
		Record<string, unknown>,
		{ maxRole: number },
	];
	deepStrictEqual(req.repo, {
		id: fx.router,
		path: "rawkode/platform/router",
		nodeId: fx.router,
	});
	deepStrictEqual(req.actor, { kind: "agent", id: fx.claude });
	equal(req.laneId, LANE);
	equal(bounds.maxRole, 30);
});

Deno.test("events_tail tails the repo log; runs_status, runs_logs and why read their owners", async () => {
	const { fx } = setup();
	const reads: unknown[] = [];
	fx.forge.setRepo(fx.router, {
		events: {
			head: () => Promise.resolve(120),
			read: (q) => {
				reads.push(q);
				return Promise.resolve([]);
			},
		},
		runs: {
			get: (runId) =>
				Promise.resolve(runId === "r1" ? { runId } as never : null),
			logs: () => Promise.resolve("ok 1 - test\n"),
		},
		land: {
			why: (q) =>
				Promise.resolve(
					q.sha ? { commit: q.sha, note: null, events: [] } : null,
				),
		},
	});
	const session = await fx.open(fx.claude, "rawkode/platform/router");
	const tail = valueOf(
		await fx.call(session, "events_tail", {
			repo: "rawkode/platform/router",
			limit: 20,
			types: ["push.*"],
		}),
	);
	equal(tail.head, 120);
	deepStrictEqual(reads[0], { since: 100, limit: 20, patterns: ["push.*"] });
	equal(
		valueOf(await fx.call(session, "runs_status", { runId: "r1" })).runId,
		"r1",
	);
	equal(
		valueOf(await fx.call(session, "runs_status", { runId: "r2" })).error,
		"not_found",
	);
	const logs = await fx.call(session, "runs_logs", {
		runId: "r1",
		jobId: "test",
	});
	equal(logs.content[0].text, "ok 1 - test\n");
	const why = valueOf(
		await fx.call(session, "why", {
			repo: "rawkode/platform/router",
			sha: TIP,
		}),
	);
	equal(why.commit, TIP);
	ok(
		valueOf(await fx.call(session, "why", { repo: "rawkode/platform/router" }))
			.error === "invalid",
	);
});
