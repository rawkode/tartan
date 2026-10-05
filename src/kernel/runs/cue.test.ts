// The repository-config job queue of TartanSandbox (`cue:trunk`,
// `cue:preview:<k>`; ADR repo config, "Testing"):
// `cueSubmit` returns before the job runs, single flight by input key,
// strict priority on `cue:trunk`, previews kept apart and rate-limited, the
// bundle and one exec per job, results through the sinks, and an outage.

import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import {
	CUE_EVAL_CONTRACT,
	CUE_EVALUATOR_ID,
	CUE_JOB_VERSION,
	CUE_VERSION,
	type CueJobClass,
	type CueJobInput,
	type CueJobSink,
	DEFAULT_EVAL_LIMITS,
	type EvalResponse,
	isEvalOk,
	JOB_SLOT_DEFAULTS,
	REPO_CONFIG_LIMITS,
} from "@tartan/contract";
import { createFakeStorage } from "../repo/testing/sqlite.ts";
import { createCueQueue, type CueExecResult } from "./cue.ts";

const KEY = (n: number) => n.toString(16).padStart(64, "c");

const result = (rc = 0): CueExecResult => ({
	exitCode: rc,
	stdout: `${
		JSON.stringify({
			job: CUE_JOB_VERSION,
			cue: CUE_VERSION,
			rc,
			ms: 3,
			out: rc === 0 ? '{"extensions":{}}' : "",
			outBytes: rc === 0 ? 17 : 0,
			err: rc === 0 ? "" : "x: conflicting values 1 and 2:\n    ./a.cue:3:4\n",
			errBytes: 0,
		})
	}\n`,
	stderr: "",
});

type Delivery = { sink: CueJobSink; key: string; envelope: EvalResponse };

const harness = (role: "trunk" | "preview", opts: {
	available?: boolean;
	exec?: (command: string) => Promise<CueExecResult>;
} = {}) => {
	const storage = createFakeStorage();
	const deliveries: Delivery[] = [];
	const execs: string[] = [];
	const writes: { path: string; content: string }[] = [];
	const background: Promise<unknown>[] = [];
	let t = 1_000;
	const queue = createCueQueue({
		sql: storage.sql,
		role,
		now: () => t,
		sleep: () => Promise.resolve(),
		log: () => {},
		port: {
			available: () => opts.available ?? true,
			warm: () => true,
			writeFile: (path, content) => {
				writes.push({ path, content });
				return Promise.resolve();
			},
			exec: (command) => {
				execs.push(command);
				return opts.exec ? opts.exec(command) : Promise.resolve(result());
			},
			waitUntil: (work) => void background.push(work),
		},
		sinks: {
			deliver: (sink, key, envelope) => {
				deliveries.push({ sink, key, envelope });
				return Promise.resolve();
			},
		},
	});
	return {
		queue,
		deliveries,
		execs,
		writes,
		advance: (ms: number) => {
			t += ms;
		},
		settle: async () => {
			while (background.length > 0) await Promise.all(background.splice(0));
		},
	};
};

const job = (
	n: number,
	cls: CueJobClass,
	over: Partial<CueJobInput> = {},
): CueJobInput => ({
	class: cls,
	sink: { kind: "repo", repoId: "01k6aaaaaaaaaaaaaaaaaaaaaa" },
	request: {
		version: CUE_EVAL_CONTRACT,
		evaluator: CUE_EVALUATOR_ID,
		inputKey: KEY(n),
		files: {
			"~tartan.cue": "package tartan\n",
			"tartan.cue": `package tartan\n\nx: ${n}\n`,
		},
		limits: DEFAULT_EVAL_LIMITS,
	},
	...over,
});

/** An exec that waits for `release()`. */
const gate = () => {
	let release!: () => void;
	const opened = new Promise<void>((r) => (release = r));
	return { opened, release };
};

