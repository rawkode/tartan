/// <reference types="@cloudflare/vitest-pool-workers/types" />
// WP3 in workerd (vitest project `tree`): the tree module on a real
// ForgeDO's SQLite beside the real identity, registry, forge events and job
// slot modules (WP0's host: migrations, RpcTarget facades), then a repo
// created end to end against the pool's FakeArtifacts binding and a real
// RepoDO (WP5a: `init`, the K1 genesis intent applied to the ref index),
// browsed through WP3's handlers with the real RepoDO ref resolution (K15)
// and the real RepoProbe (WP8).
//
// The genesis transport here writes the commit through the pool fake's
// test-only `commit` RPC: the pool cannot route the Worker's outbound git
// fetches to the fakes worker yet (WP1), so the in-Worker pack push itself
// is covered by the Deno tests (`genesis.test.ts`, `repos.test.ts`).

import { runInDurableObject } from "cloudflare:test";
import {
	type BlobResponse,
	type CommitResponse,
	createUlid,
	fromRpcError,
	type LogResponse,
	repoArtifactsName,
	repoDoName,
	ROLE,
	type TreeResponse,
	trunkRef,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	AuthContext,
	RepoCoreFacade,
	RepoStore,
} from "@tartan/contract/kernel.ts";
import { describe, expect, it } from "vitest";
import { testEnv as env, uniqueName } from "../../../test/env.ts";
import { FORGE_COMMON, FORGE_MODULES } from "../../do/forge.ts";
import { createDoHost } from "../../do/host.ts";
import type { RouteContext, RouteHandler } from "../../router.ts";
import type { BrowseDeps } from "../browse/deps.ts";
import { createRawHandler, RAW_CSP } from "../browse/raw.ts";
import {
	createBlobHandler,
	createCommitHandler,
	createLogHandler,
	createTreeHandler,
} from "../browse/repo.ts";
import { loopback } from "../../exports.ts";
import type { TreePorts } from "./context.ts";
import { createTreeModule } from "./module.ts";

/** The pool fake's test-only RPC (never called by product code). */
type FakeArtifactsRpc = RepoStore & {
	commit(
		name: string,
		ref: string,
		changes: Record<string, string>,
		message: string,
	): Promise<string>;
	refs(name: string): Promise<Record<string, string>>;
};
const artifacts = env.ARTIFACTS as unknown as FakeArtifactsRpc;

const core = (repoId: string) =>
	env.REPO.getByName(repoDoName(repoId)).core() as unknown as RepoCoreFacade;

/** Genesis through the pool fake's `commit` RPC, then the real RepoDO K1 ledger. */
const poolGenesis: TreePorts["genesis"] = async (repoId, input) => {
	const ref = trunkRef(input.defaultBranch);
	const commit = await artifacts.commit(
		repoArtifactsName(repoId),
		ref,
		{
			"README.md": `# ${input.title ?? "Repository"}\n`,
		},
		input.message,
	);
	const repo = core(repoId);
	const intent = await repo.registerKernelWrite({
		target: "repo",
		ref,
		expectOld: ZERO_SHA,
		newSha: commit,
		purpose: "genesis",
		ownerKind: "kernel",
		ownerId: `genesis:${repoId}`,
	});
	await repo.markKernelWrite(intent.id, "pushed");
	return { commit };
};

const makeForge = async (state: DurableObjectState) => {
	const ports: TreePorts = {
		artifacts: env.ARTIFACTS as unknown as RepoStore,
		repo: (repoId) => core(repoId),
		genesis: poolGenesis,
	};
	const host = createDoHost({
		kind: "forge-test",
		ctx: state,
		env,
		modules: {
			...FORGE_MODULES,
			tree: createTreeModule({ ports: () => ports }),
		},
		common: FORGE_COMMON,
		log: () => {},
	});
	await host.ready;
	const ulid = createUlid();
	const sql = state.storage.sql;
	const user = (handle: string, admin = false): string => {
		const id = `u_${ulid()}`;
		sql.exec(
			"INSERT INTO principals (id, kind, handle, display, is_admin, created_at) VALUES (?, 'user', ?, ?, ?, ?)",
			id,
			handle,
			handle,
			admin ? 1 : 0,
			Date.now(),
		);
		return id;
	};
	const owner = user(`owner-${ulid().slice(-6)}`, true);
	sql.exec(
		"INSERT INTO meta (k, v) VALUES ('owner_principal', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
		owner,
	);
	return {
		host,
		tree: host.facade("tree"),
		internal: host.internal("tree"),
		sql,
		owner,
		user,
		ulid,
	};
};

