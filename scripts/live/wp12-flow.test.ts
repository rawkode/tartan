// WP12 testkit scenario: tartan.work, tartan.changes
// and tartan.board run together through `@tartan/testkit`'s `runExtension`
// (FakeKernelCaps: the caps policy table, K12 confinement, per-call grant
// checks) over one in-memory event log, the way the kernel delivers events:
//
//   create → claim (footprint) → lane.opened → changes.opened → submitted →
//   revised → landed → work.done → card Done
//
// The kernel side (lane open, the two push-recording phases, review, queue
// and the Advance) is scripted here, as WP5a/WP10/WP14/WP15 would append it.
// The same flow runs live in `wp12-flow.ts`.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	type Actor,
	type CapsMethod,
	type Envelope,
	type ExtensionModule,
	type ExtMigration,
	type Lane,
	laneRemotePath,
	type Manifest,
	matchesAnyPattern,
	parseManifest,
	type ToolContext,
	validateEventData,
} from "@tartan/contract";
import { runExtension, type RunExtensionResult } from "@tartan/testkit";
import { createSqliteSql } from "@tartan/testkit/ext/sqlite.ts";
import * as board from "../../extensions/board/src/index.ts";
import boardJson from "../../extensions/board/tartan.json" with {
	type: "json",
};
import * as changes from "../../extensions/changes/src/index.ts";
import changesJson from "../../extensions/changes/tartan.json" with {
	type: "json",
};
import * as work from "../../extensions/work/src/index.ts";
import workJson from "../../extensions/work/tartan.json" with { type: "json" };

const GROUP = "01k6gggggggggggggggggggggg";
const REPO = "01k6rrrrrrrrrrrrrrrrrrrrrr";
const REPO_PATH = "acme/router";
const TRUNK = "a".repeat(40);
const USER = "u_01k6vvvvvvvvvvvvvvvvvvvvvv";
const AGENT = "a_01k6aaaaaaaaaaaaaaaaaaaaaa";
const user: Actor = { kind: "user", id: USER };
const agent: Actor = { kind: "agent", id: AGENT, onBehalfOf: USER };

const manifestOf = (raw: unknown): Manifest => {
	const parsed = parseManifest(raw);
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.manifest;
};

type Ext = {
	readonly name: string;
	readonly module: ExtensionModule;
	readonly manifest: Manifest;
	readonly migrations: readonly ExtMigration[];
	readonly inst: string;
	readonly scope: "repo" | "node";
	readonly sql: ReturnType<typeof createSqliteSql>;
	migrated: boolean;
	cursor: number;
};

