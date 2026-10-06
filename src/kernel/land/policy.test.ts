// K13.2 and K13.3 on the land path (ADR repo config, "Testing") on the
// land harness: the real core, event log, land and
// repoconfig modules with stock git, and an auto-approving review provider.
// A policy path is any root `*.cue` file (Tartan config is the root package
// `tartan`; another package's root file counts too).

import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { fromRpcError, isPolicyPath } from "@tartan/contract";
import type { GateDispatchResult } from "@tartan/contract/kernel.ts";
import { policyDigestOf } from "../repoconfig/key.ts";
import {
	eventsOf,
	type LandHarness,
	landTest,
	rolesOf,
} from "./testing/harness.ts";
import {
	landRequest,
	pushLane,
	QUEUE_INST,
	REVIEW_INST,
	submitChange,
} from "./testing/lanes.ts";
import { createFakeStep } from "./testing/step.ts";

const A = "a_01k6eeeeeeeeeeeeeeeeeeeeee";
const B = "a_01k6ffffffffffffffffffffff";
const MAINT = "u_01k6mmmmmmmmmmmmmmmmmmmmmm";
const REPORTER = "u_01k6rrrrrrrrrrrrrrrrrrrrrr";
const CONFIG =
	'package tartan\n\nextensions: "tartan.weave": settings: batch: 2\n';

const opts = { repoConfig: true };

const code = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
	} catch (error) {
		const e = fromRpcError(error);
		return `${e.code}${e.reason ? `(${e.reason})` : ""}: ${e.text}`;
	}
	return "ok";
};

/** A lane pushing `files`, with its push.diffed (phase 2), submitted and auto-approved. */
const policyChange = async (
	h: LandHarness,
	owner: string,
	files: Record<string, string>,
) => {
	const lane = await pushLane(h, { owner, files, rangeCommits: [] });
	return submitChange(h, lane);
};

const signOff = async (
	h: LandHarness,
	laneId: string,
	head: string,
	signer = MAINT,
) => {
	const digest = await (async () => {
		const repo = await h.fake.get(h.canonical);
		const commit = await repo.readCommit(head);
		const root = await repo.readTree(commit!.treeHash);
		return policyDigestOf(
			root!.filter((e) => isPolicyPath(e.name)).map((e) => ({
				name: e.name,
				mode: e.mode,
				oid: e.hash,
			})),
		);
	})();
	return await h.repoconfig!.facade.signOff(
		laneId,
		{ head, policyDigest: digest },
		signer,
	);
};

landTest(
	"K13.3: an auto-approving review provider cannot land a root *.cue change without a kernel sign-off",
	async (h) => {
		h.reviewProvider = REVIEW_INST;
		rolesOf(h).set(MAINT, 40);
		for (
			const name of [
				"tartan.cue",
				"a\u2028.cue",
				// Another package's root file (cuenv's env.cue) is policy too.
				"env.cue",
			]
		) {
			const change = await policyChange(h, A, { [name]: CONFIG });
			const refused = await code(
				h.land.submit(landRequest(h, [change]), QUEUE_INST),
			);
			match(refused, /^denied\(policy-signoff\)/, name);
		}
		// An ordinary change (a subdirectory .cue file, the retired .tartan/
		// directory) still lands without a sign-off.
		const plain = await policyChange(h, B, {
			"src/app.ts": "x\n",
			"services/api/x.cue": "package x\n",
			".tartan/pipeline.yaml": "jobs: {}\n",
		});
		equal(await code(h.land.submit(landRequest(h, [plain]), QUEUE_INST)), "ok");
	},
	opts,
);

