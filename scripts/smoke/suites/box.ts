// The box smoke suite (S7, S8, S11): container liveness, exec streams, RPC into the Sandbox subclass, per-exec
// env, a long silent job kept alive, destroy and re-create; land operations
// in a sandbox against Artifacts; the Workers AI judge. Live only: there is
// no local container runtime in the ladder.

import type { SmokeContext, WorkerTarget } from "../lib/context.ts";
import { wants } from "../lib/context.ts";

type Exec = { ms: number; exitCode?: number; stdout?: string; error?: string };

const call = async <T>(t: WorkerTarget, path: string): Promise<T> => {
	const res = await fetch(`${t.base}${path}`, {
		headers: { "x-smoke-key": t.key },
	});
	const text = await res.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`${path}: ${res.status} ${text.slice(0, 200)}`);
	}
};

const streamLines = async (t: WorkerTarget, path: string) => {
	const t0 = Date.now();
	const res = await fetch(`${t.base}${path}`, {
		headers: { "x-smoke-key": t.key },
	});
	const text = await res.text();
	return {
		ms: Date.now() - t0,
		lines: text.split("\n").filter((l) => l.startsWith("data:")).length,
		text,
	};
};

const stepRc = (out: string | undefined, step: string): number | null => {
	const m = new RegExp(`STEP ${step} rc=(\\d+)`).exec(out ?? "");
	return m ? Number(m[1]) : null;
};

export const runBoxSuite = async (
	ctx: SmokeContext,
	t: WorkerTarget,
): Promise<void> => {
	const { rec, tag } = ctx;
	const sb = `s7-${tag}`;
	if (wants(ctx, "S7")) {
		const info = await call<{ cold: Exec; warm: { p50: number; p95: number } }>(
			t,
			`/s7/info?sb=${sb}`,
		);
		const gitVersion =
			/git version (\d+\.\d+\.\d+)/.exec(info.cold.stdout ?? "")?.[1] ?? "?";
		rec.check({
			id: "S7",
			title:
				"sandbox cold start, warm exec latency, git and merge-tree in the image",
			pass: info.cold.exitCode === 0 &&
				/merge-tree rc=0/.test(info.cold.stdout ?? ""),
			numbers: {
				coldMs: info.cold.ms,
				warmP50: info.warm.p50,
				warmP95: info.warm.p95,
				git: gitVersion,
			},
			decides: "IMAGE_VARIANT",
		});
		const rpc = await call<{ ms: number; r: { ok: boolean } }>(
			t,
			`/s7/rpc?sb=${sb}`,
		);
		rec.check({
			id: "S7",
			title: "custom RPC on the Sandbox subclass",
			pass: rpc.r.ok,
			numbers: { ms: rpc.ms },
		});
		const es = await streamLines(t, `/s7/execstream?sb=${sb}`);
		const ps = await streamLines(t, `/s7/procstream?sb=${sb}`);
		rec.check({
			id: "S7",
			title: "execStream and streamProcessLogs deliver lines over ~6 s",
			pass: es.lines >= 6 && ps.lines >= 6,
			numbers: {
				execLines: es.lines,
				execMs: es.ms,
				procLines: ps.lines,
				procMs: ps.ms,
			},
		});
		const env = await call<{ a: Exec; b: Exec }>(t, `/s7/env?sb=${sb}`);
		rec.check({
			id: "S7",
			title: "per-exec env does not leak into the next exec",
			pass: (env.a.stdout ?? "").includes("FOO=per-exec-value-1") &&
				(env.b.stdout ?? "").includes("FOO=unset"),
			numbers: {},
		});
		const secs = ctx.small ? 5 : 180;
		const job = `j${tag}`;
		const start = await call<{ r: { procId: string } }>(
			t,
			`/s7/start?sb=${sb}&mode=pump&job=${job}&secs=${secs}&keepAlive=1`,
		);
		await new Promise((r) => setTimeout(r, (secs + 15) * 1000));
		const check = await call<{ jobState?: { exit: unknown }; fs: Exec }>(
			t,
			`/s7/check?sb=${sb}&mode=pump&job=${job}&proc=${start.r.procId}`,
		);
		rec.check({
			id: "S7",
			title: `a silent ${secs} s job survives with a log pump (keepAlive)`,
			pass: (check.fs.stdout ?? "").startsWith("done"),
			numbers: { secs, pumpExit: check.jobState?.exit !== null },
			decides: "job liveness",
		});
		const destroy = await call<
			{ destroyMs: number; destroyErr: string | null }
		>(t, `/s7/destroy?sb=${sb}&final=1`);
		rec.check({
			id: "S7",
			title: "destroy() ends the container; the next exec gets a fresh one",
			pass: destroy.destroyErr === null,
			numbers: { destroyMs: destroy.destroyMs },
		});
	}
	if (wants(ctx, "S8")) {
		const s8 = await call<{
			land: Exec;
			C1: string;
			C2: string;
			rb: Record<string, unknown>;
			log: unknown[];
		}>(t, `/s8/run?run=${tag}`);
		const out = s8.land.stdout ?? "";
		rec.check({
			id: "S8",
			title:
				"land ops in a sandbox: fetch by SHA, merge-tree, lease, atomic, notes, hidden refs",
			pass: /merge-tree-clean rc=0/.test(out) &&
				/merge-tree-conflict rc=1/.test(out) &&
				stepRc(out, "push-lease-ok") === 0 &&
				(stepRc(out, "push-lease-stale") ?? 0) !== 0 &&
				stepRc(out, "push-atomic") === 0 &&
				stepRc(out, "push-notes-and-hidden") === 0 &&
				/CAS wrong-old http=200 [^\n]*ng /.test(out) &&
				/CAS right-old http=200 [^\n]*ok /.test(out),
			numbers: { landMs: s8.land.ms, c1: Boolean(s8.C1), c2: Boolean(s8.C2) },
			decides: "kernel git jobs",
		});
		await call(
			t,
			`/s8/delete?names=tartan-smoke-box-trunk-${tag},tartan-smoke-box-scratch-${tag}`,
		);
	}
	if (wants(ctx, "S11")) {
		const s11 = await call<
			{ valid: number; n: number; p50: number; p95: number }
		>(t, `/s11?n=10`);
		rec.check({
			id: "S11",
			title: "Workers AI judge returns schema-valid JSON",
			pass: s11.valid >= s11.n - 1,
			numbers: { valid: s11.valid, n: s11.n, p50: s11.p50, p95: s11.p95 },
			decides: "judge model",
		});
	}
};
