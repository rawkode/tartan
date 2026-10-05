// WP5b live harness Worker (deployed only as `tartan-dev-wp05b` by
// `scripts/live/wp05b-lanes.ts`; never part of the product). It runs the
// REAL RepoDO `core` module (WP5a) with the REAL `repo` lane backend (WP5b)
// and the REAL event log (WP6) on Durable Object SQLite, against the REAL
// Artifacts binding, so lanes are seeded with `import()` by the real
// importer through a capability URL on this Worker's own origin.
//
// What other work packages build is played here:
// - the capability route (WP4, not merged): `/-/cap/v1/…` checks syntax,
//   TTL and MAC before any DO call, then `capUse`, reads the upstream tip,
//   synthesizes `HEAD` → `refs/heads/main` at the attempt's base, forwards
//   the single-want request to the canonical repo with a per-request read
//   token (revoked after), applies the gateway's trailer transform, and
//   reports `served` with the pack size;
// - ForgeDO's tree (WP3): `HarnessForge`, an `artifacts_index` and the
//   canonical origin;
// - the lane remote (WP4): `push` writes one commit into the lane repo with
//   the lane's own upstream token (`upstream({laneId}, "write")`, layer 2)
//   and records it as the gateway would.
// Containers are not deployed.
//
// Credentials: the admin API takes `Authorization: Bearer <HARNESS_KEY>` (a
// secret the driver generates and never prints). Artifacts tokens never
// leave this Worker (K11); `sign` returns a capability path only for tests
// of refused (expired, replayed or consumed) capabilities.

import { DurableObject } from "cloudflare:workers";
import {
	capPath,
	createUlid,
	FORGE_DO_NAME,
	LANE_REPO_HEAD_REF,
	laneArtifactsName,
	type LaneSelfTestResult,
	parseArtifactsName,
	parseCapPath,
	redactSecrets,
	repoArtifactsName,
	repoDoName,
	type SetupStateDto,
	trunkRef,
	ZERO_SHA,
} from "../../packages/contract/src/index.ts";
import type {
	ArtifactsIndexRow,
	DoModule,
	IndexArtifactsInput,
	IndexArtifactsResult,
	KernelGitJobs,
	RepoCoreFacade,
	RepoEventsFacade,
	RepoInternals,
	RepoStore,
	TreeFacade,
} from "../../packages/contract/src/kernel.ts";
import { MIGRATION_RANGES } from "../../packages/contract/src/kernel.ts";
import {
	decodePktLines,
	encodeCommit,
	encodePktLine,
	encodeSpecialPkt,
	encodeTree,
	hashObject,
	lsRefs,
	writePack,
} from "../../packages/gitproto/src/index.ts";
import { LANE_CAP_TTL_S, MAX_LANE_REPOS_FORGE } from "../../src/constants.ts";
import { createDoHost } from "../../src/do/host.ts";
import { COMMON_MIGRATIONS } from "../../src/do/migrations.ts";
import type { Env } from "../../src/env.ts";
import { createRepoEventsModule } from "../../src/kernel/events/repo.ts";
import { capMacOf } from "../../src/kernel/http/capmac.ts";
import { createKernelGitJobsWith } from "../../src/kernel/land/gitjobs.ts";
import { pushRefsCompat } from "../../src/kernel/land/refpush.ts";
import { authorizationFor } from "../../src/kernel/repo/gitremote.ts";
import { runRepoBackendCron } from "../../src/kernel/repo/lanes/repo-backend/cron.ts";
import { createRepoBackendWith } from "../../src/kernel/repo/lanes/repo-backend/index.ts";
import { runLaneSelfTestWith } from "../../src/kernel/repo/lanes/repo-backend/selftest.ts";
import { createRepoCoreModule } from "../../src/kernel/repo/module.ts";
import { createFakeLand } from "../../src/kernel/repo/testing/fakes.ts";

type HarnessEnv = {
	readonly ARTIFACTS: Artifacts;
	readonly REPO: DurableObjectNamespace;
	readonly FORGE: DurableObjectNamespace;
	readonly HARNESS_KEY?: string;
};

type Row = Record<string, SqlStorageValue>;