landTest(
	"K13.3: with a Maintainer's sign-off of that head the change is accepted and the kernel pins the sign-off",
	async (h) => {
		h.reviewProvider = REVIEW_INST;
		rolesOf(h).set(MAINT, 40);
		const change = await policyChange(h, A, {
			"tartan.cue": CONFIG,
		});
		const s = await signOff(h, change.laneId, change.head);
		const request = landRequest(h, [change]);
		equal(await code(h.land.submit(request, QUEUE_INST)), "ok");
		const submitted = eventsOf(h, "land.submitted").pop()!;
		ok(
			(submitted.data as { reasonEvents: string[] }).reasonEvents.includes(
				s.eventId,
			),
		);
		const detail = await h.land.batch(request.batchId);
		ok(
			detail?.reason.events.includes(s.eventId),
			"the reason chain holds the sign-off",
		);
	},
	opts,
);

landTest(
	"K13.3: a Reporter's, another head's or a revoked sign-off does not count",
	async (h) => {
		h.reviewProvider = REVIEW_INST;
		rolesOf(h).set(MAINT, 40);
		rolesOf(h).set(REPORTER, 20);
		const byReporter = await policyChange(h, A, {
			"tartan.cue": CONFIG,
		});
		await signOff(h, byReporter.laneId, byReporter.head, REPORTER);
		match(
			await code(h.land.submit(landRequest(h, [byReporter]), QUEUE_INST)),
			/policy-signoff.*no longer a Maintainer/,
		);
		// Signed, then pushed again: the new head has no sign-off.
		const lane = await pushLane(h, {
			owner: B,
			files: { "tartan.cue": CONFIG },
			rangeCommits: [],
		});
		await signOff(h, lane.laneId, lane.head);
		const moved = await pushLane(h, {
			owner: B,
			laneId: lane.laneId,
			files: { "tartan.cue": CONFIG.replace("2", "3") },
			rangeCommits: [],
		});
		match(
			await code(
				h.land.submit(landRequest(h, [submitChange(h, moved)]), QUEUE_INST),
			),
			/^denied\(policy-signoff\)/,
		);
		// Revoked.
		const revoked = await policyChange(h, "a_01k6gggggggggggggggggggggg", {
			"tartan.cue": CONFIG,
		});
		await signOff(h, revoked.laneId, revoked.head);
		await h.repoconfig!.facade.revokeSignOff(
			revoked.laneId,
			revoked.head,
			MAINT,
		);
		match(
			await code(h.land.submit(landRequest(h, [revoked]), QUEUE_INST)),
			/^denied\(policy-signoff\)/,
		);
	},
	opts,
);

landTest(
	"K13.3: a change whose diff is still unknown is refused with policy-unknown (transient), never policy-signoff; once its diff is known it lands",
	async (h) => {
		h.reviewProvider = REVIEW_INST;
		rolesOf(h).set(MAINT, 40);
		// Pushed without its phase 2 (no push.diffed yet), and the lane range
		// cannot be read (Artifacts answers 500): whether it touches policy is
		// unknown.
		const lane = await pushLane(h, {
			owner: A,
			files: { "src/app.ts": "x\n" },
		});
		const change = submitChange(h, lane);
		h.failLaneRange = true;
		const refused = await code(
			h.land.submit(landRequest(h, [change]), QUEUE_INST),
		);
		match(refused, /^denied\(policy-unknown\)/);
		ok(!refused.includes("policy-signoff"), refused);
		ok(refused.includes(change.changeId), "the refusal names the change");
		// Phase 2 lands later (the diff timer's backstop): the diff is known,
		// the change touches no policy path and is accepted without a
		// sign-off.
		await h.core.recordDiff(lane.pushId!, {
			rangeBase: lane.head,
			rangeTruncated: false,
			diffKey: `diffs/${h.repoId}/${lane.head}.json`,
			commits: [],
			paths: ["src/app.ts"],
			truncated: false,
		});
		equal(
			await code(h.land.submit(landRequest(h, [change]), QUEUE_INST)),
			"ok",
		);
	},
	opts,
);

