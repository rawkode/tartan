/// <reference types="@cloudflare/vitest-pool-workers/types" />
// WP7a in workerd (vitest project `exthost`): the registry migration and
// boot-time builtin registration inside the real ForgeDO (RpcTarget facade,
// node:crypto under nodejs_compat), the registry against real DO SQLite
// with `transactionSync` rollback (fake tree/events siblings, because WP3
// and WP6 are stubs in this tree), and the WP7a routes through the Worker.

import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import {
	createUlid,
	type EffectiveRole,
	fromRpcError,
	pathPrefixes,
} from "@tartan/contract";
import type {
	ForgeEventsInternal,
	ForgeInternals,
	NodeRow,
	RegistryFacade,
	TreeInternal,
} from "@tartan/contract/kernel.ts";
import { describe, expect, it } from "vitest";
import { testEnv as env, uniqueName } from "../../../../test/env.ts";
import { builtins } from "../../../builtins.ts";
import {
	createRouter,
	ROUTES,
	type SecurityMiddleware,
} from "../../../router.ts";
import { createRegistry, type RegistryDeps } from "./module.ts";

const OWNER = "u_owner";

/** A tree over a `nodes` table in the same DO database (WP3's DDL subset). */
const sqlTree = (sql: SqlStorage): TreeInternal & {
	add(path: string, kind?: "group" | "repo"): void;
} => {
	sql.exec(
		`CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, parent_id TEXT,
		kind TEXT NOT NULL, slug TEXT NOT NULL, path TEXT NOT NULL UNIQUE, depth INTEGER NOT NULL,
		visibility TEXT NOT NULL DEFAULT 'private', artifacts_name TEXT, default_branch TEXT,
		description TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, archived_at INTEGER)`,
	);
	const ulid = createUlid();
	const byPath = (path: string) =>
		sql.exec<NodeRow>("SELECT * FROM nodes WHERE path = ?", path)
			.toArray()[0] ??
			null;
	const byId = (id: string) =>
		sql.exec<NodeRow>("SELECT * FROM nodes WHERE id = ?", id).toArray()[0] ??
			null;
	return {
		add: (path, kind = "group") => {
			let parent: NodeRow | null = null;
			for (const [i, p] of pathPrefixes(path).entries()) {
				parent = byPath(p) ?? (() => {
					const id = ulid();
					const nodeKind = p === path ? kind : "group";
					// WP3's DDL: a repo node carries its Artifacts name.
					sql.exec(
						"INSERT INTO nodes (id, parent_id, kind, slug, path, depth, artifacts_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'u_test', 0)",
						id,
						parent?.id ?? null,
						nodeKind,
						p.split("/").pop()!,
						p,
						i,
						nodeKind === "repo" ? `r-${id}` : null,
					);
					return byPath(p);
				})();
			}
		},
		nodeSync: byId,
		nodeByPathSync: byPath,
		ancestorPathsSync: (id) => pathPrefixes(byId(id)?.path ?? ""),
		effectiveRoleSync: (principals, id) =>
			(principals.includes(OWNER) && byId(id) !== null
				? 50
				: 0) as EffectiveRole,
		isWithinSync: () => true,
		// Contract additions the registry never calls.
		holdsRoleWithinSync: () => {
			throw new Error("not used by the registry");
		},
		createRootSync: () => {
			throw new Error("not used by the registry");
		},
		grantSync: () => {
			throw new Error("not used by the registry");
		},
	};
};

describe("registry in the real ForgeDO", () => {
	it("migrates, registers the bundled packages at boot and serves them over RPC", async () => {
		const forge = env.FORGE.getByName(uniqueName("wp7a-forge"));
		// The RPC stub's mapped types do not survive the Manifest's records; the facade type does.
		const registry = forge.registry() as unknown as RegistryFacade;
		const packages = await registry.packages();
		expect(packages.map((p) => p.extId).sort()).toEqual(
			[...builtins.ids].sort(),
		);
		expect(packages.every((p) => p.bundled && /^[0-9a-f]{64}$/.test(p.sha256)))
			.toBe(true);
		const version = await registry.extVersion();
		expect(version).toBe(1);
		// Re-registering the same bundle is a no-op.
		await registry.registerBuiltins(
			builtins.all().map((p) => p.manifest),
		);
		expect(await registry.extVersion()).toBe(1);
		// Promote is served over RPC: an unknown installation is not found.
		const error = await registry.promote(OWNER, "i_x").catch((
			e: unknown,
		) => e);
		expect(fromRpcError(error).code).toBe("not_found");
	});
});

