// WP4 live harness for the `repo` lane backend (deployed only as
// `tartan-dev-wp04` by `scripts/live/wp04-lanes.ts`; never part of the
// product). It serves the REAL gateway code — the capability route
// (`src/kernel/gateway/cap.ts`), lane remotes (`laneremote.ts`,
// `receive.ts`) and the canonical handlers — in front of the REAL Artifacts
// binding, so Artifacts' own importer seeds lane repos through the route and
// stock git pushes them through the edge. What RepoDO (WP5a + WP5b, the
// seeder not merged) would answer is played by `HarnessLanes`, a SQLite DO
// with the same `capUse`/`capReport`/`pushContext`/`getLane`/`upstream`
// contract; the capability MAC uses WP2's real keyring (HKDF from the
// `TARTAN_SECRET` the driver generates) and `capMacOf`.
//
// Credentials: the admin API takes `Authorization: Bearer <HARNESS_KEY>`.
// Git tokens are stored as sha256 hashes and live only in the driver's
// memory. Artifacts tokens never leave this Worker (K11). Capability paths
// are never logged.

import { DurableObject } from "cloudflare:workers";
import {
	capPath,
	type Lane,
	type LaneState,
	type NodeDto,
	redactSecrets,
	ROLE,
	ulid,
	ZERO_SHA,
} from "../../packages/contract/src/index.ts";
import type {
	AuthContext,
	CapContext,
	CapReport,
	CapUse,
	PushContext,
	PushReport,
	ReadContext,
	RecordPushResult,
	RefRow,
	Upstream,
} from "../../packages/contract/src/kernel.ts";
import { decodePktLines } from "../../packages/gitproto/src/index.ts";
import { CAP_INFO_USES_MAX } from "../../src/constants.ts";
import { capMacOf } from "../../src/kernel/http/capmac.ts";
import { createKeyring } from "../../src/kernel/identity/keyring.ts";
import {
	type CapDeps,
	createCapControlBucket,
	createCapFailureBuckets,
	createCapTokenMinter,
	handleCapInfoRefs,
	handleCapNotFound,
	handleCapUploadPack,
} from "../../src/kernel/gateway/cap.ts";
import {
	handleLaneInfoRefs,
	handleLaneUploadPack,
} from "../../src/kernel/gateway/laneremote.ts";
import {
	canonicalPushPolicy,
	laneRepoPolicy,
} from "../../src/kernel/gateway/policy.ts";
import { handleReceivePack } from "../../src/kernel/gateway/receive.ts";
import type {
	GatewayDeps,
	GatewayRepo,
	GitRequest,
} from "../../src/kernel/gateway/types.ts";
import {
	handleInfoRefs,
	handleUploadPack,
} from "../../src/kernel/gateway/upload.ts";
import { authorizationFor } from "../../src/kernel/repo/gitremote.ts";

type HarnessEnv = {
	readonly ARTIFACTS: Artifacts;
	readonly LANES: DurableObjectNamespace<HarnessLanes>;
	readonly HARNESS_KEY?: string;
	readonly TARTAN_SECRET?: string;
};

export const REPO_PATH = "acme/shop";
const ACTIVE: readonly LaneState[] = ["open", "submitted", "landing", "lost"];
const MAIN = "refs/heads/main";

type Row = Record<string, SqlStorageValue>;

const sha256Hex = async (text: string): Promise<string> =>
	[
		...new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
		),
	].map((b) => b.toString(16).padStart(2, "0")).join("");

const randomHex = (bytes: number): string =>
	[...crypto.getRandomValues(new Uint8Array(bytes))].map((b) =>
		b.toString(16).padStart(2, "0")
	).join("");

const randomToken = (prefix: string): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return `${prefix}${
		btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(
			/\//g,
			"_",
		).replace(/=+$/, "")
	}`;
};

const laneRepoNameOf = (repoId: string, laneId: string): string =>
	`l-${repoId}-${laneId.slice(3)}`;

export class HarnessLanes extends DurableObject<HarnessEnv> {
	#tokens = new Map<string, { token: string; expiresAt: number }>();
	#remotes = new Map<string, string>();