/** A one-repo forge: the event log, the lanes and the caps answers. */
const createForge = () => {
	const log: Envelope[] = [];
	const lanes = new Map<string, Lane>();
	const notes: { changeId: string; ext: string }[] = [];
	let clock = 1_790_000_000_000;
	let ids = 0;
	const nextId = () => `01k6e${String(++ids).padStart(21, "0")}`;

	const append = (
		type: string,
		data: Record<string, unknown>,
		source: Envelope["source"],
		actor: Actor,
		causedBy?: string,
	): Envelope => {
		const checked = validateEventData(type, data);
		if (!checked.ok) throw new Error(`${type}: ${checked.errors.join("; ")}`);
		const ev: Envelope = {
			id: nextId(),
			seq: log.length + 1,
			stream: `repo:${REPO}`,
			type,
			v: 1,
			source,
			actor,
			node: REPO,
			repo: REPO,
			depth: 0,
			shadow: false,
			at: ++clock,
			...(causedBy ? { causedBy } : {}),
			data,
		};
		log.push(ev);
		return ev;
	};
	const kernel = (type: string, data: Record<string, unknown>, actor = agent) =>
		append(type, data, { kind: "kernel" }, actor);

	const responses = (ext: string): Partial<Record<CapsMethod, unknown>> => ({
		"repo.info": () => ({
			id: REPO,
			nodeId: REPO,
			path: REPO_PATH,
			defaultBranch: "main",
			visibility: "private",
			trunkSha: TRUNK,
			landingPaused: false,
		}),
		// WP5a's branch backend: open at once, `lane.opened` in the same transaction.
		"lanes.open": ([o]: readonly unknown[]) => {
			const input = o as {
				owner: string;
				entity: { kind: string; id: string };
				footprint: Lane["footprint"];
			};
			const id = `ln_01k6${String(lanes.size + 1).padStart(22, "0")}`;
			const lane: Lane = {
				id,
				repoId: REPO,
				kind: "lane",
				mode: "branch",
				ref: `refs/heads/lanes/${id}`,
				branch: `lanes/${id}`,
				owner: input.owner,
				delegates: [],
				entity: input.entity,
				footprint: input.footprint,
				base: TRUNK,
				state: "open",
				quarantined: false,
				leaseExpiresAt: clock + 1_800_000,
				pushes: 0,
				createdAt: clock,
				remote: laneRemotePath({ id, mode: "branch" }, REPO_PATH),
			};
			lanes.set(id, lane);
			kernel("lane.opened", {
				laneId: id,
				entity: input.entity,
				owner: input.owner,
				base: TRUNK,
				footprint: input.footprint,
				mode: "branch",
			});
			return lane;
		},
		"lanes.get": ([id]: readonly unknown[]) => {
			const lane = lanes.get(id as string);
			if (!lane) throw new Error(`not_found: lane ${id}`);
			return lane;
		},
		"repo.laneRange": ([id]: readonly unknown[]) => {
			const lane = lanes.get(id as string)!;
			return {
				head: lane.head,
				rangeBase: lane.base,
				rangeTruncated: false,
				diffKey: `diffs/${REPO}/${lane.base}..${lane.head}.json`,
			};
		},
		"repo.affected": () => ({ projects: ["api"], global: false }),
		"repo.diff": () => [],
		"interfaces.call": () => ({ results: [] }),
		"notes.contribute": ([, changeId]: readonly unknown[]) => {
			notes.push({ changeId: changeId as string, ext });
		},
		"authz.check": () => true,
	});

	const install = (
		name: string,
		mod: { extension: ExtensionModule; migrations: readonly ExtMigration[] },
		raw: unknown,
		n: number,
	): Ext => {
		const manifest = manifestOf(raw);
		return {
			name,
			module: mod.extension,
			manifest,
			migrations: mod.migrations,
			inst: `i_01k6${String(n).padStart(22, "0")}`,
			scope: manifest.storage.scope,
			sql: createSqliteSql(),
			migrated: false,
			cursor: 0,
		};
	};

	const run = async (
		ext: Ext,
		input: {
			readonly events?: readonly Envelope[];
			readonly tools?: { name: string; args: unknown; actor: Actor }[];
			readonly renders?: { slot: string; ctx: Record<string, unknown> }[];
		},
	): Promise<RunExtensionResult> => {
		const first = !ext.migrated;
		ext.migrated = true;
		const toolCtx = (actor: Actor): ToolContext => ({
			node: REPO,
			repo: REPO,
			scope: REPO_PATH,
			actor,
			mode: "enforce",
		});
		const result = await runExtension(ext.module, input.events ?? [], {
			manifest: ext.manifest,
			...(first ? { migrations: ext.migrations } : {}),
			sql: ext.sql,
			init: first,
			install: {
				id: ext.inst,
				scopeKey: ext.scope === "repo" ? `repo:${REPO}` : "node",
			},
			caps: {
				props: {
					inst: ext.inst,
					node: { id: GROUP, path: "acme" },
					...(ext.scope === "repo" ? { repo: REPO } : {}),
				},
				nodes: { [REPO]: REPO_PATH },
				responses: responses(ext.manifest.id),
			},
			tools: (input.tools ?? []).map((t) => ({
				name: t.name,
				args: t.args,
				ctx: toolCtx(t.actor),
			})),
			renders: (input.renders ?? []).map((r) => ({
				slot: r.slot,
				ctx: { node: GROUP, mode: "enforce", ...r.ctx } as never,
				viewer: user,
			})),
		});
		for (const outcome of result.events) {
			if (!outcome.outcome.ok) {
				throw new Error(
					`${ext.name}: event ${outcome.id}: ${outcome.outcome.error}`,
				);
			}
		}
		// The host appends what the installation emitted (K10 checked above).
		for (const call of result.calls) {
			if (call.method !== "events.emit" || call.denied || call.error) continue;
			const [type, data] = call.args as [string, Record<string, unknown>];
			append(
				type,
				data,
				{
					kind: "installation",
					id: ext.inst,
					ext: `${ext.manifest.id}@${ext.manifest.version}`,
				},
				input.tools?.[0]?.actor ?? { kind: "ext", id: `x_${ext.inst}` },
			);
		}
		equal(
			result.denials.length,
			0,
			`${ext.name}: ${JSON.stringify(result.denials)}`,
		);
		return result;
	};

	/** Drains every installation until no new event is left (in log order per installation). */
	const deliver = async (exts: readonly Ext[]): Promise<void> => {
		for (let round = 0; round < 50; round++) {
			let moved = false;
			for (const ext of exts) {
				const patterns = (ext.manifest.subscribe ?? []).map((s) => s.event);
				const due = log.filter((e) => e.seq > ext.cursor);
				if (due.length === 0) continue;
				ext.cursor = due.at(-1)!.seq;
				const mine = due.filter((e) => matchesAnyPattern(patterns, e.type));
				if (mine.length > 0) {
					await run(ext, { events: mine });
					moved = true;
				}
			}
			if (!moved && exts.every((e) => e.cursor === log.length)) return;
		}
		throw new Error("events did not settle");
	};

	const push = (laneId: string, head: string, deliverPhase2 = true) => {
		const lane = lanes.get(laneId)!;
		const before = lane.head ?? "0".repeat(40);
		lanes.set(laneId, { ...lane, head, pushes: lane.pushes + 1 });
		const pushId = `p_${head.slice(0, 8)}`;
		kernel("push.accepted", {
			pushId,
			target: laneId,
			ref: lane.ref,
			before,
			after: head,
			via: "gateway",
		});
		const phase2 = () =>
			kernel("push.diffed", {
				pushId,
				target: laneId,
				ref: lane.ref,
				after: head,
				rangeBase: lane.base,
				rangeTruncated: false,
				commits: [],
				paths: ["services/api/src/middleware/limit.ts"],
				truncated: false,
				diffKey: `diffs/${REPO}/${lane.base}..${head}.json`,
			});
		if (deliverPhase2) phase2();
		return phase2;
	};

	return { log, lanes, notes, install, run, deliver, push, kernel, append };
};

