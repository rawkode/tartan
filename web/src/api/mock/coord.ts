// Mock fixtures for the coordination views (WP19): lanes of the sample repo
// (`LaneDto`, WP5a's shape) and its event log (`Envelope`s whose `data`
// follow the contract's kernel and interface event schemas, checked by
// `test/coord-fixtures.spec.ts`). Both lane backends appear: branch lanes
// (M1's backend) and lanes in their own repository, one still `opening`.

import type { LaneDto } from "@tartan/contract/api.ts";
import type { Envelope } from "@tartan/contract/events.ts";
import {
	AGENTS,
	CHANGE_ID,
	instId,
	MOCK_NOW,
	mockUlid,
	OWNER_ID,
	REPO_ID,
	SHAS,
} from "./fixtures.ts";

const MIN = 60_000;
const REPO_PATH = "acme/platform/router";

export const LANE_IDS = {
	limits: `ln_${mockUlid(3001)}`,
	router: `ln_${mockUlid(3002)}`,
	web: `ln_${mockUlid(3003)}`,
	seeding: `ln_${mockUlid(3004)}`,
	docs: `ln_${mockUlid(3005)}`,
	human: `ln_${mockUlid(3006)}`,
} as const;

/** Another change id (reverse-hex, `[k-z]{32}`). */
export const CHANGE_ID_2 = "lmnopqrstuvwxyzklmnopqrstuvwxyzk";

const CLAUDE = AGENTS[0]?.id ?? `a_${mockUlid(201)}`;
const CODEX = AGENTS[1]?.id ?? `a_${mockUlid(202)}`;
const OTHER_AGENT = `a_${mockUlid(209)}`;

export const WORK = {
	limits: `${REPO_PATH}#12`,
	router: `${REPO_PATH}#14`,
	web: `${REPO_PATH}#15`,
	seeding: `${REPO_PATH}#16`,
	docs: `${REPO_PATH}#17`,
} as const;

export const WORK_TITLES: Readonly<Record<string, string>> = {
	[WORK.limits]: "Rate limit the public API per token",
	[WORK.router]: "Split the router config by service",
	[WORK.web]: "Show lane health in the web dashboard",
	[WORK.seeding]: "Cache shared package builds",
	[WORK.docs]: "Document the deploy button",
};

const sha = (n: number): string => n.toString(16).padStart(40, "a");

const lane = (
	id: string,
	owner: string,
	extra: Partial<LaneDto> & Pick<LaneDto, "createdAt">,
): LaneDto => {
	const mode = extra.mode ?? "branch";
	return {
		id,
		repoId: REPO_ID,
		kind: "lane",
		mode,
		ref: mode === "repo" ? "refs/heads/main" : `refs/heads/lanes/${id}`,
		branch: `lanes/${id}`,
		owner,
		delegates: [],
		footprint: { projects: [], prefixes: [] },
		base: SHAS.c3,
		state: "open",
		quarantined: false,
		leaseExpiresAt: MOCK_NOW + 25 * MIN,
		pushes: 0,
		remote: mode === "repo"
			? `/${REPO_PATH}/-/lanes/${id}.git`
			: `/${REPO_PATH}.git`,
		...extra,
	};
};

export const LANES: readonly LaneDto[] = [
	lane(LANE_IDS.limits, CLAUDE, {
		createdAt: MOCK_NOW - 52 * MIN,
		entity: { kind: "work", id: WORK.limits },
		footprint: {
			projects: ["services/api"],
			prefixes: ["services/api/src/limits", "packages/shared/src/config.ts"],
		},
		head: sha(11),
		pushes: 3,
		lastPushAt: MOCK_NOW - 4 * MIN,
		state: "submitted",
	}),
	lane(LANE_IDS.router, CODEX, {
		createdAt: MOCK_NOW - 41 * MIN,
		entity: { kind: "work", id: WORK.router },
		footprint: {
			projects: ["services/api"],
			prefixes: ["services/api/src/router", "packages/shared/src/config.ts"],
		},
		head: sha(12),
		pushes: 2,
		lastPushAt: MOCK_NOW - 9 * MIN,
	}),
	lane(LANE_IDS.web, CLAUDE, {
		createdAt: MOCK_NOW - 33 * MIN,
		mode: "repo",
		seed: "import",
		seedMs: 2140,
		entity: { kind: "work", id: WORK.web },
		footprint: { projects: ["apps/web"], prefixes: ["apps/web/src/lanes"] },
		head: sha(13),
		pushes: 1,
		lastPushAt: MOCK_NOW - 12 * MIN,
	}),
	lane(LANE_IDS.seeding, OTHER_AGENT, {
		createdAt: MOCK_NOW - 15_000,
		mode: "repo",
		seed: "import",
		state: "opening",
		entity: { kind: "work", id: WORK.seeding },
		footprint: { projects: ["packages/shared"], prefixes: [] },
	}),
	lane(LANE_IDS.docs, CODEX, {
		createdAt: MOCK_NOW - 75 * MIN,
		entity: { kind: "work", id: WORK.docs },
		footprint: { projects: [], prefixes: ["docs"] },
		head: sha(15),
		pushes: 4,
		lastPushAt: MOCK_NOW - 20 * MIN,
		state: "landing",
	}),
	lane(LANE_IDS.human, OWNER_ID, {
		createdAt: MOCK_NOW - 3 * MIN,
		kind: "adopted",
		ref: "refs/heads/fix-readme",
		branch: "fix-readme",
		footprint: { projects: [], prefixes: ["README.md"] },
	}),
];

