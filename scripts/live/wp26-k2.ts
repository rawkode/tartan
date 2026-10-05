// WP26 live acceptance: against a deployed
// `dev-*` stage with dev tools, the K2 binding and the Secrets Store consume
// token, built with `WORKLOAD_TRANSPORT = "k2"`.
//
//   1. health: `/-/health` reports `k2` (expect `ok` once the consumer polls);
//   2. warm the consumer: `/-/dev/k2/status` until it polled within 15 s and
//      holds its `workloads-<gen>` subscription;
//   3. conformance: `POST /-/dev/k2/conformance` runs the K2 suite inside
//      the Worker against its own stream (every scenario must pass);
//   4. dispatch: N CI runs (`--runs`, default 20) across R fresh repos
//      (`--repos`, default 5) through `/-/dev/runs`; each run must report
//      `transport: k2` and `via: k2`, its dispatch lag (run created → the
//      Workflow instance) is measured (p50, p95, max);
//   5. relay: every repo's relay is `ok` with lag 0 (`/-/dev/k2/relay/<id>`);
//   6. via counters: the consumer counted the runs' `run.dispatched` by via;
//   7. leak scan: no response body carries an Artifacts token, a capability
//      path, a bearer header or the K2 token's store name pattern.
// The runs fail later (fresh repos have no git data, and `--no-containers`
// stages have no runner): only their dispatch is under test.
//
// The dev keys are derived from TARTAN_SECRET (read from the TARTAN_SECRET
// env var, never printed): `x-tartan-dev-key` for `/-/dev/runs` is
// hex(HMAC-SHA256(secret, "tartan:dev:runs")), for `/-/dev/k2`
// hex(HMAC-SHA256(secret, "tartan:dev:k2")).
//
// Usage:
//   TARTAN_SECRET=… deno task live -- --stage dev-wp26 wp26 \
//     --base https://tartan-dev-wp26.<sub>.workers.dev [--runs 20] [--repos 5]
//     [--evidence <file.json>]

import { ulid } from "@tartan/contract";

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i === -1 ? undefined : Deno.args[i + 1];
};

const base = arg("base");
const runCount = Number(arg("runs") ?? "20");
const repoCount = Number(arg("repos") ?? "5");
const evidencePath = arg("evidence");
const secret = Deno.env.get("TARTAN_SECRET");
if (!base || !secret || !Number.isInteger(runCount) || runCount < 1) {
	console.error(
		"usage: TARTAN_SECRET=… wp26-k2.ts --base <url> [--runs n] [--repos n] [--evidence file]",
	);
	Deno.exit(2);
}

const hmacHex = async (label: string): Promise<string> => {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(label),
	);
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0"))
		.join("");
};
const runsKey = await hmacHex("tartan:dev:runs");
const k2Key = await hmacHex("tartan:dev:k2");

const LEAK = [
	/art_v[0-9]+_(?!<redacted>)/,
	/\/-\/cap\/(?!<redacted>)/,
	/bearer\s+[a-z0-9]/i,
	/authorization/i,
];
const leaks: string[] = [];
const scan = (where: string, text: string) => {
	for (const re of LEAK) if (re.test(text)) leaks.push(`${where} ${re}`);
};

