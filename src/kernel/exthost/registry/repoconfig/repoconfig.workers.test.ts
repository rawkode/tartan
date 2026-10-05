/// <reference types="@cloudflare/vitest-pool-workers/types" />
// Repository config in the real ForgeDO (vitest project `exthost`; ADR repo
// config, "Applying results"): the registry's fenced apply over RPC, the
// installation rows it writes, and the binding rule after a real tree move,
// an archive and a revoke (WP3's moveNode/archiveNode revalidate inside
// their own transaction), an Owner's kill switch, and a package version
// whose self-check has not passed being absent from the schema. The pool's
// TartanSandbox has no container, so a self-check that needs CUE stays
// `checking`; packages without a `config.cue` approve at once.

import { runInDurableObject } from "cloudflare:test";
import {
	CUE_EVALUATOR_ID,
	FORGE_DO_NAME,
	type Manifest,
	repoArtifactsName,
	type RepoConfigApplyInput,
	ulid,
} from "@tartan/contract";
import type { RegistryFacade } from "@tartan/contract/kernel.ts";
import { afterAll, describe, expect, it } from "vitest";
import { settleBackground, testEnv as env } from "../../../../../test/env.ts";

const OWNER = "u_01k6ffffffffffffffffffffff";
const SHA = (n: number) => n.toString(16).padStart(40, "a");
const KEY = (n: number) => n.toString(16).padStart(64, "b");

const forge = () => env.FORGE.getByName(FORGE_DO_NAME);
// Typed through the contract facade (the RPC stub types are too deep).
const registry = () => forge().registry() as unknown as RegistryFacade;

const sql = <T extends Record<string, SqlStorageValue>>(
	query: string,
	...bindings: unknown[]
): Promise<T[]> =>
	runInDurableObject(
		forge(),
		(_instance, state) =>
			state.storage.sql.exec<T>(query, ...bindings).toArray(),
	);

/** A third-party package manifest (version 1.0.0). */
const thirdParty = (
	id: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
	schema: 1,
	id,
	name: id,
	version: "1.0.0",
	api: "tartan:ext@0.1.0",
	runtime: "js",
	entry: { js: "index.js" },
	storage: { scope: "repo" },
	permissions: { repo: "read" },
	...extra,
});

/** A package with a gate and no `config.cue`: it approves at once. */
const gatePackage = (id: string) =>
	thirdParty(id, { gates: [{ point: "ref.advance" }] });

/** An own install of `gate`, enforced, with no settings. */
const ownInstall = (gate: string) => ({
	extensions: { [gate]: { enabled: true, mode: "enforce", settings: {} } },
});

const publish = (m: Record<string, unknown>, configCue?: string) =>
	registry().publish(OWNER, m as unknown as Manifest, {
		sha256: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
		r2Prefix: `ext/${m.id}/${m.version}`,
		...(configCue === undefined ? {} : { configCue }),
	});

/**
 * Two roots owned by OWNER; `/<root>/platform/api` is a repo (inserted the
 * way WP3 writes one: the pool cannot run the genesis push). Weave is in
 * force at the root with repo overrides on, and a gate package is approved
 * there for repo config.
 */
const world = async () => {
	const tag = ulid().slice(-10);
	const root = await forge().tree().createRoot({
		kind: "group",
		slug: `rcf-${tag}`,
		owner: OWNER,
	});
	const other = await forge().tree().createRoot({
		kind: "group",
		slug: `rco-${tag}`,
		owner: OWNER,
	});
	const platform = await forge().tree().createNode(OWNER, {
		parentId: root.id,
		kind: "group",
		slug: "platform",
	});
	const repoId = ulid();
	await sql(
		`INSERT INTO nodes (id, parent_id, kind, slug, path, depth, artifacts_name, default_branch, created_by, created_at)
		 VALUES (?, ?, 'repo', 'api', ?, 2, ?, 'main', ?, ?)`,
		repoId,
		platform.id,
		`${platform.path}/api`,
		repoArtifactsName(repoId),
		OWNER,
		Date.now(),
	);
	const weave = await registry().install(OWNER, {
		extId: "tartan.weave",
		version: "0.1.0",
		node: root.path,
		mode: "enforce",
	});
	await registry().setRepoOverrides(OWNER, weave.id, true);
	const gate = `acme.g${tag}`;
	await publish(gatePackage(gate));
	const approval = await registry().requestConfigApproval(
		OWNER,
		root.id,
		gate,
		{ version: "1.0.0" },
	);
	expect(approval.state).toBe("approved");
	return { root, other, platform, repoId, weave, gate };
};