Deno.test("cueSubmit returns before the job runs; the envelope arrives through the sink", async () => {
	const g = gate();
	const h = harness("trunk", {
		exec: async () => {
			await g.opened;
			return result();
		},
	});
	const answer = h.queue.submit(job(1, "trunk"));
	ok(answer.accepted);
	if (answer.accepted) {
		equal(answer.joined, false);
		equal(answer.warm, true);
	}
	equal(h.deliveries.length, 0, "nothing delivered while the job runs");
	g.release();
	await h.settle();
	equal(h.deliveries.length, 1);
	equal(h.deliveries[0].key, KEY(1));
	ok(isEvalOk(h.deliveries[0].envelope));
	// One bundle, one exec, as tartan-git, with the bundle removed after.
	equal(h.writes.length, 1);
	ok(h.writes[0].path.startsWith("/opt/tartan-cue/bundles/bundle-"));
	const bundle = JSON.parse(h.writes[0].content);
	equal(bundle.v, 1);
	equal(
		atob(bundle.files["tartan.cue"]),
		"package tartan\n\nx: 1\n",
	);
	equal(h.execs.length, 1);
	ok(h.execs[0].includes("setpriv --reuid=tartan-git"));
	ok(h.execs[0].includes("rm -f /opt/tartan-cue/bundles/bundle-"));
	deepStrictEqual(h.queue.list(), []);
});

Deno.test("single flight: a duplicate submit joins the queued job and adds its sink", async () => {
	const g = gate();
	const h = harness("trunk", {
		exec: async () => {
			await g.opened;
			return result();
		},
	});
	h.queue.submit(job(1, "trunk"));
	const again = h.queue.submit(job(1, "registry", {
		sink: { kind: "approval", requestId: "car_x" },
	}));
	ok(again.accepted && again.joined);
	g.release();
	await h.settle();
	equal(h.execs.length, 1);
	deepStrictEqual(
		h.deliveries.map((d) => d.sink.kind).sort(),
		["approval", "repo"],
	);
});

Deno.test("strict priority on cue:trunk: trunk, then trunk moves outside the Advance, registry, self-checks", async () => {
	const g = gate();
	const order: string[] = [];
	const h = harness("trunk", {
		exec: async (command) => {
			order.push(command);
			if (order.length === 1) await g.opened;
			return result();
		},
	});
	h.queue.submit(job(9, "selfcheck")); // starts first and blocks
	await new Promise((r) => setTimeout(r, 0));
	equal(order.length, 1);
	h.advance(1);
	h.queue.submit(job(2, "selfcheck"));
	h.advance(1);
	h.queue.submit(job(3, "registry"));
	h.advance(1);
	h.queue.submit(job(4, "external"));
	h.advance(1);
	h.queue.submit(job(5, "trunk"));
	g.release();
	await h.settle();
	deepStrictEqual(
		h.deliveries.map((d) => d.key),
		[KEY(9), KEY(5), KEY(4), KEY(3), KEY(2)],
	);
});

Deno.test("previews: never on cue:trunk; one in flight per principal; the latest per lane replaces a queued one; a bounded queue and an hourly budget", async () => {
	const trunk = harness("trunk");
	const refused = trunk.queue.submit(job(1, "preview", { principal: "a_x" }));
	ok(!refused.accepted && refused.reason === "invalid");
	const p = harness("preview", { exec: () => new Promise(() => {}) });
	ok(
		!p.queue.submit(job(1, "trunk")).accepted,
		"kernel work never runs on a preview sandbox",
	);
	const lane = "ln_01k6aaaaaaaaaaaaaaaaaaaaaa";
	// The first job of a principal starts (and hangs); a second is refused.
	ok(
		p.queue.submit(job(1, "preview", { principal: "a_one", laneId: lane }))
			.accepted,
	);
	const busy = p.queue.submit(
		job(2, "preview", {
			principal: "a_one",
			laneId: "ln_01k6bbbbbbbbbbbbbbbbbbbbbb",
		}),
	);
	ok(!busy.accepted && busy.reason === "rate_limited");
	// A newer push of the lane whose preview is running queues behind it.
	await new Promise((r) => setTimeout(r, 0)); // the drain starts job 1
	deepStrictEqual(p.queue.list().map((j) => j.state), ["running"]);
	const newer = p.queue.submit(
		job(3, "preview", { principal: "a_one", laneId: lane }),
	);
	ok(newer.accepted, JSON.stringify(newer));
	const newest = p.queue.submit(
		job(4, "preview", { principal: "a_one", laneId: lane }),
	);
	ok(newest.accepted);
	deepStrictEqual(
		p.queue.list().filter((j) => j.principal === "a_one").map((j) => [
			j.inputKey,
			j.state,
		]),
		[[KEY(1), "running"], [KEY(4), "queued"]],
	);
	// A queued request of a lane is replaced by the latest one.
	const q = harness("preview", { exec: () => new Promise(() => {}) });
	ok(q.queue.submit(job(10, "preview", { principal: "a_hog" })).accepted); // runs
	ok(
		q.queue.submit(job(11, "preview", { principal: "a_two", laneId: lane }))
			.accepted,
	);
	ok(
		q.queue.submit(job(12, "preview", { principal: "a_two", laneId: lane }))
			.accepted,
	);
	deepStrictEqual(
		q.queue.list().filter((j) => j.principal === "a_two").map((j) =>
			j.inputKey
		),
		[KEY(12)],
	);
	// A full queue answers rate_limited.
	const full = harness("preview", { exec: () => new Promise(() => {}) });
	for (let i = 0; i < REPO_CONFIG_LIMITS.previewQueue; i++) {
		ok(
			full.queue.submit(job(100 + i, "preview", { principal: `a_p${i}` }))
				.accepted,
			`${i}`,
		);
	}
	const over = full.queue.submit(job(999, "preview", { principal: "a_late" }));
	ok(!over.accepted && over.reason === "rate_limited");
	// The hourly budget per principal.
	const budget = harness("preview");
	for (let i = 0; i < REPO_CONFIG_LIMITS.previewsPerHour; i++) {
		ok(
			budget.queue.submit(job(200 + i, "preview", { principal: "a_b" }))
				.accepted,
		);
		await budget.settle();
	}
	const spent = budget.queue.submit(job(300, "preview", { principal: "a_b" }));
	ok(!spent.accepted && spent.reason === "rate_limited");
	budget.advance(60 * 60 * 1000);
	ok(budget.queue.submit(job(301, "preview", { principal: "a_b" })).accepted);
});