/** `stream` as the contract types it (`repo:<id>`). */
const STREAM = `repo:${REPO_ID}` as const;

/** Interface events come from the installation that provides the interface. */
const PROVIDER: Readonly<Record<string, Envelope["source"]>> = Object
	.fromEntries(
		([
			["work", "tartan.work"],
			["changes", "tartan.changes"],
			["conflicts", "tartan.radar"],
			["checks", "tartan.ci"],
		] as const).map(([ns, ext]) => [ns, {
			kind: "installation",
			id: instId(ext),
			ext: `${ext}@0.1.0`,
		}]),
	);

let seq = 0;
const event = (
	type: string,
	at: number,
	data: Readonly<Record<string, unknown>>,
	actor = CLAUDE,
): Envelope => {
	seq += 1;
	return {
		id: mockUlid(5000 + seq),
		seq,
		stream: STREAM,
		type,
		v: 1,
		source: PROVIDER[type.split(".")[0] ?? ""] ?? { kind: "kernel" },
		actor: { kind: actor.startsWith("a_") ? "agent" : "user", id: actor },
		node: REPO_ID,
		repo: REPO_ID,
		depth: 0,
		shadow: false,
		at,
		data,
	} as Envelope;
};

const push = (laneId: string, at: number, after: string, actor: string) =>
	event("push.accepted", at, {
		pushId: `p${at}`,
		target: laneId,
		ref: LANES.find((l) => l.id === laneId)?.ref ?? "refs/heads/main",
		before: SHAS.c3,
		after,
		via: "gateway",
	}, actor);

const laneEvent = (type: string, l: LaneDto, at: number) =>
	event(type, at, {
		laneId: l.id,
		...(l.entity ? { entity: l.entity } : {}),
		owner: l.owner,
		base: l.base,
		footprint: l.footprint,
		mode: l.mode,
		...(l.seed ? { seed: l.seed } : {}),
		...(type === "lane.opened" && l.seedMs !== undefined
			? { seedMs: l.seedMs }
			: {}),
	}, l.owner);

const byId = (id: string): LaneDto => LANES.find((l) => l.id === id) as LaneDto;

