// One simulated agent (WP20): the same loop a real agent
// runs, through the same MCP tools and git smart HTTP, as its own principal:
//
//   work_create (an intent from a template) → work_claim (footprint) → the
//   lane → push a commit to its own lane ref, a few times (each built in
//   memory on top of the last, packed undeltified) → changes_submit →
//   changes_get (read-your-writes: the revision's head is the pushed
//   head) → the next item.
//
// The agent never chooses another agent's lane: the lane ref comes from its
// own claim. `probeWrongLane` deliberately pushes to someone else's lane to
// prove the gateway refuses it. State is plain JSON,
// so a cohort can hand an agent over to a successor instance; the in-memory
// caches (directory listings, hot-file contents) are rebuilt when needed.

import { ZERO_SHA } from "@tartan/contract";
import type { PushCommand } from "@tartan/contract/kernel.ts";
import { writePack } from "@tartan/gitproto";
import {
	buildCommit,
	type DirEntry,
	type FileEdit,
	normalizeMode,
	type TreeReader,
	type TreeState,
	treeStateOf,
} from "./gittree.ts";
import { rngFor } from "./rng.ts";
import { HOT_FILES, WORK_TEMPLATES, type WorkTemplate } from "./sample.ts";

/** What an agent can do, as itself (in-process MCP and git, `transport.ts`). */
export type SimPort = {
	/** An MCP tool call; rejects with `SimToolError` when the result is an error. */
	tool(
		name: string,
		args: Record<string, unknown>,
	): Promise<Record<string, unknown>>;
	/** receive-pack on `remote`; one status per command. */
	push(
		remote: string,
		commands: readonly PushCommand[],
		pack: Uint8Array,
	): Promise<readonly { ref: string; ok: boolean; reason?: string }[]>;
};

export class SimToolError extends Error {
	constructor(readonly tool: string, readonly detail: string) {
		super(`${tool}: ${detail}`);
		this.name = "SimToolError";
	}
}

export type SimLane = {
	readonly id: string;
	readonly ref: string;
	readonly remote: string;
	readonly base: string;
};

export type SimAgentState = {
	readonly handle: string;
	/** Items started (created and claimed). */
	readonly items: number;
	readonly phase: "idle" | "lane" | "done";
	readonly work?: string;
	readonly title?: string;
	/** The agent's own file for the current item (no one else edits it). */
	readonly own?: string;
	readonly lane?: SimLane;
	/** The lane's head after the agent's last accepted push. */
	readonly head?: string;
	readonly pushes: number;
	/** Actions taken (every tick counts, errors included). */
	readonly ticks: number;
};

export type SimStats = {
	claims: number;
	pushes: number;
	pushesRejected: number;
	submits: number;
	rywChecks: number;
	rywMismatches: number;
	errors: number;
	/** In-process requests made (MCP calls and pushes), for the subrequest estimate. */
	requests: number;
	lastError?: string;
};

export const emptyStats = (): SimStats => ({
	claims: 0,
	pushes: 0,
	pushesRejected: 0,
	submits: 0,
	rywChecks: 0,
	rywMismatches: 0,
	errors: 0,
	requests: 0,
});

export const addStats = (a: SimStats, b: SimStats): SimStats => {
	const lastError = b.lastError ?? a.lastError;
	return {
		claims: a.claims + b.claims,
		pushes: a.pushes + b.pushes,
		pushesRejected: a.pushesRejected + b.pushesRejected,
		submits: a.submits + b.submits,
		rywChecks: a.rywChecks + b.rywChecks,
		rywMismatches: a.rywMismatches + b.rywMismatches,
		errors: a.errors + b.errors,
		requests: a.requests + b.requests,
		...(lastError !== undefined ? { lastError } : {}),
	};
};

export const newAgent = (handle: string): SimAgentState => ({
	handle,
	items: 0,
	phase: "idle",
	pushes: 0,
	ticks: 0,
});

export type SimConfig = {
	readonly swarmId: string;
	/** The shard repo's path (`<ns>/sim/router-<nn>`). */
	readonly repo: string;
	readonly itemsPerAgent: number;
	readonly pushesPerItem: number;
	readonly overlap: number;
	readonly hotFiles: number;
	readonly now: () => number;
};

