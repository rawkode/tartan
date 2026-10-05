// The M1 loop's progress (support/loop-stages.ts names the stages), shared
// by the tests of tests/loop/m1-loop.e2e.ts: each stage runs once per loop
// instance across all workers and stores what the checks need (ids, SHAs,
// states; never a token). A test reaches the stage it checks, then asserts
// on the UI and the API itself, so a failed check never stops the loop, and
// a failed stage fails every later test with the stage that broke it.
//
// Who does what:
// - the Owner's PAT (from Node) imports the fixture (`LOOP_FIXTURE`, the root
//   package `tartan` enabling CI and review) into `e2e/swarm`, and reads the
//   repository config until it is current;
// - two scripted agents (support/agent.ts) create and claim one work item
//   each with overlapping footprints, push their lanes (both edit
//   `LOOP_FILE`, lines apart), and submit; radar must predict the overlap;
// - CI runs in containers until every check of both changes is green;
//   review routes both to a person (the owners rule, sensitivity 3);
// - the Owner's browser approves both on the change pages (the only UI step
//   of the progress; the test that reaches it first does it);
// - the Weave and an Advance land both on trunk; the work items close.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { type App, expect, type Screen } from "e2e";
import type { Browser } from "@e2e-dev/web";
import type {
	Change,
	Check,
	Conflict,
	LaneHandle,
	Review,
	WorkItem,
} from "@tartan/contract/interfaces.ts";
import type { LogResponse } from "@tartan/contract/api.ts";
import type { RepoConfigStateDto } from "@tartan/contract/repoconfig.ts";
import { type AgentName, type OpenLane, scriptedAgent } from "./agent.ts";
import type { NoticeView } from "./mcp.ts";
import { sharedStore } from "./fixtures.ts";
import {
	CI_JOB,
	editedLimits,
	LOOP_EDITS,
	LOOP_FILE,
	LOOP_FIXTURE,
	LOOP_LIMITS_LINES,
	LOOP_PROJECT,
	type LoopAgent,
} from "./fixture-repo.ts";
import { ok, query, tokenApi } from "./http.ts";
import { actionLabel } from "./labels.ts";
import {
	checkKey,
	type LoopStage,
	loopSuite,
	PRE_LAND_CHECKS,
	stageKey,
} from "./loop-stages.ts";
import { PACK_GROUP } from "./names.ts";
import { fixtureRepo } from "./repos.ts";
import { keyOf, sharedDirOf } from "./shared.ts";
import { type Stage, tokensOf } from "./stage.ts";

const AGENTS: readonly AgentName[] = ["A", "B"];

/** The CI check states that count as green (contract `CheckStateSchema`). */
const GREEN: readonly Check["state"][] = ["success", "cached", "skipped"];
const RED: readonly Check["state"][] = ["failure", "cancelled"];
const DONE: WorkItem["state"] = "done";
const LANDED: Change["state"] = "landed";
const EJECTED: Change["state"] = "ejected";
const HUMAN: Review["route"] = "human";
const APPROVE: NonNullable<Review["decision"]> = "approve";
const FAILED_CONFIG: RepoConfigStateDto["status"] = "failed";
/** Trunk's config evaluated: applied (`current`) or waiting for an apply. */
const EVALUATED: readonly RepoConfigStateDto["status"][] = [
	"current",
	"needs-apply",
];

/** The review extension's approve button, read from its source (labels.ts). */
export const APPROVE_LABEL = actionLabel("tartan.review", "approve");
export const REVIEW_PANEL =
	'section[data-slot="change.panel"][data-ext="tartan.review"]';

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `probe` every `everyMs` until it returns a value (not undefined), or throws `what` after `ms`. */
const until = async <T>(
	what: string,
	ms: number,
	everyMs: number,
	probe: () => Promise<T | undefined>,
): Promise<T> => {
	const deadline = Date.now() + ms;
	let last = "";
	for (;;) {
		try {
			const value = await probe();
			if (value !== undefined) return value;
		} catch (error) {
			last = (error as Error).message;
			if (error instanceof LoopFailure) throw error;
		}
		if (Date.now() > deadline) {
			throw new Error(
				`${what}: not after ${Math.round(ms / 1000)} s${
					last ? ` (last: ${last})` : ""
				}`,
			);
		}
		await sleep(everyMs);
	}
};

