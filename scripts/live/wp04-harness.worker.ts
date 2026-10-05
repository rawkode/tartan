// WP4 live harness Worker (deployed only as `tartan-dev-wp04` by
// `scripts/live/wp04-git.ts --deploy`; never part of the product). It serves
// the REAL gateway handlers (`src/kernel/gateway`) in front of the REAL
// Artifacts binding, so stock git can be driven through the edge: auth,
// advertisements, the ref-policy table, synthesized rejections, the public
// view, size limits and the relay. What the product's RepoDO (WP5a) and tree
// (WP3, not merged) would answer is played by `HarnessRepo`, a small SQLite DO
// with the same `pushContext`/`readContext`/`recordPush`/`upstream` contract;
// the local suites run the real RepoDO core instead.
//
// Credentials: the admin API takes `Authorization: Bearer <HARNESS_KEY>` (a
// secret the driver generates and never prints). Git tokens are minted by
// the admin API, stored as sha256 hashes, and live only in the driver's
// memory. Artifacts tokens never leave this Worker (K11).

import { DurableObject } from "cloudflare:workers";
import {
	isHiddenRef,
	type NodeDto,
	redactSecrets,
	ROLE,
	trunkRef,
	ulid,
	ZERO_SHA,
} from "../../packages/contract/src/index.ts";
import type {
	AuthContext,
	PushContext,
	PushReport,
	ReadContext,
	RecordPushResult,
	RefRow,
	Upstream,
} from "../../packages/contract/src/kernel.ts";
import { maxPushBytes } from "../../src/constants.ts";
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

type HarnessEnv = {
	readonly ARTIFACTS: Artifacts;
	readonly REPO: DurableObjectNamespace<HarnessRepo>;
	readonly HARNESS_KEY?: string;
	readonly TARTAN_MAX_PUSH_MB: string;
	/** "1": band-2 guidance (ECHO_ENABLED) for the display check. */
	readonly HARNESS_ECHO?: string;
};

export const REPO_PATH = "acme/shop";
const ACTIVE = ["open", "submitted", "landing", "lost"];
const RECENT_MS = 600_000;

const sha256Hex = async (text: string): Promise<string> =>
	[
		...new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
		),
	].map((b) => b.toString(16).padStart(2, "0")).join("");

const randomToken = (prefix: string): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return prefix + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-")
		.replace(/\//g, "_").replace(/=+$/, "");
};

type Row = Record<string, SqlStorageValue>;

/** The RepoDO stand-in: one repo, its index, lanes, pushes and principals. */
export class HarnessRepo extends DurableObject<HarnessEnv> {
	#tokens = new Map<string, { token: string; expiresAt: number }>();
	#remote: string | null = null;

	constructor(ctx: DurableObjectState, env: HarnessEnv) {
		super(ctx, env);
		const sql = ctx.storage.sql;
		for (
			const ddl of [
				"CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
				"CREATE TABLE IF NOT EXISTS principals (hash TEXT PRIMARY KEY, auth_json TEXT NOT NULL, role INTEGER NOT NULL)",
				"CREATE TABLE IF NOT EXISTS refs (ref TEXT PRIMARY KEY, sha TEXT NOT NULL)",
				"CREATE TABLE IF NOT EXISTS lanes (id TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, head TEXT)",
				"CREATE TABLE IF NOT EXISTS pushes (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, ref TEXT NOT NULL, before TEXT NOT NULL, after TEXT NOT NULL, principal TEXT, target TEXT NOT NULL, bytes INTEGER, at INTEGER NOT NULL)",
				"CREATE TABLE IF NOT EXISTS rejections (id TEXT PRIMARY KEY, request_id TEXT, reason TEXT NOT NULL, refs TEXT NOT NULL, at INTEGER NOT NULL)",
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

	#name(): string {
		const name = this.#meta("name");
		if (name === null) throw new Error("not set up");
		return name;
	}

	#roleOf(principal: string): number {
		return Number(
			this.#rows(
				"SELECT MAX(role) AS role FROM principals WHERE json_extract(auth_json, '$.principal') = ?",
				principal,
			)[0]?.role ?? 0,
		);
	}