const session = (principal: string): AuthContext => ({
	principal,
	kind: "user",
	via: "session",
	scopes: [],
	nodeId: null,
	laneId: null,
	maxRole: 50,
	isAdmin: false,
});

const call = (
	handler: RouteHandler,
	path: string,
	auth: AuthContext | null,
	params: Record<string, string> = {},
) => {
	const url = new URL(`https://code.example.test${path}`);
	return handler({
		req: new Request(url),
		env,
		ctx: {} as ExecutionContext,
		url,
		params,
		route: { id: "test", owner: "WP3", policy: {} as never },
		auth,
	} as RouteContext);
};

describe("tree module on Durable Object SQLite", () => {
	it("migrates beside the other forge modules; hierarchy, grants, moves, redirects and forge events", async () => {
		await runInDurableObject(
			env.FORGE.getByName(uniqueName("wp03-tree")),
			async (_instance, state) => {
				const f = await makeForge(state);
				const migrations = f.sql.exec<{ n: number }>(
					"SELECT n FROM _migrations WHERE n BETWEEN 200 AND 299",
				).toArray().map((r) => r.n);
				expect(migrations).toEqual([200]);
				const root = await f.tree.createRoot({
					kind: "user",
					slug: "acme",
					owner: f.owner,
				});
				let parent = root;
				for (const slug of ["platform", "edge", "router"]) {
					parent = await f.tree.createNode(f.owner, {
						parentId: parent.id,
						kind: "group",
						slug,
					});
				}
				expect(parent.path).toBe("acme/platform/edge/router");
				expect(parent.depth).toBe(3);
				const dev = f.user("dev");
				const platform = (await f.tree.resolvePath("acme/platform"))!.node;
				await f.tree.grant(f.owner, platform.id, dev, ROLE.developer);
				expect(await f.tree.effectiveRole([dev], parent.id)).toBe(30);
				expect(await f.tree.effectiveRole([f.owner], parent.id)).toBe(50);
				expect(f.internal.holdsRoleWithinSync(dev, root.id, Date.now())).toBe(
					true,
				);
				const moved = await f.tree.moveNode(f.owner, platform.id, {
					slug: "core",
				});
				expect(moved.path).toBe("acme/core");
				const old = await f.tree.resolvePath(
					"acme/platform/edge/router/-/raw/main/x",
				);
				expect(old?.node.id).toBe(parent.id);
				expect(old?.redirectTo).toBe("acme/core/edge/router/-/raw/main/x");
				expect((await f.tree.node(parent.id))?.path).toBe(
					"acme/core/edge/router",
				);
				// WP6's real forge stream got one event per change (K3).
				const types = f.sql.exec<{ type: string }>(
					"SELECT type FROM forge_events ORDER BY seq",
				).toArray().map((r) => r.type);
				expect(types).toEqual([
					"node.created",
					"node.created",
					"node.created",
					"node.created",
					"node.moved",
				]);
				// Foreign keys hold on Durable Object SQLite.
				expect(() =>
					f.sql.exec(
						"INSERT INTO grants (node_id, principal_id, role, granted_by, created_at) VALUES ('nope', ?, 10, ?, 0)",
						dev,
						f.owner,
					)
				).toThrow();
				const reserved = await f.tree.createRoot({
					kind: "group",
					slug: "api",
					owner: f.owner,
				}).catch((e: unknown) => fromRpcError(e));
				expect(reserved).toMatchObject({ code: "invalid" });
				// The artifacts index over RPC.
				const repoId = f.ulid();
				expect(
					await f.tree.indexArtifacts({
						name: repoArtifactsName(repoId).toUpperCase(),
						kind: "repo",
						repoId,
						state: "pending",
					}),
				).toEqual({ ok: true });
				expect(
					(await f.tree.lookupArtifacts(repoArtifactsName(repoId)))?.state,
				).toBe("pending");
				expect(await f.tree.countLaneRepos()).toEqual({
					retained: 0,
					max: 1000,
				});
			},
		);
	});

	it("creates a repo against the pool's Artifacts and a real RepoDO, then browses it through the handlers and RepoProbe", async () => {
		await runInDurableObject(
			env.FORGE.getByName(uniqueName("wp03-repo")),
			async (_instance, state) => {
				const f = await makeForge(state);
				const root = await f.tree.createRoot({
					kind: "user",
					slug: `acme-${f.ulid().slice(-8)}`,
					owner: f.owner,
				});
				const group = await f.tree.createNode(f.owner, {
					parentId: root.id,
					kind: "group",
					slug: "platform",
				});
				const repo = await f.tree.createRepo(f.owner, {
					parentId: group.id,
					slug: "router",
				});
				const name = repoArtifactsName(repo.id);
				expect((await f.tree.lookupArtifacts(name))?.state).toBe("live");
				const refs = await artifacts.refs(name);
				const genesis = refs["refs/heads/main"];
				expect(genesis).toMatch(/^[0-9a-f]{40}$/);
				// RepoDO applied the K1 genesis intent: its ref index knows main.
				const repoCore = core(repo.id);
				expect(await repoCore.resolveRef("refs/heads/main")).toBe(genesis);
				expect(await repoCore.resolveRef("main")).toBe(genesis);
				const info = await repoCore.info();
				expect(info.defaultBranch).toBe("main");
				expect((await f.tree.listRepos()).repos).toContainEqual({
					id: repo.id,
					path: repo.path,
				});
				// A second commit, read by SHA (it is not in the index).
				const second = await artifacts.commit(
					name,
					"refs/heads/main",
					{ "src/app.ts": "export {};\n" },
					"Add app",
				);
				const deps: BrowseDeps = {
					tree: () => f.tree,
					repo: (id) => core(id),
					artifacts: env.ARTIFACTS as unknown as RepoStore,
					probe: () => loopback(state).RepoProbe,
				};
				const owner = session(f.owner);
				const q = (p: Record<string, string>) =>
					new URLSearchParams({ repo: repo.path, ...p }).toString();
				const tree = await call(
					createTreeHandler(() => deps),
					`/-/api/tree?${q({ ref: "refs/heads/main" })}`,
					owner,
				);
				expect(tree.status).toBe(200);
				const treeBody = await tree.json() as TreeResponse;
				expect(treeBody.sha).toBe(genesis);
				expect(treeBody.entries.map((e) => e.name).sort()).toEqual([
					"README.md",
				]);
				const blob = await call(
					createBlobHandler(() => deps),
					`/-/api/blob?${q({ path: "README.md" })}`,
					owner,
				);
				expect(((await blob.json()) as BlobResponse).text).toBe("# router\n");
				const log = await call(
					createLogHandler(() => deps),
					`/-/api/log?${q({ ref: second })}`,
					owner,
				);
				expect(
					((await log.json()) as LogResponse).commits.map((c) => c.subject),
				).toEqual(["Add app", "Initial commit"]);
				const commit = await call(
					createCommitHandler(() => deps),
					`/-/api/commit?${q({ sha: second })}`,
					owner,
				);
				expect(commit.status).toBe(200);
				const commitBody = await commit.json() as CommitResponse;
				expect(commitBody.files.map((x) => [x.path, x.change])).toEqual([
					["src/app.ts", "added"],
				]);
				// Anonymous callers never learn a private repo exists.
				const anon = await call(
					createTreeHandler(() => deps),
					`/-/api/tree?${q({})}`,
					null,
				);
				expect(anon.status).toBe(404);
				const raw = await call(
					createRawHandler(() => deps),
					`/${repo.path}/-/raw/main/README.md`,
					owner,
					{ repo: repo.path, rest: "main/README.md" },
				);
				expect(raw.status).toBe(200);
				expect(raw.headers.get("content-security-policy")).toBe(RAW_CSP);
				expect(await raw.text()).toBe("# router\n");
			},
		);
	});
});