/** A definite failure while polling (red CI, an ejected change): stop at once. */
export class LoopFailure extends Error {
	override name = "LoopFailure";
}

// ---------------------------------------------------------------------------
// What each stage stores
// ---------------------------------------------------------------------------

type PerAgent<T> = { readonly A: T; readonly B: T };

export type RepoOutcome = {
	readonly path: string;
	readonly id: string;
	readonly remote: string;
	/** False: the forge evaluates no repository config (deploy without --repo-config). */
	readonly configEnabled: boolean;
	readonly configStatus: string;
	readonly rootFiles: readonly string[];
	readonly pipelineJobs: readonly string[];
	readonly ownerPaths: readonly string[];
	readonly projects: readonly string[];
};

export type ClaimOutcome = {
	readonly items: PerAgent<
		{
			readonly ref: string;
			readonly title: string;
			/** The item's state in the claim's answer. */
			readonly state: string;
		}
	>;
	readonly lanes: PerAgent<
		{
			readonly id: string;
			readonly ref: string;
			readonly branch: string;
			readonly base: string;
		}
	>;
	/** What B's claim answered about A's lane (declared footprints). */
	readonly overlapsB: readonly {
		readonly laneId: string;
		readonly severity: string;
		readonly suggestion: string;
	}[];
};

export type PushOutcome = {
	readonly heads: PerAgent<string>;
	/** The text of the line each agent wrote. */
	readonly lines: PerAgent<string>;
	readonly conflict: {
		readonly id: string;
		readonly path: string;
		readonly severity: string;
		readonly suggestion: string;
	};
	/** The conflict notice A's next tool result carried (radar notified it about B). */
	readonly noticeA: { readonly severity: string; readonly text: string } | null;
};

export type SubmitOutcome = {
	readonly changes: PerAgent<
		{ readonly changeId: string; readonly title: string }
	>;
};

export type CiOutcome = {
	readonly checks: PerAgent<
		readonly {
			readonly context: string;
			readonly state: string;
			readonly runId: string | null;
		}[]
	>;
};

export type ReviewOutcome = {
	readonly reviews: PerAgent<
		{
			readonly route: string;
			readonly risk: number;
			readonly factors: Readonly<Record<string, number>>;
		}
	>;
};

export type ApproveOutcome = {
	readonly decidedBy: PerAgent<string>;
};

export type LandOutcome = {
	readonly commits: PerAgent<string>;
	/** The agents in the order their changes landed on trunk (oldest first). */
	readonly order: readonly AgentName[];
	/** Trunk after both landed, newest first (the first commits of the log). */
	readonly trunk: readonly string[];
};

export type CloseOutcome = { readonly states: PerAgent<string> };

/** The browser parts of the test that runs the approval. */
export type OwnerUi = {
	readonly app: App;
	readonly screen: Screen;
	readonly browser: Browser;
};

// ---------------------------------------------------------------------------

export type Loop = {
	readonly index: number;
	readonly repo: () => Promise<RepoOutcome>;
	readonly claimed: () => Promise<ClaimOutcome>;
	readonly pushed: () => Promise<PushOutcome>;
	readonly submitted: () => Promise<SubmitOutcome>;
	readonly ciGreen: () => Promise<CiOutcome>;
	readonly reviewHuman: () => Promise<ReviewOutcome>;
	/** Needs the Owner's browser: the test that gets here first approves. */
	readonly approved: (ui: OwnerUi) => Promise<ApproveOutcome>;
	readonly landed: (ui: OwnerUi) => Promise<LandOutcome>;
	readonly closed: (ui: OwnerUi) => Promise<CloseOutcome>;
	/** Marks loop test `step` started; the returned function marks it done. */
	readonly checking: (step: number) => Promise<() => Promise<void>>;
	/** A scripted agent of this loop. */
	readonly agentOf: (name: AgentName) => ReturnType<typeof scriptedAgent>;
};

