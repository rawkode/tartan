// tartan-smoke-box: S7 (containers, Sandbox 0.12.1), S8 (land operations in
// a sandbox against Artifacts) and S11 (Workers AI judge). Every resource carries the `tartan-smoke-box` prefix.
// Endpoints need the `x-smoke-key` header (secret SMOKE_KEY). Artifacts
// tokens only ever travel in one exec's environment and are redacted from
// every response.

import { getSandbox, parseSSEStream, Sandbox } from "@cloudflare/sandbox";
import { redactSecrets } from "@tartan/contract";
import { S8_LAND, S8_LANES, S8_SEED } from "./s8.ts";
import { s11 } from "./s11.ts";

export type Env = {
	readonly BOX: DurableObjectNamespace<BoxSandbox>;
	readonly ARTIFACTS: Artifacts;
	readonly AI: Ai;
	readonly SMOKE_KEY: string;
	readonly VARIANT: string;
};

const json = (o: unknown, status = 200) =>
	new Response(redactSecrets(JSON.stringify(o, null, 2)), {
		status,
		headers: { "content-type": "application/json" },
	});

const message = (e: unknown): string =>
	redactSecrets(String((e as { message?: string })?.message ?? e));

type LogEvent = { type?: string; data?: unknown; exitCode?: number };
type JobState = {
	jobId: string;
	cmd: string;
	procId: string;
	pid?: number;
	startedAt: number;
	startMs: number;
	events: { at: number; type?: string; data?: unknown; exitCode?: number }[];
	exit: { at: number; exitCode?: number } | null;
	pumpEnded: number | null;
	pumpError: { at: number; msg: string } | null;
};

/**
 * U18: a Sandbox subclass with custom RPC. `runJob` starts a process and
 * pumps its logs into DO storage from `ctx.waitUntil` (kept alive by
 * `durable_object_io_tasks_prevent_eviction`, U17).
 */
export class BoxSandbox extends Sandbox<Env> {
	ping(tag: string) {
		return { ok: true, tag, at: Date.now(), variant: this.env.VARIANT };
	}

	async runJob(jobId: string, cmd: string) {
		const t0 = Date.now();
		const proc = await this.startProcess(cmd);
		const st: JobState = {
			jobId,
			cmd,
			procId: proc.id,
			pid: proc.pid,
			startedAt: t0,
			startMs: Date.now() - t0,
			events: [],
			exit: null,
			pumpEnded: null,
			pumpError: null,
		};
		await this.ctx.storage.put(`job:${jobId}`, st);
		this.ctx.waitUntil(this.pump(jobId, proc.id));
		return { procId: proc.id, pid: proc.pid, startMs: st.startMs };
	}

	async pump(jobId: string, procId: string) {
		const key = `job:${jobId}`;
		const load = async () => (await this.ctx.storage.get<JobState>(key))!;
		try {
			const stream = await this.streamProcessLogs(procId);
			for await (const ev of parseSSEStream<LogEvent>(stream)) {
				const st = await load();
				st.events.push({
					at: Date.now(),
					type: ev.type,
					data: typeof ev.data === "string" ? ev.data.slice(0, 500) : ev.data,
					exitCode: ev.exitCode,
				});
				if (ev.type === "exit" || ev.type === "complete") {
					st.exit = { at: Date.now(), exitCode: ev.exitCode };
				}
				await this.ctx.storage.put(key, st);
			}
			const st = await load();
			st.pumpEnded = Date.now();
			await this.ctx.storage.put(key, st);
		} catch (e) {
			const st = await load();
			st.pumpError = { at: Date.now(), msg: message(e) };
			await this.ctx.storage.put(key, st);
		}
	}

	async jobState(jobId: string) {
		return (await this.ctx.storage.get<JobState>(`job:${jobId}`)) ?? null;
	}
}

const sb = (env: Env, id: string, url: URL) =>
	getSandbox(
		env.BOX,
		id,
		{
			enableDefaultSession: url.searchParams.get("session") === "1",
			...(url.searchParams.has("keepAlive")
				? { keepAlive: url.searchParams.get("keepAlive") === "1" }
				: {}),
			...(url.searchParams.has("sleepAfter")
				? { sleepAfter: url.searchParams.get("sleepAfter")! }
				: {}),
		} as Parameters<typeof getSandbox>[2],
	);

type Box = ReturnType<typeof sb>;

