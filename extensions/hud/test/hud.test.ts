// tartan.hud: the counters behind the cold open.
// Events go through the extension host harness the way the builtin host
// delivers them; renders are checked against `tartan-ui@1`.
//
// Covered: the manifest subscribes to named events only (never `*`), each
// covered by its `events.read` grant; active lanes follow lane.* (opening and
// open count, a closed lane never reopens); predicted and avoided conflicts;
// landed per hour over a sliding hour; "needed a human" counts each change
// once; redelivered and backfilled events are applied once per stream;
// shadow events count for nothing; simulated agents are counted and named;
// old per-minute rows are pruned while totals stay; every slot renders a
// valid document that refreshes itself.

import {
	type Envelope,
	parseManifest,
	type UiDoc,
	type UiNode,
	validateUi,
} from "@tartan/contract";
import { createTestHarness, type Harness } from "@tartan/ext-api/testing.ts";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import manifestJson from "../tartan.json" with { type: "json" };
import { extension, migrations } from "../src/index.ts";
import { foldEvent, HUD_EVENTS, METRIC } from "../src/fold.ts";
import {
	createStore,
	MINUTE_MS,
	minuteOf,
	RETENTION_MINUTES,
} from "../src/store.ts";
import { METRIC_SLOTS, REFRESH_MS, renderWith, WINDOW } from "../src/ui.ts";

const result = parseManifest(manifestJson);
if (!result.ok) throw new Error(result.errors.join("; "));
const manifest = result.manifest;

const NODE = "01k6gggggggggggggggggggggg";
const R1 = "01k6rrrrrrrrrrrrrrrrrrrrr1";
const R2 = "01k6rrrrrrrrrrrrrrrrrrrrr2";
const AGENT = "a_01k6aaaaaaaaaaaaaaaaaaaaaa";
const sha = (c: string) => c.repeat(40);
/** A fixed minute so windows are deterministic. */
const NOW = 29_000_000;
const at = (minutesAgo: number, second = 0) =>
	(NOW - minutesAgo) * MINUTE_MS + second * 1000;

type EventInit = {
	readonly repo?: string;
	readonly minutesAgo?: number;
	readonly sim?: boolean;
	readonly shadow?: boolean;
	readonly kernel?: boolean;
};

const createStream = () => {
	const seqs = new Map<string, number>();
	let clock = 0;
	return (
		type: string,
		data: Record<string, unknown>,
		init: EventInit = {},
	): Envelope => {
		const repo = init.repo ?? R1;
		const seq = (seqs.get(repo) ?? 0) + 1;
		seqs.set(repo, seq);
		clock += 1;
		return {
			id: `01k6e${String(clock).padStart(21, "0")}`,
			seq,
			stream: `repo:${repo}`,
			type,
			v: 1,
			source: init.kernel === false
				? {
					kind: "installation",
					id: "i_01k6wwwwwwwwwwwwwwwwwwwwww",
					ext: "tartan.radar@0.1.0",
				}
				: { kind: "kernel" },
			actor: { kind: "agent", id: AGENT },
			node: repo,
			repo,
			depth: 0,
			shadow: init.shadow ?? false,
			...(init.sim ? { sim: true } : {}),
			at: at(init.minutesAgo ?? 0),
			data,
		};
	};
};

const lane = (id: string) => ({
	laneId: `ln_01k6llllllllllllllllllll${id}`,
	owner: AGENT,
	base: sha("b"),
	mode: "branch",
});

const harness = (): Harness =>
	createTestHarness({
		module: extension,
		migrations,
		grants: manifest.permissions,
		install: {
			id: "i_01k6hhhhhhhhhhhhhhhhhhhhhh",
			extId: manifest.id,
			version: manifest.version,
			node: { id: NODE, path: "rawkode" },
			scopeKey: "node",
		},
	});

const withHud = async (
	fn: (h: Harness, emit: ReturnType<typeof createStream>) => Promise<void>,
) => {
	const h = harness();
	try {
		await h.init();
		await fn(h, createStream());
	} finally {
		h.close();
	}
};

const store = (h: Harness) => createStore(h.ctx({ readOnly: true }).sql);

