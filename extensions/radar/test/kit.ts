// Test kit for tartan.radar (Deno only). Extension files may import only
// `@tartan/contract`, `@tartan/ext-api` and their own files, so this kit
// builds on `@tartan/ext-api/testing.ts` (the builtin host's rules: guarded
// SQL, read-only renders and context, `capsDenial`) and brings its own
// assertions and a small kernel stand-in ("world") behind the caps handlers.

import {
	type CapsMethod,
	createUlid,
	type Envelope,
	type Footprint,
	type Lane,
	type ManifestPermissions,
	notFound,
	type PathDiff,
	type ToolContext,
} from "@tartan/contract";
import {
	type CapsHandler,
	createTestHarness,
	type Harness,
	rows,
} from "@tartan/ext-api/testing.ts";
import manifest from "../tartan.json" with { type: "json" };
import { extension, migrations } from "../src/index.ts";
import type { ProjectRoot } from "../src/paths.ts";

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const show = (v: unknown): string => JSON.stringify(v, null, 1);

export const equal = (actual: unknown, expected: unknown, msg = ""): void => {
	const a = show(actual);
	const e = show(expected);
	if (a !== e) {
		throw new Error(`${msg ? `${msg}: ` : ""}expected ${e}\n   got ${a}`);
	}
};

export const ok = (cond: unknown, msg = "expected truthy"): void => {
	if (!cond) throw new Error(msg);
};

export const rejects = async (
	p: Promise<unknown>,
	check: (e: unknown) => boolean,
	msg = "expected a rejection",
): Promise<void> => {
	try {
		await p;
	} catch (e) {
		if (!check(e)) throw new Error(`${msg}: wrong error ${String(e)}`);
		return;
	}
	throw new Error(msg);
};

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const body = (n: number): string => `01k6${String(n).padStart(22, "0")}`;
export const REPO = body(990);
export const NODE = body(991);
export const laneId = (n: number): string => `ln_${body(n)}`;
export const agentId = (n: number): string => `a_${body(n)}`;
export const userId = (n: number): string => `u_${body(n)}`;
export const sha = (n: number): string => n.toString(16).padStart(40, "0");
export const ZERO = "0".repeat(40);

// ---------------------------------------------------------------------------
// World: the kernel state behind the caps handlers
// ---------------------------------------------------------------------------

export type World = {
	now: number;
	readonly lanes: Map<string, Lane>;
	readonly principals: Map<
		string,
		{ handle: string; ownerUserId?: string; kind?: string }
	>;
	readonly work: Map<string, { title: string; why: string }>;
	roots: ProjectRoot[];
	/** `laneRange` answers per lane (fallback path without a diffKey). */
	readonly ranges: Map<
		string,
		{
			head: string;
			rangeBase: string;
			rangeTruncated: boolean;
			diffKey: string;
		}
	>;
	/** `diffPaths` answers per `<base>..<head>`. */
	readonly diffs: Map<string, PathDiff>;
	/** Principals holding Maintainer+ at the repo (`authz.check approve`). */
	readonly maintainers: Set<string>;
	defaultBranch: string;
	/** Errors `notify.send` throws, one per call, before it delivers again. */
	readonly notifyErrors: Error[];
	/** Delivered notices, in order. */
	readonly notified: { principal: string; notice: unknown }[];
};

export const createWorld = (): World => ({
	now: 1_790_000_000_000,
	lanes: new Map(),
	principals: new Map(),
	work: new Map(),
	roots: [
		{ name: "api", root: "services/api" },
		{ name: "web", root: "apps/web" },
		{ name: "shared", root: "packages/shared" },
	],
	ranges: new Map(),
	diffs: new Map(),
	maintainers: new Set(),
	defaultBranch: "main",
	notifyErrors: [],
	notified: [],
});

export type LaneSpec = {
	readonly n: number;
	readonly owner?: string;
	readonly mode?: "repo" | "branch";
	readonly state?: Lane["state"];
	readonly base?: string;
	readonly head?: string;
	readonly footprint?: Partial<Footprint>;
	readonly entity?: { kind: string; id: string };
	readonly handle?: string;
};

