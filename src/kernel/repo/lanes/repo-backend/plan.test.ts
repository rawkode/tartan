// The seeder's rules, pure: the breaker, the fallback rules and the bounds.

import { deepStrictEqual, equal } from "node:assert/strict";
import { isLanePlatformFault, type LaneMode } from "@tartan/contract";
import { artifactsError, FakeRateLimitError } from "@tartan/testkit";
import { LANE_BREAKER, LANE_IMPORT_MAX_BYTES } from "../../../../constants.ts";
import {
	attemptDeadline,
	type AttemptOutcome,
	classifyImportFailure,
	degradedMode,
	firstSeed,
	importTimeoutMs,
	modeIn,
	nextAfterFailure,
	nextMode,
	parseBreaker,
	recordStrike,
	strikeOf,
} from "./plan.ts";

const FULL: readonly LaneMode[] = ["import", "branch"];
const BRANCH_ONLY: readonly LaneMode[] = ["branch"];
const MiB = 1024 * 1024;
const LANE = (n: number) =>
	`ln_01k6c0ffee00000000000000${n.toString().padStart(2, "0")}`;

Deno.test("import timeout: 8 s + 0.4 s per MiB, capped at 30 s", () => {
	equal(importTimeoutMs(null), 8_000);
	equal(importTimeoutMs(10 * MiB), 12_000);
	equal(importTimeoutMs(100 * MiB), 30_000);
	equal(attemptDeadline(1_000, null), 1_000 + 8_000 + 5_000 + 5_000);
	equal(attemptDeadline(1_000, 100 * MiB), 1_000 + 30_000 + 5_000 + 5_000);
});

Deno.test("the chain may be shortened, never reordered: a missing mode moves on", () => {
	equal(modeIn("import", BRANCH_ONLY), "branch");
	equal(modeIn("import", FULL), "import");
	equal(modeIn("branch", FULL), "branch");
	equal(nextMode("import", FULL), "branch");
	equal(nextMode("branch", FULL), "branch");
});

Deno.test("first seed: configured mode, breaker, size flags, ceiling", () => {
	const base = {
		configured: "import" as LaneMode,
		chain: FULL,
		now: 1_000,
		breaker: null,
		tooLargeUntil: null,
		packBytes: null,
		ceilingReached: false,
	};
	deepStrictEqual(firstSeed(base), { mode: "import" });
	deepStrictEqual(firstSeed({ ...base, configured: "branch" }), {
		mode: "branch",
	});
	deepStrictEqual(firstSeed({ ...base, chain: BRANCH_ONLY }), {
		mode: "branch",
	});
	deepStrictEqual(
		firstSeed({
			...base,
			breaker: { strikes: [], degradedTo: "branch", until: 2_000 },
		}),
		{ mode: "branch", reason: "degraded" },
		"degraded for the hour",
	);
	deepStrictEqual(
		firstSeed({
			...base,
			breaker: { strikes: [], degradedTo: "branch", until: 500 },
		}),
		{ mode: "import" },
		"after the hour the configured mode is tried again",
	);
	deepStrictEqual(firstSeed({ ...base, tooLargeUntil: 5_000 }), {
		mode: "branch",
		reason: "lane-too-large",
	});
	deepStrictEqual(
		firstSeed({ ...base, packBytes: LANE_IMPORT_MAX_BYTES + 1 }),
		{ mode: "branch", reason: "lane-too-large" },
	);
	deepStrictEqual(firstSeed({ ...base, ceilingReached: true }), {
		mode: "branch",
		reason: "lane-repo-ceiling",
	});
});

Deno.test("import failures are classified from the route's report on the nonce", () => {
	const none = { uses: 0, consumedAt: null, outcome: null };
	const seen = { uses: 1, consumedAt: 5, outcome: "served" };
	equal(
		classifyImportFailure(artifactsError("MEMORY_LIMIT"), seen, false),
		"lane-too-large",
	);
	equal(
		classifyImportFailure(new FakeRateLimitError("import"), none, false),
		"rate-limited",
	);
	equal(
		classifyImportFailure(artifactsError("UPSTREAM_UNAVAILABLE"), {
			uses: 1,
			consumedAt: null,
			outcome: "trunk-moved",
		}, false),
		"trunk-moved",
	);
	equal(
		classifyImportFailure(artifactsError("UPSTREAM_UNAVAILABLE"), none, false),
		"importer-unreachable",
	);
	equal(
		classifyImportFailure(new Error("timeout"), none, true),
		"importer-unreachable",
	);
	equal(
		classifyImportFailure(new Error("timeout"), seen, true),
		"import-timeout",
	);
	equal(
		classifyImportFailure(artifactsError("INTERNAL_ERROR"), seen, false),
		"import-error",
	);
});

const failed = (
	attempt: number,
	seed: "import",
	code: AttemptOutcome["code"],
) => ({ attempt, seed, code });

Deno.test("fallback: import retries once after a platform failure, then branch", () => {
	deepStrictEqual(
		nextAfterFailure({
			failed: failed(1, "import", "import-error") as never,
			history: [],
			chain: FULL,
		}),
		{ kind: "seed", seed: "import", delayMs: 0 },
	);
	deepStrictEqual(
		nextAfterFailure({
			failed: failed(2, "import", "import-timeout") as never,
			history: [failed(1, "import", "import-error")],
			chain: FULL,
		}),
		{ kind: "branch" },
	);
	deepStrictEqual(
		nextAfterFailure({
			failed: failed(2, "import", "verify-failed") as never,
			history: [failed(1, "import", "importer-unreachable")],
			chain: FULL,
		}),
		{ kind: "branch" },
	);
});