/** The HarnessRepo stub as the Worker calls it (RPC). */
type RepoStub = {
	core(): RepoCoreFacade;
	events(): RepoEventsFacade;
	laneDetail(laneId: string): Promise<{ lane: Row | null; attempts: Row[] }>;
	seedIntents(laneId: string): Promise<Row[]>;
};

/** The HarnessForge stub (ForgeDO's tree and setup state, played here). */
type ForgeStub =
	& Pick<
		TreeFacade,
		| "indexArtifacts"
		| "lookupArtifacts"
		| "listArtifactsIndex"
		| "countLaneRepos"
	>
	& {
		setOrigin(origin: string): Promise<void>;
		origin(): Promise<string>;
		setupState(): Promise<SetupStateDto>;
		setCapBlocked(blocked: boolean): Promise<void>;
		capBlocked(): Promise<boolean>;
		recordLaneSelfTest(result: LaneSelfTestResult): Promise<void>;
		lastLaneSelfTest(): Promise<LaneSelfTestResult | null>;
		index(): Promise<ArtifactsIndexRow[]>;
	};

const utf8 = (text: string): Uint8Array<ArrayBuffer> =>
	new TextEncoder().encode(text);

const concat = (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

const capMacFor = (env: HarnessEnv) =>
	capMacOf(() =>
		crypto.subtle.importKey(
			"raw",
			utf8(`tartan-dev-wp05b:lane-cap:${env.HARNESS_KEY ?? ""}`),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign", "verify"],
		)
	);

const forgeOf = (env: HarnessEnv): ForgeStub =>
	env.FORGE.getByName(FORGE_DO_NAME) as unknown as ForgeStub;
const repoOf = (env: HarnessEnv, repoId: string): RepoStub =>
	env.REPO.getByName(repoDoName(repoId)) as unknown as RepoStub;

// ---------------------------------------------------------------------------
// HarnessForge: ForgeDO's artifacts index, the canonical origin, knobs
// ---------------------------------------------------------------------------

const STATE_ORDER = { pending: 0, live: 1, deleted: 2 } as const;

export class HarnessForge extends DurableObject<HarnessEnv> {
	constructor(ctx: DurableObjectState, env: HarnessEnv) {
		super(ctx, env);
		ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS artifacts_index (name TEXT PRIMARY KEY, kind TEXT NOT NULL,
			   repo_id TEXT NOT NULL, lane_id TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL,
			   updated_at INTEGER NOT NULL)`,
		);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
		);
	}

	#rows(query: string, ...args: SqlStorageValue[]): Row[] {
		return this.ctx.storage.sql.exec(query, ...args).toArray() as Row[];
	}

	#meta(k: string): string | null {
		return (this.#rows("SELECT v FROM meta WHERE k = ?", k)[0]?.v as
			| string
			| undefined) ?? null;
	}

	#setMeta(k: string, v: string | null): void {
		if (v === null) {
			this.ctx.storage.sql.exec("DELETE FROM meta WHERE k = ?", k);
		} else {
			this.ctx.storage.sql.exec(
				"INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
				k,
				v,
			);
		}
	}

	setOrigin(origin: string): void {
		this.#setMeta("origin", origin);
	}

	origin(): string {
		const origin = this.#meta("origin");
		if (origin === null) throw new Error("no canonical origin yet");
		return origin;
	}

	setupState(): SetupStateDto {
		const origin = this.#meta("origin");
		return {
			state: "done",
			forgeName: "Tartan dev-wp05b harness",
			...(origin !== null ? { canonicalOrigin: origin } : {}),
			rootKeyFallback: false,
		};
	}

	setCapBlocked(blocked: boolean): void {
		this.#setMeta("cap_blocked", blocked ? "1" : null);
	}

	capBlocked(): boolean {
		return this.#meta("cap_blocked") === "1";
	}

	recordLaneSelfTest(result: LaneSelfTestResult): void {
		this.#setMeta("lane_selftest_json", JSON.stringify(result));
	}

	lastLaneSelfTest(): LaneSelfTestResult | null {
		const raw = this.#meta("lane_selftest_json");
		return raw === null ? null : JSON.parse(raw) as LaneSelfTestResult;
	}

	// TreeFacade (the parts RepoDO core and the repo backend call)

	indexArtifacts(input: IndexArtifactsInput): IndexArtifactsResult {
		const name = input.name.toLowerCase();
		const now = Date.now();
		const existing = this.#rows(
			"SELECT state FROM artifacts_index WHERE name = ?",
			name,
		)[0] as { state: keyof typeof STATE_ORDER } | undefined;
		if (existing !== undefined) {
			if (STATE_ORDER[input.state] > STATE_ORDER[existing.state]) {
				this.ctx.storage.sql.exec(
					"UPDATE artifacts_index SET state = ?, updated_at = ? WHERE name = ?",
					input.state,
					now,
					name,
				);
			}
			return { ok: true };
		}
		const retained = Number(
			this.#rows(
				"SELECT COUNT(*) AS n FROM artifacts_index WHERE kind = 'lane' AND state IN ('pending','live')",
			)[0].n,
		);
		if (
			input.kind === "lane" && input.state === "pending" &&
			retained >= MAX_LANE_REPOS_FORGE
		) {
			return { ok: false, reason: "lane-repo-ceiling" };
		}
		this.ctx.storage.sql.exec(
			`INSERT INTO artifacts_index (name, kind, repo_id, lane_id, state, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			name,
			input.kind,
			input.repoId,
			input.laneId ?? null,
			input.state,
			now,
			now,
		);
		return { ok: true };
	}

	lookupArtifacts(name: string): ArtifactsIndexRow | null {
		return (this.#rows(
			"SELECT * FROM artifacts_index WHERE name = ?",
			name.toLowerCase(),
		)[0] as unknown as ArtifactsIndexRow | undefined) ?? null;
	}

	listArtifactsIndex(
		state: ArtifactsIndexRow["state"],
		olderThan: number,
	): ArtifactsIndexRow[] {
		return this.#rows(
			"SELECT * FROM artifacts_index WHERE state = ? AND updated_at < ? ORDER BY updated_at LIMIT 500",
			state,
			olderThan,
		) as unknown as ArtifactsIndexRow[];
	}

	countLaneRepos(): { retained: number; max: number } {
		return {
			retained: Number(
				this.#rows(
					"SELECT COUNT(*) AS n FROM artifacts_index WHERE kind = 'lane' AND state IN ('pending','live')",
				)[0].n,
			),
			max: MAX_LANE_REPOS_FORGE,
		};
	}

	index(): ArtifactsIndexRow[] {
		return this.#rows(
			"SELECT * FROM artifacts_index ORDER BY created_at",
		) as unknown as ArtifactsIndexRow[];
	}

	node(): null {
		return null;
	}

	effectiveRole(): number {
		return 0;
	}

	protectedRefs(): string[] {
		return [];
	}

	grants(): [] {
		return [];
	}
}