const INFO_CMD = `set +e
echo "== git"; git --version
echo "== node"; node --version 2>&1; npm --version 2>&1
echo "== os"; . /etc/os-release; echo "$PRETTY_NAME"; uname -m
echo "== whoami"; id
echo "== boot"; cat /proc/sys/kernel/random/boot_id; cat /tmp/marker 2>/dev/null || echo "no-marker"
echo "== cpu/mem"; nproc; free -m | head -2; df -h / | tail -1
echo "== merge-tree"
D=$(mktemp -d); cd $D; git init -q -b main . ; git -c user.name=x -c user.email=x@x commit -q --allow-empty -m base
git checkout -q -b o; echo o > f; git add f; git -c user.name=x -c user.email=x@x commit -qm o
git checkout -q main; echo m > g; git add g; git -c user.name=x -c user.email=x@x commit -qm m
git merge-tree --write-tree main o; echo "merge-tree rc=$?"
echo "== tools"; for t in curl jq tail bash python3 bun corepack pnpm; do printf "%s: " $t; command -v $t || echo missing; done
`;

export type ExecTiming = {
	ms: number;
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	error?: string;
};

export const timeExec = async (
	s: Box,
	cmd: string,
	opts?: Parameters<Box["exec"]>[1],
): Promise<ExecTiming> => {
	const t0 = Date.now();
	try {
		const r = await s.exec(cmd, opts);
		return {
			ms: Date.now() - t0,
			exitCode: r.exitCode,
			stdout: redactSecrets(r.stdout),
			stderr: redactSecrets(r.stderr),
		};
	} catch (e) {
		return { ms: Date.now() - t0, error: message(e) };
	}
};

const pct = (xs: readonly number[], p: number) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

const jobName = (url: URL) =>
	(url.searchParams.get("job") ?? "j1").replace(/[^a-z0-9-]/g, "");

const s7 = async (env: Env, url: URL, id: string): Promise<Response | null> => {
	const p = url.pathname;
	if (p === "/s7/info") {
		const s = sb(env, id, url);
		const cold = await timeExec(s, INFO_CMD);
		const warm: number[] = [];
		for (let i = 0; i < 10; i++) {
			const t0 = Date.now();
			await s.exec("true");
			warm.push(Date.now() - t0);
		}
		await s.exec("echo marker-$(date +%s) > /tmp/marker");
		return json({
			variant: env.VARIANT,
			sandbox: id,
			cold,
			warm: { samples: warm, p50: pct(warm, 50), p95: pct(warm, 95) },
		});
	}
	if (p === "/s7/rpc") {
		const s = sb(env, id, url);
		const t0 = Date.now();
		const r = await s.ping("hello");
		return json({ ms: Date.now() - t0, r });
	}
	if (p === "/s7/execstream") {
		const s = sb(env, id, url);
		const stream = await s.execStream(
			`for i in 1 2 3 4 5 6; do echo "line-$i $(date +%s%3N)"; sleep 1; done; echo err-line >&2`,
		);
		return new Response(stream, {
			headers: { "content-type": "text/event-stream" },
		});
	}
	if (p === "/s7/procstream") {
		const s = sb(env, id, url);
		const proc = await s.startProcess(
			`sh -c 'for i in 1 2 3 4 5 6; do echo "pline-$i $(date +%s%3N)"; sleep 1; done; exit 3'`,
		);
		const stream = await s.streamProcessLogs(proc.id);
		return new Response(stream, {
			headers: { "content-type": "text/event-stream" },
		});
	}
	if (p === "/s7/env") {
		const s = sb(env, id, url);
		const a = await timeExec(
			s,
			`echo "A FOO=\${FOO:-unset}"; export BAR=exported; cd /tmp; echo "A pwd=$(pwd)"`,
			{ env: { FOO: "per-exec-value-1" } },
		);
		const b = await timeExec(
			s,
			`echo "B FOO=\${FOO:-unset} BAR=\${BAR:-unset} pwd=$(pwd)"`,
		);
		const c = await timeExec(
			s,
			`cat /proc/self/environ | tr '\\0' '\\n' | grep -c '^FOO=' || true`,
		);
		return json({ session: url.searchParams.get("session") === "1", a, b, c });
	}
	if (p === "/s7/start") {
		const s = sb(env, id, url);
		const job = jobName(url);
		const secs = Math.max(
			1,
			Math.min(
				900,
				Math.floor(Number(url.searchParams.get("secs") ?? "180")) || 180,
			),
		);
		const cmd =
			`sh -c 'echo started $(date +%s); sleep ${secs}; echo done $(date +%s); echo done > /tmp/${job}.done'`;
		const t0 = Date.now();
		if (url.searchParams.get("mode") === "pump") {
			const r = await s.runJob(job, cmd);
			return json({ mode: "pump", ms: Date.now() - t0, r });
		}
		const proc = await s.startProcess(cmd);
		return json({
			mode: "plain",
			ms: Date.now() - t0,
			procId: proc.id,
			pid: proc.pid,
		});
	}
	if (p === "/s7/check") {
		const s = sb(env, id, url);
		const job = jobName(url);
		const out: Record<string, unknown> = { at: Date.now() };
		if (url.searchParams.get("mode") === "pump") {
			out.jobState = await s.jobState(job);
		}
		const procId = url.searchParams.get("proc");
		if (procId) {
			try {
				const pr = await s.getProcess(procId);
				out.proc = pr
					? { status: pr.status, exitCode: pr.exitCode, endTime: pr.endTime }
					: null;
				if (pr) {
					out.logs = await s.getProcessLogs(procId).catch((e: unknown) => ({
						error: message(e),
					}));
				}
			} catch (e) {
				out.procError = message(e);
			}
		}
		out.fs = await timeExec(
			s,
			`cat /tmp/${job}.done 2>/dev/null || echo no-done-file; cat /proc/sys/kernel/random/boot_id; cat /tmp/marker 2>/dev/null || echo no-marker; ps -eo pid,etimes,args | grep -v grep | grep sleep || echo no-sleep-proc`,
		);
		return json(out);
	}
	if (p === "/s7/destroy") {
		const s = sb(env, id, url);
		const before = await timeExec(
			s,
			"cat /proc/sys/kernel/random/boot_id; cat /tmp/marker 2>/dev/null || echo no-marker",
		);
		const t0 = Date.now();
		let destroyErr: string | null = null;
		try {
			await s.destroy();
		} catch (e) {
			destroyErr = message(e);
		}
		const destroyMs = Date.now() - t0;
		const after = await timeExec(
			s,
			"cat /proc/sys/kernel/random/boot_id; cat /tmp/marker 2>/dev/null || echo no-marker",
		);
		let finalErr: string | null = null;
		if (url.searchParams.get("final") === "1") {
			try {
				await s.destroy();
			} catch (e) {
				finalErr = message(e);
			}
		}
		return json({
			before,
			destroyMs,
			destroyErr,
			after_recreated: after,
			finalDestroyErr: finalErr,
		});
	}
	return null;
};