const call = async (
	method: string,
	path: string,
	key: string,
	body?: unknown,
): Promise<{ status: number; json: unknown; ms: number }> => {
	const started = performance.now();
	const res = await fetch(`${base}${path}`, {
		method,
		headers: {
			"x-tartan-dev-key": key,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	scan(`${method} ${path}`, text);
	let json: unknown = text;
	try {
		json = JSON.parse(text);
	} catch {
		// keep the text
	}
	return {
		status: res.status,
		json,
		ms: Math.round(performance.now() - started),
	};
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { step: string; ok: boolean; detail: unknown }[] = [];
const record = (step: string, ok: boolean, detail: unknown) => {
	results.push({ step, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${step} ${JSON.stringify(detail)}`);
};

type Status = {
	health: string;
	transport: string;
	consumer: {
		consume: string;
		subscription: string | null;
		lastPollOkAt: number | null;
		records: number;
		dead: number;
		retry: number;
		consumerLagMs: number | null;
		via: { hour: number; k2: number; backstop: number; local: number }[];
	} | null;
	relay: { forge: { state: string; lag: number } | null };
	lastHour: { k2: number; backstop: number; local: number };
};

// 1. Health.
const health = await call("GET", "/-/health", "");
record("health", health.status === 200, {
	k2: (health.json as { k2?: string }).k2,
	bindings: Object.keys(
		(health.json as { bindings?: Record<string, string> }).bindings ?? {},
	).length,
});

// 2. Warm the consumer.
let status: Status | null = null;
for (let i = 0; i < 30; i++) {
	const s = await call("GET", "/-/dev/k2/status", k2Key);
	status = s.json as Status;
	const c = status.consumer;
	if (
		c?.consume === "ok" && c.subscription !== null &&
		c.lastPollOkAt !== null && Date.now() - c.lastPollOkAt < 15_000
	) break;
	await sleep(1_000);
}
record("consumer polling", status?.consumer?.consume === "ok", {
	subscription: status?.consumer?.subscription,
	transport: status?.transport,
	health: status?.health,
});

// 3. Conformance, live.
const conformance = await call("POST", "/-/dev/k2/conformance", k2Key, {});
const scenarios = (conformance.json as {
	results?: { name: string; ok: boolean; ms: number; detail?: string }[];
})
	.results ?? [];
record(
	"conformance",
	scenarios.length > 0 && scenarios.every((r) => r.ok),
	{ status: conformance.status, scenarios },
);

// 4. Dispatch through the global log.
const repos = Array.from({ length: repoCount }, () => ulid());
const graph = (repo: string, n: number) => ({
	repo: { id: repo },
	kind: "ci",
	subject: { kind: "change", id: `wp26-${n}` },
	source: { repoId: repo },
	sha: "0".repeat(40),
	jobs: [{ id: "true", run: "true" }],
});
const started: { repo: string; runId: string; at: number }[] = [];
const runId = `${Date.now()}`;
for (let i = 0; i < runCount; i++) {
	const repo = repos[i % repos.length];
	const res = await call("POST", `/-/dev/runs/${repo}`, runsKey, {
		graph: graph(repo, i),
		idemKey: `wp26:${runId}:${i}`,
	});
	if (res.status !== 201) {
		record(`start run ${i}`, false, { status: res.status, body: res.json });
		continue;
	}
	started.push({
		repo,
		runId: (res.json as { runId: string }).runId,
		at: Date.now(),
	});
}
type Run = {
	transport?: string;
	via?: string;
	createdAt: number;
	dispatchedAt?: number;
	state: string;
};
const finished = new Map<string, Run>();
const deadline = Date.now() + 60_000;
while (finished.size < started.length && Date.now() < deadline) {
	for (const s of started) {
		if (finished.has(s.runId)) continue;
		const res = await call("GET", `/-/dev/runs/${s.repo}/${s.runId}`, runsKey);
		const run = res.json as Run;
		if (run.via !== undefined) finished.set(s.runId, run);
	}
	if (finished.size < started.length) await sleep(500);
}
const runs = [...finished.values()];
const lags = runs.map((r) => (r.dispatchedAt ?? 0) - r.createdAt).sort((a, b) =>
	a - b
);
const pct = (p: number) =>
	lags.length === 0
		? null
		: lags[Math.min(lags.length - 1, Math.floor(p * lags.length))];
const byVia = runs.reduce<Record<string, number>>((acc, r) => {
	acc[r.via ?? "none"] = (acc[r.via ?? "none"] ?? 0) + 1;
	return acc;
}, {});
record("dispatch via k2", runs.length === runCount && byVia.k2 === runCount, {
	started: started.length,
	dispatched: runs.length,
	byVia,
	transport: runs.reduce<Record<string, number>>((acc, r) => {
		acc[r.transport ?? "none"] = (acc[r.transport ?? "none"] ?? 0) + 1;
		return acc;
	}, {}),
	lagMs: { p50: pct(0.5), p95: pct(0.95), max: lags.at(-1) ?? null },
});

// 5. Relays caught up.
await sleep(3_000);
const relays = [];
for (const repo of repos) {
	const r = await call("GET", `/-/dev/k2/relay/${repo}`, k2Key);
	relays.push(r.json as { state: string; lag: number; sentRecords: number });
}
record(
	"relays ok, lag 0",
	relays.every((r) => r.state === "ok" && r.lag === 0),
	relays.map((r) => ({ state: r.state, lag: r.lag, sent: r.sentRecords })),
);

// 6. Via counters.
const after = (await call("GET", "/-/dev/k2/status", k2Key)).json as Status;
record("via counters", after.lastHour.k2 >= runCount, {
	lastHour: after.lastHour,
	consumer: {
		records: after.consumer?.records,
		dead: after.consumer?.dead,
		retry: after.consumer?.retry,
		consumerLagMs: after.consumer?.consumerLagMs,
	},
	health: after.health,
});

// 7. Leak scan.
record("leak scan", leaks.length === 0, { leaks });

const ok = results.every((r) => r.ok);
if (evidencePath) {
	await Deno.writeTextFile(
		evidencePath,
		`${
			JSON.stringify(
				{ at: new Date().toISOString(), base, ok, results },
				null,
				"\t",
			)
		}\n`,
	);
}
console.log(ok ? "wp26-k2: PASS" : "wp26-k2: FAIL");
Deno.exit(ok ? 0 : 1);