// ---------------------------------------------------------------------------
// HarnessRepo: RepoDO with the real core, repo backend and event log
// ---------------------------------------------------------------------------

const NO_GATES = {
	gates: () => Promise.resolve({ calls: [], effective: [], blocked: false }),
};

const kernelGitJobs = (env: HarnessEnv): KernelGitJobs =>
	createKernelGitJobsWith({
		artifacts: env.ARTIFACTS as unknown as RepoStore,
		core: (repoId) => repoOf(env, repoId).core(),
		land: () => {
			throw new Error("no land module in the harness");
		},
		exec: () => () => Promise.reject(new Error("no runner in the harness")),
		gates: NO_GATES as never,
		probe: () => ({
			addedLines: () => Promise.resolve({ lines: [], truncated: true }),
			diffPaths: () => Promise.resolve({ paths: [], truncated: true }),
		}),
	});

const emptyModule = <N extends string>(
	name: N,
	range: readonly [number, number],
) =>
	({
		name,
		range,
		migrations: [],
		create: () => ({ facade: {}, internal: {} }),
	}) as unknown as DoModule<object, never, Env, RepoInternals>;

export class HarnessRepo extends DurableObject<HarnessEnv> {
	readonly #host;

	constructor(ctx: DurableObjectState, env: HarnessEnv) {
		super(ctx, env);
		const land = createFakeLand();
		const capMac = capMacFor(env);
		const gitJobs = kernelGitJobs(env);
		this.#host = createDoHost({
			kind: "repo",
			ctx,
			env: env as unknown as Env,
			modules: {
				core: createRepoCoreModule({
					laneModes: ["import", "branch"],
					ports: () => ({
						artifacts: env.ARTIFACTS as unknown as RepoStore,
						forgeTree: () => forgeOf(env) as unknown as TreeFacade,
						canonicalOrigin: async () => await forgeOf(env).origin(),
						gitJobs,
						capMac,
						dispatch: NO_GATES as never,
						probe: () => ({
							laneDiff: (_source, after) =>
								Promise.resolve({
									rangeBase: ZERO_SHA,
									rangeTruncated: true,
									diffKey: `diffs/harness/${after}.json`,
									commits: [],
									paths: [],
									truncated: false,
								}),
						}),
						laneMode: "import",
					}),
					createRepoBackend: (deps) =>
						createRepoBackendWith(deps, {
							laneMode: "import",
							chain: ["import", "branch"],
						}),
				}),
				events: createRepoEventsModule({
					poke: () => () => Promise.resolve(),
					subscribers: () => ({
						extVersion: () => Promise.resolve(0),
						load: () => Promise.resolve({ rows: [], extVersion: 0 }),
					}),
				}),
				probe: emptyModule("probe", MIGRATION_RANGES.repo.probe),
				runs: emptyModule("runs", MIGRATION_RANGES.repo.runs),
				land: {
					name: "land",
					range: MIGRATION_RANGES.repo.land,
					migrations: [],
					create: () => ({ facade: {}, internal: land }),
				} as unknown as DoModule<object, never, Env, RepoInternals>,
			},
			common: [COMMON_MIGRATIONS.base],
		});
	}

	core() {
		return this.#host.facade("core");
	}

	events() {
		return this.#host.facade("events");
	}

	override async alarm(): Promise<void> {
		await this.#host.alarm();
	}

	/** The lane row and its seed attempts, read directly (diagnostics). */
	laneDetail(laneId: string): { lane: Row | null; attempts: Row[] } {
		const sql = this.ctx.storage.sql;
		return {
			lane:
				(sql.exec("SELECT * FROM lanes WHERE id = ?", laneId).toArray()[0] ??
					null) as Row | null,
			attempts: sql.exec(
				"SELECT attempt, seed, repo_name, outcome, code, started_at, ended_at FROM lane_seed_attempts WHERE lane_id = ? ORDER BY attempt",
				laneId,
			).toArray() as Row[],
		};
	}

	seedIntents(laneId: string): Row[] {
		return this.ctx.storage.sql.exec(
			"SELECT purpose, state, new_sha FROM kernel_writes WHERE target = ? ORDER BY created_at",
			laneId,
		).toArray() as Row[];
	}
}