/** The repo log, oldest first (`EventsResponse.events`). */
export const EVENTS: readonly Envelope[] = [
	...Object.entries(WORK_TITLES).map(([ref, title]) =>
		event("work.created", MOCK_NOW - 90 * MIN, {
			ref,
			kind: "issue",
			title,
		}, OWNER_ID)
	),
	laneEvent("lane.opened", byId(LANE_IDS.docs), MOCK_NOW - 75 * MIN),
	event("work.claimed", MOCK_NOW - 75 * MIN, {
		ref: WORK.docs,
		principal: CODEX,
		laneId: LANE_IDS.docs,
	}, CODEX),
	laneEvent("lane.opened", byId(LANE_IDS.limits), MOCK_NOW - 52 * MIN),
	event("work.claimed", MOCK_NOW - 52 * MIN, {
		ref: WORK.limits,
		principal: CLAUDE,
		laneId: LANE_IDS.limits,
	}),
	push(LANE_IDS.docs, MOCK_NOW - 48 * MIN, sha(21), CODEX),
	laneEvent("lane.opened", byId(LANE_IDS.router), MOCK_NOW - 41 * MIN),
	event("work.claimed", MOCK_NOW - 41 * MIN, {
		ref: WORK.router,
		principal: CODEX,
		laneId: LANE_IDS.router,
	}, CODEX),
	push(LANE_IDS.limits, MOCK_NOW - 38 * MIN, sha(22), CLAUDE),
	push(LANE_IDS.docs, MOCK_NOW - 36 * MIN, sha(23), CODEX),
	laneEvent("lane.opening", byId(LANE_IDS.web), MOCK_NOW - 33 * MIN),
	laneEvent("lane.opened", byId(LANE_IDS.web), MOCK_NOW - 33 * MIN + 2140),
	push(LANE_IDS.router, MOCK_NOW - 30 * MIN, sha(24), CODEX),
	event("conflicts.detected", MOCK_NOW - 30 * MIN, {
		conflictId: `cf_${mockUlid(6001)}`,
		a: LANE_IDS.limits,
		b: LANE_IDS.router,
		path: "packages/shared/src/config.ts",
		severity: "same_file",
		suggestion: "coordinate",
	}),
	push(LANE_IDS.limits, MOCK_NOW - 22 * MIN, sha(25), CLAUDE),
	push(LANE_IDS.docs, MOCK_NOW - 20 * MIN, sha(15), CODEX),
	event("changes.opened", MOCK_NOW - 19 * MIN, {
		changeId: CHANGE_ID_2,
		laneId: LANE_IDS.docs,
		workRef: WORK.docs,
		title: "docs: the deploy button",
	}, CODEX),
	event("changes.submitted", MOCK_NOW - 19 * MIN, {
		changeId: CHANGE_ID_2,
		laneId: LANE_IDS.docs,
		revision: 1,
		head: sha(15),
		base: SHAS.c3,
		affected: [],
		workRef: WORK.docs,
	}, CODEX),
	event("checks.completed", MOCK_NOW - 17 * MIN, {
		subject: { kind: "change", id: CHANGE_ID_2 },
		sha: sha(15),
		state: "success",
		contexts: [],
		cached: true,
	}),
	event("land.submitted", MOCK_NOW - 15 * MIN, {
		batchId: "lb_1",
		attempt: 1,
		ref: "refs/heads/main",
		changes: [{ changeId: CHANGE_ID_2, laneId: LANE_IDS.docs, head: sha(15) }],
		reasonEvents: [],
		requestedBy: "tartan.weave",
		testPolicy: "checks",
	}),
	push(LANE_IDS.web, MOCK_NOW - 12 * MIN, sha(13), CLAUDE),
	push(LANE_IDS.router, MOCK_NOW - 9 * MIN, sha(12), CODEX),
	event("run.started", MOCK_NOW - 9 * MIN, {
		runId: "run_1",
		state: "running",
		subject: { kind: "lane", id: LANE_IDS.router },
	}),
	push(LANE_IDS.limits, MOCK_NOW - 4 * MIN, sha(11), CLAUDE),
	event("changes.opened", MOCK_NOW - 4 * MIN, {
		changeId: CHANGE_ID,
		laneId: LANE_IDS.limits,
		workRef: WORK.limits,
		title: "api: rate limits on /v1",
	}),
	event("changes.submitted", MOCK_NOW - 4 * MIN, {
		changeId: CHANGE_ID,
		laneId: LANE_IDS.limits,
		revision: 1,
		head: sha(11),
		base: SHAS.c3,
		affected: ["services/api", "packages/shared"],
		workRef: WORK.limits,
	}),
	event("checks.updated", MOCK_NOW - 3 * MIN, {
		subject: { kind: "change", id: CHANGE_ID },
		sha: sha(11),
		context: "services/api:test",
		state: "success",
	}),
	event("checks.updated", MOCK_NOW - 2 * MIN, {
		subject: { kind: "change", id: CHANGE_ID },
		sha: sha(11),
		context: "packages/shared:test",
		state: "success",
	}),
	laneEvent("lane.opening", byId(LANE_IDS.seeding), MOCK_NOW - 15_000),
];

export const EVENTS_HEAD = EVENTS.length;

/** A live push to a lane (mock `/-/live`), with seq/time supplied by the socket. */
export const livePush = (
	n: number,
): {
	readonly type: string;
	readonly data: Readonly<Record<string, unknown>>;
} => {
	const targets = [LANE_IDS.limits, LANE_IDS.router, LANE_IDS.web];
	const target = targets[n % targets.length] ?? LANE_IDS.limits;
	return {
		type: "push.accepted",
		data: {
			pushId: `live${n}`,
			target,
			ref: byId(target).ref,
			before: SHAS.c3,
			after: sha(1000 + n),
			via: "gateway",
		},
	};
};

/** Lanes for the mock `GET /-/api/lanes`: filter, id order, `limit` and `cursor` (WP5a). */
export const lanesPage = (
	lanes: readonly LaneDto[],
	query: { state?: string; cursor?: string; limit?: string },
): { lanes: LaneDto[]; cursor?: string } => {
	const states = query.state ? query.state.split(",") : null;
	const limit = Math.min(200, Math.max(1, Number(query.limit ?? "50") || 50));
	const matching = lanes
		.filter((l) => states === null || states.includes(l.state))
		.filter((l) => !query.cursor || l.id > query.cursor)
		.slice()
		.sort((a, b) => a.id.localeCompare(b.id));
	const page = matching.slice(0, limit);
	return {
		lanes: page,
		...(matching.length > limit ? { cursor: page[page.length - 1]?.id } : {}),
	};
};

/** A synthetic swarm of `n` branch lanes (the 1,000-lane render check). */
export const swarmLanes = (n: number): LaneDto[] =>
	Array.from(
		{ length: n },
		(_, i) =>
			lane(`ln_${mockUlid(100_000 + i)}`, `a_${mockUlid(200_000 + i)}`, {
				createdAt: MOCK_NOW - (i % 120) * MIN,
				footprint: { projects: [`services/s${i % 40}`], prefixes: [] },
				pushes: i % 5,
			}),
	);