Deno.test("fallback: lane-too-large, the ceiling and attempt 9 end on branch at once", () => {
	deepStrictEqual(
		nextAfterFailure({
			failed: failed(1, "import", "lane-too-large") as never,
			history: [],
			chain: FULL,
		}),
		{ kind: "branch" },
	);
	deepStrictEqual(
		nextAfterFailure({
			failed: failed(1, "import", "lane-repo-ceiling") as never,
			history: [],
			chain: FULL,
		}),
		{ kind: "branch" },
	);
	deepStrictEqual(
		nextAfterFailure({
			failed: failed(9, "import", "trunk-moved") as never,
			history: [],
			chain: FULL,
		}),
		{ kind: "branch" },
	);
});

Deno.test("fallback: trunk-moved, interrupted and rate-limited retry without the one retry, ≤ 3 per lane", () => {
	const t1 = nextAfterFailure({
		failed: failed(1, "import", "trunk-moved") as never,
		history: [],
		chain: FULL,
	});
	deepStrictEqual(t1, { kind: "seed", seed: "import", delayMs: 0 });
	// After a transient retry, a platform failure still gets its one retry.
	deepStrictEqual(
		nextAfterFailure({
			failed: failed(2, "import", "import-error") as never,
			history: [failed(1, "import", "trunk-moved")],
			chain: FULL,
		}),
		{ kind: "seed", seed: "import", delayMs: 0 },
	);
	// Rate limits back off 1 s, 2 s, 4 s.
	const delays = [1, 2, 3].map((n) => {
		const history = Array.from(
			{ length: n - 1 },
			(_, i) => failed(i + 1, "import", "rate-limited"),
		);
		const step = nextAfterFailure({
			failed: failed(n, "import", "rate-limited") as never,
			history,
			chain: FULL,
		});
		return step.kind === "seed" ? step.delayMs : -1;
	});
	deepStrictEqual(delays, [1_000, 2_000, 4_000]);
	// A fourth transient failure moves on.
	deepStrictEqual(
		nextAfterFailure({
			failed: failed(4, "import", "interrupted") as never,
			history: [
				failed(1, "import", "trunk-moved"),
				failed(2, "import", "rate-limited"),
				failed(3, "import", "interrupted"),
			],
			chain: FULL,
		}),
		{ kind: "branch" },
	);
});

Deno.test("strikes: per lane outcome, platform-side codes only", () => {
	equal(
		strikeOf({
			firstSeed: "import",
			final: "branch",
			attempts: [
				failed(1, "import", "import-error"),
				failed(2, "import", "import-error"),
			],
		}),
		"import-error",
	);
	equal(
		strikeOf({
			firstSeed: "import",
			final: "import",
			attempts: [failed(1, "import", "import-error")],
		}),
		null,
		"opened on its first seed after a retry: no strike",
	);
	for (
		const code of [
			"trunk-moved",
			"interrupted",
			"rate-limited",
			"lane-too-large",
			"lane-repo-ceiling",
		] as const
	) {
		equal(isLanePlatformFault(code), false);
		equal(
			strikeOf({
				firstSeed: "import",
				final: "branch",
				attempts: [failed(1, "import", code)],
			}),
			null,
			code,
		);
	}
});

Deno.test("breaker: 3 different lanes in 10 minutes degrade the repo for 1 hour; one lane never counts twice", () => {
	let state = null as ReturnType<typeof recordStrike>["state"] | null;
	const strike = (laneId: string, at: number) => {
		const update = recordStrike({
			state,
			strike: { at, laneId, code: "import-error" },
			firstSeed: "import",
			effective: "import",
			chain: FULL,
		});
		state = update.state;
		return update;
	};
	equal(strike(LANE(1), 0).degraded, undefined);
	equal(strike(LANE(1), 1_000).degraded, undefined, "same lane");
	equal(strike(LANE(2), 2_000).degraded, undefined);
	const third = strike(LANE(3), 3_000);
	deepStrictEqual(third.degraded?.to, "branch");
	equal(third.degraded?.until, 3_000 + LANE_BREAKER.degradeMs);
	equal(third.degraded?.strikes.length, 3);
	deepStrictEqual(state?.strikes, []);
	// Strikes outside the window do not add up.
	state = null;
	strike(LANE(1), 0);
	strike(LANE(2), 1_000);
	equal(strike(LANE(3), LANE_BREAKER.windowMs + 2_000).degraded, undefined);
	// Malformed meta reads as no breaker.
	equal(parseBreaker("{"), null);
	deepStrictEqual(parseBreaker('{"strikes":[]}'), { strikes: [] });
});

Deno.test("breaker: lanes of an import outage that finish after the degradation leave it as it is", () => {
	// Six lanes start on import during one outage; each fails import and
	// opens as a branch lane. Lanes 1-3 degrade import -> branch; lanes 4-6
	// finish after that and strike with an import fault while new lanes open
	// as branch lanes.
	let state = null as ReturnType<typeof recordStrike>["state"] | null;
	const strike = (laneId: string, at: number) => {
		const update = recordStrike({
			state,
			strike: { at, laneId, code: "import-timeout" },
			firstSeed: "import",
			effective: degradedMode(state, at) ?? "import",
			chain: FULL,
		});
		state = update.state;
		return update;
	};
	strike(LANE(1), 0);
	strike(LANE(2), 1_000);
	const degraded = strike(LANE(3), 2_000).degraded;
	equal(degraded?.to, "branch");
	for (const [n, at] of [[4, 3_000], [5, 4_000], [6, 5_000]] as const) {
		equal(strike(LANE(n), at).degraded, undefined, `lane ${n}`);
	}
	equal(degradedMode(state, 6_000), "branch", "branch lanes stay in use");
	equal(state?.until, degraded?.until, "the degradation is not extended");
	deepStrictEqual(state?.strikes, [], "the leftover strikes are dropped");
});