	// --- admin -------------------------------------------------------------

	/**
	 * Creates an empty Artifacts repo in import mode: until
	 * `importComplete`, only the forge Owner (minted here) may push heads and
	 * tags, which is how the driver lands `main` through the
	 * gateway.
	 */
	async setup(
		input: { name: string; visibility: string },
	): Promise<{ token: string; principal: string }> {
		await this.env.ARTIFACTS.create(input.name);
		const owner = await this.mint({ kind: "user", role: ROLE.owner });
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO meta (key, value) VALUES ('name', ?), ('visibility', ?), ('importing', '1'), ('owner', ?)",
			input.name,
			input.visibility,
			owner.principal,
		);
		return owner;
	}

	importComplete(): void {
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO meta (key, value) VALUES ('importing', '0')",
		);
	}

	isOwner(principal: string): boolean {
		return this.#meta("owner") === principal;
	}

	setVisibility(visibility: string): void {
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO meta (key, value) VALUES ('visibility', ?)",
			visibility,
		);
	}

	visibility(): string {
		return this.#meta("visibility") ?? "private";
	}

	async mint(input: {
		kind: "user" | "agent";
		role: number;
		scopes?: string[];
		principal?: string;
		laneId?: string;
	}): Promise<{ token: string; principal: string }> {
		const principal = input.principal ??
			`${input.kind === "user" ? "u" : "a"}_${ulid()}`;
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

	openLane(owner: string): string {
		const id = `ln_${ulid()}`;
		this.ctx.storage.sql.exec(
			"INSERT INTO lanes (id, owner, state, head) VALUES (?, ?, 'open', NULL)",
			id,
			owner,
		);
		return id;
	}

	setLaneState(id: string, state: string): void {
		this.ctx.storage.sql.exec(
			"UPDATE lanes SET state = ? WHERE id = ?",
			state,
			id,
		);
	}

	state(): {
		refs: Row[];
		lanes: Row[];
		pushes: Row[];
		rejections: Row[];
	} {
		return {
			refs: this.#rows("SELECT * FROM refs ORDER BY ref"),
			lanes: this.#rows("SELECT * FROM lanes ORDER BY id"),
			pushes: this.#rows("SELECT * FROM pushes ORDER BY at, id"),
			rejections: this.#rows("SELECT * FROM rejections ORDER BY at, id"),
		};
	}

	/**
	 * Deletes every repo of the harness's own namespace (`tartan-dev-wp04`,
	 * used by nothing else), including any a failed setup left behind.
	 */
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
				"refs",
				"lanes",
				"pushes",
				"rejections",
			]
		) {
			this.ctx.storage.sql.exec(`DELETE FROM ${table}`);
		}
		this.#tokens.clear();
		this.#remote = null;
		return deleted;
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
		return this.#roleOf(principal);
	}

	#ownLanes(principal: string, pin: string | null) {
		return this.#rows(
			`SELECT * FROM lanes WHERE owner = ? AND state IN (${
				ACTIVE.map(() => "?").join(",")
			})`,
			principal,
			...ACTIVE,
		).filter((lane) => pin === null || lane.id === pin);
	}

	pushContext(
		auth: AuthContext,
		tokenLaneId: string | null,
	): PushContext {
		const scoped = auth.scopes.includes("lanes") ||
			auth.scopes.includes("repo:write");
		const refs = this.#rows("SELECT ref FROM refs").map((r) => r.ref as string);
		const importing = this.#meta("importing") === "1";
		const lanes = this.#rows("SELECT id FROM lanes").map((r) =>
			`refs/heads/lanes/${r.id}`
		);
		return {
			caller: {
				kind: auth.kind,
				writeCredential: scoped &&
					this.#roleOf(auth.principal) >= ROLE.developer,
			},
			ownLanes: this.#ownLanes(auth.principal, tokenLaneId).map((lane) => ({
				laneId: lane.id as string,
				mode: "branch" as const,
				ref: `refs/heads/lanes/${lane.id}`,
				state: lane.state as PushContext["ownLanes"][number]["state"],
				headSha: (lane.head as string | null) ?? null,
				resumable: true,
				leased: false,
			})),
			adopted: [],
			protectedPatterns: importing ? [] : [trunkRef("main")],
			defaultBranch: "main",
			caseFoldedRefs: [
				...new Set([...refs, ...lanes].map((r) => r.toLowerCase())),
			],
			importState: importing ? "importing" : "none",
			landingPaused: false,
		};
	}

	readContext(principal: AuthContext | "anon"): ReadContext {
		const visible = this.#rows("SELECT ref, sha FROM refs").filter((r) =>
			!isHiddenRef(r.ref as string)
		);
		const recent = this.#rows(
			"SELECT ref, before, after FROM pushes WHERE at >= ?",
			Date.now() - RECENT_MS,
		).filter((r) => !isHiddenRef(r.ref as string));
		return {
			view: principal === "anon" ? "public" : "member",
			visibleTips: visible.map((r) => r.sha as string),
			recentTips: recent.flatMap((r) => [r.before as string, r.after as string])
				.filter((s) => s !== ZERO_SHA),
			ownLanes: principal === "anon"
				? []
				: this.#ownLanes(principal.principal, principal.laneId).map((
					lane,
				) => ({
					laneId: lane.id as string,
					ref: `refs/heads/lanes/${lane.id}`,
					headSha: (lane.head as string | null) ?? null,
				})),
		};
	}

	recordPush(report: PushReport): RecordPushResult {
		const at = Date.now();
		const events = report.refs.map((update) => {
			const id = `p_${ulid()}`;
			const lane = /^refs\/heads\/lanes\/(ln_[0-9a-z]{26})$/.exec(update.ref);
			const target = lane ? lane[1] : "repo";
			this.ctx.storage.sql.exec(
				"INSERT INTO pushes (id, request_id, ref, before, after, principal, target, bytes, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				id,
				report.requestId,
				update.ref,
				update.before,
				update.after,
				report.principal,
				target,
				report.bytes ?? null,
				at,
			);
			if (lane) {
				this.ctx.storage.sql.exec(
					"UPDATE lanes SET head = ? WHERE id = ?",
					update.after === ZERO_SHA ? null : update.after,
					lane[1],
				);
			}
			if (update.after === ZERO_SHA) {
				this.ctx.storage.sql.exec("DELETE FROM refs WHERE ref = ?", update.ref);
			} else {
				this.ctx.storage.sql.exec(
					"INSERT OR REPLACE INTO refs (ref, sha) VALUES (?, ?)",
					update.ref,
					update.after,
				);
			}
			return {
				id: ulid(),
				type: "push.accepted",
				data: { pushId: id, target, ...update, via: report.via },
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
		commands: readonly { ref: string }[];
		reason: string;
		requestId?: string;
	}): void {
		this.ctx.storage.sql.exec(
			"INSERT INTO rejections (id, request_id, reason, refs, at) VALUES (?, ?, ?, ?, ?)",
			ulid(),
			rejection.requestId ?? null,
			rejection.reason,
			JSON.stringify(rejection.commands.map((c) => c.ref)),
			Date.now(),
		);
	}

	recordDiff(): void {}

	refs(): RefRow[] {
		return this.#rows("SELECT ref, sha FROM refs").map((r) => ({
			ref: r.ref as string,
			sha: r.sha as string,
			updated_at: 0,
			push_id: null,
			peeled: null,
			reconciled_at: null,
		}));
	}

	/** Memory-only, scoped to this one repo, 600 s (K11), as RepoDO mints them. */
	async upstream(
		_target: { laneId?: string },
		scope: "read" | "write",
	): Promise<Upstream> {
		const name = this.#name();
		const cached = this.#tokens.get(scope);
		if (cached === undefined || cached.expiresAt < Date.now() + 60_000) {
			const repo = await this.env.ARTIFACTS.get(name);
			const token = await repo.createToken(scope, 600);
			this.#remote ??= (await repo.info()).remote;
			this.#tokens.set(scope, {
				token: token.plaintext,
				expiresAt: Date.now() + 540_000,
			});
		}
		const token = this.#tokens.get(scope) as {
			token: string;
			expiresAt: number;
		};
		return {
			artifactsName: name,
			remote: this.#remote as string,
			token: token.token,
			expiresAt: token.expiresAt,
			kind: "canonical",
			ref: "refs/heads/main",
		};
	}
}

