// WP23 live acceptance (ADR repo config "Testing", Live):
// the repository-config evaluator sandboxes (`cue:trunk`, `cue:preview:<k>`)
// of a deployed dev stage with containers and dev tools, measured on the
// production runtime through the dev-only probe route `POST /-/dev/cue`
// (src/kernel/runs/cueprobe.ts; fixed probes only, no sign-in):
//
//   0. the deployed job answers a valid case on both sandboxes first;
//   1. info: the instance (architecture, CPUs, memory, the cgroup limit, the
//      runner record, `tartan-git`'s limits) of both sandboxes;
//   2. net: DNS and TCP from both sandboxes, as root and as `tartan-git`,
//      must all fail (`enableInternet: false`);
//   3. valid: the corpus's valid case and the demo monorepo's package
//      tartan, each byte-equal (sha256 of the exported JSON) to a local
//      `cue export` of the same files (`CUE_BIN`, the oracle);
//   4. invalid: the invalid cases give BUILD_VALUE with `file:line:col`
//      positions, equal to the local CLI evaluator's issues;
//   5. comprehension and doubling: stopped within the 10 s KILL;
//   6. RLIMIT_AS: doubling with a 60 s clock must end LIMIT_EXCEEDED
//      ("address-space limit reached"), never the clock or the OOM killer;
//   7. flood: the corpus's 5,000 errors end LIMIT_EXCEEDED or BUILD_VALUE
//      with the error text capped; 50,000 are stopped by the KILL;
//      an export over the 4 MiB file cap is LIMIT_EXCEEDED with no job path;
//   8. OOM: 32 doublings without RLIMIT_AS: PID 1 keeps its start time and
//      the control server answers after it on both sandboxes, and the OOM
//      killer, which fires on at least one, takes only cue (kernel log);
//   9. after every pathological case the sandbox evaluates the valid case;
//  10. timings: warm p50/p95 (n = --warm) of the valid case and the demo
//      config on `cue:trunk`, and cold ones (n = --cold) on fresh
//      `cue:preview:<k>` sandboxes (k from --cold-base), as the client saw
//      them;
//  11. leak scan: no answer carries an Artifacts token, a capability path,
//      a bearer header, the secret or the dev key.
//
// The dev key `x-tartan-dev-key` = hex(HMAC-SHA256(TARTAN_SECRET,
// "tartan:dev:cue")) is derived from the TARTAN_SECRET env var (never
// printed). CUE_BIN is cue v0.17.1 (without it the oracle checks fail).
//
//   TARTAN_SECRET=… CUE_BIN=… deno task live -- --stage dev-wp23 wp23 \
//     --base https://tartan-dev-wp23.<sub>.workers.dev \
//     [--warm 20] [--cold 5] [--cold-base 20] [--evidence <file.json>]
//
// Exit code 0 only when every check passes.

import { createHash } from "node:crypto";
import {
	CUE_EVAL_CONTRACT,
	CUE_EVALUATOR_ID,
	CUE_JOB_VERSION,
	DEFAULT_EVAL_LIMITS,
	type EvalLimits,
	isEvalOk,
	REPO_CONFIG_LIMITS,
	REPO_CONFIG_POSITION_RE,
} from "../../packages/contract/src/index.ts";
import { MONOREPO_TARTAN_FILES } from "../../packages/testkit/src/index.ts";
import { createCliEvaluator } from "../../src/kernel/repoconfig/evaluators/cli.ts";
import {
	caseFiles,
	CORPUS_SCHEMA,
	cueBin,
	oracleExport,
} from "../../src/kernel/repoconfig/testing/corpus.ts";
import {
	type CueProbeResult,
	DEV_CUE_KEY_LABEL,
	PROBE_ISSUES,
} from "../../src/kernel/runs/cueprobe.ts";

// ---------------------------------------------------------------------------
// Pure helpers (tested in wp23-cue.test.ts)
// ---------------------------------------------------------------------------