/** Every node of a document, depth first. */
const nodes = (doc: UiDoc): UiNode[] => {
	const out: UiNode[] = [];
	const walk = (value: unknown) => {
		if (Array.isArray(value)) return value.forEach(walk);
		if (typeof value !== "object" || value === null) return;
		if (typeof (value as UiNode).t === "string") out.push(value as UiNode);
		Object.values(value).forEach(walk);
	};
	walk(doc.root);
	return out;
};

const statOf = (doc: UiDoc) =>
	nodes(doc).find((n) => n.t === "stat") as
		| { label: string; value: number; delta?: number; unit?: string }
		| undefined;

const texts = (doc: UiDoc): string[] =>
	nodes(doc).flatMap((n) =>
		"text" in n && typeof n.text === "string" ? [n.text] : []
	);

const metric = (h: Harness, slot: string) =>
	renderWith(store(h), slot, "rawkode", NOW);

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

Deno.test("subscribes to named events only, each covered by events.read", () => {
	const subs = (manifest.subscribe ?? []).map((s): string => s.event);
	ok(!subs.includes("*"), "never every event");
	deepStrictEqual(subs, [...HUD_EVENTS]);
	const reads = manifest.permissions["events.read"] ?? [];
	deepStrictEqual(reads, [...HUD_EVENTS]);
	equal(manifest.storage?.scope, "node");
	equal(manifest.backfill, "30d");
});

Deno.test("five role-cached hud.metric slots and a viewer-cached home section", () => {
	const slots = manifest.contributes?.slots ?? [];
	deepStrictEqual(
		slots.filter((s) => s.slot === "hud.metric").map((s) => [s.id, s.cache]),
		METRIC_SLOTS.map((id) => [id, "role"]),
	);
	const home = slots.filter((s) => s.slot === "home.section");
	deepStrictEqual(home.map((s) => [s.id, s.cache]), [["swarm", "viewer"]]);
	ok(slots.every((s) => s.dynamic));
});

Deno.test("the module has init, onEvent and render only", () => {
	deepStrictEqual(Object.keys(extension).sort(), ["init", "onEvent", "render"]);
});

// ---------------------------------------------------------------------------
// Fold
// ---------------------------------------------------------------------------

Deno.test("fold: what each event counts", () => {
	const emit = createStream();
	deepStrictEqual(foldEvent(emit("lane.opening", lane("1"))), [
		{ kind: "lane", laneId: lane("1").laneId, state: "opening" },
	]);
	deepStrictEqual(foldEvent(emit("lane.opened", lane("1"))), [
		{ kind: "lane", laneId: lane("1").laneId, state: "open" },
		{ kind: "count", metric: METRIC.lanesOpened, n: 1 },
	]);
	for (
		const t of ["lane.closed", "lane.lost", "lane.archived", "lane.deleted"]
	) {
		deepStrictEqual(foldEvent(emit(t, lane("1"))), [
			{ kind: "lane", laneId: lane("1").laneId, state: "gone" },
		], t);
	}
	deepStrictEqual(foldEvent(emit("lane.synced", lane("1"))), []);
	deepStrictEqual(
		foldEvent(emit("conflicts.cleared", { conflictId: "c1", avoided: false })),
		[],
	);
	deepStrictEqual(
		foldEvent(
			emit("ref.advanced", {
				ref: "refs/heads/main",
				old: sha("a"),
				new: sha("b"),
				advanceId: "adv_1",
				changes: [
					{
						changeId: "c".repeat(32),
						laneId: lane("1").laneId,
						commit: sha("c"),
					},
					{
						changeId: "d".repeat(32),
						laneId: lane("2").laneId,
						commit: sha("d"),
					},
				],
				reasonEvents: [],
				evidenceReused: false,
			}),
		),
		[{ kind: "count", metric: METRIC.landed, n: 2 }],
	);
	deepStrictEqual(
		foldEvent(
			emit("review.decided", {
				changeId: "c".repeat(32),
				route: "auto",
				decision: "approve",
			}),
		),
		[{ kind: "review", changeId: "c".repeat(32), human: false }],
	);
	deepStrictEqual(
		foldEvent(emit("lane.opened", lane("9"), { shadow: true })),
		[],
		"shadow events count for nothing",
	);
});