// ---------------------------------------------------------------------------
// The capability route stand-in (WP4's in the product)
// ---------------------------------------------------------------------------

const plain = (status: number) =>
	new Response(null, { status, headers: { "cache-control": "no-store" } });

/** The upload-pack capabilities the stand-in advertises. */
const CAP_ADVERTISED = "thin-pack ofs-delta shallow no-progress include-tag";

const capRoute = async (
	request: Request,
	env: HarnessEnv,
	url: URL,
): Promise<Response> => {
	if (await forgeOf(env).capBlocked()) return plain(404);
	const parts = parseCapPath(url.pathname);
	const nowS = Math.floor(Date.now() / 1000);
	if (
		parts === null || parts.exp <= nowS ||
		parts.exp > nowS + LANE_CAP_TTL_S + 5 ||
		!(await capMacFor(env).verify(parts, parts.mac))
	) {
		return plain(404);
	}
	const core = repoOf(env, parts.repoId).core();
	if (parts.op === "info/refs") {
		if (
			request.method !== "GET" ||
			url.searchParams.get("service") !== "git-upload-pack"
		) {
			return plain(404);
		}
		const use = await core.capUse(parts.laneId, parts.nonce, "info");
		if (!use.ok) return plain(404);
		const canonical = await env.ARTIFACTS.get(repoArtifactsName(parts.repoId));
		const remote = (await canonical.info()).remote;
		const token = await canonical.createToken("read", LANE_CAP_TTL_S);
		try {
			const ref = trunkRef(use.ctx.defaultBranch);
			const refs = await lsRefs({
				url: remote,
				authorization: authorizationFor(token.plaintext),
			}, { refPrefixes: [ref] });
			const tip = refs.find((r) => r.ref === ref)?.sha ?? null;
			if (
				tip !== use.ctx.base &&
				!(use.ctx.pinBase && tip !== null &&
					use.ctx.explainedTips.includes(tip))
			) {
				await core.capReport(parts.laneId, parts.nonce, {
					op: "info",
					outcome: "trunk-moved",
					...(tip !== null ? { upstreamTip: tip } : {}),
				});
				return plain(503);
			}
		} finally {
			await canonical.revokeToken(token.id).catch(() => false);
		}
		const base = use.ctx.base;
		return new Response(
			concat([
				encodePktLine("# service=git-upload-pack\n"),
				encodeSpecialPkt("flush"),
				encodePktLine(
					`${base} HEAD\0${CAP_ADVERTISED} symref=HEAD:${LANE_REPO_HEAD_REF} agent=tartan\n`,
				),
				encodePktLine(`${base} ${LANE_REPO_HEAD_REF}\n`),
				encodeSpecialPkt("flush"),
			]),
			{
				headers: {
					"content-type": "application/x-git-upload-pack-advertisement",
					"cache-control": "no-store",
				},
			},
		);
	}
	if (request.method !== "POST") return plain(404);
	const use = await core.capUse(parts.laneId, parts.nonce, "pack");
	if (!use.ok) return plain(404);
	const body = new Uint8Array(await request.arrayBuffer());
	let lines: string[];
	try {
		lines = decodePktLines(body).lines.flatMap((line) =>
			line.kind === "data" ? [new TextDecoder().decode(line.data).trim()] : []
		);
	} catch {
		return plain(400);
	}
	const wants = lines.filter((l) => l.startsWith("want "));
	if (
		wants.length !== 1 || wants[0].split(" ")[1] !== use.ctx.base ||
		lines.some((l) =>
			l.startsWith("have ") || l.startsWith("shallow ") ||
			l.startsWith("deepen") || l.startsWith("filter")
		)
	) {
		await core.capReport(parts.laneId, parts.nonce, {
			op: "pack",
			outcome: "aborted",
		});
		return plain(400);
	}
	const sideBand = wants[0].includes("side-band");
	const canonical = await env.ARTIFACTS.get(repoArtifactsName(parts.repoId));
	const remote = (await canonical.info()).remote;
	const token = await canonical.createToken("read", LANE_CAP_TTL_S);
	try {
		const upstream = await fetch(`${remote}/git-upload-pack`, {
			method: "POST",
			headers: {
				authorization: authorizationFor(token.plaintext),
				"content-type": "application/x-git-upload-pack-request",
				accept: "application/x-git-upload-pack-result",
			},
			body,
		});
		if (upstream.status !== 200) {
			await upstream.body?.cancel();
			await core.capReport(parts.laneId, parts.nonce, {
				op: "pack",
				outcome: "upstream-error",
			});
			return plain(502);
		}
		let bytes = new Uint8Array(await upstream.arrayBuffer());
		// The gateway's trailer transform (`stripV0Trailer`).
		const tail = new TextDecoder().decode(bytes.subarray(bytes.length - 4));
		if (!sideBand && bytes.length >= 4 && tail === "0000") {
			bytes = bytes.subarray(0, bytes.length - 4);
		}
		await core.capReport(parts.laneId, parts.nonce, {
			op: "pack",
			bytes: bytes.length,
			outcome: "served",
		});
		return new Response(bytes, {
			headers: {
				"content-type": "application/x-git-upload-pack-result",
				"cache-control": "no-store",
			},
		});
	} finally {
		await canonical.revokeToken(token.id).catch(() => false);
	}
};