landTest(
	"K13.3: a policy change with an unknown diff and a standing sign-off of its head is accepted",
	async (h) => {
		h.reviewProvider = REVIEW_INST;
		rolesOf(h).set(MAINT, 40);
		const lane = await pushLane(h, {
			owner: A,
			files: { "tartan.cue": CONFIG },
		});
		const change = submitChange(h, lane);
		await signOff(h, change.laneId, change.head);
		h.failLaneRange = true;
		equal(
			await code(h.land.submit(landRequest(h, [change]), QUEUE_INST)),
			"ok",
		);
	},
	opts,
);

landTest(
	"K13.2: two policy-touching changes in one batch are refused (policy-batch)",
	async (h) => {
		h.reviewProvider = REVIEW_INST;
		rolesOf(h).set(MAINT, 40);
		const one = await policyChange(h, A, { "a.cue": CONFIG });
		const two = await policyChange(h, B, { "b.cue": CONFIG });
		await signOff(h, one.laneId, one.head);
		await signOff(h, two.laneId, two.head);
		match(
			await code(h.land.submit(landRequest(h, [one, two]), QUEUE_INST)),
			/^denied\(policy-batch\)/,
		);
	},
	opts,
);

landTest(
	"K13.2: a candidate whose root *.cue digest differs from the signed one is ejected (config-plan-changed); K13.1 holds the next land",
	async (h) => {
		h.reviewProvider = REVIEW_INST;
		rolesOf(h).set(MAINT, 40);
		// Two lanes from the same trunk, both adding a root .cue file (other files).
		const first = await policyChange(h, A, { "a.cue": CONFIG });
		const second = await policyChange(h, B, { "b.cue": CONFIG });
		await signOff(h, first.laneId, first.head);
		await signOff(h, second.laneId, second.head);
		const one = landRequest(h, [first]);
		equal(await code(h.land.submit(one, QUEUE_INST)), "ok");
		const landed = await h.drive(
			one.batchId,
			createFakeStep({ clock: h.clock }),
		);
		equal(landed.state, "landed");
		// The Advance touched a root .cue file: repository config is pending, lands held.
		deepStrictEqual(await h.land.configHold(), {
			held: true,
			reason: "pending",
		});
		equal((await h.repoconfig!.facade.state()).status, "pending");
		// Release the hold the way an Owner would while the evaluator is out.
		await h.repoconfig!.facade.override(
			"keep-last-good",
			"u_01k6ffffffffffffffffffffff",
		);
		equal((await h.land.configHold()).held, false);
		// The second change composes on the new trunk: its candidate's root
		// holds a.cue and b.cue, not what was signed (b.cue only).
		const two = landRequest(h, [second]);
		equal(await code(h.land.submit(two, QUEUE_INST)), "ok");
		const result = await h.drive(
			two.batchId,
			createFakeStep({ clock: h.clock }),
		);
		ok(result.state !== "landed", JSON.stringify(result));
		const vetoed = eventsOf(h, "land.vetoed").pop()!;
		equal((vetoed.data as { code: string }).code, "config-plan-changed");
		equal((vetoed.data as { changeId: string }).changeId, second.changeId);
	},
	opts,
);