/** Adds (or replaces) a lane in the world and returns it. */
export const putLane = (w: World, spec: LaneSpec): Lane => {
	const id = laneId(spec.n);
	const owner = spec.owner ?? agentId(spec.n);
	const mode = spec.mode ?? "branch";
	const lane = {
		id,
		repoId: REPO,
		kind: "lane",
		mode,
		...(mode === "repo" ? { seed: "import" } : {}),
		ref: mode === "repo" ? "refs/heads/main" : `refs/heads/lanes/${id}`,
		branch: `lanes/${id}`,
		owner,
		delegates: [],
		...(spec.entity ? { entity: spec.entity } : {}),
		footprint: {
			projects: spec.footprint?.projects ?? [],
			prefixes: spec.footprint?.prefixes ?? [],
		},
		base: spec.base ?? sha(1),
		...(spec.head ? { head: spec.head } : {}),
		state: spec.state ?? "open",
		quarantined: false,
		leaseExpiresAt: w.now + 1_800_000,
		pushes: 0,
		createdAt: w.now,
		remote: mode === "repo"
			? `/acme/platform/router/-/lanes/${id}.git`
			: "/acme/platform/router.git",
	} as Lane;
	w.lanes.set(id, lane);
	if (!w.principals.has(owner)) {
		w.principals.set(owner, { handle: spec.handle ?? `agent-${spec.n}` });
	}
	return lane;
};

export const setHead = (w: World, id: string, head: string): void => {
	const lane = w.lanes.get(id);
	if (lane) w.lanes.set(id, { ...lane, head, state: lane.state });
};

export const setState = (w: World, id: string, state: Lane["state"]): void => {
	const lane = w.lanes.get(id);
	if (lane) w.lanes.set(id, { ...lane, state });
};

const handlersFor = (
	w: World,
): Partial<Record<CapsMethod, CapsHandler>> => ({
	"clock.now": () => w.now,
	"notify.send": ((principal: string, notice: unknown) => {
		const error = w.notifyErrors.shift();
		if (error) throw error;
		w.notified.push({ principal, notice });
	}) as CapsHandler,
	"lanes.get": ((id: string) => {
		const lane = w.lanes.get(id);
		if (!lane) throw notFound(`lane ${id}`);
		return lane;
	}) as CapsHandler,
	"lanes.list":
		((f: { state?: string[] }) =>
			[...w.lanes.values()].filter((l) =>
				!f.state || f.state.includes(l.state)
			)) as CapsHandler,
	"principals.get": ((id: string) => {
		const p = w.principals.get(id);
		if (!p) throw notFound(`principal ${id}`);
		return {
			id,
			kind: p.kind ?? (id.startsWith("u_") ? "user" : "agent"),
			handle: p.handle,
			display: p.handle,
			...(p.ownerUserId ? { ownerUserId: p.ownerUserId } : {}),
		};
	}) as CapsHandler,
	"interfaces.call": ((iface: string, tool: string, args: { ref: string }) => {
		const item = iface === "work@1" && tool === "work_get"
			? w.work.get(args.ref)
			: undefined;
		if (!item) throw notFound(`work ${args?.ref}`);
		return { ref: args.ref, ...item };
	}) as CapsHandler,
	"repo.info": (() => ({
		id: REPO,
		nodeId: REPO,
		path: "acme/platform/router",
		defaultBranch: w.defaultBranch,
		visibility: "private",
		trunkSha: sha(1),
		landingPaused: false,
	})) as CapsHandler,
	"repo.projectGraph": ((_repo: unknown, at: string) => ({
		sha: at,
		manifestsTreeSha: "x",
		projects: w.roots.map((r) => ({
			name: r.name,
			root: r.root,
			deps: [],
			dependents: [],
			owners: [],
			sensitive: false,
			source: "pnpm-workspace",
		})),
		globalFiles: [],
	})) as CapsHandler,
	"repo.laneRange": ((id: string) => {
		const r = w.ranges.get(id);
		if (!r) throw notFound(`range ${id}`);
		return r;
	}) as CapsHandler,
	"repo.diffPaths": ((_s: unknown, base: string, head: string) => {
		const diff = w.diffs.get(`${base}..${head}`);
		if (!diff) throw notFound(`diff ${base}..${head}`);
		return diff;
	}) as CapsHandler,
	"authz.check":
		((principal: string, _node: unknown, perm: string) =>
			perm === "approve" && w.maintainers.has(principal)) as CapsHandler,
});

export type Radar = Harness & {
	readonly world: World;
	/** Delivers events in order, stamping seq and the world clock. */
	deliver(...events: Envelope[]): Promise<void>;
	/** Raw rows of the extension database. */
	q<T extends Record<string, unknown>>(
		sql: string,
		...b: (string | number)[]
	): T[];
	toolCtx(actor: string): ToolContext;
};