// ---------------------------------------------------------------------------
// The admin API (`/-/harness/<op>`, Bearer HARNESS_KEY)
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200): Response =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });

const ulid = createUlid();
const agentActor = (id: string) => ({ kind: "agent" as const, id });

/** Every repo name of this namespace. */
const allNames = async (env: HarnessEnv): Promise<string[]> => {
	const names: string[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 50; page++) {
		const listed = await env.ARTIFACTS.list({
			limit: 200,
			...(cursor !== undefined ? { cursor } : {}),
		});
		names.push(...listed.repos.map((r) => r.name));
		cursor = listed.cursor;
		if (cursor === undefined || listed.repos.length === 0) break;
	}
	return names;
};

/** One commit on `parent` adding `path`, pushed to `remote` with `token`. */
const pushFile = async (
	env: HarnessEnv,
	input: {
		readonly artifactsName: string;
		readonly remote: string;
		readonly token: string;
		readonly ref: string;
		readonly parent: string;
		readonly path: string;
		readonly content: string;
		readonly author: string;
	},
): Promise<{ commit: string; ok: boolean; reason?: string }> => {
	const repo = await env.ARTIFACTS.get(input.artifactsName);
	const parent = await repo.readCommit(input.parent);
	if (parent === null) throw new Error(`no commit ${input.parent}`);
	const entries = (await repo.readTree(parent.treeHash)) ?? [];
	const blob = utf8(input.content);
	const blobId = await hashObject("blob", blob);
	const tree = encodeTree([
		...entries.filter((e) => e.name !== input.path).map((e) => ({
			mode: e.mode as "100644",
			name: e.name,
			id: e.hash,
		})),
		{ mode: "100644", name: input.path, id: blobId },
	]);
	const at = Math.floor(Date.now() / 1000);
	const commit = encodeCommit({
		tree: await hashObject("tree", tree),
		parents: [input.parent],
		author: { name: input.author, email: `${input.author}@agents.test`, at },
		message: `harness: ${input.path}\n`,
	});
	const { pack, ids } = await writePack([
		{ type: "blob", data: blob },
		{ type: "tree", data: tree },
		{ type: "commit", data: commit },
	]);
	const [status] = await pushRefsCompat(
		{ url: input.remote, authorization: authorizationFor(input.token) },
		[{ ref: input.ref, old: input.parent, new: ids[2] }],
		{ pack },
	);
	return {
		commit: ids[2],
		ok: status?.ok === true,
		...(status?.ok === true ? {} : { reason: status?.reason ?? "no status" }),
	};
};

