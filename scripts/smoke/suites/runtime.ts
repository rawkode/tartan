// The runtime smoke suite (S6: B1–B5 and Tails). Live only: Dynamic
// Workers, facets and tails need the edge (the vitest pool covers what
// workerd can run locally).

import type { SmokeContext, WorkerTarget } from "../lib/context.ts";
import { wants } from "../lib/context.ts";
import { pct } from "../lib/evidence.ts";

const WASM_DIR = new URL("../worker-runtime/wasm/", import.meta.url).pathname;

type Envelope<T> = { ok: boolean; serverMs: number; body: T; error?: string };

const call = async <T>(
	t: WorkerTarget,
	path: string,
	body?: Uint8Array<ArrayBuffer>,
): Promise<Envelope<T>> => {
	const res = await fetch(`${t.base}${path}`, {
		method: body ? "POST" : "GET",
		headers: { "x-smoke-key": t.key },
		body,
	});
	const text = await res.text();
	try {
		return JSON.parse(text) as Envelope<T>;
	} catch {
		throw new Error(`${path}: ${res.status} ${text.slice(0, 200)}`);
	}
};

/** Builds the B2 module with cargo (shared CARGO_TARGET_DIR); null when cargo is missing. */
const buildWasm = async (): Promise<Uint8Array<ArrayBuffer> | null> => {
	const target = Deno.env.get("CARGO_TARGET_DIR") ?? `${WASM_DIR}target`;
	try {
		const out = await new Deno.Command("cargo", {
			args: ["build", "--release", "--target", "wasm32-unknown-unknown"],
			cwd: WASM_DIR,
			env: { CARGO_TARGET_DIR: target },
			stdout: "null",
			stderr: "piped",
		}).output();
		if (!out.success) return null;
		return new Uint8Array(
			await Deno.readFile(
				`${target}/wasm32-unknown-unknown/release/tartan_smoke_wasm.wasm`,
			),
		);
	} catch {
		return null;
	}
};