const CANONICAL =
	/^\/(?<repo>[^/-][^/]*?(?:\/[^/-][^/]*?)*?)(?:\.git)?\/(?<op>info\/refs|git-upload-pack|git-receive-pack)$/;

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

const admin = async (
	request: Request,
	env: HarnessEnv,
	repo: DurableObjectStub<HarnessRepo>,
	action: string,
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
			return json(
				await repo.setup({
					name: `r-${ulid()}`,
					visibility: String(body.visibility ?? "private"),
				}),
			);
		case "import-complete":
			await repo.importComplete();
			return json({ ok: true });
		case "visibility":
			await repo.setVisibility(String(body.visibility));
			return json({ ok: true });
		case "mint":
			return json(await repo.mint(body as never));
		case "lane":
			return json({ laneId: await repo.openLane(String(body.owner)) });
		case "lane-state":
			await repo.setLaneState(String(body.laneId), String(body.state));
			return json({ ok: true });
		case "state":
			return json(await repo.state());
		case "cleanup":
			return json({ deleted: await repo.cleanup() });
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
		const repo = env.REPO.getByName("harness");
		const action = /^\/-\/harness\/([a-z-]+)$/.exec(url.pathname);
		if (action) {
			try {
				return await admin(request, env, repo, action[1]);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return json({ error: redactSecrets(message) }, 500);
			}
		}
		const match = CANONICAL.exec(url.pathname);
		if (match?.groups === undefined) {
			return new Response("not found\n", { status: 404 });
		}
		// WP2's middleware for `POLICY.git`: tokens only, a bad one is 401.
		const header = request.headers.get("authorization");
		let auth: AuthContext | null = null;
		if (header !== null) {
			const credential = credentialOf(header);
			auth = credential === null
				? null
				: await repo.authOf(await sha256Hex(credential));
			if (auth === null) {
				return new Response("authentication required\n", {
					status: 401,
					headers: {
						"www-authenticate": 'Basic realm="Tartan", charset="UTF-8"',
					},
				});
			}
		}
		const visibility = await repo.visibility();
		const node: NodeDto = {
			id: "01k7harness0000000000000000".slice(0, 26),
			parentId: null,
			kind: "repo",
			slug: "shop",
			path: REPO_PATH,
			depth: 1,
			visibility: visibility as NodeDto["visibility"],
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
						...(await Promise.all(principals.map((p) => repo.role(p)))),
					) as 0,
				node: (id) => Promise.resolve(id === node.id ? node : null),
			},
			repo: () => repo as unknown as GatewayRepo,
			isForgeOwner: (principal) => repo.isOwner(principal),
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
			log: (message, data) => console.error(message, JSON.stringify(data)),
			config: {
				maxPushBytes: maxPushBytes(env.TARTAN_MAX_PUSH_MB),
				echo: env.HARNESS_ECHO === "1",
				upstreamAuth: "bearer",
				phase1WaitMs: 5_000,
				policy: canonicalPushPolicy,
				lanePolicy: laneRepoPolicy,
			},
		};
		const r: GitRequest = {
			req: request,
			url,
			repoPath: match.groups.repo,
			auth,
			waitUntil: (promise) => ctx.waitUntil(promise),
		};
		const op = match.groups.op;
		const method = op === "info/refs" ? "GET" : "POST";
		if (request.method !== method) {
			return new Response("method\n", { status: 405 });
		}
		return op === "info/refs"
			? await handleInfoRefs(deps, r)
			: op === "git-upload-pack"
			? await handleUploadPack(deps, r)
			: await handleReceivePack(deps, r);
	},
} satisfies ExportedHandler<HarnessEnv>;