/** Messages are redacted to their first line, 300 characters, no tokens. */
export const redactError = (error: unknown): string =>
	(error instanceof Error ? error.message : String(error))
		.split("\n")[0]!
		.replace(/\b(tagt|tpat|art_v\d+)_[A-Za-z0-9_-]+/g, "$1_[redacted]")
		.slice(0, 300);

const record = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null
		? value as Record<string, unknown>
		: {};

const str = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? value : undefined;

/** The template of the agent's next item (stable for a swarm, agent and item). */
export const templateFor = (
	cfg: Pick<SimConfig, "swarmId">,
	s: Pick<SimAgentState, "handle" | "items">,
): WorkTemplate =>
	rngFor(cfg.swarmId, s.handle, "template", s.items).pick(WORK_TEMPLATES);

/** The agent's own file for its n-th item. */
export const ownFileOf = (
	handle: string,
	item: number,
	t: WorkTemplate,
): string => `${t.project.path}/src/sim/${handle}-${item}.ts`;

/** The file a push edits: a hot file with probability `overlap`, else the agent's own. */
export const pathForPush = (
	cfg: Pick<SimConfig, "swarmId" | "overlap" | "hotFiles">,
	s: Pick<SimAgentState, "handle" | "items" | "pushes" | "own">,
): string => {
	const rng = rngFor(cfg.swarmId, s.handle, "path", s.items, s.pushes);
	const hot = HOT_FILES.slice(0, Math.max(0, cfg.hotFiles));
	return hot.length > 0 && rng.chance(cfg.overlap)
		? rng.pick(hot)
		: s.own ?? `${s.handle}.txt`;
};

/** The agent's own file after `pushes` pushes (deterministic: nothing to read). */
export const ownContent = (handle: string, pushes: number): string =>
	Array.from(
		{ length: pushes },
		(_, i) => `export const step${i + 1} = ${JSON.stringify(handle)};\n`,
	).join("");

const isNotFound = (error: unknown): boolean =>
	error instanceof SimToolError && /not.?found/i.test(error.detail);

/** A `repo_tree` listing → directory entries; null when the path is missing. */
export const treeReaderOf =
	(port: SimPort, repo: string, stats: SimStats): TreeReader =>
	async (commit, path) => {
		stats.requests++;
		try {
			const out = await port.tool("repo_tree", { repo, ref: commit, path });
			const entries = Array.isArray(out["entries"]) ? out["entries"] : [];
			return entries.map((e): DirEntry => {
				const r = record(e);
				return {
					name: String(r["name"]),
					mode: normalizeMode(String(r["mode"])),
					id: String(r["hash"]),
				};
			});
		} catch (error) {
			if (isNotFound(error)) return null;
			throw error;
		}
	};