export const runRuntimeSuite = async (
	ctx: SmokeContext,
	t: WorkerTarget,
): Promise<void> => {
	const { rec, tag } = ctx;
	if (wants(ctx, "B1")) {
		type B1 = {
			fetch: { dynIsolate: string };
			rpc: { pong: number };
			refetch: { dynIsolate: string };
			cbCountGlobal: number;
		};
		const first = await call<B1>(t, `/b1?nonce=${tag}`);
		const second = await call<B1>(t, `/b1?nonce=${tag}`);
		rec.check({
			id: "B1",
			title: "Dynamic Worker fetch + RPC; getCode runs once per id",
			pass: first.ok && second.ok && first.body.rpc.pong === 7 &&
				second.body.cbCountGlobal === 1,
			numbers: {
				cbCountGlobal: second.body.cbCountGlobal,
				sameIsolate:
					first.body.fetch.dynIsolate === first.body.refetch.dynIsolate,
			},
			decides: "EXT_DYNAMIC_ENABLED",
		});
		type Egress = { fetchResult: { egressOk: boolean } };
		const nul = await call<Egress>(t, `/b1/egress?nonce=${tag}`);
		const inherit = await call<Egress>(
			t,
			`/b1/egress?nonce=${tag}&outbound=inherit`,
		);
		rec.check({
			id: "B1",
			title:
				"globalOutbound:null blocks fetch(); the inherited control reaches the internet",
			pass: nul.body.fetchResult.egressOk === false &&
				inherit.body.fetchResult.egressOk === true,
			numbers: {},
		});
		const cold: number[] = [];
		const warm: number[] = [];
		for (let i = 0; i < (ctx.small ? 3 : 10); i++) {
			cold.push(
				(await call<{ fetchMs: number }>(t, `/b1/lat?nonce=${tag}-c${i}`)).body
					.fetchMs,
			);
		}
		for (let i = 0; i < (ctx.small ? 3 : 19); i++) {
			warm.push(
				(await call<{ fetchMs: number }>(t, `/b1/lat?nonce=${tag}-warm`)).body
					.fetchMs,
			);
		}
		rec.check({
			id: "B1",
			title: "server-side LOADER.get().fetch() latency, cold vs warm",
			pass: true,
			numbers: {
				coldP50: pct(cold, 50),
				coldP95: pct(cold, 95),
				warmP50: pct(warm, 50),
				warmP95: pct(warm, 95),
			},
		});
	}
	if (wants(ctx, "B2")) {
		const bytes = await buildWasm();
		if (!bytes) {
			rec.check({
				id: "B2",
				title: "WASM by bytes (cargo build unavailable)",
				pass: false,
				numbers: {},
			});
		} else {
			const r = await call<{
				parent: Record<string, string>;
				add: unknown;
				transform: { from?: string };
				compileInsideDynamic: Record<string, string>;
				firstCallMs: number;
			}>(t, "/b2", bytes);
			rec.check({
				id: "B2",
				title:
					"a Rust module as {wasm: bytes} runs; runtime compile is refused in parent and dynamic Worker",
				pass: r.body.add === 42 && r.body.transform.from === "rust" &&
					r.body.parent.compile.startsWith("rejected") &&
					r.body.compileInsideDynamic.compile?.startsWith("rejected") === true,
				numbers: { bytes: bytes.length, firstCallMs: r.body.firstCallMs },
				decides: "WASM runtime forms",
			});
		}
	}
	if (wants(ctx, "B3")) {
		const r = await call<
			{ secretLeaked: boolean; dynamicSaw: { whoami: { tenant: string } } }
		>(
			t,
			`/b3?nonce=${tag}&tenant=acme`,
		);
		rec.check({
			id: "B3",
			title:
				"a capability in a dynamic env answers per tenant and hides its props",
			pass: !r.body.secretLeaked && r.body.dynamicSaw.whoami.tenant === "acme",
			numbers: { secretLeaked: r.body.secretLeaked },
			decides: "K12 caps per call",
		});
		const arg = await call<{
			secretLeaked: boolean;
			loadsThisIsolate: number;
			calls: { label: string; whoami: { tenant: string } }[];
		}>(t, `/b3/arg?nonce=${tag}`);
		const later = await call<{ kept: { useKeptFromEarlierRequest: unknown } }>(
			t,
			`/b3/arg?nonce=${tag}&step=later`,
		);
		rec.check({
			id: "B3",
			title:
				"capabilities minted per call as RPC arguments; a kept capability dies with its request",
			pass: !arg.body.secretLeaked && arg.body.calls.every((c) =>
				c.whoami.tenant === c.label
			) &&
				String(later.body.kept.useKeptFromEarlierRequest).startsWith("ERR"),
			numbers: {
				calls: arg.body.calls.length,
				loads: arg.body.loadsThisIsolate,
			},
		});
	}
	if (wants(ctx, "B4")) {
		await call(t, `/b4?nonce=${tag}&step=write`);
		const r = await call<{
			alpha: { rows: string[] };
			beta: { rows: string[] };
			gammaNew: { rows: string[] };
			supB_alpha: { rows: string[] };
			supervisorA: { supervisorTables: string[] };
		}>(t, `/b4?nonce=${tag}&step=read`);
		rec.check({
			id: "B4",
			title: "facets of a dynamic class: own SQLite, persistence, isolation",
			pass: r.body.alpha.rows.length === 2 && r.body.beta.rows.length === 1 &&
				r.body.gammaNew.rows.length === 0 &&
				r.body.supB_alpha.rows.length === 0 &&
				!r.body.supervisorA.supervisorTables.includes("rows"),
			numbers: {
				alpha: r.body.alpha.rows.length,
				beta: r.body.beta.rows.length,
			},
			decides: "ExtensionDO facets",
		});
		await call(t, `/b4x?nonce=${tag}&what=synthetic&step=write`);
		const synth = await call<
			{ synthString: { ctxIdStr: string | null; rows: string[] } }
		>(
			t,
			`/b4x?nonce=${tag}&what=synthetic&step=read`,
		);
		rec.check({
			id: "B4",
			title: "a synthetic facet id persists and hides the supervisor's name",
			pass: synth.body.synthString.ctxIdStr === "ext:forge.issues" &&
				synth.body.synthString.rows.length === 1,
			numbers: {},
		});
		const abort = await call<
			{
				race: { timeout?: boolean };
				slowSettled: unknown;
				slowAfterAbort: unknown;
			}
		>(
			t,
			`/b4x?nonce=${tag}&what=limits&part=abort`,
		);
		rec.check({
			id: "B4",
			title:
				"host wall-clock timeout + facets.abort ends an awaiting facet; it restarts",
			pass: abort.body.race.timeout === true &&
				String(abort.body.slowSettled).includes("tartan wall-clock timeout") &&
				!String(abort.body.slowAfterAbort).startsWith("ERR"),
			numbers: {},
			decides: "host timeouts",
		});
		const cpu = await call<
			{ cpuLimitedSpin2000: unknown; cpuLimitedSpin2000Ms: number }
		>(
			t,
			`/b4x?nonce=${tag}-cpu&what=limits&part=cpu`,
		);
		rec.check({
			id: "B4",
			title: "facet limits.cpuMs=50 stops a 2 s spin",
			pass: String(cpu.body.cpuLimitedSpin2000).startsWith("ERR"),
			numbers: { ms: cpu.body.cpuLimitedSpin2000Ms },
			decides: "breaker on runaway extensions (B4-limits)",
		});
	}
	if (wants(ctx, "B5")) {
		type Fan = { rejected: number; firstRejection: string | null };
		const four = await call<Fan>(t, `/b5?nonce=${tag}-4&n=4`);
		const five = await call<Fan>(t, `/b5?nonce=${tag}-5&n=5`);
		const ten = await call<Fan>(t, `/b5/do?nonce=${tag}-10&n=10`);
		const eleven = await call<Fan>(t, `/b5/do?nonce=${tag}-11&n=11`);
		rec.check({
			id: "B5",
			title: "concurrency limits: 4 dynamic invocations per request, 10 per DO",
			pass: four.body.rejected === 0 && five.body.rejected === 1 &&
				ten.body.rejected === 0 && eleven.body.rejected === 1,
			numbers: {
				n4: four.body.rejected,
				n5: five.body.rejected,
				do10: ten.body.rejected,
				do11: eleven.body.rejected,
			},
			decides: "fan-out concurrency caps",
		});
	}
	if (wants(ctx, "TAILS")) {
		const started = await call<{ since: number }>(t, `/tails?nonce=${tag}`);
		await new Promise((r) => setTimeout(r, ctx.small ? 3000 : 10_000));
		const read = await call<{ rows: { props: { install: string } }[] }>(
			t,
			`/tails?step=read&since=${started.body.since}`,
		);
		const installs = new Set(read.body.rows.map((r) => r.props.install));
		rec.check({
			id: "TAILS",
			title: "per-install tails attribute dynamic Worker logs",
			pass: installs.has("A") && installs.has("B") &&
				read.body.rows.length >= 7,
			numbers: { events: read.body.rows.length },
			decides: "ExtTail attribution",
		});
	}
};