landTest(
	"K13.1: the hold delays a land without using an attempt (config-hold steps)",
	async (h) => {
		h.reviewProvider = REVIEW_INST;
		rolesOf(h).set(MAINT, 40);
		const first = await policyChange(h, A, { "a.cue": CONFIG });
		await signOff(h, first.laneId, first.head);
		const one = landRequest(h, [first]);
		await h.land.submit(one, QUEUE_INST);
		equal(
			(await h.drive(one.batchId, createFakeStep({ clock: h.clock }))).state,
			"landed",
		);
		ok((await h.land.configHold()).held);
		const plain = await policyChange(h, B, { "src/app.ts": "y\n" });
		const two = landRequest(h, [plain]);
		await h.land.submit(two, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		// Three hold rounds pass, then an Owner keeps the last-good config.
		step.before = async (name) => {
			if (name === "config-hold-1-3") {
				await h.repoconfig!.facade.override(
					"keep-last-good",
					"u_01k6ffffffffffffffffffffff",
				);
			}
		};
		const result = await h.drive(two.batchId, step);
		equal(result.state, "landed");
		equal(result.attempt, 1, "no attempt was used by the hold");
		deepStrictEqual(
			step.sleeps.filter((s) => s.name.startsWith("config-wait-")).map((s) =>
				s.name
			),
			["config-wait-1-0", "config-wait-1-1", "config-wait-1-2"],
		);
	},
	opts,
);

/** A gate fake: `veto` decides; every call is recorded. */
const gateFake = (h: LandHarness, decide: () => boolean) => {
	const calls: string[] = [];
	h.gates = (input): Promise<GateDispatchResult> => {
		calls.push((input as { changeId: string }).changeId);
		const veto = decide();
		return Promise.resolve({
			calls: [],
			effective: [{
				installation: "i_01k6hhhhhhhhhhhhhhhhhhhhhh",
				ext: "acme.no-secrets@0.2.0",
				mode: "enforce",
				decision: veto ? "veto" : "allow",
				message: veto ? "a secret" : "clean",
				basis: "answer",
			}],
			blocked: veto,
		});
	};
	return calls;
};

landTest(
	"K13.1: gates are worked out after the hold lifts, so a gate the resolved config brings runs for the batch",
	async (h) => {
		h.reviewProvider = REVIEW_INST;
		rolesOf(h).set(MAINT, 40);
		const first = await policyChange(h, A, { "a.cue": CONFIG });
		await signOff(h, first.laneId, first.head);
		const one = landRequest(h, [first]);
		await h.land.submit(one, QUEUE_INST);
		equal(
			(await h.drive(one.batchId, createFakeStep({ clock: h.clock }))).state,
			"landed",
		);
		ok((await h.land.configHold()).held, "the config landing holds");
		// Until trunk's config resolves no gate is in force; once it does,
		// the gate it installs vetoes this change.
		let resolved = false;
		const calls = gateFake(h, () => resolved);
		const plain = await policyChange(h, B, { "src/app.ts": "secret\n" });
		const two = landRequest(h, [plain]);
		await h.land.submit(two, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		step.before = async (name) => {
			if (name === "config-hold-1-2") {
				resolved = true;
				await h.repoconfig!.facade.override(
					"keep-last-good",
					"u_01k6ffffffffffffffffffffff",
				);
			}
		};
		const result = await h.drive(two.batchId, step);
		ok(result.state !== "landed", JSON.stringify(result));
		ok(calls.length > 0, "the gates ran");
		const vetoed = eventsOf(h, "land.vetoed").pop()!;
		equal((vetoed.data as { changeId: string }).changeId, plain.changeId);
		ok(
			step.ran.indexOf("gate-1") > step.ran.indexOf("config-hold-1-2"),
			"the gate step ran after the hold lifted",
		);
	},
	opts,
);

landTest(
	"K13.1: ForgeDO's gate-missing hold is read fresh; one that begins while the gates run is waited out and the gates run again",
	async (h) => {
		h.reviewProvider = REVIEW_INST;
		const calls = gateFake(h, () => false);
		const plain = await policyChange(h, B, { "src/app.ts": "y\n" });
		const request = landRequest(h, [plain]);
		await h.land.submit(request, QUEUE_INST);
		// ForgeDO dropped a gate-bearing row: held at once (no evaluation ran).
		h.forgeHold = "gate-missing";
		deepStrictEqual(await h.land.configHold(), {
			held: true,
			reason: "gate-missing",
		});
		h.forgeHold = null;
		const step = createFakeStep({ clock: h.clock });
		step.before = (name) => {
			// The registry change lands while the first gate step runs ...
			if (name === "gate-1") h.forgeHold = "gate-missing";
			// ... and the re-apply commits two checks later.
			if (name === "config-hold-1-3") h.forgeHold = null;
		};
		const result = await h.drive(request.batchId, step);
		equal(result.state, "landed");
		ok(calls.length >= 2, "the gates ran again after the hold");
		const ran = step.ran.filter((n) => /^(gate|config-hold)-1/.test(n));
		deepStrictEqual(ran.slice(0, 2), ["config-hold-1-0", "gate-1"]);
		ok(
			ran.indexOf("gate-1-1") > ran.indexOf("config-hold-1-3"),
			JSON.stringify(step.ran),
		);
		ok(step.sleeps.some((s) => s.name.startsWith("config-wait-1-")));
	},
	opts,
);

landTest(
	"K9: a hold past its bound ends the batch config-hold, never error, and releases its lanes",
	async (h) => {
		h.reviewProvider = REVIEW_INST;
		const plain = await policyChange(h, B, { "src/app.ts": "y\n" });
		const request = landRequest(h, [plain]);
		await h.land.submit(request, QUEUE_INST);
		// An Owner revoked a gate approval and nobody acts: the hold stays.
		h.forgeHold = "gate-missing";
		const result = await h.drive(
			request.batchId,
			createFakeStep({ clock: h.clock }),
		);
		equal(result.state, "failed");
		const failed = eventsOf(h, "land.failed").pop()!;
		equal((failed.data as { reason: string }).reason, "config-hold");
		equal(eventsOf(h, "land.vetoed").length, 0, "a delay, never a veto");
		equal(
			(await h.core.getLane(plain.laneId))?.state,
			"submitted",
			"the lane's pushes reopen",
		);
	},
	opts,
);

landTest(
	"K13.3: a sign-off revoked after compose ejects the change at the K5 lock",
	async (h) => {
		h.reviewProvider = REVIEW_INST;
		rolesOf(h).set(MAINT, 40);
		const change = await policyChange(h, A, { "tartan.cue": CONFIG });
		await signOff(h, change.laneId, change.head);
		const request = landRequest(h, [change]);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		step.before = async (name) => {
			if (name === "lock-1") {
				await h.repoconfig!.facade.revokeSignOff(
					change.laneId,
					change.head,
					MAINT,
				);
			}
		};
		const result = await h.drive(request.batchId, step);
		ok(result.state !== "landed", JSON.stringify(result));
		const vetoed = eventsOf(h, "land.vetoed").pop()!;
		equal((vetoed.data as { code?: string }).code, "policy-signoff");
		equal(eventsOf(h, "ref.advanced").length, 0, "trunk never moved");
	},
	opts,
);

landTest(
	"K13.3: a signer demoted while the batch waits is an ejection at the K5 lock",
	async (h) => {
		h.reviewProvider = REVIEW_INST;
		rolesOf(h).set(MAINT, 40);
		const change = await policyChange(h, A, { "tartan.cue": CONFIG });
		await signOff(h, change.laneId, change.head);
		const request = landRequest(h, [change]);
		await h.land.submit(request, QUEUE_INST);
		const step = createFakeStep({ clock: h.clock });
		step.before = (name) => {
			if (name === "lock-1") rolesOf(h).set(MAINT, 30);
		};
		const result = await h.drive(request.batchId, step);
		ok(result.state !== "landed", JSON.stringify(result));
		const vetoed = eventsOf(h, "land.vetoed").pop()!;
		equal((vetoed.data as { code?: string }).code, "policy-signoff");
		match(
			(vetoed.data as { message: string }).message,
			/no longer a Maintainer/,
		);
	},
	opts,
);

landTest(
	"K13.3: a change under a root directory named *.cue needs a sign-off",
	async (h) => {
		h.reviewProvider = REVIEW_INST;
		const change = await policyChange(h, A, {
			"schema.cue/README.md": "not a config file\n",
		});
		const refused = await code(
			h.land.submit(landRequest(h, [change]), QUEUE_INST),
		);
		match(refused, /^denied\(policy-signoff\)/);
	},
	opts,
);
