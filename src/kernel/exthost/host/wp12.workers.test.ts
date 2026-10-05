/// <reference types="@cloudflare/vitest-pool-workers/types" />
// WP12 builtins in the real ExtensionDO (workerd): tartan.work and
// tartan.board migrate on DO SQLite (FTS5, ALTER TABLE), answer tools over
// RPC through the host's interface checks, drain pokes and render.

import { runInDurableObject } from "cloudflare:test";
import {
	createUlid,
	extDoName,
	type ExtensionModule,
	type ExtMigration,
	type Manifest,
	parseManifest,
	SESSION_BOUNDS,
} from "@tartan/contract";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../../../../test/env.ts";
import * as board from "../../../../extensions/board/src/index.ts";
import boardJson from "../../../../extensions/board/tartan.json" with {
	type: "json",
};
import * as work from "../../../../extensions/work/src/index.ts";
import workJson from "../../../../extensions/work/tartan.json" with {
	type: "json",
};
import { ExtensionDO } from "./do.ts";
import { createModuleRuntime } from "./runtime.ts";
import {
	agentActor,
	createFakeInstallations,
	createFakeKernel,
	type FakeKernel,
	NODES,
	PRINCIPALS,
	userActor,
} from "./testing/fakes.ts";

const ulid = createUlid();
const manifestOf = (raw: unknown): Manifest => {
	const parsed = parseManifest(raw);
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.manifest;
};

const wire = async (
	manifest: Manifest,
	module: ExtensionModule,
	migrations: readonly ExtMigration[],
	kernel: FakeKernel,
) => {
	const installationId = `i_${ulid()}`;
	const name = extDoName(
		installationId,
		manifest.storage.scope === "repo"
			? { kind: "repo", repoId: NODES.router.id }
			: { kind: "node" },
	);
	const installations = createFakeInstallations(manifest, {
		id: installationId,
	});
	const stub = env.EXT.getByName(name);
	await runInDurableObject(stub, async (instance) => {
		await ExtensionDO.rewire(instance, (defaults) => ({
			...defaults,
			kernel: kernel.ports,
			installations,
			packages: () =>
				Promise.resolve({
					runtime: createModuleRuntime(() => module),
					migrations,
				}),
			budgets: { hold: 100 },
		}));
	});
	return stub;
};

describe("WP12 builtins in ExtensionDO (workerd)", () => {
	it("tartan.work: migrations (FTS5) on DO SQLite, work_create and work_claim over RPC", async () => {
		const kernel = createFakeKernel();
		const stub = await wire(
			manifestOf(workJson),
			work.extension,
			work.migrations,
			kernel,
		);
		const ctx = (actor = userActor(PRINCIPALS.dev)) => ({
			node: NODES.router.id,
			repo: NODES.router.id,
			scope: NODES.router.path,
			actor,
			mode: "enforce" as const,
		});
		const created = await stub.callTool(
			"work_create",
			{
				repo: NODES.router.path,
				kind: "intent",
				title: "Rate limiting",
				why: "token bucket",
			},
			ctx(),
			SESSION_BOUNDS,
		) as { ref: string };
		expect(created.ref).toBe("acme/router#1");
		const claim = await stub.callTool(
			"work_claim",
			{
				ref: created.ref,
				footprint: { projects: ["api"], prefixes: [] },
			},
			ctx(agentActor(PRINCIPALS.agent, PRINCIPALS.dev)),
			{
				...SESSION_BOUNDS,
				maxRole: 30,
			},
		) as { lane: { state: string; git?: unknown } };
		expect(claim.lane.state).toBe("open");
		expect(claim.lane.git).toBeDefined();
		expect(kernel.appended.map((a) => a.type)).toEqual([
			"work.created",
			"work.claimed",
		]);
		const fts = await runInDurableObject(
			stub,
			(_i, state) =>
				state.storage.sql.exec(
					"SELECT rowid FROM items_fts WHERE items_fts MATCH 'bucket'",
				).toArray(),
		);
		expect(fts.length).toBe(1);
	});

	it("tartan.board: drains two repo streams and renders the board", async () => {
		const kernel = createFakeKernel();
		const stub = await wire(
			manifestOf(boardJson),
			board.extension,
			board.migrations,
			kernel,
		);
		kernel.addEvent(NODES.router.id, {
			type: "work.created",
			data: { ref: "acme/router#1", kind: "intent", title: "Rate limiting" },
		});
		kernel.addEvent(NODES.platformApi.id, {
			type: "work.created",
			data: { ref: "acme/platform/api#1", kind: "issue", title: "Quotas" },
		});
		kernel.addEvent(NODES.router.id, {
			type: "work.claimed",
			data: {
				ref: "acme/router#1",
				principal: PRINCIPALS.agent,
				laneId: "ln_01k6000000000000000000000a",
			},
		});
		await stub.poke({ stream: `repo:${NODES.router.id}`, head: 2 });
		await stub.poke({ stream: `repo:${NODES.platformApi.id}`, head: 1 });
		const doc = await stub.render("board", {
			slot: "node.tab",
			node: NODES.acme.id,
			mode: "enforce",
			viewer: userActor(PRINCIPALS.dev),
		}, { actor: userActor(PRINCIPALS.dev), role: 30, kind: "user" });
		const text = JSON.stringify(doc);
		expect(doc.root.t).toBe("board");
		expect(text).toContain('"col":"progress"');
		expect(text).toContain("Quotas");
	});
});