describe("registry on DO SQLite", () => {
	it("installs a pack atomically and rolls back a failed install", async () => {
		const stub = env.FORGE.getByName(uniqueName("wp7a-sql"));
		await runInDurableObject(stub, async (_instance, state) => {
			const tree = sqlTree(state.storage.sql);
			tree.add("acme/platform/router", "repo");
			const events: string[] = [];
			const eventsApi: ForgeEventsInternal = {
				appendSync: (e) => {
					events.push(e.type);
					return { id: "x", seq: events.length };
				},
				auditSync: () => {},
			};
			const modules = { tree, events: eventsApi } as unknown as ForgeInternals;
			const deps = {
				sql: state.storage.sql,
				storage: state.storage,
				ctx: state,
				env,
				modules,
				timers: { schedule: () => {}, cancel: () => {}, get: () => null },
				clock: { now: () => Date.now() },
				ids: { ulid: createUlid() },
			} as unknown as RegistryDeps;
			const registry = createRegistry(deps, { builtins: () => builtins.all() });
			const f = registry.facade;
			const pack = await f.install(OWNER, {
				extId: "tartan.pack.swarm",
				version: "0.1.0",
				node: "acme",
				mode: "enforce",
			});
			const repoId = tree.nodeByPathSync("acme/platform/router")!.id;
			const inForce = await f.inForce(repoId);
			expect(inForce.filter((i) => i.installation.pack === pack.extId).length)
				.toBe(
					1 +
						(builtins.get("tartan.pack.swarm")!.manifest.members ?? []).length,
				);
			expect((await f.provider("queue@1", repoId))?.installation.extId).toBe(
				"tartan.weave",
			);
			const before = state.storage.sql.exec(
				"SELECT COUNT(*) AS n FROM installations",
			).one().n;
			const failed = await f.install(OWNER, {
				extId: "tartan.pack.swarm",
				version: "0.1.0",
				node: "acme",
				mode: "enforce",
			}).catch((e: unknown) => e);
			expect(fromRpcError(failed).code).toBe("conflict");
			expect(
				state.storage.sql.exec("SELECT COUNT(*) AS n FROM installations").one()
					.n,
			).toBe(before);
			// A different queue provider below replaces weave there; a locked one cannot be overridden.
			await f.install(OWNER, {
				extId: "tartan.fifo",
				version: "0.1.0",
				node: "acme/platform",
				mode: "enforce",
			});
			expect((await f.provider("queue@1", repoId))?.installation.extId).toBe(
				"tartan.fifo",
			);
			expect(events.filter((t) => t === "extension.installed").length).toBe(
				(await f.installed(repoId)).length,
			);
			// What acts at the repo leaves the replaced Weave out.
			expect(
				(await f.inForce(repoId)).some((i) =>
					i.installation.extId === "tartan.weave"
				),
			).toBe(false);
		});
	});

	it("Classic under Swarm, and an Owner's queue@1 swap and back, on DO SQLite", async () => {
		const stub = env.FORGE.getByName(uniqueName("wp12-protocols"));
		await runInDurableObject(stub, async (_instance, state) => {
			const tree = sqlTree(state.storage.sql);
			tree.add("rawkode/platform/router", "repo");
			tree.add("rawkode/docs/site", "repo");
			const events: string[] = [];
			const audits: string[] = [];
			const eventsApi: ForgeEventsInternal = {
				appendSync: (e) => {
					events.push(e.type);
					return { id: "x", seq: events.length };
				},
				auditSync: (a) => {
					audits.push(a.action);
				},
			};
			const deps = {
				sql: state.storage.sql,
				storage: state.storage,
				ctx: state,
				env,
				modules: { tree, events: eventsApi } as unknown as ForgeInternals,
				timers: { schedule: () => {}, cancel: () => {}, get: () => null },
				clock: { now: () => Date.now() },
				ids: { ulid: createUlid() },
			} as unknown as RegistryDeps;
			const f = createRegistry(deps, { builtins: () => builtins.all() }).facade;
			const install = (extId: string, node: string) =>
				f.install(OWNER, { extId, version: "0.1.0", node, mode: "enforce" });
			await install("tartan.pack.swarm", "rawkode");
			await install("tartan.pack.classic", "rawkode/docs");
			const id = (path: string) => tree.nodeByPathSync(path)!.id;
			const site = id("rawkode/docs/site");
			const router = id("rawkode/platform/router");
			const providerAt = async (iface: string, node: string) =>
				(await f.provider(iface, node))?.installation.extId ?? null;
			expect(await providerAt("queue@1", site)).toBe("tartan.fifo");
			expect(await providerAt("conflicts@1", site)).toBe(null);
			expect(await providerAt("queue@1", router)).toBe("tartan.weave");
			expect(await providerAt("conflicts@1", router)).toBe("tartan.radar");
			const swap = (extId: string) =>
				f.replaceProvider(OWNER, {
					node: "rawkode/platform/router",
					iface: "queue@1",
					extId,
					version: "0.1.0",
				});
			const done = await swap("tartan.fifo");
			expect(done.steps.map((s) => s.kind)).toEqual(["install"]);
			expect(await providerAt("queue@1", router)).toBe("tartan.fifo");
			const back = await swap("tartan.weave");
			expect(back.steps.map((s) => s.kind)).toEqual(["disable", "inherit"]);
			expect(await providerAt("queue@1", router)).toBe("tartan.weave");
			expect(audits.filter((a) => a === "extension.replace").length).toBe(2);
			// A refused swap writes nothing (transactionSync rollback).
			const rows = state.storage.sql.exec(
				"SELECT COUNT(*) AS n FROM installations",
			).one().n;
			const refused = await f.replaceProvider(OWNER, {
				node: "rawkode/platform/router",
				iface: "queue@1",
				extId: "tartan.radar",
				version: "0.1.0",
			}).catch((e: unknown) => e);
			expect(fromRpcError(refused).code).toBe("invalid");
			expect(
				state.storage.sql.exec("SELECT COUNT(*) AS n FROM installations").one()
					.n,
			).toBe(rows);
		});
	});

	it("the real ForgeDO serves replaceProvider and installed over RPC", async () => {
		const forge = env.FORGE.getByName(uniqueName("wp12-rpc"));
		const registry = forge.registry() as unknown as RegistryFacade & {
			installed(nodeId: string): Promise<unknown[]>;
			replaceProvider(by: string, input: unknown): Promise<unknown>;
		};
		const bad = await registry.replaceProvider(OWNER, { node: "x" }).catch((
			e: unknown,
		) => e);
		expect(fromRpcError(bad).code).toBe("invalid");
		const missing = await registry.replaceProvider(OWNER, {
			node: "nowhere",
			iface: "queue@1",
			extId: "tartan.fifo",
			version: "0.1.0",
		}).catch((e: unknown) => e);
		expect(fromRpcError(missing).code).toBe("not_found");
	});
});

describe("WP7a routes through the Worker", () => {
	// The route table behind a pass-through middleware: WP2's real
	// middleware answers 503 setup_required on a fresh forge (its own suites
	// cover the gating), so the WP7a handlers are reached with no caller.
	const passThrough: SecurityMiddleware = (_c, next) => next(null);
	const router = createRouter(ROUTES, passThrough);
	const call = (method: string, path: string) =>
		router(
			new Request(`https://tartan.test${path}`, { method }),
			env,
			createExecutionContext(),
		);

	it("answers from the WP7a handlers, not the M0 stubs", async () => {
		// No caller: 401, not 501.
		const packages = await call("GET", "/-/api/packages");
		expect(packages.status).toBe(401);
		const installations = await call("GET", "/-/api/installations?node=acme");
		expect(installations.status).toBe(401);
		// A malformed installation id is a plain 404 before any DO call.
		const slot = await call("GET", "/-/api/slot/i_x/repo.tab?ctx=e30");
		expect(slot.status).toBe(404);
		expect(slot.headers.get("cache-control")).toBe("private, no-store");
		const action = await call("POST", "/-/api/slot/i_x/repo.tab/action");
		expect(action.status).toBe(401);
	});
});