const toolValue = <T>(result: RunExtensionResult, i = 0): T => {
	const outcome = result.tools[i].outcome;
	if (!outcome.ok) throw new Error(`${result.tools[i].name}: ${outcome.error}`);
	return outcome.value as T;
};

Deno.test("WP12 scenario: create → claim → lane.opened → changes.opened → submitted → revised → landed → work.done → card Done", async () => {
	const f = createForge();
	const workExt = f.install("work", work, workJson, 1);
	const changesExt = f.install("changes", changes, changesJson, 2);
	const boardExt = f.install("board", board, boardJson, 3);
	const all = [workExt, changesExt, boardExt];
	const column = async (ref: string): Promise<string> => {
		const out = await f.run(boardExt, {
			renders: [{
				slot: "repo-board",
				ctx: { slot: "repo.tab", node: REPO, repo: REPO },
			}],
		});
		const render = out.renders[0];
		if (!render.outcome.ok) throw new Error(render.outcome.error);
		deepStrictEqual(render.uiErrors, []);
		const root = render.outcome.value.root as {
			cards: { id: string; col: string }[];
		};
		return root.cards.find((c) => c.id === ref)?.col ?? "none";
	};
	try {
		// 1. A human creates the intent; the board shows it in the Backlog.
		const created = await f.run(workExt, {
			tools: [{
				name: "work_create",
				args: {
					repo: REPO_PATH,
					kind: "intent",
					title: "Rate limiting",
					why: "Protect the API",
					acceptance: ["429 above 100 rps"],
				},
				actor: user,
			}],
		});
		const ref = toolValue<{ ref: string }>(created).ref;
		equal(ref, `${REPO_PATH}#1`);
		await f.deliver(all);
		equal(await column(ref), "backlog");

		// 2. The agent claims it with a footprint: its own lane, open at once (branch).
		const claimed = await f.run(workExt, {
			tools: [{
				name: "work_claim",
				args: {
					ref,
					footprint: {
						projects: ["api"],
						prefixes: ["services/api/src/middleware"],
					},
					plan: "token bucket",
				},
				actor: agent,
			}],
		});
		const lane =
			toolValue<{ lane: { id: string; git: { push: string } } }>(claimed).lane;
		equal(lane.git.push, `git push -u origin HEAD:refs/heads/lanes/${lane.id}`);
		const conflictsCheck = claimed.calls.find((c) =>
			c.method === "interfaces.call"
		)!;
		deepStrictEqual(conflictsCheck.args.slice(0, 2), [
			"conflicts@1",
			"conflicts_check",
		]);
		await f.deliver(all);
		equal(await column(ref), "progress");

		// 3. Push, then submit right away: phase 2 is still pending.
		const phase2 = f.push(lane.id, "1".repeat(40), false);
		const submitted = await f.run(changesExt, {
			tools: [{
				name: "changes_submit",
				args: {
					laneId: lane.id,
					title: "Token bucket",
					summary: "Adds a limiter",
				},
				actor: agent,
			}],
		});
		const { changeId, revision } = toolValue<
			{ changeId: string; revision: number }
		>(submitted);
		equal(revision, 1);
		phase2();
		await f.deliver(all);
		equal(await column(ref), "review");

		// 4. A second push is revision 2.
		f.push(lane.id, "2".repeat(40));
		await f.deliver(all);

		// 5. Review, queue and the Advance (review@1, queue@1 and the kernel).
		const review = {
			kind: "installation" as const,
			id: "i_01k6000000000000000000000r",
			ext: "tartan.review@0.1.0",
		};
		const weave = {
			kind: "installation" as const,
			id: "i_01k6000000000000000000000w",
			ext: "tartan.weave@0.1.0",
		};
		f.append(
			"review.decided",
			{
				changeId,
				revision: 2,
				head: "2".repeat(40),
				decision: "approve",
				route: "auto",
				decidedBy: { kind: "ext", id: "x_i_01k6000000000000000000000r" },
			},
			review,
			{ kind: "ext", id: "x_i_01k6000000000000000000000r" },
		);
		f.append("queue.enqueued", { changeId, partition: "api" }, weave, {
			kind: "ext",
			id: "x_i_01k6000000000000000000000w",
		});
		const batchId = "lb_01k6bbbbbbbbbbbbbbbbbbbbbb";
		f.append(
			"queue.batched",
			{ batchId, partition: "api", changes: [changeId] },
			weave,
			{ kind: "ext", id: "x_i_01k6000000000000000000000w" },
		);
		await f.deliver(all);
		equal(await column(ref), "landing");
		f.kernel("land.submitted", {
			batchId,
			attempt: 1,
			ref: "refs/heads/main",
			changes: [{ changeId, laneId: lane.id, head: "2".repeat(40) }],
			reasonEvents: [],
			requestedBy: weave.id,
			testPolicy: "checks",
		});
		f.kernel("ref.advanced", {
			ref: "refs/heads/main",
			old: TRUNK,
			new: "e".repeat(40),
			advanceId: "adv_01k6bbbbbbbbbbbbbbbbbbbbbb_1",
			changes: [{ changeId, laneId: lane.id, commit: "e".repeat(40) }],
			reasonEvents: [],
			evidenceReused: false,
		});
		await f.deliver(all);
		equal(await column(ref), "done");

		// The interface events, in order, as the log holds them.
		const types = f.log.map((e) => e.type).filter((t) =>
			/^(work|changes)\./.test(t)
		);
		deepStrictEqual(types, [
			"work.created",
			"work.claimed",
			"changes.opened",
			"changes.submitted",
			"work.updated",
			"changes.revised",
			"changes.landed",
			"work.done",
		]);
		const revised = f.log.find((e) => e.type === "changes.revised")!;
		deepStrictEqual(
			[
				(revised.data as { revision: number }).revision,
				(revised.data as { head: string }).head,
			],
			[2, "2".repeat(40)],
		);
		const first = f.log.find((e) => e.type === "changes.submitted")!;
		equal((first.data as { head: string }).head, "1".repeat(40));
		// Work and changes each contributed a why-note section for the change.
		deepStrictEqual(
			[
				...new Set(
					f.notes.filter((n) => n.changeId === changeId).map((n) => n.ext),
				),
			].sort(),
			["tartan.changes", "tartan.work"],
		);
		const item = toolValue<{ state: string }>(
			await f.run(workExt, {
				tools: [{ name: "work_get", args: { ref }, actor: user }],
			}),
		);
		equal(item.state, "done");
		const change = toolValue<{ state: string; revisions: unknown[] }>(
			await f.run(changesExt, {
				tools: [{ name: "changes_get", args: { changeId }, actor: user }],
			}),
		);
		equal(change.state, "landed");
		equal(change.revisions.length, 2);
	} finally {
		for (const e of all) e.sql.close();
	}
});