// ---------------------------------------------------------------------------
// Counters through the host harness
// ---------------------------------------------------------------------------

Deno.test("active lanes: opening and open count, closed lanes leave and never reopen", async () => {
	await withHud(async (h, emit) => {
		await h.event(emit("lane.opening", lane("1"), { minutesAgo: 30 }));
		await h.event(emit("lane.opened", lane("1"), { minutesAgo: 29 }));
		await h.event(emit("lane.opened", lane("2"), { minutesAgo: 20 }));
		await h.event(
			emit("lane.opened", lane("3"), { minutesAgo: 10, repo: R2 }),
		);
		await h.event(emit("lane.closed", lane("2"), { minutesAgo: 5 }));
		// A late `lane.opened` for a closed lane does not bring it back.
		await h.event(emit("lane.opened", lane("2"), { minutesAgo: 4 }));
		const doc = metric(h, "active-lanes");
		equal(statOf(doc)?.value, 2);
		const spark = nodes(doc).find((n) => n.t === "sparkline") as {
			values: number[];
		};
		equal(spark.values.length, WINDOW);
		// The gauge carries forward over quiet minutes.
		equal(spark.values[WINDOW - 1 - 30], 1);
		equal(spark.values[WINDOW - 1 - 25], 1);
		equal(spark.values[WINDOW - 1 - 20], 2);
		equal(spark.values[WINDOW - 1 - 10], 3);
		equal(spark.values[WINDOW - 1], 2);
		equal(statOf(doc)?.delta, 2, "two more than an hour ago");
		ok(texts(doc).includes("every lane is a real agent's"));
		ok(texts(doc).includes("every repository under rawkode"), "the scope");
	});
});

Deno.test("a lost lane its agent renews counts as active again, and not as opened twice", async () => {
	await withHud(async (h, emit) => {
		await h.event(emit("lane.opened", lane("1"), { minutesAgo: 50 }));
		await h.event(emit("lane.lost", lane("1"), { minutesAgo: 15 }));
		equal(store(h).activeLanes().total, 0);
		await h.event(
			emit("lane.opened", { ...lane("1"), reason: "resumed" }, {
				minutesAgo: 5,
			}),
		);
		deepStrictEqual(store(h).activeLanes(), { total: 1, sim: 0 });
		equal(store(h).total(METRIC.lanesOpened), 1, "opened once");
		equal(statOf(metric(h, "active-lanes"))?.value, 1);
		// Closed for good afterwards.
		await h.event(emit("lane.closed", lane("1"), { minutesAgo: 2 }));
		equal(store(h).activeLanes().total, 0);
	});
});

Deno.test("predicted and avoided conflicts, with the share that never reached trunk", async () => {
	await withHud(async (h, emit) => {
		for (let i = 0; i < 4; i++) {
			await h.event(
				emit("conflicts.detected", {
					conflictId: `c${i}`,
					path: "packages/shared/src/money.ts",
					severity: "same_file",
				}, { minutesAgo: 50 - i, kernel: false }),
			);
		}
		await h.event(
			emit("conflicts.cleared", { conflictId: "c0", avoided: true }, {
				kernel: false,
			}),
		);
		await h.event(
			emit("conflicts.cleared", { conflictId: "c1", avoided: false }, {
				kernel: false,
			}),
		);
		await h.event(
			emit("conflicts.cleared", { conflictId: "c2", avoided: true }, {
				kernel: false,
			}),
		);
		equal(statOf(metric(h, "predicted-conflicts"))?.value, 4);
		const avoided = metric(h, "conflicts-avoided");
		equal(statOf(avoided)?.value, 2);
		ok(
			texts(avoided).some((t) => t.startsWith("50% of predicted conflicts")),
			texts(avoided).join(" | "),
		);
	});
});