/** The nearest-rank percentile of `values` (`p` in 0–100). */
export const percentile = (values: readonly number[], p: number): number => {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
};

export type NetReport = {
	/** `<who> <check>` → exit status, e.g. `content tcp443` → 124. */
	readonly checks: Readonly<Record<string, number>>;
	/** Interface names, and whether any is not loopback. */
	readonly interfaces: readonly string[];
	/** Every check failed (non-zero), and all six were reported. */
	readonly blocked: boolean;
};

const NET_LINE = /^(root|content) (dns|tcp443|tcp53)=(\d+)$/;

/** Parses the `net` probe's output (`CUE_PROBE_COMMANDS.net`). */
export const parseNet = (output: string): NetReport => {
	const checks: Record<string, number> = {};
	const interfaces = new Set<string>();
	let after = false;
	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (line === "---") {
			after = true;
			continue;
		}
		const m = NET_LINE.exec(line);
		if (m !== null) {
			checks[`${m[1]} ${m[2]}`] = Number(m[3]);
		} else if (after && line !== "") {
			interfaces.add(line.split(" ")[0]);
		}
	}
	const values = Object.values(checks);
	return {
		checks,
		interfaces: [...interfaces].sort(),
		blocked: values.length === 6 && values.every((v) => v !== 0),
	};
};

/** The `info` probe's output, reduced to what the evidence needs. */
export const parseInfo = (output: string) => {
	const parts = output.split(/\n?---\n?/).map((p) => p.trim());
	const memTotal = /MemTotal:\s+(\d+) kB/.exec(parts[2] ?? "");
	let runner: Record<string, unknown> | null = null;
	try {
		runner = JSON.parse(parts[4] ?? "") as Record<string, unknown>;
	} catch {
		runner = null;
	}
	return {
		arch: parts[0] ?? "",
		cpus: Number(parts[1] ?? Number.NaN),
		memTotalKiB: memTotal === null ? null : Number(memTotal[1]),
		cgroupMemoryMax: parts[3] ?? "",
		runner,
		contentLimits: (parts[5] ?? "").split("\n").filter((l) =>
			/virtual memory|max user processes|file size|core file size|open files/
				.test(l)
		),
	};
};

/** What the `oom` probe read around the job (`CUE_PROBE_COMMANDS.victim`). */
export const parseVictim = (output: string) => {
	const before = /^pid1-start-before: *(\S*)/m.exec(output)?.[1] ?? "";
	const [log = "", tail = ""] = output.replace(/^pid1-start-before:.*\n?/m, "")
		.split(/\n?---\n/);
	const [after = "", pid1 = ""] = tail.trim().split("\n");
	const killed = [
		...log.matchAll(/Killed process \d+ \(([^)]+)\)|task=([^,\s]+)/g),
	].map((m) => m[1] ?? m[2]);
	return {
		before,
		after: after.trim(),
		pid1: pid1.trim(),
		killed: [...new Set(killed)],
	};
};

/** The corpus's string doubling, to 2^`steps` bytes. */
export const doublingTo = (steps: number): string => {
	const lines = ["package tartan", "", '_s0: "x"'];
	for (let k = 1; k <= steps; k++) {
		lines.push(`_s${k}: _s${k - 1} + _s${k - 1}`);
	}
	lines.push(
		"",
		`extensions: "acme.no-secrets": settings: allow: [_s${steps}]`,
	);
	return `${lines.join("\n")}\n`;
};

/** The JSON a value exports to, as the probe digests it. */
export const valueDigest = (value: unknown): string =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** A position in a root file or in the forge schema's files (`cue.mod/…`). */
export const ANY_POSITION_RE =
	/^(?:cue\.mod\/[A-Za-z0-9_.\/-]+|[A-Za-z0-9_.~-]+)\.cue:\d+:\d+$/;