Deno.test("a flood of slow previews never delays a trunk evaluation (separate sandboxes)", async () => {
	const previews = harness("preview", { exec: () => new Promise(() => {}) });
	for (let i = 0; i < 20; i++) {
		previews.queue.submit(job(500 + i, "preview", { principal: `a_${i}` }));
	}
	const trunk = harness("trunk");
	const started = Date.now();
	ok(trunk.queue.submit(job(1, "trunk")).accepted);
	await trunk.settle();
	equal(trunk.deliveries.length, 1);
	ok(Date.now() - started < REPO_CONFIG_LIMITS.deadlineWarmMs);
	// The two cue sandboxes stay outside the job-slot semaphore, whose total
	// keeps CI below the container cap (wrangler.jsonc max_instances 20).
	ok(JOB_SLOT_DEFAULTS.total + 2 <= 20);
});

Deno.test("no container: unavailable at once; a failing exec delivers EVALUATOR_UNAVAILABLE", async () => {
	const off = harness("trunk", { available: false });
	const answer = off.queue.submit(job(1, "trunk"));
	ok(!answer.accepted && answer.reason === "unavailable");
	const broken = harness("trunk", {
		exec: () => Promise.reject(new Error("start failed")),
	});
	ok(broken.queue.submit(job(2, "trunk")).accepted);
	await broken.settle();
	equal(broken.deliveries.length, 1);
	const env = broken.deliveries[0].envelope;
	ok(!isEvalOk(env) && env.error.code === "EVALUATOR_UNAVAILABLE");
	const big = harness("trunk");
	const tooLarge = big.queue.submit(job(3, "trunk", {
		request: {
			...job(3, "trunk").request,
			files: { "~tartan.cue": "x", "a.cue": "x".repeat(800 * 1024) },
		},
	}));
	ok(!tooLarge.accepted && tooLarge.reason === "too_large");
	const bad = harness("trunk").queue.submit(job(4, "trunk", {
		request: { ...job(4, "trunk").request, files: { "../escape.cue": "x" } },
	}));
	ok(!bad.accepted && bad.reason === "too_large");
});

Deno.test("a CUE error is classified by the job's own result line", async () => {
	const h = harness("trunk", { exec: () => Promise.resolve(result(1)) });
	h.queue.submit(job(1, "trunk"));
	await h.settle();
	const env = h.deliveries[0].envelope;
	ok(!isEvalOk(env));
	if (!isEvalOk(env)) {
		equal(env.error.code, "BUILD_VALUE");
		deepStrictEqual(env.issues[0].pos, ["a.cue:3:4"]);
	}
});