type Body = Record<string, unknown>;

const admin = async (
	op: string,
	body: Body,
	env: HarnessEnv,
	origin: string,
): Promise<Response> => {
	const forge = forgeOf(env);
	const gitJobs = kernelGitJobs(env);
	switch (op) {
		case "setup": {
			await forge.setOrigin(origin);
			const repoId = ulid();
			const name = repoArtifactsName(repoId);
			const defaultBranch = typeof body.defaultBranch === "string"
				? body.defaultBranch
				: "main";
			await forge.indexArtifacts({
				name,
				kind: "repo",
				repoId,
				state: "pending",
			});
			await env.ARTIFACTS.create(name, { setDefaultBranch: defaultBranch });
			const core = repoOf(env, repoId).core();
			await core.init({
				repoId,
				nodeId: repoId,
				path: `acme/shop-${repoId}`,
				defaultBranch,
			});
			const { commit } = await gitJobs.genesis(repoId, {
				defaultBranch,
				message: "Initial commit",
				author: { name: "Tartan", email: "tartan@kernel.invalid" },
			});
			// One more trunk commit with content, as a kernel `seed` write (K1).
			const ref = trunkRef(defaultBranch);
			const repo = await env.ARTIFACTS.get(name);
			const token = await repo.createToken("write", 300);
			const remote = (await repo.info()).remote;
			let trunk = commit;
			try {
				const pushed = await pushFile(env, {
					artifactsName: name,
					remote,
					token: token.plaintext,
					ref,
					parent: commit,
					path: "README.md",
					content:
						"# shop\n\nA repo whose lanes are their own Artifacts repos.\n",
					author: "Tartan",
				});
				if (!pushed.ok) throw new Error(`trunk push: ${pushed.reason}`);
				const intent = await core.registerKernelWrite({
					target: "repo",
					ref,
					expectOld: commit,
					newSha: pushed.commit,
					purpose: "seed",
					ownerKind: "kernel",
					ownerId: "harness",
				});
				await core.markKernelWrite(intent.id, "pushed");
				trunk = pushed.commit;
			} finally {
				await repo.revokeToken(token.id).catch(() => false);
			}
			await forge.indexArtifacts({ name, kind: "repo", repoId, state: "live" });
			return json({ repoId, trunk, defaultBranch });
		}
		case "open": {
			const core = repoOf(env, String(body.repoId)).core();
			const owners = body.owners as string[];
			const started = Date.now();
			const lanes = await Promise.all(
				owners.map((owner) =>
					core.openLane({ owner, actor: agentActor(owner) })
				),
			);
			return json({ lanes, ms: Date.now() - started });
		}
		case "wait": {
			const core = repoOf(env, String(body.repoId)).core();
			const ids = body.laneIds as string[];
			const lanes = await Promise.all(
				ids.map((id) => core.awaitLane(id, Number(body.ms ?? 20_000))),
			);
			return json({ lanes });
		}
		case "inspect": {
			const repoId = String(body.repoId);
			const laneId = String(body.laneId);
			const stub = repoOf(env, repoId);
			const detail = await stub.laneDetail(laneId);
			const intents = await stub.seedIntents(laneId);
			const lane = await stub.core().getLane(laneId);
			let refs: unknown = null;
			let commit: unknown = null;
			if (lane?.mode === "repo" && lane.state !== "deleted") {
				const read = await stub.core().upstream({ laneId }, "read");
				refs = await lsRefs({
					url: read.remote,
					authorization: authorizationFor(read.token),
				}, { refPrefixes: ["refs/", "HEAD"], symrefs: true });
				const repo = await env.ARTIFACTS.get(read.artifactsName);
				const c = await repo.readCommit(lane.base);
				commit = c === null
					? null
					: { hash: c.hash, tree: c.treeHash, parents: c.parents };
			}
			return json({ lane, detail, intents, refs, commit });
		}
		case "push": {
			const repoId = String(body.repoId);
			const laneId = String(body.laneId);
			const owner = String(body.owner);
			const core = repoOf(env, repoId).core();
			const lane = await core.getLane(laneId);
			if (lane === null || lane.head === undefined) {
				throw new Error("no lane head");
			}
			const up = await core.upstream({ laneId }, "write");
			const pushed = await pushFile(env, {
				artifactsName: up.artifactsName,
				remote: up.remote,
				token: up.token,
				ref: LANE_REPO_HEAD_REF,
				parent: lane.head,
				path: String(body.path ?? `work-${laneId}.txt`),
				content: String(body.content ?? `work of ${owner}\n`),
				author: owner,
			});
			if (!pushed.ok) return json({ pushed }, 409);
			const recorded = await core.recordPush({
				target: laneId,
				repoName: up.artifactsName,
				refs: [{
					ref: LANE_REPO_HEAD_REF,
					before: lane.head,
					after: pushed.commit,
				}],
				principal: owner,
				via: "gateway",
				requestId: `req_${ulid()}`,
			});
			return json({ pushed, pushIds: recorded.pushIds });
		}
		case "layer2": {
			// The lane's upstream write token against trunk and another lane repo.
			const repoId = String(body.repoId);
			const core = repoOf(env, repoId).core();
			const up = await core.upstream({ laneId: String(body.laneId) }, "write");
			const other = await core.upstream(
				{ laneId: String(body.otherLaneId) },
				"read",
			);
			const canonical = await env.ARTIFACTS.get(repoArtifactsName(repoId));
			const targets = {
				own: up.remote,
				canonical: (await canonical.info()).remote,
				otherLane: other.remote,
			};
			const statuses: Record<string, number> = {};
			for (const [key, remote] of Object.entries(targets)) {
				const res = await fetch(
					`${remote}/info/refs?service=git-receive-pack`,
					{ headers: { authorization: authorizationFor(up.token) } },
				);
				await res.body?.cancel();
				statuses[key] = res.status;
			}
			return json({ statuses });
		}
		case "close": {
			const core = repoOf(env, String(body.repoId)).core();
			await core.closeLane(
				String(body.laneId),
				"harness",
				agentActor(String(body.owner)),
			);
			return json({ ok: true });
		}
		case "gc": {
			const core = repoOf(env, String(body.repoId)).core();
			return json(await core.gcLanes(Number(body.at)));
		}
		case "reconcile": {
			const core = repoOf(env, String(body.repoId)).core();
			return json(await core.reconcileLaneRepos(Number(body.at ?? Date.now())));
		}
		case "orphan": {
			const repoId = String(body.repoId);
			const name = laneArtifactsName(repoId, ulid());
			await env.ARTIFACTS.create(name);
			return json({ name });
		}
		case "sweep": {
			const outcome = await runRepoBackendCron({
				artifacts: env.ARTIFACTS as unknown as RepoStore,
				tree: forge as unknown as TreeFacade,
				core: (repoId) =>
					repoOf(env, repoId).core() as unknown as RepoCoreFacade,
				log: (message, data) =>
					console.error(`[harness] ${message}`, JSON.stringify(data)),
			}, Number(body.at));
			return json(outcome);
		}
		case "names":
			return json({
				names: (await allNames(env)).filter((n) =>
					parseArtifactsName(n) !== null
				),
			});
		case "index":
			return json({ index: await forge.index() });
		case "events": {
			const core = repoOf(env, String(body.repoId));
			const events = await (core.events() as unknown as RepoEventsFacade).read({
				since: 0,
				limit: 1000,
				...(body.patterns ? { patterns: body.patterns as string[] } : {}),
			});
			return json({ events });
		}
		case "sign": {
			// A capability path for a lane that is no longer `opening` (tests of
			// refused capabilities only).
			const fields = {
				exp: Math.floor(Date.now() / 1000) + 60,
				laneId: String(body.laneId),
				nonce: String(body.nonce),
				repoId: String(body.repoId),
			};
			const mac = await capMacFor(env).sign(fields);
			return json({ path: capPath({ ...fields, mac }) });
		}
		case "selftest": {
			await forge.setOrigin(origin);
			await forge.setCapBlocked(body.blocked === true);
			try {
				const result = await runLaneSelfTestWith({
					artifacts: env.ARTIFACTS as unknown as RepoStore,
					repo: (repoId) => repoOf(env, repoId) as never,
					gitJobs,
					tree: forge as unknown as TreeFacade,
					setupState: async () => await forge.setupState(),
					store: async (r) => await forge.recordLaneSelfTest(r),
					now: () => Date.now(),
					ulid,
					sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
					log: (message, data) =>
						console.error(`[harness] ${message}`, JSON.stringify(data)),
				}, "u_01k6aaaaaaaaaaaaaaaaaaaaaa");
				return json({ result, last: await forge.lastLaneSelfTest() });
			} finally {
				await forge.setCapBlocked(false);
			}
		}
		case "cleanup": {
			const names = (await allNames(env)).filter((n) =>
				parseArtifactsName(n) !== null
			);
			const deleted: string[] = [];
			for (const name of names) {
				if (await env.ARTIFACTS.delete(name).catch(() => false)) {
					deleted.push(name);
				}
			}
			return json({ deleted });
		}
		default:
			return json({ error: `unknown op ${op}` }, 404);
	}
};

export default {
	async fetch(request: Request, env: HarnessEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/-/cap/")) {
			try {
				return await capRoute(request, env, url);
			} catch (error) {
				console.error(
					"[harness] capability route failed",
					redactSecrets(String(error)),
				);
				return plain(500);
			}
		}
		const m = /^\/-\/harness\/([a-z0-9]+)$/.exec(url.pathname);
		if (m === null) return plain(404);
		const key = env.HARNESS_KEY ?? "";
		if (
			key.length < 32 ||
			request.headers.get("authorization") !== `Bearer ${key}`
		) {
			return plain(404);
		}
		try {
			const body = request.method === "POST"
				? await request.json() as Body
				: {};
			return await admin(m[1], body, env, url.origin);
		} catch (error) {
			return json({ error: redactSecrets(String(error)).slice(0, 1000) }, 500);
		}
	},
};