Deno.test("landed per hour slides with the hour; totals keep everything", async () => {
	await withHud(async (h, emit) => {
		const advanced = (n: number, minutesAgo: number) =>
			emit("ref.advanced", {
				ref: "refs/heads/main",
				old: sha("a"),
				new: sha("b"),
				advanceId: `adv_${minutesAgo}`,
				changes: Array.from({ length: n }, (_, i) => ({
					changeId: String(i).repeat(32).slice(0, 32),
					laneId: lane(String(i)).laneId,
					commit: sha("c"),
				})),
				reasonEvents: [],
				evidenceReused: false,
			}, { minutesAgo });
		await h.event(advanced(3, 90));
		await h.event(advanced(2, 30));
		await h.event(advanced(1, 0));
		const doc = metric(h, "landed-per-hour");
		equal(statOf(doc)?.value, 3, "only the last 60 minutes");
		equal(statOf(doc)?.unit, "changes");
		ok(texts(doc).some((t) => t.startsWith("6 landed in all")));
	});
});

Deno.test("needed a human: each change once, routed to a human or not", async () => {
	await withHud(async (h, emit) => {
		const c = (n: string) => n.repeat(32);
		// Auto-approved twice (two revisions): one reviewed change.
		await h.event(
			emit("review.decided", { changeId: c("a"), route: "auto" }, {
				kernel: false,
			}),
		);
		await h.event(
			emit("review.decided", { changeId: c("a"), route: "auto" }, {
				kernel: false,
			}),
		);
		// Requested from a human, then decided by them: one change, human.
		await h.event(
			emit("review.requested", { changeId: c("b"), route: "human" }, {
				kernel: false,
			}),
		);
		await h.event(
			emit("review.decided", { changeId: c("b"), route: "human" }, {
				kernel: false,
			}),
		);
		// Auto first, then escalated to a human.
		await h.event(
			emit("review.decided", { changeId: c("d"), route: "auto" }, {
				kernel: false,
			}),
		);
		await h.event(
			emit("review.requested", { changeId: c("d"), route: "human" }, {
				kernel: false,
			}),
		);
		// The same change id in another repo is another change.
		await h.event(
			emit("review.decided", { changeId: c("a"), route: "auto" }, {
				kernel: false,
				repo: R2,
			}),
		);
		const doc = metric(h, "needed-a-human");
		equal(statOf(doc)?.value, 2);
		ok(
			texts(doc).some((t) => t.startsWith("2 of 4 reviewed changes (50%)")),
			texts(doc).join(" | "),
		);
	});
});

Deno.test("a redelivered or backfilled event is applied once per stream", async () => {
	await withHud(async (h, emit) => {
		const opened = emit("lane.opened", lane("1"), { minutesAgo: 3 });
		const detected = emit("conflicts.detected", {
			conflictId: "c1",
		}, { minutesAgo: 2, kernel: false });
		await h.event(opened);
		await h.event(detected);
		await h.event(detected);
		await h.event(opened);
		// Another stream's seq 1 is its own.
		await h.event(
			emit("conflicts.detected", { conflictId: "c2" }, {
				repo: R2,
				kernel: false,
			}),
		);
		equal(statOf(metric(h, "predicted-conflicts"))?.value, 2);
		equal(store(h).total(METRIC.lanesOpened), 1);
	});
});

Deno.test("shadow events count for nothing", async () => {
	await withHud(async (h, emit) => {
		await h.event(
			emit("review.requested", { changeId: "e".repeat(32) }, {
				shadow: true,
				kernel: false,
			}),
		);
		await h.event(emit("lane.opened", lane("1"), { shadow: true }));
		equal(statOf(metric(h, "needed-a-human"))?.value, 0);
		equal(statOf(metric(h, "active-lanes"))?.value, 0);
	});
});

Deno.test("simulated agents are counted and named", async () => {
	await withHud(async (h, emit) => {
		await h.event(emit("lane.opened", lane("1")));
		await h.event(emit("lane.opened", lane("2"), { sim: true }));
		await h.event(emit("lane.opened", lane("3"), { sim: true }));
		await h.event(
			emit("conflicts.detected", { conflictId: "c1" }, {
				sim: true,
				kernel: false,
			}),
		);
		const lanes = metric(h, "active-lanes");
		equal(statOf(lanes)?.value, 3);
		ok(texts(lanes).includes("2 of them simulated agents (swarm)"));
		ok(
			texts(metric(h, "predicted-conflicts")).some((t) =>
				t.endsWith("1 from simulated agents")
			),
		);
		equal(store(h).total(METRIC.lanesOpened, true), 2);
	});
});