Deno.test("WP12 scenario: an agent's changes_open {sourceRef} is refused before any lane operation (K16)", async () => {
	const f = createForge();
	const changesExt = f.install("changes", changes, changesJson, 2);
	try {
		const out = await f.run(changesExt, {
			tools: [{
				name: "changes_open",
				args: { repo: REPO_PATH, sourceRef: "feature/x" },
				actor: agent,
			}],
		});
		const outcome = out.tools[0].outcome;
		ok(!outcome.ok && outcome.error.startsWith("denied(lane-op)"));
		equal(out.calls.filter((c) => c.method === "lanes.adopt").length, 0);
	} finally {
		changesExt.sql.close();
	}
});

Deno.test("Swarm pack (M1 install): every member is bundled; the MCP instructions of its cards fit 8 KB", async () => {
	const { createBuiltinRegistry, BUILTIN_SOURCES } = await import(
		"../../src/builtins.ts"
	);
	const registry = createBuiltinRegistry(BUILTIN_SOURCES);
	const pack = registry.get("tartan.pack.swarm")!;
	const members = pack.manifest.members ?? [];
	ok(members.length > 0);
	let total = 0;
	for (const m of members) {
		const pkg = registry.get(m.id);
		ok(pkg, `${m.id} is bundled`);
		equal(pkg.manifest.version, m.version);
		const bytes = new TextEncoder().encode(pkg.protocol ?? "").length;
		ok(bytes <= 2048, `${m.id}: card ≤ 2 KB`);
		total += bytes;
	}
	ok(total <= 8192, `cards total ${total} B ≤ 8 KB`);
	ok(registry.get("tartan.work")!.protocol!.includes("git.push"));
	ok(registry.get("tartan.changes")!.protocol!.includes("changes_submit"));
});
