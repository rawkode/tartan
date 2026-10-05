// WP9 live acceptance (S7-rem): against a deployed dev stage
// with containers and dev tools (`TARTAN_STAGE ^dev`, `TARTAN_DEV_TOOLS=1`),
// on a repo whose canonical Artifacts repo holds the pnpm workspace fixture.
//
//   1. warm-up: `POST /-/health/warm` (the selftest sandbox; git, pnpm, users)
//   2. a 3-job CI run (install → lint, test) with live log lines; the lag from
//      a job printing `tick <epoch ms>` to the line showing in the logs API is
//      measured (acceptance: within 2 s)
//   3. cancel: a running run is cancelled; its state and job states follow
//   4. supersede: a second run in the same concurrency group supersedes the first
//   5. timeout: a job over its `timeoutMs` is killed by the watchdog
//      (`Container.schedule()`, 60 s) and fails with a timeout
//
// Every response body is scanned for `art_v<n>_` tokens and unredacted
// `/-/cap/` paths. Runs are started and read through the dev-only route
// `/-/dev/runs` (no session or token, any setup state), authorized by the dev
// key (`x-tartan-dev-key`) = hex(HMAC-SHA256(TARTAN_SECRET,
// "tartan:dev:runs")), read from the TARTAN_DEV_KEY env var; it is never
// printed.
//
// Usage:
//   TARTAN_DEV_KEY=… deno task live -- --stage dev-wp09 wp09 \
//     --base https://tartan-dev-wp09.<sub>.workers.dev --repo <repoUlid> --sha <sha>
//     [--only warm,run,cancel,supersede,timeout]

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i === -1 ? undefined : Deno.args[i + 1];
};

const base = arg("base");
const repo = arg("repo");
const sha = arg("sha");
const only = new Set(
	(arg("only") ?? "warm,run,cancel,supersede,timeout").split(","),
);
const key = Deno.env.get("TARTAN_DEV_KEY");
if (!base || !repo || !sha || !key) {
	console.error(
		"usage: TARTAN_DEV_KEY=… wp09-runs.ts --base <url> --repo <ulid> --sha <sha>",
	);
	Deno.exit(2);
}

const LEAK = [/art_v[0-9]+_(?!<redacted>)/, /\/-\/cap\/(?!<redacted>)/];
const leaks: string[] = [];
const scan = (where: string, text: string) => {
	for (const re of LEAK) if (re.test(text)) leaks.push(where);
};

const api = async (
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; json: unknown }> => {
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
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = text;
	}
	return { status: res.status, json };
};