const applyInput = async (
	repoId: string,
	resolved: unknown,
	n: number,
	over: Partial<RepoConfigApplyInput> = {},
): Promise<RepoConfigApplyInput> => {
	const schema = await registry().repoConfigSchema(repoId);
	return {
		trunkSeq: n,
		epoch: schema.epoch,
		sha: SHA(n),
		inputKey: KEY(n),
		schemaKey: schema.schemaKey,
		resolved,
		principals: [OWNER],
		provenance: {
			firstSha: SHA(n),
			evaluator: CUE_EVALUATOR_ID,
			cueVersion: "v0.17.1",
		},
		...over,
	};
};

const configFor = (gate: string, batch: number) => ({
	extensions: {
		[gate]: { enabled: true, mode: "enforce", settings: {} },
		"tartan.weave": { settings: { batch } },
	},
});

const gateRows = (repoId: string, gate: string) =>
	sql<
		{
			id: string;
			source: string;
			source_sha: string;
			source_key: string;
			mode: string;
		}
	>(
		"SELECT id, source, source_sha, source_key, mode FROM installations WHERE node_id = ? AND ext_id = ?",
		repoId,
		gate,
	);

const overlays = async (repoId: string) =>
	(await sql<{ n: number }>(
		"SELECT COUNT(*) AS n FROM repo_config_overlays WHERE repo_node_id = ?",
		repoId,
	))[0]!.n;

const forgeEvents = async () =>
	(await sql<{ n: number }>("SELECT COUNT(*) AS n FROM forge_events"))[0]!.n;

afterAll(() => settleBackground());