	constructor(ctx: DurableObjectState, env: HarnessEnv) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		for (
			const ddl of [
				"CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
				"CREATE TABLE IF NOT EXISTS principals (hash TEXT PRIMARY KEY, auth_json TEXT NOT NULL, role INTEGER NOT NULL)",
				"CREATE TABLE IF NOT EXISTS lanes (id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, repo_name TEXT NOT NULL, base TEXT NOT NULL, head TEXT, nonce TEXT, attempt INTEGER NOT NULL, info_uses INTEGER NOT NULL, consumed INTEGER NOT NULL, pin_base INTEGER NOT NULL, explained TEXT NOT NULL, created_at INTEGER NOT NULL)",
				"CREATE TABLE IF NOT EXISTS pushes (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, ref TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL, principal TEXT, target TEXT NOT NULL, repo_name TEXT, bytes INTEGER, at INTEGER NOT NULL)",
				"CREATE TABLE IF NOT EXISTS rejections (id TEXT PRIMARY KEY, target TEXT NOT NULL, reason TEXT NOT NULL, refs TEXT NOT NULL, at INTEGER NOT NULL)",
				"CREATE TABLE IF NOT EXISTS cap_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, lane_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL)",
			]
		) sql.exec(ddl);
	}

	#rows(query: string, ...args: SqlStorageValue[]): Row[] {
		return this.ctx.storage.sql.exec(query, ...args).toArray() as Row[];
	}

	#meta(key: string): string | null {
		return (this.#rows("SELECT value FROM meta WHERE key = ?", key)[0]
			?.value as string | undefined) ?? null;
	}

	#setMeta(key: string, value: string): void {
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
			key,
			value,
		);
	}

	#repoId(): string {
		const id = this.#meta("repo_id");
		if (id === null) throw new Error("not set up");
		return id;
	}

	#event(laneId: string | null, kind: string, data: unknown): void {
		this.ctx.storage.sql.exec(
			"INSERT INTO cap_events (lane_id, kind, data, at) VALUES (?, ?, ?, ?)",
			laneId,
			kind,
			JSON.stringify(data),
			Date.now(),
		);
	}

	async #token(
		name: string,
		scope: "read" | "write",
	): Promise<{ token: string; remote: string }> {
		const key = `${name}|${scope}`;
		const cached = this.#tokens.get(key);
		if (cached === undefined || cached.expiresAt < Date.now() + 60_000) {
			const repo = await this.env.ARTIFACTS.get(name);
			const created = await repo.createToken(scope, 600);
			if (!this.#remotes.has(name)) {
				this.#remotes.set(name, (await repo.info()).remote);
			}
			this.#tokens.set(key, {
				token: created.plaintext,
				expiresAt: Date.now() + 540_000,
			});
		}
		return {
			token: (this.#tokens.get(key) as { token: string }).token,
			remote: this.#remotes.get(name) as string,
		};
	}

	async #tip(name: string, ref: string): Promise<string | null> {
		return (await this.#refsOf(name))[ref] ?? null;
	}

	/** Every advertised ref of `name`, from a v0 `info/refs` (as the gateway reads them). */
	async #refsOf(name: string): Promise<Record<string, string>> {
		const { token, remote } = await this.#token(name, "read");
		const res = await fetch(`${remote}/info/refs?service=git-upload-pack`, {
			headers: { authorization: authorizationFor(token) },
		});
		if (res.status !== 200) {
			await res.body?.cancel();
			throw new Error(`info/refs answered ${res.status}`);
		}
		const lines = decodePktLines(new Uint8Array(await res.arrayBuffer())).lines;
		const out: Record<string, string> = {};
		const decoder = new TextDecoder();
		for (const line of lines) {
			if (line.kind !== "data") continue;
			const text = decoder.decode(line.data).replace(/\n$/, "");
			if (text.startsWith("# service=")) continue;
			const [refPart] = text.split("\0");
			const [sha, ref] = refPart.split(" ");
			if (ref === undefined || ref === "capabilities^{}") continue;
			out[ref] = sha;
		}
		return out;
	}

	// --- admin -------------------------------------------------------------

	/** Imports a public repo as the canonical repo `r-<repoId>` (its default branch kept). */
	async setup(input: { source: string }): Promise<{
		repoId: string;
		defaultBranch: string;
		branches: string[];
		trunk: string;
		importMs: number;
	}> {
		const repoId = ulid().toLowerCase();
		const name = `r-${repoId}`;
		const started = Date.now();
		await this.env.ARTIFACTS.import({
			source: { url: input.source },
			target: { name },
		});
		const importMs = Date.now() - started;
		// Tartan takes the default branch from the advertised HEAD (kept on the
		// repo node) and polls until the imported refs read.
		let refs: Record<string, string> = {};
		for (let i = 0; i < 30 && refs.HEAD === undefined; i++) {
			if (i > 0) await new Promise((r) => setTimeout(r, 1_000));
			try {
				refs = await this.#refsOf(name);
			} catch {
				// Not ready yet.
			}
		}
		const branches = Object.keys(refs).filter((r) =>
			r.startsWith("refs/heads/")
		);
		const head = branches.find((r) => refs[r] === refs.HEAD) ?? branches[0];
		if (head === undefined) {
			throw new Error(
				`the imported repo has no branch (refs=${
					JSON.stringify(Object.keys(refs))
				})`,
			);
		}
		const defaultBranch = head.slice("refs/heads/".length);
		this.#setMeta("repo_id", repoId);
		this.#setMeta("default_branch", defaultBranch);
		return {
			repoId,
			defaultBranch,
			branches,
			trunk: refs[head],
			importMs,
		};
	}

	async mint(input: {
		kind: "user" | "agent";
		role: number;
		scopes?: string[];
		laneId?: string;
	}): Promise<{ token: string; principal: string }> {
		const principal = `${input.kind === "user" ? "u" : "a"}_${ulid()}`;
		const token = randomToken(input.kind === "user" ? "tpat_" : "tagt_");
		const auth: AuthContext = {
			principal,
			kind: input.kind,
			via: input.kind === "user" ? "pat" : "agent-token",
			tokenId: `tok_${ulid()}`,
			scopes: (input.scopes ??
				["repo:read", "repo:write", "lanes", "mcp"]) as AuthContext["scopes"],
			nodeId: null,
			laneId: input.laneId ?? null,
			maxRole: ROLE.owner,
			isAdmin: false,
		};
		this.ctx.storage.sql.exec(
			"INSERT INTO principals (hash, auth_json, role) VALUES (?, ?, ?)",
			await sha256Hex(token),
			JSON.stringify(auth),
			input.role,
		);
		return { token, principal };
	}

	/**
	 * An `opening` lane on attempt 1 (what WP5b's open transaction plans):
	 * the base is the canonical default-branch tip now, the nonce fresh.
	 * Returns the signing fields; the Worker signs and starts the import.
	 */
	async planLane(input: {
		owner: string;
		pinBase?: boolean;
	}): Promise<{
		laneId: string;
		repoId: string;
		nonce: string;
		repoName: string;
		base: string;
	}> {
		const repoId = this.#repoId();
		const defaultBranch = this.#meta("default_branch") ?? "main";
		const base = await this.#tip(`r-${repoId}`, `refs/heads/${defaultBranch}`);
		if (base === null) throw new Error("no trunk");
		const laneId = `ln_${ulid().toLowerCase()}`;
		const nonce = randomHex(16);
		const repoName = laneRepoNameOf(repoId, laneId);
		this.ctx.storage.sql.exec(
			"INSERT INTO lanes (id, owner, state, repo_name, base, head, nonce, attempt, info_uses, consumed, pin_base, explained, created_at) VALUES (?, ?, 'opening', ?, ?, NULL, ?, 1, 0, 0, ?, '[]', ?)",
			laneId,
			input.owner,
			repoName,
			base,
			nonce,
			input.pinBase ? 1 : 0,
			Date.now(),
		);
		return { laneId, repoId, nonce, repoName, base };
	}

	/** After the import: verify the lane repo (exactly `refs/heads/main` at the base), then open it. */
	async verifyLane(laneId: string): Promise<{
		refs: Record<string, string>;
		ok: boolean;
	}> {
		const lane = this.#rows("SELECT * FROM lanes WHERE id = ?", laneId)[0];
		if (lane === undefined) throw new Error("unknown lane");
		// As WP5b's verification: poll briefly until the imported refs read.
		let refs: Record<string, string> = {};
		for (let i = 0; i < 20 && refs[MAIN] === undefined; i++) {
			if (i > 0) await new Promise((r) => setTimeout(r, 1_000));
			refs = await this.#refsOf(lane.repo_name as string).catch(() => ({}));
		}
		const ok = Object.keys(refs).filter((r) => r !== "HEAD").join(",") ===
				MAIN && refs[MAIN] === lane.base;
		this.ctx.storage.sql.exec(
			"UPDATE lanes SET state = ?, head = ?, nonce = NULL WHERE id = ?",
			ok ? "open" : "closed",
			ok ? lane.base : null,
			laneId,
		);
		return { refs, ok };
	}

	setLaneState(laneId: string, state: string): void {
		this.ctx.storage.sql.exec(
			"UPDATE lanes SET state = ? WHERE id = ?",
			state,
			laneId,
		);
	}

	/**
	 * Layer 2 on the real binding: a write token minted for lane A's repo (as
	 * `upstream({laneId}, "write")` mints it) against the canonical repo, lane
	 * B's repo and lane A's own repo (receive-pack advertisements).
	 */
	async layer2(input: { laneA: string; laneB: string }): Promise<
		Record<string, number>
	> {
		const repoId = this.#repoId();
		const a = laneRepoNameOf(repoId, input.laneA);
		const { token } = await this.#token(a, "write");
		const out: Record<string, number> = {};
		for (
			const [label, name] of [
				["canonical", `r-${repoId}`],
				["laneB", laneRepoNameOf(repoId, input.laneB)],
				["laneA", a],
			] as const
		) {
			const remote = (await this.#token(name, "read")).remote;
			const res = await fetch(
				`${remote}/info/refs?service=git-receive-pack`,
				{ headers: { authorization: authorizationFor(token) } },
			);
			await res.body?.cancel();
			out[label] = res.status;
		}
		return out;
	}

	/** The repo's id: the node id the gateway resolves `acme/shop` to. */
	repoId(): string | null {
		return this.#meta("repo_id");
	}

	/** The canonical repo's tokens (the capability route's read tokens are revoked). */
	async canonicalTokens(): Promise<
		{ scope: string; state: string; ttlS: number }[]
	> {
		const repo = await this.env.ARTIFACTS.get(`r-${this.#repoId()}`);
		const list = await repo.listTokens();
		return list.tokens.map((t) => ({
			scope: t.scope,
			state: t.state,
			ttlS: Math.round(
				(Date.parse(t.expiresAt) - Date.parse(t.createdAt)) / 1000,
			),
		}));
	}

	async state(): Promise<Record<string, unknown>> {
		const repoId = this.#meta("repo_id");
		return {
			canonical: repoId === null ? null : await this.#refsOf(`r-${repoId}`),
			lanes: await Promise.all(
				this.#rows("SELECT * FROM lanes ORDER BY created_at").map(
					async (lane) => ({
						id: lane.id,
						state: lane.state,
						base: lane.base,
						head: lane.head,
						infoUses: lane.info_uses,
						consumed: lane.consumed === 1,
						repo: lane.state === "opening"
							? null
							: await this.#refsOf(lane.repo_name as string).catch((e) =>
								`unreadable: ${redactSecrets(String(e))}`
							),
					}),
				),
			),
			pushes: this.#rows("SELECT * FROM pushes ORDER BY at, id"),
			rejections: this.#rows("SELECT * FROM rejections ORDER BY at, id"),
			capEvents: this.#rows("SELECT * FROM cap_events ORDER BY seq").map((
				row,
			) => ({ ...row, data: JSON.parse(row.data as string) })),
		};
	}

	/** Deletes every repo of the harness namespace (`tartan-dev-wp04`, used by nothing else). */
	async cleanup(): Promise<string[]> {
		const names: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.env.ARTIFACTS.list({ limit: 100, cursor });
			names.push(...page.repos.map((repo) => repo.name));
			cursor = page.cursor;
		} while (cursor);
		const deleted: string[] = [];
		for (const name of names) {
			if (await this.env.ARTIFACTS.delete(name)) deleted.push(name);
		}
		for (
			const table of [
				"meta",
				"principals",
				"lanes",
				"pushes",
				"rejections",
				"cap_events",
			]
		) {
			this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
		}
		this.#tokens.clear();
		this.#remotes.clear();
		return deleted;
	}

	// --- the capability state (WP5b's contract) ------------------------------

	capUse(laneId: string, nonce: string, op: "info" | "pack"): CapUse {
		const lane = this.#rows("SELECT * FROM lanes WHERE id = ?", laneId)[0];
		const refuse = (
			reason: "unknown" | "not-opening" | "consumed" | "uses-exceeded",
		): CapUse => {
			this.#event(laneId, "capUse", { op, ok: false, reason });
			return { ok: false, reason };
		};
		if (lane === undefined) return refuse("unknown");
		if (lane.state !== "opening") return refuse("not-opening");
		if (lane.nonce !== nonce) return refuse("unknown");
		if (lane.consumed === 1) return refuse("consumed");
		if (op === "info") {
			if ((lane.info_uses as number) >= CAP_INFO_USES_MAX) {
				return refuse("uses-exceeded");
			}
			this.ctx.storage.sql.exec(
				"UPDATE lanes SET info_uses = info_uses + 1 WHERE id = ?",
				laneId,
			);
		} else {
			this.ctx.storage.sql.exec(
				"UPDATE lanes SET consumed = 1 WHERE id = ?",
				laneId,
			);
		}
		this.#event(laneId, "capUse", { op, ok: true });
		const ctx: CapContext = {
			repoId: this.#repoId(),
			laneId,
			nonce,
			attempt: lane.attempt as number,
			base: lane.base as string,
			defaultBranch: this.#meta("default_branch") ?? "main",
			pinBase: lane.pin_base === 1,
			explainedTips: JSON.parse(lane.explained as string),
		};
		return { ok: true, ctx };
	}

	capReport(laneId: string, _nonce: string, report: CapReport): void {
		this.#event(laneId, "capReport", report);
	}

	/** What the Worker saw of a capability request (never the path). */
	capSeen(data: Record<string, unknown>): void {
		this.#event(null, "request", data);
	}

	// --- what the gateway calls (the RepoDO contract) ------------------------

	authOf(hash: string): AuthContext | null {
		const row = this.#rows(
			"SELECT auth_json FROM principals WHERE hash = ?",
			hash,
		)[0];
		return row === undefined
			? null
			: JSON.parse(row.auth_json as string) as AuthContext;
	}

	role(principal: string): number {
		return Number(
			this.#rows(
				"SELECT MAX(role) AS role FROM principals WHERE json_extract(auth_json, '$.principal') = ?",
				principal,
			)[0]?.role ?? 0,
		);
	}

	#lane(row: Row): Lane {
		return {
			id: row.id as string,
			repoId: this.#repoId(),
			kind: "lane",
			mode: "repo",
			seed: "import",
			ref: MAIN,
			branch: `lanes/${row.id}`,
			owner: row.owner as string,
			delegates: [],
			footprint: { paths: [], projects: [] } as unknown as Lane["footprint"],
			base: row.base as string,
			...(row.head === null ? {} : { head: row.head as string }),
			state: row.state as LaneState,
			quarantined: false,
			leaseExpiresAt: Number.MAX_SAFE_INTEGER,
			pushes: 0,
			createdAt: row.created_at as number,
			remote: `/${REPO_PATH}/-/lanes/${row.id}.git`,
		};
	}

	getLane(laneId: string): Lane | null {
		const row = this.#rows("SELECT * FROM lanes WHERE id = ?", laneId)[0];
		return row === undefined ? null : this.#lane(row);
	}

	pushContext(
		auth: AuthContext,
		tokenLaneId: string | null,
		target?: { laneId: string },
	): PushContext {
		const scoped = auth.scopes.includes("lanes") ||
			auth.scopes.includes("repo:write");
		const own = this.#rows(
			`SELECT * FROM lanes WHERE owner = ? AND state IN (${
				ACTIVE.map(() => "?").join(",")
			})`,
			auth.principal,
			...ACTIVE,
		).filter((lane) => tokenLaneId === null || lane.id === tokenLaneId);
		const lane = target === undefined
			? undefined
			: this.#rows("SELECT * FROM lanes WHERE id = ?", target.laneId)[0];
		if (target !== undefined && lane === undefined) {
			throw Object.assign(new Error(`not_found: unknown lane`), {
				name: "TartanError",
				code: "not_found",
			});
		}
		return {
			caller: {
				kind: auth.kind,
				writeCredential: scoped && this.role(auth.principal) >= ROLE.developer,
			},
			ownLanes: own.map((row) => ({
				laneId: row.id as string,
				mode: "repo" as const,
				ref: MAIN,
				state: row.state as LaneState,
				headSha: (row.head as string | null) ?? null,
				resumable: true,
				leased: false,
			})),
			...(lane === undefined ? {} : {
				target: {
					laneId: lane.id as string,
					mode: "repo" as const,
					state: lane.state as LaneState,
					owner: lane.owner as string,
					delegates: [],
					headSha: (lane.head as string | null) ?? null,
					quarantined: false,
					resumable: true,
					leased: false,
				},
			}),
			adopted: [],
			protectedPatterns: [
				`refs/heads/${this.#meta("default_branch") ?? "main"}`,
			],
			defaultBranch: this.#meta("default_branch") ?? "main",
			caseFoldedRefs: [],
			importState: "none",
			landingPaused: false,
		};
	}

	readContext(principal: AuthContext | "anon"): ReadContext {
		return {
			view: principal === "anon" ? "public" : "member",
			visibleTips: [],
			recentTips: [],
			ownLanes: [],
		};
	}

	recordPush(report: PushReport): RecordPushResult {
		const at = Date.now();
		const events = report.refs.map((update) => {
			const id = `p_${ulid()}`;
			this.ctx.storage.sql.exec(
				"INSERT INTO pushes (id, request_id, ref, before, after, principal, target, repo_name, bytes, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				id,
				report.requestId,
				update.ref,
				update.before,
				update.after,
				report.principal,
				report.target,
				report.repoName ?? null,
				report.bytes ?? null,
				at,
			);
			if (report.target !== "repo" && update.ref === MAIN) {
				this.ctx.storage.sql.exec(
					"UPDATE lanes SET head = ? WHERE id = ?",
					update.after === ZERO_SHA ? null : update.after,
					report.target,
				);
			}
			return {
				id: ulid(),
				type: "push.accepted",
				data: { pushId: id, target: report.target, ...update, via: report.via },
			};
		});
		return {
			pushIds: events.map((e) => e.data.pushId),
			eventIds: events.map((e) => e.id),
			events,
			reconciled: [],
		} as unknown as RecordPushResult;
	}

	recordRejection(rejection: {
		target: string;
		commands: readonly { ref: string }[];
		reason: string;
	}): void {
		this.ctx.storage.sql.exec(
			"INSERT INTO rejections (id, target, reason, refs, at) VALUES (?, ?, ?, ?, ?)",
			ulid(),
			rejection.target,
			rejection.reason,
			JSON.stringify(rejection.commands.map((c) => c.ref)),
			Date.now(),
		);
	}

	recordDiff(): void {}

	refs(): RefRow[] {
		return [];
	}

	/** Memory-only, scoped to one repo, 600 s (K11), as RepoDO mints them. */
	async upstream(
		target: { laneId?: string },
		scope: "read" | "write",
	): Promise<Upstream> {
		const repoId = this.#repoId();
		if (target.laneId === undefined) {
			const name = `r-${repoId}`;
			const { token, remote } = await this.#token(name, scope);
			return {
				artifactsName: name,
				remote,
				token,
				expiresAt: Date.now() + 540_000,
				kind: "canonical",
				ref: `refs/heads/${this.#meta("default_branch") ?? "main"}`,
			};
		}
		const lane = this.#rows(
			"SELECT * FROM lanes WHERE id = ?",
			target.laneId,
		)[0];
		if (lane === undefined || lane.state === "opening") {
			throw Object.assign(new Error("not_found: no lane repo"), {
				name: "TartanError",
				code: "not_found",
			});
		}
		const name = lane.repo_name as string;
		const { token, remote } = await this.#token(name, scope);
		return {
			artifactsName: name,
			remote,
			token,
			expiresAt: Date.now() + 540_000,
			kind: "lane-repo",
			ref: MAIN,
		};
	}
}