const loops = new Map<number, Loop>();

/** Loop instance `index` of this run (one per `--repeat-each` repeat). */
export const loopOf = (stage: Stage, index: number): Loop => {
	const existing = loops.get(index);
	if (existing !== undefined) return existing;
	const shared = sharedStore();
	const owner = tokenApi(stage.origin, tokensOf(stage).ownerPat);
	const agents = {
		A: scriptedAgent(stage, PACK_GROUP.swarm, "A"),
		B: scriptedAgent(stage, PACK_GROUP.swarm, "B"),
	};
	const once = <T>(s: LoopStage, work: () => Promise<T>): Promise<T> =>
		shared.once(stageKey(index, s), work as () => Promise<never>);

	// -- repo ------------------------------------------------------------------
	const repo = (): Promise<RepoOutcome> =>
		once("repo", async () => {
			const r = await fixtureRepo(
				stage,
				"swarm",
				loopSuite(index),
				LOOP_FIXTURE,
			);
			const at = `/-/api/repos/${encodeURIComponent(r.id)}/config`;
			// An import moves trunk outside the Advance: trunk's config is read
			// as policy at once and the installations wait as `needs-apply`
			// until a Maintainer+ applies it (ADR repo-config-cue, "Trunk moves
			// outside the Advance"); loop test 1 applies it as the Owner.
			const state = await until(
				"the loop repo's package tartan to be evaluated and in force as policy",
				240_000,
				3_000,
				async () => {
					const s = ok("GET", at, await owner.get<RepoConfigStateDto>(at));
					if (!s.enabled) return s;
					if (s.status === FAILED_CONFIG) {
						throw new LoopFailure(
							`the loop's package tartan failed: ${s.failure?.code ?? "?"} ${
								s.failure?.message ?? ""
							}`,
						);
					}
					return EVALUATED.includes(s.status) && !s.policy.pending &&
							s.policy.inForce?.status === "ok"
						? s
						: undefined;
				},
			);
			const pipeline = state.policy.pipeline as
				| { jobs?: Record<string, unknown> }
				| undefined;
			const owners = state.policy.owners as
				| { rules?: { paths?: string[] }[] }
				| undefined;
			return {
				path: r.path,
				id: r.id,
				remote: r.remote,
				configEnabled: state.enabled,
				configStatus: state.status,
				rootFiles: state.rootFiles.map((f) => f.name).sort(),
				pipelineJobs: Object.keys(pipeline?.jobs ?? {}).sort(),
				ownerPaths: (owners?.rules ?? []).flatMap((rule) => rule.paths ?? []),
				projects: Object.keys(
					(state.policy.projects ?? {}) as Record<string, unknown>,
				).sort(),
			};
		});

	const ready = async (): Promise<RepoOutcome> => {
		const r = await repo();
		if (!r.configEnabled) {
			throw new LoopFailure(
				"repository config is off on this forge (stage up deploys with --repo-config)",
			);
		}
		return r;
	};

	// -- claimed -------------------------------------------------------------------
	const footprint = { projects: [LOOP_PROJECT], prefixes: ["src/rate"] };
	const claimed = (): Promise<ClaimOutcome> =>
		once("claimed", async () => {
			const r = await ready();
			const items = {} as Record<
				AgentName,
				{ ref: string; title: string; state: string }
			>;
			const lanes = {} as Record<
				AgentName,
				{ id: string; ref: string; branch: string; base: string }
			>;
			let overlapsB: ClaimOutcome["overlapsB"] = [];
			for (const name of AGENTS) {
				const a = agents[name];
				const title = name === "A"
					? `Raise the read limit (${stage.runId}/${index})`
					: `Raise the admin limit (${stage.runId}/${index})`;
				const item = await a.mcp.call<WorkItem>("work_create", {
					repo: r.path,
					kind: "intent",
					title,
					why: `The ${
						name === "A" ? "read" : "admin"
					} limit is too low for the e2e loop.`,
					acceptance: [`${LOOP_FILE} carries the new limit`],
					footprint,
				});
				const claim = await a.mcp.call<{
					lane: LaneHandle;
					work: WorkItem;
					overlaps: {
						laneId: string;
						severity: string;
						suggestion: string;
					}[];
				}>("work_claim", {
					ref: item.ref,
					footprint,
					plan: `Edit line ${LOOP_EDITS[name].line} of ${LOOP_FILE}`,
				});
				const lane: OpenLane = await a.awaitOpen(r.path, claim.lane);
				items[name] = { ref: item.ref, title, state: claim.work.state };
				lanes[name] = {
					id: lane.id,
					ref: lane.ref,
					branch: lane.branch,
					base: lane.base,
				};
				if (name === "B") {
					overlapsB = claim.overlaps.map((o) => ({
						laneId: o.laneId,
						severity: o.severity,
						suggestion: o.suggestion,
					}));
				}
			}
			return { items, lanes, overlapsB };
		});

	// -- pushed --------------------------------------------------------------------
	const pushed = (): Promise<PushOutcome> =>
		once("pushed", async () => {
			const r = await ready();
			const c = await claimed();
			const heads = {} as Record<AgentName, string>;
			const lines = {} as Record<AgentName, string>;
			for (const name of AGENTS) {
				const a = agents[name];
				const clone = await a.clone(
					path.join(await loopScratch(stage, index), `push-${name}`),
					r.remote,
				);
				const { lane: handle } = await a.mcp.call<{ lane: LaneHandle }>(
					"lanes_get",
					{ repo: r.path, laneId: c.lanes[name].id },
				);
				const lane = await a.awaitOpen(r.path, handle);
				await a.runLane(lane.git.start, clone);
				const file = path.join(clone, ...LOOP_FILE.split("/"));
				const current = (await readFile(file, "utf8")).replace(/\n$/, "")
					.split("\n");
				if (current.join("\n") !== LOOP_LIMITS_LINES.join("\n")) {
					throw new Error(`${LOOP_FILE} at the lane base is not the fixture's`);
				}
				const line = loopLine(name as LoopAgent, stage.runId, index);
				await writeFile(
					file,
					`${editedLimits(current, name as LoopAgent, line).join("\n")}\n`,
				);
				heads[name] = await a.commit(clone, `Raise the limit (${name})`, [
					`Tartan-Work: ${c.items[name].ref}`,
				]);
				lines[name] = line;
				await a.runLane(lane.git.push, clone);
			}
			// A notice is delivered once, on the next result of any of A's
			// tools, so every call A makes from here on is read for it.
			const seenA: NoticeView[] = [];
			const aboutB = () =>
				seenA.find((n) =>
					n.kind === "conflict" && n.text.includes(c.lanes.B.id)
				);
			// Radar: B's push overlaps A's lane in the same file.
			const conflict = await until(
				"radar to report a conflict between the two lanes",
				120_000,
				2_000,
				async () => {
					const result = await agents.A.mcp.callFull<
						{ conflicts: Conflict[] }
					>("conflicts_list", { repo: r.path });
					seenA.push(...result.notices);
					return result.value.conflicts.find((x) =>
						x.path === LOOP_FILE && x.state !== "cleared" &&
						new Set([x.a, x.b]).has(c.lanes.A.id) &&
						new Set([x.a, x.b]).has(c.lanes.B.id)
					);
				},
			);
			// A's next tool result carries radar's notice about B's lane.
			const noticeA = await until(
				"agent A's next tool result to carry radar's notice",
				60_000,
				2_000,
				async () => {
					if (aboutB() !== undefined) return aboutB();
					const result = await agents.A.mcp.callFull("lanes_get", {
						repo: r.path,
						laneId: c.lanes.A.id,
					});
					seenA.push(...result.notices);
					return aboutB();
				},
			).catch(() => null);
			return {
				heads,
				lines,
				conflict: {
					id: conflict.id,
					path: conflict.path,
					severity: conflict.severity,
					suggestion: conflict.suggestion,
				},
				noticeA: noticeA === null
					? null
					: { severity: noticeA.severity, text: noticeA.text },
			};
		});

	// -- submitted -----------------------------------------------------------------
	const submitted = (): Promise<SubmitOutcome> =>
		once("submitted", async () => {
			const r = await ready();
			const c = await claimed();
			await pushed();
			const changes = {} as Record<
				AgentName,
				{ changeId: string; title: string }
			>;
			for (const name of AGENTS) {
				const title = `${c.items[name].title}: change`;
				const s = await agents[name].mcp.call<{ changeId: string }>(
					"changes_submit",
					{
						repo: r.path,
						laneId: c.lanes[name].id,
						title,
						summary: `Edits line ${LOOP_EDITS[name].line} of ${LOOP_FILE}.`,
						why: `Work item ${c.items[name].ref}.`,
					},
				);
				changes[name] = { changeId: s.changeId, title };
			}
			return { changes };
		});

	// -- ci-green ------------------------------------------------------------------
	const ciGreen = (): Promise<CiOutcome> =>
		once("ci-green", async () => {
			const r = await ready();
			const p = await pushed();
			const s = await submitted();
			const checks = {} as Record<AgentName, CiOutcome["checks"]["A"]>;
			for (const name of AGENTS) {
				checks[name] = await until(
					`CI to go green for change ${name}`,
					15 * 60_000,
					5_000,
					async () => {
						const { checks: list } = await agents[name].mcp.call<
							{ checks: Check[] }
						>("checks_get", {
							repo: r.path,
							changeId: s.changes[name].changeId,
						});
						const mine = list.filter((x) => x.sha === p.heads[name]);
						const red = mine.filter((x) => RED.includes(x.state));
						if (red.length > 0) {
							throw new LoopFailure(
								`CI failed for change ${name}: ${
									red.map((x) => `${x.context} ${x.state}`).join(", ")
								}`,
							);
						}
						const done = mine.length > 0 &&
							mine.every((x) => GREEN.includes(x.state)) &&
							mine.some((x) => x.context.startsWith(CI_JOB));
						return done
							? mine.map((x) => ({
								context: x.context,
								state: x.state,
								runId: x.runId ?? null,
							}))
							: undefined;
					},
				);
			}
			return { checks };
		});

	// -- review-human --------------------------------------------------------------
	const reviewHuman = (): Promise<ReviewOutcome> =>
		once("review-human", async () => {
			const r = await ready();
			const s = await submitted();
			await ciGreen();
			const reviews = {} as Record<AgentName, ReviewOutcome["reviews"]["A"]>;
			for (const name of AGENTS) {
				reviews[name] = await until(
					`review to route change ${name} to a person`,
					5 * 60_000,
					3_000,
					async () => {
						const review = await agents[name].mcp.call<Review>("review_get", {
							repo: r.path,
							changeId: s.changes[name].changeId,
						});
						if (review.decision === APPROVE && review.route !== HUMAN) {
							throw new LoopFailure(
								`review approved change ${name} automatically (risk ${review.risk}): the owners rule did not route it to a person`,
							);
						}
						return review.route === HUMAN
							? {
								route: review.route,
								risk: review.risk,
								factors: review.factors,
							}
							: undefined;
					},
				);
			}
			return { reviews };
		});

	// -- approved (UI) ---------------------------------------------------------
	const approved = (ui: OwnerUi): Promise<ApproveOutcome> =>
		once("approved", async () => {
			const r = await ready();
			const s = await submitted();
			await reviewHuman();
			// What the earlier checks look at must still be there while they look.
			await until(
				"the earlier checks of the loop to finish before anything lands",
				180_000,
				1_000,
				async () => {
					for (const step of PRE_LAND_CHECKS) {
						if (
							await shared.has(checkKey(index, step, "started")) &&
							!(await shared.has(checkKey(index, step, "done")))
						) {
							return undefined;
						}
					}
					return true;
				},
			);
			const decidedBy = {} as Record<AgentName, string>;
			for (const name of AGENTS) {
				const changeId = s.changes[name].changeId;
				await ui.app.open(`/${r.path}/-/changes/${changeId}`);
				const panel = ui.browser.locator(REVIEW_PANEL);
				const approve = panel.getByRole("button", APPROVE_LABEL);
				await expect(approve).toBeVisible({ timeout: 30_000 });
				await approve.tap();
				// The decision is checked on the API; the panel's in-place
				// update rides the live feed, which the loop does not wait on
				// (a fresh page must show the decided review: test 6 checks it).
				decidedBy[name] = await until(
					`the approval of change ${name} to be recorded`,
					60_000,
					2_000,
					async () => {
						const review = await agents[name].mcp.call<Review>("review_get", {
							repo: r.path,
							changeId,
						});
						return review.decision === APPROVE &&
								review.decidedBy?.kind === "user"
							? review.decidedBy.id
							: undefined;
					},
				);
			}
			return { decidedBy };
		});

	// -- landed --------------------------------------------------------------------
	const landed = (ui: OwnerUi): Promise<LandOutcome> =>
		once("landed", async () => {
			const r = await ready();
			const s = await submitted();
			await approved(ui);
			const commits = {} as Record<AgentName, string>;
			for (const name of AGENTS) {
				commits[name] = await until(
					`change ${name} to land on trunk`,
					20 * 60_000,
					5_000,
					async () => {
						const change = await agents[name].mcp.call<Change>("changes_get", {
							repo: r.path,
							changeId: s.changes[name].changeId,
						});
						if (change.state === EJECTED) {
							throw new LoopFailure(
								`change ${name} was ejected from the queue`,
							);
						}
						return change.state === LANDED ? change.landedCommit : undefined;
					},
				);
			}
			const at = `/-/api/log?${query({ repo: r.path, ref: "main" })}`;
			const log = ok("GET", "/-/api/log", await owner.get<LogResponse>(at));
			const trunk = log.commits.map((c) => c.sha);
			const position = (name: AgentName) => trunk.indexOf(commits[name]);
			for (const name of AGENTS) {
				if (position(name) < 0) {
					throw new Error(
						`change ${name}'s landed commit is not on trunk's history`,
					);
				}
			}
			const order = [...AGENTS].sort((a, b) => position(b) - position(a));
			return { commits, order, trunk: trunk.slice(0, 5) };
		});

	// -- closed --------------------------------------------------------------------
	const closed = (ui: OwnerUi): Promise<CloseOutcome> =>
		once("closed", async () => {
			const c = await claimed();
			await landed(ui);
			const states = {} as Record<AgentName, string>;
			for (const name of AGENTS) {
				states[name] = await until(
					`work item ${name} to close`,
					5 * 60_000,
					3_000,
					async () => {
						const item = await agents[name].mcp.call<WorkItem>("work_get", {
							ref: c.items[name].ref,
						});
						return item.state === DONE ? item.state : undefined;
					},
				);
			}
			return { states };
		});

	const loop: Loop = {
		index,
		repo,
		claimed,
		pushed,
		submitted,
		ciGreen,
		reviewHuman,
		approved,
		landed,
		closed,
		checking: async (step) => {
			await shared.mark(checkKey(index, step, "started"));
			return () => shared.mark(checkKey(index, step, "done"));
		},
		agentOf: (name) => agents[name],
	};
	loops.set(index, loop);
	return loop;
};

/** The line agent `name` writes into `LOOP_FILE` (unique per run and instance). */
export const loopLine = (
	name: LoopAgent,
	runId: string,
	index: number,
): string =>
	name === "A"
		? `\tread: 120, // ${runId}/${index} A`
		: `\tadmin: 2, // ${runId}/${index} B`;

/**
 * The agents' clones of loop instance `index`: inside the run's shared
 * directory (outside the repository), which the launcher removes after the
 * run, because the clones outlive the test that made them.
 */
const loopScratch = async (stage: Stage, index: number): Promise<string> => {
	const dir = path.join(
		sharedDirOf(tmpdir(), stage.runId),
		`scratch-loop-${index}`,
	);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
};

/** The loop instance of this attempt: the n-th time this test runs in the run. */
export const loopFor = async (
	stage: Stage,
	testTitle: string,
): Promise<Loop> =>
	loopOf(stage, await sharedStore().claimIndex(`claim-${keyOf(testTitle)}`));

export const LOOP_AGENTS = AGENTS;