const readFile = async (
	port: SimPort,
	repo: string,
	commit: string,
	path: string,
	stats: SimStats,
): Promise<string | null> => {
	stats.requests++;
	try {
		const out = await port.tool("repo_read", { repo, ref: commit, path });
		return str(out["text"]) ?? str(out["content"]) ?? "";
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
};

export type AgentRuntime = {
	readonly port: SimPort;
	readonly cfg: SimConfig;
	/** Directory listings at each agent's head (rebuilt after a hand-over). */
	readonly trees: Map<string, TreeState>;
	/** Hot-file contents at each agent's head, by path (rebuilt likewise). */
	readonly files: Map<string, Map<string, string>>;
};

export const createRuntime = (port: SimPort, cfg: SimConfig): AgentRuntime => ({
	port,
	cfg,
	trees: new Map(),
	files: new Map(),
});

const claim = async (
	rt: AgentRuntime,
	s: SimAgentState,
	stats: SimStats,
): Promise<SimAgentState> => {
	const t = templateFor(rt.cfg, s);
	const item = s.items + 1;
	const own = ownFileOf(s.handle, item, t);
	const title = `${t.title} (${s.handle} #${item})`;
	const footprint = {
		projects: [t.project.name],
		prefixes: [`${t.project.path}/`],
	};
	stats.requests++;
	const created = await rt.port.tool("work_create", {
		repo: rt.cfg.repo,
		kind: "intent",
		title,
		why: `${t.why} Simulated agent ${s.handle}.`,
		acceptance: [...t.acceptance],
		footprint,
		labels: ["sim"],
	});
	const ref = str(created["ref"]);
	if (!ref) throw new SimToolError("work_create", "no ref in the result");
	stats.requests++;
	const claimed = await rt.port.tool("work_claim", {
		ref,
		footprint,
		plan: `Edit ${own}`,
	});
	const lane = record(claimed["lane"]);
	const id = str(lane["id"]);
	const laneRef = str(lane["ref"]);
	const remote = str(lane["remote"]);
	const base = str(lane["base"]);
	if (!id || !laneRef || !remote || !base) {
		throw new SimToolError("work_claim", "no lane handle in the result");
	}
	stats.claims++;
	rt.trees.set(s.handle, treeStateOf(base));
	rt.files.delete(s.handle);
	return {
		handle: s.handle,
		items: item,
		phase: "lane",
		work: ref,
		title,
		own,
		lane: { id, ref: laneRef, remote, base },
		pushes: 0,
		ticks: s.ticks,
	};
};

const editFor = async (
	rt: AgentRuntime,
	s: SimAgentState,
	parent: string,
	stats: SimStats,
): Promise<FileEdit> => {
	const path = pathForPush(rt.cfg, s);
	if (path === s.own) {
		return { path, content: ownContent(s.handle, s.pushes + 1) };
	}
	const current = rt.files.get(s.handle)?.get(path) ??
		(await readFile(rt.port, rt.cfg.repo, parent, path, stats)) ?? "";
	return {
		path,
		content: `${current}// ${s.handle}: ${s.work ?? "work"} push ${
			s.pushes + 1
		}\n`,
	};
};

const push = async (
	rt: AgentRuntime,
	s: SimAgentState,
	stats: SimStats,
): Promise<SimAgentState> => {
	const lane = s.lane!;
	const parent = s.head ?? lane.base;
	const cached = rt.trees.get(s.handle);
	const state = cached?.commit === parent ? cached : treeStateOf(parent);
	const edit = await editFor(rt, s, parent, stats);
	const built = await buildCommit({
		state,
		read: treeReaderOf(rt.port, rt.cfg.repo, stats),
		edits: [edit],
		message: `${s.title ?? "sim"}: push ${
			s.pushes + 1
		}\n\nSimulated agent ${s.handle}.`,
		author: {
			name: s.handle,
			email: `${s.handle}@sim.tartan.invalid`,
			at: Math.floor(rt.cfg.now() / 1000),
		},
	});
	const { pack } = await writePack(built.objects);
	stats.requests++;
	const [status] = await rt.port.push(
		lane.remote,
		[{ ref: lane.ref, old: s.head ?? ZERO_SHA, new: built.commit }],
		pack,
	);
	if (!status?.ok) {
		stats.pushesRejected++;
		throw new Error(`push refused: ${status?.reason ?? "no status"}`);
	}
	stats.pushes++;
	rt.trees.set(s.handle, built.state);
	if (edit.path !== s.own) {
		const files = rt.files.get(s.handle) ?? new Map<string, string>();
		files.set(edit.path, edit.content);
		rt.files.set(s.handle, files);
	}
	return { ...s, head: built.commit, pushes: s.pushes + 1 };
};

const submit = async (
	rt: AgentRuntime,
	s: SimAgentState,
	stats: SimStats,
): Promise<SimAgentState> => {
	const lane = s.lane!;
	stats.requests++;
	const out = await rt.port.tool("changes_submit", {
		repo: rt.cfg.repo,
		laneId: lane.id,
		title: s.title ?? `Simulated change by ${s.handle}`,
		summary: `${s.pushes} simulated commits by ${s.handle}.`,
		why: `Simulated agent ${s.handle} finished ${s.work ?? "its work item"}.`,
	});
	stats.submits++;
	const changeId = str(out["changeId"]);
	if (changeId) {
		// Read-your-writes: the revision records the head just pushed.
		stats.requests++;
		const change = await rt.port.tool("changes_get", {
			repo: rt.cfg.repo,
			changeId,
		});
		const revisions = Array.isArray(change["revisions"])
			? change["revisions"].map(record)
			: [];
		const latest = revisions.reduce<Record<string, unknown> | null>(
			(best, r) =>
				best === null || Number(r["n"]) > Number(best["n"]) ? r : best,
			null,
		);
		stats.rywChecks++;
		if (latest?.["head"] !== s.head) stats.rywMismatches++;
	}
	rt.trees.delete(s.handle);
	rt.files.delete(s.handle);
	return {
		handle: s.handle,
		items: s.items,
		phase: s.items >= rt.cfg.itemsPerAgent ? "done" : "idle",
		pushes: 0,
		ticks: s.ticks,
	};
};

/**
 * One action of one agent (the next step of its loop). Errors are counted
 * and the agent keeps its state, so the next tick retries.
 */
export const tick = async (
	rt: AgentRuntime,
	s: SimAgentState,
	stats: SimStats,
): Promise<SimAgentState> => {
	const ticked = { ...s, ticks: s.ticks + 1 };
	try {
		if (s.phase === "done") return ticked;
		if (s.phase === "idle") {
			return s.items >= rt.cfg.itemsPerAgent
				? { ...ticked, phase: "done" }
				: await claim(rt, ticked, stats);
		}
		return s.pushes < rt.cfg.pushesPerItem
			? await push(rt, ticked, stats)
			: await submit(rt, ticked, stats);
	} catch (error) {
		stats.errors++;
		stats.lastError = redactError(error);
		return ticked;
	}
};

/** What the wrong-lane probe proved (WP20). */
export type WrongLaneProbe = "refused" | "accepted" | "inconclusive";

/** The gateway's ownership verdict on a push to another agent's lane. */
const NOT_YOUR_LANE = /\bnot-your-lane\b/;

/** The victim lane's head now, from `lanes_get` (best effort). */
const currentHead = async (
	prober: SimPort,
	repo: string,
	laneId: string,
	stats: SimStats,
): Promise<string | undefined> => {
	stats.requests++;
	try {
		const out = await prober.tool("lanes_get", { repo, laneId });
		const head = record(out["lane"])["head"];
		return typeof head === "string" && head !== "" ? head : undefined;
	} catch {
		return undefined;
	}
};

/**
 * Pushes as `prober` to `victim`'s lane ref, on the lane's current head.
 * `refused` only when the gateway refused it as `not-your-lane` (only a lane's
 * owner writes it); any other refusal or error (a stale old SHA, a landing
 * lane, a 5xx, an expired token) proves nothing about the ownership check and
 * is `inconclusive`.
 */
export const probeWrongLane = async (
	prober: SimPort,
	victim: SimLane,
	head: string | undefined,
	stats: SimStats,
	repo?: string,
): Promise<WrongLaneProbe> => {
	const now = repo === undefined
		? head
		: (await currentHead(prober, repo, victim.id, stats)) ?? head;
	const built = await buildCommit({
		state: treeStateOf(now ?? victim.base),
		read: () => Promise.resolve([]),
		edits: [{ path: "WRONG-LANE.md", content: "must be refused\n" }],
		message: "a push to another agent's lane (must be refused)",
		author: { name: "probe", email: "probe@sim.tartan.invalid", at: 0 },
	});
	const { pack } = await writePack(built.objects);
	stats.requests++;
	try {
		const [status] = await prober.push(
			victim.remote,
			[{ ref: victim.ref, old: now ?? ZERO_SHA, new: built.commit }],
			pack,
		);
		if (status?.ok === true) return "accepted";
		return NOT_YOUR_LANE.test(status?.reason ?? "")
			? "refused"
			: "inconclusive";
	} catch (error) {
		// Without report-status the gateway answers 403 "push rejected: <reason>".
		const text = error instanceof Error ? error.message : String(error);
		return NOT_YOUR_LANE.test(text) ? "refused" : "inconclusive";
	}
};