// ---------------------------------------------------------------------------
// The Worker
// ---------------------------------------------------------------------------

const LANE_PATH =
	/^\/acme\/shop\/-\/lanes\/(ln_[0-9a-hjkmnp-tv-z]{26})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const CANONICAL_PATH =
	/^\/acme\/shop(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const CAP_ROUTE = /^\/-\/cap\//;

const json = (value: unknown, status = 200) =>
	Response.json(value, { status, headers: { "cache-control": "no-store" } });

const constantTimeEqual = (a: string, b: string): boolean => {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	if (x.length !== y.length) return false;
	let diff = 0;
	for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
	return diff === 0;
};

const credentialOf = (header: string): string | null => {
	const m = /^\s*(Bearer|Basic)\s+(\S+)\s*$/i.exec(header);
	if (m === null) return null;
	if (m[1].toLowerCase() === "bearer") return m[2];
	try {
		const decoded = atob(m[2]);
		const colon = decoded.indexOf(":");
		return colon === -1 ? null : decoded.slice(colon + 1);
	} catch {
		return null;
	}
};

let keyring: Promise<CryptoKey> | null = null;
const capBuckets = createCapFailureBuckets();
const capControl = createCapControlBucket(50);
let minter: ((repoId: string) => ReturnType<CapDeps["mintReadToken"]>) | null =
	null;

const log = (message: string, data: Record<string, unknown>) =>
	console.error(redactSecrets(message), redactSecrets(JSON.stringify(data)));

/** WP2's keyring (HKDF from the root secret, label `tartan:lane-cap:v1`), once per isolate. */
const macOf = (env: HarnessEnv) => {
	keyring ??= createKeyring(env.TARTAN_SECRET ?? "").then((k) => k.laneCap);
	const key = keyring;
	return capMacOf(() => key);
};

const capDeps = (
	env: HarnessEnv,
	lanes: DurableObjectStub<HarnessLanes>,
): CapDeps => {
	minter ??= createCapTokenMinter({
		artifacts: env.ARTIFACTS as never,
		bucket: capControl,
		ttlS: 120,
		log,
	});
	const mac = macOf(env);
	return {
		verifyMac: (fields, value) => mac.verify(fields, value),
		repo: () => ({
			capUse: (laneId, nonce, op) => lanes.capUse(laneId, nonce, op),
			capReport: (laneId, nonce, report) =>
				lanes.capReport(laneId, nonce, report),
		}),
		mintReadToken: minter,
		fetch: (request) => fetch(request),
		now: () => Date.now(),
		log,
		buckets: capBuckets,
		config: { ttlS: 120, clientCheck: false, upstreamAuth: "bearer" },
	};
};

const admin = async (
	request: Request,
	env: HarnessEnv,
	lanes: DurableObjectStub<HarnessLanes>,
	action: string,
	origin: string,
): Promise<Response> => {
	const key = env.HARNESS_KEY ?? "";
	const given = (request.headers.get("authorization") ?? "").replace(
		/^Bearer /,
		"",
	);
	if (key.length < 32 || !constantTimeEqual(given, key)) {
		return json({ error: "not found" }, 404);
	}
	const body = request.method === "POST"
		? await request.json().catch(() => ({})) as Record<string, unknown>
		: {};
	switch (action) {
		case "setup":
			return json(await lanes.setup({ source: String(body.source) }));
		case "mint":
			return json(await lanes.mint(body as never));
		case "open-lane": {
			// WP5b's seeder in miniature: plan the attempt, sign the
			// capability, `import()` through the route with `branch: main`,
			// verify the lane repo, open the lane.
			const plan = await lanes.planLane({
				owner: String(body.owner),
				pinBase: body.pinBase === true,
			});
			const exp = Math.floor(Date.now() / 1000) + 120;
			const fields = {
				exp,
				laneId: plan.laneId,
				nonce: plan.nonce,
				repoId: plan.repoId,
			};
			const path = capPath({ ...fields, mac: await macOf(env).sign(fields) });
			const started = Date.now();
			let importError: string | null = null;
			try {
				await env.ARTIFACTS.import({
					source: { url: `${origin}${path}`, branch: "main" },
					target: { name: plan.repoName },
				});
			} catch (error) {
				importError = redactSecrets(
					error instanceof Error
						? `${error.name}: ${
							(error as { code?: string }).code ?? ""
						} ${error.message}`
						: String(error),
				);
			}
			const importMs = Date.now() - started;
			const verified = importError === null
				? await lanes.verifyLane(plan.laneId)
				: { refs: {}, ok: false };
			return json({
				laneId: plan.laneId,
				base: plan.base,
				importMs,
				importError,
				...verified,
				// For the driver's replay and negative probes only (consumed and
				// short-lived; the driver never prints it).
				capPath: path,
				capFields: fields,
			});
		}
		case "sign": {
			// Signed variants for the negative probes (an expired one, one past the TTL).
			const fields = body.fields as {
				exp: number;
				laneId: string;
				nonce: string;
				repoId: string;
			};
			return json({
				path: capPath({ ...fields, mac: await macOf(env).sign(fields) }),
			});
		}
		case "lane-state":
			await lanes.setLaneState(String(body.laneId), String(body.state));
			return json({ ok: true });
		case "layer2":
			return json(
				await lanes.layer2({
					laneA: String(body.laneA),
					laneB: String(body.laneB),
				}),
			);
		case "tokens":
			return json(await lanes.canonicalTokens());
		case "state":
			return json(await lanes.state());
		case "cleanup":
			return json({ deleted: await lanes.cleanup() });
	}
	return json({ error: "not found" }, 404);
};

export default {
	async fetch(
		request: Request,
		env: HarnessEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		const lanes = env.LANES.getByName("harness");
		const action = /^\/-\/harness\/([a-z0-9-]+)$/.exec(url.pathname);
		if (action) {
			try {
				return await admin(request, env, lanes, action[1], url.origin);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return json({ error: redactSecrets(message) }, 500);
			}
		}
		if (CAP_ROUTE.test(url.pathname)) {
			const deps = capDeps(env, lanes);
			const c = {
				req: request,
				url,
				waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
			};
			const op = url.pathname.endsWith("/info/refs") && request.method === "GET"
				? "info"
				: url.pathname.endsWith("/git-upload-pack") &&
						request.method === "POST"
				? "pack"
				: "other";
			const response = op === "info"
				? await handleCapInfoRefs(deps, c)
				: op === "pack"
				? await handleCapUploadPack(deps, c)
				: await handleCapNotFound(deps, c);
			if (response.status !== 404 && response.status !== 429) {
				ctx.waitUntil(lanes.capSeen({
					op,
					method: request.method,
					userAgent: request.headers.get("user-agent"),
					gitProtocol: request.headers.get("git-protocol"),
					asn: (request as { cf?: { asn?: number } }).cf?.asn ?? null,
					status: response.status,
				}));
			}
			return response;
		}
		const lane = LANE_PATH.exec(url.pathname);
		const canonical = lane === null ? CANONICAL_PATH.exec(url.pathname) : null;
		const op = lane?.[2] ?? canonical?.[1];
		if (op === undefined) return new Response("not found\n", { status: 404 });
		// WP2's middleware for `POLICY.git`: tokens only, a bad one is 401.
		const header = request.headers.get("authorization");
		let auth: AuthContext | null = null;
		if (header !== null) {
			const credential = credentialOf(header);
			auth = credential === null
				? null
				: await lanes.authOf(await sha256Hex(credential));
			if (auth === null) {
				return new Response("authentication required\n", {
					status: 401,
					headers: {
						"www-authenticate": 'Basic realm="Tartan", charset="UTF-8"',
					},
				});
			}
		}
		// The repo id is its node's ULID: lanes name it as `repoId`.
		const repoId = await lanes.repoId();
		if (repoId === null) return new Response("not set up\n", { status: 503 });
		const node: NodeDto = {
			id: repoId,
			parentId: null,
			kind: "repo",
			slug: "shop",
			path: REPO_PATH,
			depth: 1,
			visibility: "private",
			defaultBranch: "main",
			archived: false,
			createdAt: 0,
		};
		const deps: GatewayDeps = {
			tree: {
				resolvePath: (path) =>
					Promise.resolve(path === REPO_PATH ? { node, rest: "" } : null),
				effectiveRole: async (principals) =>
					Math.max(
						0,
						...(await Promise.all(principals.map((p) => lanes.role(p)))),
					) as 0,
				node: (id) => Promise.resolve(id === node.id ? node : null),
			},
			repo: () => lanes as unknown as GatewayRepo,
			isForgeOwner: () => Promise.resolve(false),
			probe: () => ({
				laneDiff: (_source, after) =>
					Promise.resolve({
						rangeBase: after,
						rangeTruncated: false,
						diffKey: "harness",
						commits: [],
						paths: [],
						truncated: false,
					}),
			}),
			fetch: (req) => fetch(req),
			requestId: ulid,
			log,
			config: {
				maxPushBytes: 95_000_000,
				echo: true,
				upstreamAuth: "bearer",
				phase1WaitMs: 5_000,
				policy: canonicalPushPolicy,
				lanePolicy: laneRepoPolicy,
			},
		};
		const r: GitRequest = {
			req: request,
			url,
			repoPath: REPO_PATH,
			...(lane === null ? {} : { laneId: lane[1] }),
			auth,
			waitUntil: (promise) => ctx.waitUntil(promise),
		};
		const method = op === "info/refs" ? "GET" : "POST";
		if (request.method !== method) {
			return new Response("method\n", { status: 405 });
		}
		if (op === "git-receive-pack") return await handleReceivePack(deps, r);
		if (lane !== null) {
			return op === "info/refs"
				? await handleLaneInfoRefs(deps, r)
				: await handleLaneUploadPack(deps, r);
		}
		return op === "info/refs"
			? await handleInfoRefs(deps, r)
			: await handleUploadPack(deps, r);
	},
} satisfies ExportedHandler<HarnessEnv>;