type Run = {
	runId: string;
	state: string;
	jobs: { jobId: string; state: string; exitCode?: number }[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set([
	"success",
	"failure",
	"cancelled",
	"superseded",
	"error",
]);

const getRun = async (runId: string): Promise<Run> =>
	(await api("GET", `/-/dev/runs/${repo}/${runId}`)).json as Run;

const waitRun = async (
	runId: string,
	until: (run: Run) => boolean,
	timeoutMs: number,
): Promise<Run> => {
	const start = Date.now();
	while (true) {
		const run = await getRun(runId);
		if (until(run)) return run;
		if (Date.now() - start > timeoutMs) {
			throw new Error(`run ${runId} still ${run.state} after ${timeoutMs} ms`);
		}
		await sleep(1000);
	}
};

const graph = (
	jobs: unknown[],
	extra: Record<string, unknown> = {},
) => ({
	repo: { id: repo },
	kind: "ci",
	subject: { kind: "change", id: "wp09-live" },
	source: { repoId: repo },
	sha,
	jobs,
	...extra,
});

const start = async (g: unknown, idemKey: string): Promise<string> => {
	const res = await api("POST", `/-/dev/runs/${repo}`, { graph: g, idemKey });
	if (res.status !== 201) {
		throw new Error(`start failed: ${res.status} ${JSON.stringify(res.json)}`);
	}
	return (res.json as { runId: string }).runId;
};

const evidence: Record<string, unknown> = { at: new Date().toISOString() };
const stamp = Date.now().toString(36);

if (only.has("warm")) {
	const t0 = Date.now();
	let res = await api("POST", "/-/health/warm");
	while (
		res.status !== 200 && res.status !== 429 && Date.now() - t0 < 180_000
	) {
		await sleep(5000);
		res = await api("POST", "/-/health/warm");
	}
	evidence.warm = { status: res.status, ms: Date.now() - t0, body: res.json };
	console.log("warm", res.status, Date.now() - t0, "ms");
}

if (only.has("run")) {
	const ticker =
		"node -e \"let i=0;const t=setInterval(()=>{console.log('tick '+Date.now());if(++i===10){clearInterval(t)}},1000)\" && pnpm test";
	const runId = await start(
		graph([
			{ id: "install", run: "pnpm install" },
			{ id: "lint", needs: ["install"], run: "pnpm lint" },
			{ id: "test", needs: ["install"], run: ticker },
		]),
		`run-${stamp}`,
	);
	const t0 = Date.now();
	const lags: number[] = [];
	const seen = new Set<string>();
	let run = await getRun(runId);
	while (!TERMINAL.has(run.state) && Date.now() - t0 < 600_000) {
		const log = await api(
			"GET",
			`/-/dev/runs/${repo}/${runId}/jobs/test/log`,
		);
		const text = (log.json as { text?: string }).text ?? "";
		const now = Date.now();
		for (const m of text.matchAll(/tick (\d{13})/g)) {
			if (seen.has(m[1])) continue;
			seen.add(m[1]);
			lags.push(now - Number(m[1]));
		}
		await sleep(250);
		run = await getRun(runId);
	}
	const logs: Record<string, string> = {};
	for (const job of run.jobs) {
		const log = await api(
			"GET",
			`/-/dev/runs/${repo}/${runId}/jobs/${job.jobId}/log?tail=4096`,
		);
		logs[job.jobId] = (log.json as { text: string }).text;
	}
	const sorted = [...lags].sort((a, b) => a - b);
	evidence.run = {
		runId,
		state: run.state,
		jobs: run.jobs,
		wallMs: Date.now() - t0,
		tickLagMs: {
			n: sorted.length,
			p50: sorted[Math.floor(sorted.length / 2)],
			max: sorted.at(-1),
		},
		logs,
	};
	console.log("run", run.state, JSON.stringify(evidence.run, null, 1));
}

const sleeper = (id: string, seconds: number, extra: object = {}) => ({
	id,
	run: `echo started; sleep ${seconds}; echo done`,
	...extra,
});

if (only.has("cancel")) {
	const runId = await start(graph([sleeper("long", 600)]), `cancel-${stamp}`);
	await waitRun(
		runId,
		(r) => r.jobs.some((j) => j.state === "running"),
		300_000,
	);
	const t0 = Date.now();
	const res = await api("POST", `/-/dev/runs/${repo}/${runId}/cancel`);
	const run = await getRun(runId);
	evidence.cancel = {
		runId,
		status: res.status,
		cancelMs: Date.now() - t0,
		state: run.state,
		jobs: run.jobs,
	};
	console.log("cancel", JSON.stringify(evidence.cancel));
}

if (only.has("supersede")) {
	const g = graph([sleeper("long", 600)], {
		concurrencyGroup: `wp09-${stamp}`,
	});
	const first = await start(g, `sup1-${stamp}`);
	await waitRun(
		first,
		(r) => r.jobs.some((j) => j.state === "running"),
		300_000,
	);
	const second = await start(
		graph([{ id: "quick", run: "echo quick" }], {
			concurrencyGroup: `wp09-${stamp}`,
		}),
		`sup2-${stamp}`,
	);
	const firstRun = await getRun(first);
	const secondRun = await waitRun(
		second,
		(r) => TERMINAL.has(r.state),
		300_000,
	);
	evidence.supersede = {
		first: { runId: first, state: firstRun.state, jobs: firstRun.jobs },
		second: { runId: second, state: secondRun.state },
	};
	console.log("supersede", JSON.stringify(evidence.supersede));
}

if (only.has("timeout")) {
	const runId = await start(
		graph([sleeper("slow", 300, { timeoutMs: 20_000 })]),
		`timeout-${stamp}`,
	);
	const t0 = Date.now();
	const run = await waitRun(runId, (r) => TERMINAL.has(r.state), 300_000);
	const log = await api("GET", `/-/dev/runs/${repo}/${runId}/jobs/slow/log`);
	evidence.timeout = {
		runId,
		state: run.state,
		jobs: run.jobs,
		endedAfterMs: Date.now() - t0,
		log: (log.json as { text: string }).text,
	};
	console.log("timeout", JSON.stringify(evidence.timeout));
}

// U50: a silent keepAlive job of N minutes completes with its log and
// completion event (`--only silent --silent-minutes 5`).
if (only.has("silent")) {
	const minutes = Number(arg("silent-minutes") ?? "5");
	const runId = await start(
		graph([
			sleeper("silent", minutes * 60, { timeoutMs: (minutes + 5) * 60_000 }),
		]),
		`silent-${stamp}`,
	);
	const t0 = Date.now();
	const run = await waitRun(
		runId,
		(r) => TERMINAL.has(r.state),
		(minutes + 10) * 60_000,
	);
	const log = await api("GET", `/-/dev/runs/${repo}/${runId}/jobs/silent/log`);
	evidence.silent = {
		minutes,
		runId,
		state: run.state,
		jobs: run.jobs,
		endedAfterMs: Date.now() - t0,
		log: (log.json as { text: string }).text,
	};
	console.log("silent", JSON.stringify(evidence.silent));
}

evidence.leaks = leaks;
console.log(JSON.stringify(evidence, null, "\t"));
if (leaks.length > 0) {
	console.error("LEAK in", leaks.join(", "));
	Deno.exit(1);
}