export const LEAK_PATTERNS: readonly RegExp[] = [
	/art_v[0-9]+_(?!<redacted>)/,
	/\/-\/cap\/(?!<redacted>)/,
	/bearer\s+[a-z0-9]/i,
	/authorization:/i,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** The leak patterns, and the given secrets, found in `text`. */
export const leaksIn = (
	text: string,
	secrets: readonly string[],
): string[] => [
	...LEAK_PATTERNS.filter((re) => re.test(text)).map((re) => String(re)),
	...secrets.filter((s) => s.length >= 16 && text.includes(s)).map(() =>
		"a secret value"
	),
];

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i === -1 ? undefined : Deno.args[i + 1];
};

type Check = { name: string; ok: boolean; detail: string };

const hmacHex = async (secret: string, label: string): Promise<string> => {
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

const main = async () => {
	const base = arg("base")?.replace(/\/+$/, "");
	const secret = Deno.env.get("TARTAN_SECRET");
	const warmN = Number(arg("warm") ?? "20");
	const coldN = Number(arg("cold") ?? "5");
	const coldBase = Number(arg("cold-base") ?? "20");
	const evidencePath = arg("evidence");
	if (
		!base || !secret || !Number.isInteger(warmN) || !Number.isInteger(coldN)
	) {
		console.error(
			"usage: TARTAN_SECRET=… CUE_BIN=… wp23-cue.ts --base <url> [--warm n] [--cold n] [--evidence file]",
		);
		Deno.exit(2);
	}
	const key = await hmacHex(secret, DEV_CUE_KEY_LABEL);
	const bin = cueBin();
	const checks: Check[] = [];
	const leaks: string[] = [];
	const evidence: Record<string, unknown> = {
		base,
		startedAt: new Date().toISOString(),
		evaluator: CUE_EVALUATOR_ID,
		contract: CUE_EVAL_CONTRACT,
		oracle: bin === null ? null : "CUE_BIN (cue v0.17.1)",
	};
	const check = (name: string, ok: boolean, detail: string) => {
		checks.push({ name, ok, detail });
		console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
	};

	type Answer = {
		status: number;
		wallMs: number;
		body: CueProbeResult & { error?: { code: string; message: string } };
	};
	const probe = async (
		sandbox: string,
		body: Record<string, unknown>,
	): Promise<Answer> => {
		const started = performance.now();
		const res = await fetch(`${base}/-/dev/cue`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-tartan-dev-key": key,
			},
			body: JSON.stringify({ sandbox, ...body }),
			signal: AbortSignal.timeout(420_000),
		});
		const text = await res.text();
		const wallMs = Math.round(performance.now() - started);
		for (const leak of leaksIn(text, [secret, key])) {
			leaks.push(`${sandbox} ${String(body.probe)}: ${leak}`);
		}
		let parsed: Answer["body"];
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = {
				error: { code: "NOT_JSON", message: text.slice(0, 200) },
			} as Answer["body"];
		}
		return { status: res.status, wallMs, body: parsed };
	};
	const files = async (name: string) => ({
		...CORPUS_SCHEMA.files,
		...(await caseFiles(name)),
	});
	const demoFiles = { ...CORPUS_SCHEMA.files, ...MONOREPO_TARTAN_FILES };
	const floodOf = (n: number) => ({
		...CORPUS_SCHEMA.files,
		"tartan.cue":
			`package tartan\n\nimport "list"\n\nextensions: "acme.no-secrets": settings: {\n\tfor i in list.Range(0, ${n}, 1) {"k\\(i)": i}\n}\n`,
	});

	const evalCase = (
		sandbox: string,
		f: Readonly<Record<string, string>>,
		limits: Partial<EvalLimits> = {},
		kind: "case" | "oom" = "case",
	) => probe(sandbox, { probe: kind, files: f, limits });
	const brief = (a: Answer) => {
		const r = a.body.result;
		return r === undefined
			? `HTTP ${a.status} ${a.body.error?.code ?? "?"}: ${
				a.body.error?.message ?? ""
			}`.slice(0, 300)
			: `${r.ok ? "ok" : r.code}${
				r.message ? ` (${r.message.slice(0, 80)})` : ""
			}, job ${
				r.jobMs ?? "?"
			} ms, exec ${a.body.ms} ms, wall ${a.wallMs} ms, healthy ${a.body.healthy}, warm ${a.body.warm}`;
	};
	const record: Record<string, unknown> = {};
	evidence.answers = record;
	const keep = (name: string, a: Answer) => {
		record[name] = { status: a.status, wallMs: a.wallMs, body: a.body };
	};

	const SANDBOXES = ["cue:trunk", "cue:preview:0"] as const;
	const valid = await files("valid");
	const oracleDigest = async (
		f: Readonly<Record<string, string>>,
	): Promise<string | null> => {
		if (bin === null) return null;
		const out = await oracleExport(bin, f, 120_000);
		if (out.code !== 0) return null;
		return valueDigest(JSON.parse(out.stdout));
	};
	const validDigest = await oracleDigest(valid);
	const demoDigest = await oracleDigest(demoFiles);
	evidence.oracle = { valid: validDigest, demo: demoDigest };

	const afterValid = async (sandbox: string, after: string) => {
		const a = await evalCase(sandbox, valid);
		keep(`${sandbox} valid after ${after}`, a);
		check(
			`${sandbox}: the valid case after ${after}`,
			a.body.result?.ok === true && a.body.result.sha256 === validDigest &&
				a.body.healthy === true,
			brief(a),
		);
	};

	// 0. The deployed job answers a valid case first, on each sandbox (a job
	// of another version would answer INTERNAL).
	for (const sandbox of SANDBOXES) {
		const a = await evalCase(sandbox, valid);
		keep(`${sandbox} first valid`, a);
		check(
			`${sandbox}: the deployed job (version ${CUE_JOB_VERSION}) evaluates the valid case`,
			a.body.result?.ok === true && a.body.healthy === true,
			brief(a),
		);
	}

	// 1–2. info and net.
	for (const sandbox of SANDBOXES) {
		const info = await probe(sandbox, { probe: "info" });
		keep(`${sandbox} info`, info);
		const parsed = parseInfo(info.body.output ?? "");
		evidence[`${sandbox} info`] = parsed;
		check(
			`${sandbox}: native amd64`,
			info.status === 200 && parsed.arch === "x86_64",
			`${parsed.arch}, ${parsed.cpus} CPUs, MemTotal ${parsed.memTotalKiB} KiB, memory.max ${parsed.cgroupMemoryMax}, cue ${
				String(parsed.runner?.cue ?? "?")
			}, cold ${!info.body.warm} (${info.wallMs} ms)`,
		);
		const net = await probe(sandbox, { probe: "net" });
		keep(`${sandbox} net`, net);
		const report = parseNet(net.body.output ?? "");
		evidence[`${sandbox} net`] = report;
		check(
			`${sandbox}: no outbound network (root and tartan-git)`,
			net.status === 200 && report.blocked,
			`${JSON.stringify(report.checks)}; interfaces ${
				report.interfaces.join(", ") || "none"
			}`,
		);
	}

	// 3. valid, byte-equal to the oracle.
	for (const sandbox of SANDBOXES) {
		const a = await evalCase(sandbox, valid);
		keep(`${sandbox} valid`, a);
		check(
			`${sandbox}: valid case byte-equal to the local cue export`,
			a.body.result?.ok === true && validDigest !== null &&
				a.body.result.sha256 === validDigest,
			`${brief(a)}; sha256 ${a.body.result?.sha256?.slice(0, 16)}… oracle ${
				validDigest?.slice(0, 16)
			}…`,
		);
	}
	{
		const a = await evalCase("cue:trunk", demoFiles);
		keep("cue:trunk demo", a);
		check(
			"cue:trunk: the demo monorepo's package tartan byte-equal to the local cue export",
			a.body.result?.ok === true && demoDigest !== null &&
				a.body.result.sha256 === demoDigest,
			`${brief(a)}; keys ${a.body.result?.keys?.join(",")}`,
		);
	}

	// 4. invalid, with positions equal to the local evaluator's.
	const local = bin === null ? null : createCliEvaluator({ cueBin: bin });
	for (const name of ["invalid", "invalid-closed"]) {
		const f = await files(name);
		const a = await evalCase("cue:trunk", f);
		keep(`cue:trunk ${name}`, a);
		const r = a.body.result;
		const positioned = r?.positioned ?? [];
		// Every position is `file:line:col` (the forge schema's files under
		// cue.mod/ included; CUE leaves some issues without one), and the
		// issues point into the repository's root files.
		const allPositioned = positioned.every((i) =>
			i.pos.every((p) => ANY_POSITION_RE.test(p))
		) &&
			positioned.some((i) =>
				i.pos.some((p) => REPO_CONFIG_POSITION_RE.test(p))
			);
		let sameAsLocal = false;
		if (local !== null) {
			const l = await local.evaluate({
				version: CUE_EVAL_CONTRACT,
				evaluator: CUE_EVALUATOR_ID,
				inputKey: "0".repeat(64),
				files: f,
				limits: DEFAULT_EVAL_LIMITS,
			});
			if (!isEvalOk(l)) {
				const want = l.issues.slice(0, PROBE_ISSUES.count).map((i) => ({
					path: i.path.slice(0, PROBE_ISSUES.path),
					pos: i.pos.slice(0, PROBE_ISSUES.positions),
					msg: i.msg.slice(0, PROBE_ISSUES.msg),
				}));
				sameAsLocal = l.error.code === r?.code &&
					l.issues.length === r?.issues &&
					JSON.stringify(want) === JSON.stringify(positioned);
			}
		}
		check(
			`cue:trunk: ${name} gives BUILD_VALUE with file:line:col positions equal to the local evaluator`,
			r?.ok === false && r.code === "BUILD_VALUE" && allPositioned &&
				sameAsLocal,
			`${brief(a)}; ${r?.issues} issues; first ${
				positioned.slice(0, 3).map((i) => `${i.path} @ ${i.pos.join(" ")}`)
					.join("; ")
			}; same as local ${sameAsLocal}`,
		);
	}

	// 5. comprehension and doubling within the 10 s KILL; then valid.
	const KILL_MS = REPO_CONFIG_LIMITS.wallClockS * 1000;
	for (const sandbox of SANDBOXES) {
		for (
			const name of ["pathological-comprehension", "pathological-doubling"]
		) {
			const a = await evalCase(sandbox, await files(name));
			keep(`${sandbox} ${name}`, a);
			const r = a.body.result;
			check(
				`${sandbox}: ${name} stopped within the 10 s KILL`,
				r?.ok === false &&
					(name === "pathological-comprehension"
						? r.code === "TIMEOUT"
						: r.code === "TIMEOUT" || r.code === "LIMIT_EXCEEDED") &&
					(r.jobMs ?? Infinity) <= KILL_MS + 1000 && a.body.healthy === true,
				brief(a),
			);
			await afterValid(sandbox, name);
		}
	}

	// 6. RLIMIT_AS: doubling with a 60 s clock (five times on trunk).
	const doubling = await files("pathological-doubling");
	for (let i = 0; i < 5; i++) {
		const a = await evalCase("cue:trunk", doubling, { wallClockS: 60 });
		keep(`cue:trunk doubling 60s #${i + 1}`, a);
		const r = a.body.result;
		check(
			`cue:trunk: doubling with a 60 s clock stopped by RLIMIT_AS (#${i + 1})`,
			r?.ok === false && r.code === "LIMIT_EXCEEDED" &&
				/address-space/.test(r.message ?? "") && a.body.healthy === true,
			brief(a),
		);
	}
	await afterValid("cue:trunk", "the RLIMIT_AS runs");

	// 7. flood: 5,000 errors end LIMIT_EXCEEDED or BUILD_VALUE inside
	// the clock with the error text capped; 50,000 errors run past the
	// clock, so the 10 s KILL stops them.
	for (const sandbox of SANDBOXES) {
		const a = await evalCase(sandbox, await files("flood"));
		keep(`${sandbox} flood`, a);
		const r = a.body.result;
		const text = JSON.stringify(a.body);
		check(
			`${sandbox}: flood ends LIMIT_EXCEEDED or BUILD_VALUE with the error text capped`,
			r?.ok === false &&
				(r.code === "LIMIT_EXCEEDED" || r.code === "BUILD_VALUE") &&
				r.issues <= REPO_CONFIG_LIMITS.issues &&
				text.length <= REPO_CONFIG_LIMITS.stderrBytes + 16 * 1024 &&
				a.body.healthy === true,
			`${brief(a)}; ${r?.issues} issues; answer ${text.length} bytes`,
		);
		await afterValid(sandbox, "flood");
	}
	{
		const a = await evalCase("cue:trunk", floodOf(50_000));
		keep("cue:trunk flood 50000", a);
		const r = a.body.result;
		check(
			"cue:trunk: a flood of 50,000 errors is stopped by the 10 s KILL",
			r?.ok === false && r.code === "TIMEOUT" &&
				(r.jobMs ?? Infinity) <= KILL_MS + 1000 && a.body.healthy === true,
			brief(a),
		);
	}

	// 7b. An export over the 4 MiB file cap: LIMIT_EXCEEDED, no job path.
	for (const sandbox of SANDBOXES) {
		const a = await evalCase(sandbox, await files("pathological-export"));
		keep(`${sandbox} export over the file cap`, a);
		const r = a.body.result;
		check(
			`${sandbox}: an export over the file cap is LIMIT_EXCEEDED (the file cap), with no job directory`,
			r?.ok === false && r.code === "LIMIT_EXCEEDED" &&
				/file cap/.test(r.message ?? "") &&
				!/tartan-cue-|job\./.test(JSON.stringify(a.body)) &&
				a.body.healthy === true,
			brief(a),
		);
		await afterValid(sandbox, "the export over the file cap");
	}

	// 8. OOM: 32 doublings (4 GiB) without RLIMIT_AS and a 300 s clock. On
	// each sandbox the control server's instance must survive (PID 1 keeps
	// its start time, the control server answers, a valid case follows),
	// whether the clock or the OOM killer stops cue. If the OOM killer
	// fires, its only victim is cue (the kernel log since the instance
	// booted names only cue), and it must fire on at least one sandbox.
	const oomFiles = {
		...CORPUS_SCHEMA.files,
		"tartan.cue": doublingTo(32),
	};
	let oomKills = 0;
	const victims = new Set<string>();
	for (const sandbox of SANDBOXES) {
		const a = await evalCase(sandbox, oomFiles, { wallClockS: 300 }, "oom");
		keep(`${sandbox} oom`, a);
		const r = a.body.result;
		const victim = parseVictim(a.body.output ?? "");
		evidence[`${sandbox} oom victim`] = victim;
		const killedByOom = r?.ok === false && r.code === "LIMIT_EXCEEDED" &&
			/instance memory limit/.test(r.message ?? "");
		if (killedByOom) oomKills++;
		for (const name of victim.killed) victims.add(name);
		check(
			`${sandbox}: without RLIMIT_AS the control server's instance survives memory exhaustion`,
			r?.ok === false &&
				(killedByOom || r.code === "TIMEOUT") &&
				a.body.healthy === true && victim.before !== "" &&
				victim.before === victim.after,
			`${brief(a)}; ${
				killedByOom ? "the OOM killer stopped cue" : "the clock stopped cue"
			}; kernel log victims ${
				victim.killed.join(", ") || "none"
			}; pid 1 start ${victim.before} → ${victim.after} (${victim.pid1})`,
		);
		await afterValid(sandbox, "the OOM");
	}
	check(
		"the instance OOM killer takes cue and nothing else (oom_score_adj 1000)",
		oomKills > 0 && victims.size > 0 && [...victims].every((n) => n === "cue"),
		`${oomKills} of ${SANDBOXES.length} runs ended by the OOM killer; kernel log victims ${
			[...victims].join(", ") || "none"
		}`,
	);

	// 10. timings.
	const timing = async (
		name: string,
		sandbox: string,
		f: Readonly<Record<string, string>>,
		n: number,
	) => {
		const wall: number[] = [];
		const job: number[] = [];
		const exec: number[] = [];
		let good = 0;
		for (let i = 0; i < n; i++) {
			const a = await evalCase(sandbox, f);
			if (a.body.result?.ok === true) good++;
			wall.push(a.wallMs);
			exec.push(a.body.ms);
			if (a.body.result?.jobMs !== undefined) job.push(a.body.result.jobMs);
		}
		const stats = (v: number[]) => ({
			n: v.length,
			p50: percentile(v, 50),
			p95: percentile(v, 95),
			max: Math.max(...v),
		});
		const out = {
			wall: stats(wall),
			exec: stats(exec),
			job: stats(job),
			good,
		};
		evidence[`timing ${name}`] = out;
		check(
			`timing ${name}: every evaluation ok, job p95 under the 10 s clock`,
			good === n && out.job.p95 < KILL_MS,
			`wall p50 ${out.wall.p50} / p95 ${out.wall.p95} ms; exec p50 ${out.exec.p50} / p95 ${out.exec.p95} ms; job p50 ${out.job.p50} / p95 ${out.job.p95} ms (n = ${n})`,
		);
	};
	await timing("warm valid (cue:trunk)", "cue:trunk", valid, warmN);
	await timing("warm demo (cue:trunk)", "cue:trunk", demoFiles, warmN);
	{
		const wall: number[] = [];
		const job: number[] = [];
		let good = 0;
		let cold = 0;
		for (let i = 0; i < coldN; i++) {
			const sandbox = `cue:preview:${coldBase + i}`;
			const a = await evalCase(sandbox, valid);
			keep(`${sandbox} cold valid`, a);
			if (a.body.result?.ok === true) good++;
			if (a.body.warm === false) cold++;
			wall.push(a.wallMs);
			if (a.body.result?.jobMs !== undefined) job.push(a.body.result.jobMs);
		}
		const out = {
			wall: {
				n: wall.length,
				p50: percentile(wall, 50),
				p95: percentile(wall, 95),
				max: Math.max(...wall),
			},
			job: {
				n: job.length,
				p50: percentile(job, 50),
				p95: percentile(job, 95),
			},
			good,
			cold,
		};
		evidence["timing cold valid (fresh cue:preview:<k>)"] = out;
		check(
			"timing cold valid (fresh preview sandboxes): every evaluation ok and cold, wall p95 under the 75 s deadline",
			good === coldN && cold === coldN && out.wall.p95 < 75_000,
			`wall p50 ${out.wall.p50} / p95 ${out.wall.p95} ms; job p50 ${out.job.p50} / p95 ${out.job.p95} ms (n = ${coldN}, ${cold} cold)`,
		);
	}

	// 11. leak scan.
	check(
		"leak scan: no Artifacts token, capability path, auth header, secret or dev key in any answer",
		leaks.length === 0,
		leaks.length === 0 ? "clean" : leaks.join("; "),
	);

	evidence.checks = checks;
	evidence.finishedAt = new Date().toISOString();
	if (evidencePath !== undefined) {
		const text = JSON.stringify(evidence, null, 2);
		const late = leaksIn(text, [secret, key]);
		if (late.length > 0) {
			console.error(`wp23: evidence not written, it would leak: ${late}`);
			Deno.exit(1);
		}
		await Deno.writeTextFile(evidencePath, text);
	}
	const failed = checks.filter((c) => !c.ok);
	console.log(
		`wp23: ${checks.length - failed.length}/${checks.length} checks passed`,
	);
	Deno.exit(failed.length === 0 ? 0 : 1);
};

if (import.meta.main) await main();