Deno.test("the evaluator sandboxes always have container instances: job slots never reach max_instances (ADR 'When and where evaluation runs')", async () => {
	// `cue:trunk` and `cue:preview:<k>` take no job slot; the forge-wide job
	// semaphore stays below the container class's max_instances by at least
	// those sandboxes, so saturated CI never takes the trunk evaluator's
	// instance (with headroom for kernel git jobs and the lane self-test).
	const wrangler = await Deno.readTextFile(
		new URL("../../../wrangler.jsonc", import.meta.url),
	);
	const block = /"class_name":\s*"TartanSandbox"[^}]*"max_instances":\s*(\d+)/
		.exec(wrangler);
	ok(block, "the TartanSandbox container block names max_instances");
	const maxInstances = Number(block![1]);
	const evaluators = 1 + REPO_CONFIG_LIMITS.previewSandboxes;
	ok(
		JOB_SLOT_DEFAULTS.total + evaluators < maxInstances,
		`${JOB_SLOT_DEFAULTS.total} job slots + ${evaluators} evaluators < ${maxInstances}`,
	);
	ok(JOB_SLOT_DEFAULTS.ci < JOB_SLOT_DEFAULTS.total);
});

Deno.test("the runner image and CI pin the contract's cue release with the same sha256", async () => {
	const read = (path: string) =>
		Deno.readTextFile(new URL(`../../../${path}`, import.meta.url));
	const dockerfile = await read("containers/runner/Dockerfile");
	const workflow = await read(".github/workflows/ci.yml");
	const arg = (name: string) =>
		new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(dockerfile)?.[1];
	const env = (name: string) =>
		new RegExp(`^\\s+${name}: (\\S+)$`, "m").exec(workflow)?.[1];
	equal(arg("CUE_VERSION"), CUE_VERSION);
	equal(env("CUE_VERSION"), CUE_VERSION);
	match(arg("CUE_SHA256_AMD64") ?? "", /^[0-9a-f]{64}$/);
	match(arg("CUE_SHA256_ARM64") ?? "", /^[0-9a-f]{64}$/);
	// GitHub's runners are amd64: the workflow checks the image's amd64 pin.
	equal(env("CUE_SHA256"), arg("CUE_SHA256_AMD64"));
	ok(CUE_EVALUATOR_ID.startsWith(`cue@${CUE_VERSION}/`));
});

/** The error code of an envelope (undefined for ok). */
const codeOf = (e: EvalResponse | undefined): string | undefined =>
	e === undefined || isEvalOk(e) ? undefined : e.error.code;

Deno.test("an input that crashes the evaluator twice while other inputs evaluate is answered LIMIT_EXCEEDED, cacheably", async () => {
	/** The tartan.cue of the bundle the exec runs. */
	const running = () => {
		const bundle = JSON.parse(h.writes.at(-1)!.content);
		return atob(bundle.files["tartan.cue"]);
	};
	const h: ReturnType<typeof harness> = harness("trunk", {
		exec: () =>
			running().includes("x: 1\n")
				? Promise.reject(new Error("container exited (OOM)"))
				: Promise.resolve(result()),
	});
	equal(h.queue.submit(job(1, "trunk")).accepted, true);
	await h.settle();
	equal(codeOf(h.deliveries.at(-1)?.envelope), "EVALUATOR_UNAVAILABLE");
	h.advance(60_000);
	equal(h.queue.submit(job(2, "trunk")).accepted, true);
	await h.settle();
	ok(isEvalOk(h.deliveries.at(-1)!.envelope), "another input evaluates");
	h.advance(60_000);
	equal(h.queue.submit(job(1, "trunk")).accepted, true);
	await h.settle();
	const last = h.deliveries.at(-1)!;
	equal(last.key, KEY(1));
	equal(codeOf(last.envelope), "LIMIT_EXCEEDED");
	match(JSON.stringify(last.envelope), /crashed on this input 2 times/);
});

Deno.test("an outage (every input fails) is never mistaken for a poison input", async () => {
	const h = harness("trunk", {
		exec: () => Promise.reject(new Error("containers unavailable")),
	});
	for (let i = 0; i < 4; i++) {
		h.advance(60_000);
		equal(h.queue.submit(job(1, "trunk")).accepted, true);
		await h.settle();
		equal(codeOf(h.deliveries.at(-1)?.envelope), "EVALUATOR_UNAVAILABLE");
	}
});