const retry = async <T>(
	f: () => Promise<T>,
	label: string,
	log: unknown[],
): Promise<T> => {
	let last: unknown;
	for (let i = 0; i < 20; i++) {
		try {
			return await f();
		} catch (e) {
			last = e;
			log.push({
				retry: label,
				i,
				code: (e as { code?: string }).code,
				msg: message(e).slice(0, 200),
			});
			await new Promise((r) => setTimeout(r, 500 * (i + 1)));
		}
	}
	throw last;
};

/** S8: seed a trunk, push two lane branches to a scratch repo, compose, advance with a lease, notes, hidden refs. */
const s8 = async (env: Env, url: URL) => {
	const run = url.searchParams.get("run") ?? String(Date.now());
	const trunkName = `tartan-smoke-box-trunk-${run}`;
	const scratchName = `tartan-smoke-box-scratch-${run}`;
	const log: unknown[] = [];
	const t = async <T>(label: string, f: () => Promise<T>) => {
		const t0 = Date.now();
		const r = await f();
		log.push({ step: label, ms: Date.now() - t0 });
		return r;
	};
	const repoWithToken = async (name: string, description: string) => {
		const created = await t(
			`create(${name})`,
			() =>
				env.ARTIFACTS.create(name, { description, setDefaultBranch: "main" }),
		);
		const repo = await t(
			`get(${name})`,
			() => retry(() => env.ARTIFACTS.get(name), `get ${name}`, log),
		);
		const info = await t(`info(${name})`, () => repo.info());
		const tok = await t(
			`createToken(${name},write,3600)`,
			() => repo.createToken("write", 3600),
		);
		return { repo, url: info.remote ?? created.remote, tok };
	};
	const trunk = await repoWithToken(trunkName, "tartan smoke box trunk");
	const scratch = await repoWithToken(scratchName, "tartan smoke box scratch");
	const s = getSandbox(
		env.BOX,
		`s8-${run}`,
		{ enableDefaultSession: false, keepAlive: true } as Parameters<
			typeof getSandbox
		>[2],
	);
	const gitEnv = (extra: Record<string, string>) => {
		const pairs = Object.entries(extra);
		const e: Record<string, string> = {
			GIT_CONFIG_COUNT: String(pairs.length),
			GIT_TERMINAL_PROMPT: "0",
		};
		pairs.forEach(([k, v], i) => {
			e[`GIT_CONFIG_KEY_${i}`] = k;
			e[`GIT_CONFIG_VALUE_${i}`] = v;
		});
		return e;
	};
	const headers = {
		[`http.${trunk.url}.extraHeader`]:
			`Authorization: Bearer ${trunk.tok.plaintext}`,
		[`http.${scratch.url}.extraHeader`]:
			`Authorization: Bearer ${scratch.tok.plaintext}`,
	};
	const urls = { TRUNK_URL: trunk.url, SCRATCH_URL: scratch.url };
	const seed = await t(
		"exec seed",
		() => timeExec(s, S8_SEED, { env: { ...gitEnv(headers), ...urls } }),
	);
	const base = /BASE=([0-9a-f]{40})/.exec(seed.stdout ?? "")?.[1] ?? "";
	const laneRun = await t(
		"exec lanes",
		() =>
			timeExec(s, S8_LANES, {
				env: { ...gitEnv(headers), ...urls, BASE: base },
			}),
	);
	const m = (k: string, src: string) =>
		new RegExp(`${k}=([0-9a-f]{40})`).exec(src)?.[1] ?? "";
	const L1 = m("L1", laneRun.stdout ?? "");
	const L2 = m("L2", laneRun.stdout ?? "");
	const T1 = m("T1", laneRun.stdout ?? "");
	const land = await t("exec land", () =>
		timeExec(s, S8_LAND, {
			env: {
				...gitEnv(headers),
				...urls,
				L1,
				L2,
				T1,
				TRUNK_AUTH: `Bearer ${trunk.tok.plaintext}`,
			},
		}));
	const C1 = m("C1", land.stdout ?? "");
	const C2 = m("C2", land.stdout ?? "");
	const rb: Record<string, unknown> = {};
	const attempt = async (key: string, f: () => Promise<unknown>) => {
		try {
			rb[key] = await f();
		} catch (e) {
			rb[key] = `ERR ${(e as { code?: string }).code ?? ""} ${message(e)}`;
		}
	};
	await attempt("readCommitC2", () => trunk.repo.readCommit(C2));
	await attempt("readCommitC1", () => trunk.repo.readCommit(C1));
	await attempt(
		"logMain",
		async () =>
			(await trunk.repo.log({ ref: "main", limit: 10 })).map((c) => ({
				hash: c.hash,
				message: c.message.slice(0, 120),
				parents: c.parents,
			})),
	);
	await attempt(
		"logNotes",
		() => trunk.repo.log({ ref: "refs/notes/tartan", limit: 5 }),
	);
	await attempt(
		"logTartanX",
		() => trunk.repo.log({ ref: "refs/tartan/x", limit: 5 }),
	);
	await attempt("infoAfter", () => trunk.repo.info());
	try {
		await trunk.repo.revokeToken(trunk.tok.id);
		await scratch.repo.revokeToken(scratch.tok.id);
	} catch (e) {
		log.push({ revokeErr: message(e) });
	}
	if (url.searchParams.get("keep") !== "1") {
		try {
			await s.destroy();
		} catch {
			// The sandbox may already be gone.
		}
	}
	return {
		run,
		trunkName,
		scratchName,
		base,
		L1,
		L2,
		T1,
		C1,
		C2,
		log,
		seed,
		lanes: laneRun,
		land,
		rb,
	};
};

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		if (!env.SMOKE_KEY || req.headers.get("x-smoke-key") !== env.SMOKE_KEY) {
			return new Response("forbidden", { status: 403 });
		}
		const id = url.searchParams.get("sb") ?? "default";
		try {
			const s7Response = await s7(env, url, id);
			if (s7Response) return s7Response;
			if (url.pathname === "/s8/run") return json(await s8(env, url));
			if (url.pathname === "/s8/list") {
				const r = await env.ARTIFACTS.list({ limit: 200 });
				return json({ total: r.total, names: r.repos.map((x) => x.name) });
			}
			if (url.pathname === "/s8/delete") {
				const names = (url.searchParams.get("names") ?? "").split(",").filter((
					n,
				) => n.startsWith("tartan-smoke-box-"));
				const out: Record<string, unknown> = {};
				for (const n of names) {
					try {
						out[n] = await env.ARTIFACTS.delete(n);
					} catch (e) {
						out[n] = `ERR ${message(e)}`;
					}
				}
				return json(out);
			}
			if (url.pathname === "/s11") return json(await s11(env.AI, url));
			return new Response("not found", { status: 404 });
		} catch (e) {
			return json({ error: message(e) }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