Deno.test("per-minute rows older than the retention are pruned; totals stay", async () => {
	await withHud(async (h, emit) => {
		await h.event(
			emit("conflicts.detected", { conflictId: "c1" }, {
				minutesAgo: RETENTION_MINUTES + 10,
				kernel: false,
			}),
		);
		await h.event(
			emit("conflicts.detected", { conflictId: "c2" }, { kernel: false }),
		);
		const sql = h.ctx({ readOnly: true }).sql;
		const minutes = sql.exec<{ minute: number }>(
			"SELECT minute FROM counters WHERE metric = ? ORDER BY minute",
			METRIC.predicted,
		).toArray().map((r) => r.minute);
		deepStrictEqual(minutes, [NOW]);
		equal(store(h).total(METRIC.predicted), 2);
	});
});

Deno.test("every slot renders a valid document that refreshes itself", async () => {
	await withHud(async (h, emit) => {
		await h.event(emit("lane.opened", lane("1"), { sim: true }));
		for (const slot of manifest.contributes?.slots ?? []) {
			const doc = await h.render(slot.id, { node: NODE, mode: "enforce" });
			const checked = validateUi(doc);
			ok(checked.ok, `${slot.id}: ${checked.ok ? "" : checked.errors}`);
			equal((doc as UiDoc).refreshMs, REFRESH_MS, slot.id);
			ok(doc.root.t !== "empty", slot.id);
		}
		const home = await h.render("swarm", { node: NODE, mode: "enforce" });
		equal(home.root.t, "section");
		const table = nodes(home as UiDoc).find((n) => n.t === "table") as {
			columns: string[];
			rows: (string | number)[][];
		};
		deepStrictEqual(table.columns, [
			"Counter",
			"Real agents",
			"Simulated agents (swarm)",
		]);
		deepStrictEqual(table.rows.map((r) => r[0]), [
			"Active lanes",
			"Predicted conflicts",
			"Conflicts avoided",
			"Landed / hour",
			"Needed a human",
		]);
		deepStrictEqual(table.rows[0], ["Active lanes", 0, 1]);
		ok(
			texts(home as UiDoc).some((t) =>
				t.startsWith("Every repository under rawkode. Simulated agents run")
			),
		);
	});
});

Deno.test("the home section splits every counter into real and simulated agents", async () => {
	await withHud(async (h, emit) => {
		await h.event(emit("lane.opened", lane("1")));
		await h.event(emit("lane.opened", lane("2"), { sim: true }));
		await h.event(
			emit("conflicts.detected", { conflictId: "c1" }, { kernel: false }),
		);
		await h.event(
			emit("conflicts.detected", { conflictId: "c2" }, {
				sim: true,
				kernel: false,
			}),
		);
		await h.event(
			emit("conflicts.detected", { conflictId: "c3" }, {
				sim: true,
				kernel: false,
			}),
		);
		const doc = metric(h, "swarm");
		const table = nodes(doc).find((n) => n.t === "table") as {
			rows: (string | number)[][];
		};
		deepStrictEqual(table.rows[0], ["Active lanes", 1, 1]);
		deepStrictEqual(table.rows[1], ["Predicted conflicts", 1, 2]);
		const real = await withRealOnly();
		ok(real.some((t) => t.includes("No simulated agents are running")));
	});
});

/** The home section of a subtree with real agents only. */
const withRealOnly = async (): Promise<string[]> => {
	let out: string[] = [];
	await withHud(async (h, emit) => {
		await h.event(emit("lane.opened", lane("1")));
		out = texts(metric(h, "swarm"));
	});
	return out;
};

Deno.test("a quiet subtree says so instead of showing a wall of zeros alone", async () => {
	await withHud((h) => {
		const home = renderWith(store(h), "swarm", "rawkode", minuteOf(Date.now()));
		ok(
			texts(home).some((t) => t.startsWith("No lanes, conflicts or landings")),
		);
		return Promise.resolve();
	});
});