export const createRadar = (world: World = createWorld()): Radar => {
	const h = createTestHarness({
		module: extension,
		migrations,
		grants: manifest.permissions as unknown as ManifestPermissions,
		install: {
			id: `i_${body(992)}`,
			extId: "tartan.radar",
			version: "0.1.0",
			node: { id: NODE, path: "acme/platform" },
			scopeKey: `repo:${REPO}`,
			mode: "enforce",
		},
		handlers: handlersFor(world),
		now: () => world.now,
	});
	return {
		...h,
		world,
		deliver: async (...events) => {
			for (const ev of events) await h.event(ev);
		},
		q: <T extends Record<string, unknown>>(
			sql: string,
			...b: (string | number)[]
		) => rows(h.storage, sql, ...b) as unknown as T[],
		toolCtx: (actor: string): ToolContext => ({
			node: NODE,
			repo: REPO,
			scope: "acme/platform/router",
			actor: { kind: actor.startsWith("u_") ? "user" : "agent", id: actor },
			mode: "enforce",
		}),
	};
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const ulid = createUlid();
let seq = 0;

export const event = <T>(
	type: string,
	data: T,
	at = 1_790_000_000_000,
): Envelope<T> => ({
	id: ulid(),
	seq: ++seq,
	stream: `repo:${REPO}`,
	type,
	v: 1,
	source: { kind: "kernel" },
	actor: { kind: "system", id: "sys_kernel" },
	node: REPO,
	repo: REPO,
	depth: 0,
	shadow: false,
	at,
	data,
});

export const laneOpened = (lane: Lane, at?: number) =>
	event("lane.opened", {
		laneId: lane.id,
		owner: lane.owner,
		base: lane.base,
		mode: lane.mode,
		...(lane.entity ? { entity: lane.entity } : {}),
		footprint: lane.footprint,
	}, at);

export type PushSpec = {
	readonly paths: readonly string[];
	readonly after: string;
	readonly rangeBase?: string;
	readonly commits?: readonly string[];
	readonly diffKey?: string;
	readonly truncated?: boolean;
	readonly rangeTruncated?: boolean;
	readonly at?: number;
};

/** A `push.diffed` for a lane; also moves the world's lane head to `after`. */
export const pushed = (w: World, id: string, p: PushSpec) => {
	setHead(w, id, p.after);
	const rangeBase = p.rangeBase ?? w.lanes.get(id)?.base ?? sha(1);
	return event("push.diffed", {
		pushId: `p_${ulid()}`,
		target: id,
		ref: w.lanes.get(id)?.ref ?? `refs/heads/lanes/${id}`,
		after: p.after,
		rangeBase,
		rangeTruncated: p.rangeTruncated ?? false,
		commits: (p.commits ?? [p.after]).map((s) => ({
			sha: s,
			subject: "work",
			trailers: [],
			firstPushedBy: null,
		})),
		paths: [...p.paths],
		truncated: p.truncated ?? false,
		diffKey: p.diffKey ?? `diffs/${REPO}/${rangeBase}..${p.after}.json`,
	}, p.at ?? w.now);
};

export const advanced = (
	old: string,
	next: string,
	changes: readonly { laneId: string; changeId: string; commit: string }[],
	at?: number,
) =>
	event("ref.advanced", {
		ref: "refs/heads/main",
		old,
		new: next,
		advanceId: `adv_${ulid()}`,
		changes,
		reasonEvents: [],
		evidenceReused: false,
	}, at);

export const laneEnded = (type: string, lane: Lane, at?: number) =>
	event(type, {
		laneId: lane.id,
		owner: lane.owner,
		base: lane.base,
		mode: lane.mode,
	}, at);

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

export type Row = {
	id: string;
	a: string;
	b: string;
	path: string;
	severity: string;
	state: string;
	suggestion: string;
	notified: number;
	avoided: number | null;
};

export const conflicts = (r: Radar, state?: string): Row[] =>
	r.q<Row>(
		state
			? "SELECT id, a, b, path, severity, state, suggestion, notified, avoided FROM conflicts WHERE state = ? ORDER BY a, b, path"
			: "SELECT id, a, b, path, severity, state, suggestion, notified, avoided FROM conflicts ORDER BY a, b, path",
		...(state ? [state] : []),
	);

export const touches = (r: Radar, id: string): string[] =>
	r.q<{ path: string }>(
		"SELECT path FROM touches WHERE lane_id = ? ORDER BY path",
		id,
	).map((t) => t.path);

export const stats = (r: Radar): Record<string, number> =>
	Object.fromEntries(
		r.q<{ k: string; v: number }>("SELECT k, v FROM stats").map((s) => [
			s.k,
			s.v,
		]),
	);

export const notices = (r: Radar) =>
	r.world.notified as {
		principal: string;
		notice: {
			kind: string;
			severity: string;
			text: string;
			laneId?: string;
			data: Record<string, unknown>;
			dedupeKey: string;
		};
	}[];

export const emitted = (r: Radar, type?: string) =>
	r.recorder.emitted.filter((e) => !type || e.type === type);