describe("repository config in the real ForgeDO registry", () => {
	it("applies fenced over RPC: an older apply is refused, an equal one is a no-op without events, a moved schema is refused", async () => {
		const w = await world();
		const b = await registry().applyRepoConfig(
			w.repoId,
			await applyInput(w.repoId, configFor(w.gate, 2), 2),
		);
		expect(b.kind).toBe("applied");
		// The row carries its source and provenance (t15).
		const rows = await gateRows(w.repoId, w.gate);
		expect(rows).toEqual([expect.objectContaining({
			source: "repo-config",
			source_sha: SHA(2),
			source_key: KEY(2),
			mode: "enforce",
		})]);
		expect(await overlays(w.repoId)).toBe(1);
		expect(
			(await registry().installationAt(w.weave.id, w.repoId))?.config,
		).toMatchObject({ batch: 2 });
		// A, older, delivered last: refused; B stays.
		const a = await registry().applyRepoConfig(
			w.repoId,
			await applyInput(w.repoId, configFor(w.gate, 3), 1),
		);
		expect(a).toMatchObject({ kind: "refused", reason: "older" });
		expect(
			(await registry().installationAt(w.weave.id, w.repoId))?.config,
		).toMatchObject({ batch: 2 });
		// B again: a no-op that appends nothing.
		const events = await forgeEvents();
		const again = await registry().applyRepoConfig(
			w.repoId,
			await applyInput(w.repoId, configFor(w.gate, 2), 2),
		);
		expect(again.kind).toBe("noop");
		expect(await forgeEvents()).toBe(events);
		// The same fence with another key, and a schema that moved, are refused.
		expect(
			await registry().applyRepoConfig(
				w.repoId,
				await applyInput(w.repoId, configFor(w.gate, 4), 2, {
					inputKey: KEY(99),
				}),
			),
		).toMatchObject({ kind: "refused", reason: "fence-conflict" });
		expect(
			await registry().applyRepoConfig(
				w.repoId,
				await applyInput(w.repoId, configFor(w.gate, 4), 3, {
					schemaKey: "c".repeat(64),
				}),
			),
		).toMatchObject({ kind: "refused", reason: "schema-changed" });
		expect((await registry().repoConfigState(w.repoId))?.appliedSeq).toBe(2);
	});

	it("a tree move drops the rows and overlays that stopped binding in its transaction; a lost gate holds", async () => {
		const w = await world();
		await registry().applyRepoConfig(
			w.repoId,
			await applyInput(w.repoId, configFor(w.gate, 2), 1),
		);
		const before = (await registry().repoConfigSchema(w.repoId)).epoch;
		expect(await gateRows(w.repoId, w.gate)).toHaveLength(1);
		// Move /<root>/platform under the other root: the approval and Weave
		// at the old root are no longer above the repo.
		await forge().tree().moveNode(OWNER, w.platform.id, {
			parentId: w.other.id,
		});
		expect(await gateRows(w.repoId, w.gate)).toEqual([]);
		expect(await overlays(w.repoId)).toBe(0);
		expect((await registry().repoConfigState(w.repoId))?.holdReason).toBe(
			"gate-missing",
		);
		expect((await registry().repoConfigSchema(w.repoId)).epoch)
			.toBeGreaterThan(before);
		const inForce = await registry().inForce(w.repoId);
		expect(inForce.some((i) => i.installation.extId === w.gate)).toBe(false);
	});

	it("an archive of the approving node and a revoke each leave no unapproved row in force", async () => {
		const w = await world();
		// Approve at the other root too, then move the repo's group there.
		await registry().requestConfigApproval(OWNER, w.other.id, w.gate, {
			version: "1.0.0",
		});
		await forge().tree().moveNode(OWNER, w.platform.id, {
			parentId: w.other.id,
		});
		expect(
			(await registry().applyRepoConfig(
				w.repoId,
				await applyInput(w.repoId, ownInstall(w.gate), 1),
			)).kind,
		).toBe("applied");
		expect(await gateRows(w.repoId, w.gate)).toHaveLength(1);
		await forge().tree().archiveNode(OWNER, w.other.id);
		expect(await gateRows(w.repoId, w.gate)).toEqual([]);
		expect((await registry().repoConfigState(w.repoId))?.holdReason).toBe(
			"gate-missing",
		);

		// A revoke, on a fresh world.
		const v = await world();
		await registry().applyRepoConfig(
			v.repoId,
			await applyInput(v.repoId, ownInstall(v.gate), 1),
		);
		expect(await gateRows(v.repoId, v.gate)).toHaveLength(1);
		await registry().revokeConfigApproval(OWNER, v.root.id, v.gate);
		expect(await gateRows(v.repoId, v.gate)).toEqual([]);
		expect((await registry().repoConfigState(v.repoId))?.holdReason).toBe(
			"gate-missing",
		);
	});

	it("an Owner's disable survives reconcile; a version whose self-check has not passed is absent from the schema", async () => {
		const w = await world();
		await registry().applyRepoConfig(
			w.repoId,
			await applyInput(w.repoId, ownInstall(w.gate), 1),
		);
		const [row] = await gateRows(w.repoId, w.gate);
		await registry().setMode(OWNER, row!.id, "disabled");
		expect(
			(await registry().applyRepoConfig(
				w.repoId,
				await applyInput(w.repoId, ownInstall(w.gate), 2),
			)).kind,
		).not.toBe("denied");
		expect((await gateRows(w.repoId, w.gate))[0]?.mode).toBe("disabled");
		// A package with a config.cue whose self-check cannot run here.
		const cfg = `acme.c${ulid().slice(-10)}`;
		await publish(
			thirdParty(cfg, {
				config: { default: { level: 1 }, cue: "config/settings.cue" },
			}),
			"package settings\n\n#Settings: {level: int | *1}\n",
		);
		const request = await registry().requestConfigApproval(
			OWNER,
			w.root.id,
			cfg,
			{ version: "1.0.0" },
		);
		expect(request.state).toBe("checking");
		const schema = await registry().repoConfigSchema(w.repoId);
		expect(schema.entries.some((e) => e.extId === cfg)).toBe(false);
		expect(schema.entries.some((e) => e.extId === w.gate)).toBe(true);
	});
});
