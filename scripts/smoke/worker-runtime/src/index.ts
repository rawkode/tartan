// tartan-smoke-rt: the runtime smoke Worker (S6: B1–B5 and Tails). Dynamic
// Workers through `env.LOADER`, WASM by
// bytes, capabilities as props and as RPC arguments, Durable Object facets
// with their own SQLite, facet limits and abort, per-request and per-DO
// concurrency limits, and tail attribution. Every request needs the
// `x-smoke-key` header (secret SMOKE_KEY). The jco component test (B8) is
// not ported: it loads a component built outside this repo; WP17's WASM SDK
// and its `wasm` vitest project cover that path.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
	B1_SRC,
	B2_SRC,
	B3_SRC,
	B3ARG_SRC,
	code,
	EXT_DO_SRC,
	SLOW_SRC,
	TAIL_SRC,
} from "./dynamic.ts";

export interface Env {
	readonly LOADER: WorkerLoader;
	readonly SUPERVISOR: DurableObjectNamespace<Supervisor>;
	readonly COUNTER: DurableObjectNamespace<Counter>;
	readonly TAILSINK: DurableObjectNamespace<TailSink>;
	readonly SMOKE_KEY: string;
}

const PREFIX = "tartan-smoke-rt";

type Rpc = Record<string, (...args: unknown[]) => Promise<unknown>>;
/** Dynamic entrypoints and facets are untyped RPC stubs. */
const rpc = (stub: unknown): Rpc => stub as Rpc;

type Exports = Record<string, (o: { props: unknown }) => Fetcher>;
const exportsOf = (ctx: ExecutionContext | DurableObjectState): Exports =>
	(ctx as unknown as { exports: Exports }).exports;

const errStr = (e: unknown) =>
	e instanceof Error ? `${e.name}: ${e.message}` : String(e);

const attempt = async (f: () => Promise<unknown>): Promise<unknown> => {
	try {
		return await f();
	} catch (e) {
		return `ERR ${errStr(e)}`;
	}
};

let parentIsolate: string | undefined;
const parentIso = () => (parentIsolate ??= crypto.randomUUID());
const cbCounts: Record<string, number> = {};

// ------------------------------------------------------------------ capabilities
type CapProps = { tenant: string; secret: string };

/** B3: a per-tenant capability; only derived facts leave the host. */
export class Cap extends WorkerEntrypoint<Env, CapProps> {
	whoami() {
		const p = this.ctx.props;
		return { tenant: p.tenant, secretLen: p.secret.length };
	}
}

// ------------------------------------------------------------------ Counter DO
export class Counter extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS c(k TEXT PRIMARY KEY, n INTEGER NOT NULL)",
		);
	}
	inc(k: string): number {
		this.ctx.storage.sql.exec(
			"INSERT INTO c(k,n) VALUES(?,1) ON CONFLICT(k) DO UPDATE SET n=n+1",
			k,
		);
		return this.get(k);
	}
	get(k: string): number {
		return this.ctx.storage.sql
			.exec<{ n: number }>("SELECT n FROM c WHERE k=?", k)
			.toArray()[0]?.n ?? 0;
	}
}

// ------------------------------------------------------------------ Supervisor DO (B4, B5)
const EXT_ID = `${PREFIX}-ext-v1`;

export class Supervisor extends DurableObject<Env> {
	private facet(name: string, opts: { id?: string; cpuMs?: number } = {}) {
		return rpc(this.ctx.facets.get(name, () => {
			const cls = this.env.LOADER.get(EXT_ID, () => code(EXT_DO_SRC))
				.getDurableObjectClass(
					"ExtDO",
					opts.cpuMs ? { limits: { cpuMs: opts.cpuMs } } : undefined,
				);
			return opts.id ? { class: cls, id: opts.id } : { class: cls };
		}));
	}

	async facetAdd(name: string, v: string) {
		return await this.facet(name).add(v);
	}

	async facetList(name: string) {
		return await this.facet(name).info();
	}

	supervisorView() {
		const sql = this.ctx.storage.sql;
		sql.exec("CREATE TABLE IF NOT EXISTS sup_own(x INTEGER)");
		return {
			supervisorTables: sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
				)
				.toArray().map((r) => r.name),
			supervisorIdName: this.ctx.id.name ?? null,
		};
	}

	async synthetic(step: string) {
		const out: Record<string, unknown> = {
			supervisorIdName: this.ctx.id.name ?? null,
		};
		const id = "ext:forge.issues";
		out.plain = await attempt(() =>
			step === "write"
				? this.facet("plain").add("p-1")
				: this.facet("plain").info()
		);
		out.synthString = await attempt(() =>
			step === "write"
				? this.facet("synth", { id }).add("s-1")
				: this.facet("synth", { id }).info()
		);
		return out;
	}

	async capIntoFacet(tenant: string) {
		const cap = exportsOf(this.ctx).Cap({
			props: { tenant, secret: `s3cret-facet-${tenant}` } satisfies CapProps,
		});
		return await this.facet("capfacet").useCap(cap);
	}

	/** Facet CPU limits and the host wall-clock timeout with `facets.abort`. */
	async limits(part: string) {
		const out: Record<string, unknown> = { part };
		const timed = async (k: string, f: () => Promise<unknown>) => {
			const t = Date.now();
			out[k] = await attempt(f);
			out[`${k}Ms`] = Date.now() - t;
		};
		if (part === "cpu") {
			await timed(
				"cpuLimitedSpin2000",
				() => this.facet("spin", { cpuMs: 50 }).spin(2000),
			);
			await timed(
				"afterCpuLimit",
				() => this.facet("spin", { cpuMs: 50 }).info(),
			);
		}
		if (part === "abort") {
			const t = Date.now();
			const slow = this.facet("slow").sleep(5000);
			out.race = await Promise.race([
				slow.then((v) => ({ v })),
				new Promise((r) => setTimeout(() => r({ timeout: true }), 500)),
			]);
			try {
				this.ctx.facets.abort("slow", new Error("tartan wall-clock timeout"));
				out.abortCalled = true;
			} catch (e) {
				out.abortCalled = `ERR ${errStr(e)}`;
			}
			out.slowSettled = await attempt(() => slow);
			out.slowSettledMs = Date.now() - t;
			await timed("slowAfterAbort", () => this.facet("slow").info());
		}
		return out;
	}

	async concurrency(n: number, nonce: string) {
		return await fanout(this.env, n, `${PREFIX}-b5do-${nonce}`);
	}
}

const fanout = async (env: Env, n: number, base: string) => {
	const t0 = Date.now();
	const settled = await Promise.allSettled(
		Array.from(
			{ length: n },
			(_, i) =>
				env.LOADER.get(`${base}-${i}`, () => code(SLOW_SRC)).getEntrypoint()
					.fetch("http://dyn/").then(async (r) =>
						`${r.status} ${await r.text()}`
					),
		),
	);
	return {
		n,
		ms: Date.now() - t0,
		rejected: settled.filter((s) => s.status === "rejected").length,
		firstRejection:
			settled.flatMap((s) =>
				s.status === "rejected" ? [errStr(s.reason)] : []
			)[0] ?? null,
	};
};

// ------------------------------------------------------------------ Tails
type TailProps = { install: string; dynId: string };
type TraceLike = {
	entrypoint?: string;
	outcome?: string;
	event?: { rpcMethod?: string };
	logs?: { level: string; message: unknown }[];
	exceptions?: { name: string; message: string }[];
	eventTimestamp?: number;
};

export class DynTail extends WorkerEntrypoint<Env, TailProps> {
	override async tail(items: TraceItem[]) {
		const events = items as unknown as TraceLike[];
		const slim = events.map((e) => ({
			entrypoint: e.entrypoint ?? null,
			outcome: e.outcome ?? null,
			rpcMethod: e.event?.rpcMethod ?? null,
			logs: (e.logs ?? []).map((l) => ({ level: l.level, message: l.message })),
			exceptions: (e.exceptions ?? []).map((x) => ({
				name: x.name,
				message: x.message,
			})),
			eventTimestamp: e.eventTimestamp ?? null,
		}));
		await this.env.TAILSINK.getByName(`${PREFIX}-tails`).push(
			this.ctx.props,
			slim,
		);
	}
}

export class TailSink extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, at INTEGER, props TEXT, ev TEXT)",
		);
	}
	push(props: unknown, ev: unknown) {
		this.ctx.storage.sql.exec(
			"INSERT INTO t(at, props, ev) VALUES(?,?,?)",
			Date.now(),
			JSON.stringify(props),
			JSON.stringify(ev),
		);
	}
	read(since: number) {
		return this.ctx.storage.sql
			.exec<{ at: number; props: string; ev: string }>(
				"SELECT at, props, ev FROM t WHERE at >= ? ORDER BY id",
				since,
			)
			.toArray()
			.map((r) => ({
				at: r.at,
				props: JSON.parse(r.props),
				ev: JSON.parse(r.ev),
			}));
	}
}

// ------------------------------------------------------------------ tests
const b1 = async (env: Env, url: URL) => {
	const nonce = url.searchParams.get("nonce") ?? "x";
	const id = `${PREFIX}-b1-${nonce}`;
	const make = () => code(B1_SRC, { env: { TAG: `b1:${nonce}` } });
	const counting = async () => {
		cbCounts[id] = (cbCounts[id] ?? 0) + 1;
		await env.COUNTER.getByName("cb").inc(id);
		return make();
	};
	const t0 = Date.now();
	const stub = env.LOADER.get(id, counting);
	const r1 = await stub.getEntrypoint().fetch("http://dyn/");
	const fetched = await r1.json();
	const t1 = Date.now();
	const pinged = await rpc(stub.getEntrypoint("Api")).ping(7);
	const t2 = Date.now();
	const again = await env.LOADER.get(id, counting).getEntrypoint().fetch(
		"http://dyn/",
	);
	return {
		id,
		parentIsolate: parentIso(),
		fetch: fetched,
		rpc: pinged,
		refetch: await again.json(),
		ms: { firstFetch: t1 - t0, rpc: t2 - t1, secondGetFetch: Date.now() - t2 },
		cbCountThisIsolate: cbCounts[id] ?? 0,
		cbCountGlobal: await env.COUNTER.getByName("cb").get(id),
	};
};

const b1egress = async (env: Env, url: URL) => {
	const nonce = url.searchParams.get("nonce") ?? "x";
	const inherit = url.searchParams.get("outbound") === "inherit";
	const id = `${PREFIX}-b1egress-${inherit ? "inherit" : "null"}-${nonce}`;
	const stub = env.LOADER.get(
		id,
		() => code(B1_SRC, inherit ? { globalOutbound: undefined } : {}),
	);
	const r = await stub.getEntrypoint().fetch("http://dyn/egress");
	const rc = await stub.getEntrypoint().fetch("http://dyn/connect");
	return {
		id,
		inherit,
		fetchResult: await r.json(),
		connectResult: await rc.json(),
	};
};

const b1lat = async (env: Env, url: URL) => {
	const nonce = url.searchParams.get("nonce") ?? "x";
	const id = `${PREFIX}-b1lat-${nonce}`;
	let cb = 0;
	const t0 = Date.now();
	const stub = env.LOADER.get(id, () => {
		cb++;
		return code(B1_SRC);
	});
	await (await stub.getEntrypoint().fetch("http://dyn/")).arrayBuffer();
	const t1 = Date.now();
	await rpc(stub.getEntrypoint("Api")).ping(1);
	return { id, cbThisRequest: cb, fetchMs: t1 - t0, rpcMs: Date.now() - t1 };
};

/** B2: the driver POSTs the Rust module's bytes (built from ../wasm). */
const b2 = async (env: Env, request: Request) => {
	const bytes = await request.arrayBuffer();
	const parent: Record<string, string> = {};
	const wa = WebAssembly as unknown as {
		compile(b: ArrayBuffer): Promise<unknown>;
		Module: new (b: ArrayBuffer) => unknown;
	};
	try {
		await wa.compile(bytes);
		parent.compile = "ALLOWED";
	} catch (e) {
		parent.compile = `rejected: ${errStr(e)}`;
	}
	try {
		new wa.Module(bytes);
		parent.newModule = "ALLOWED";
	} catch (e) {
		parent.newModule = `rejected: ${errStr(e)}`;
	}
	const id = `${PREFIX}-b2-bytes-${crypto.randomUUID()}`;
	const api = rpc(
		env.LOADER.get(
			id,
			() => code(B2_SRC, {}, { "smoke.wasm": { wasm: bytes } }),
		)
			.getEntrypoint("Api"),
	);
	const t0 = Date.now();
	const add = await attempt(() => api.add(40, 2));
	const t1 = Date.now();
	const transform = await attempt(() =>
		api.transform({ hello: "tartan", n: [1, 2, 3] })
	);
	const inside = await attempt(() => api.compileInside(bytes.slice(0)));
	return {
		bytes: bytes.byteLength,
		parent,
		add,
		transform,
		compileInsideDynamic: inside,
		firstCallMs: t1 - t0,
	};
};

const b3 = async (env: Env, ctx: ExecutionContext, url: URL) => {
	const nonce = url.searchParams.get("nonce") ?? "x";
	const tenant = url.searchParams.get("tenant") ?? "acme";
	const secret = `s3cret-${nonce}-${tenant}`;
	const cap = exportsOf(ctx).Cap({
		props: { tenant, secret } satisfies CapProps,
	});
	const id = `${PREFIX}-b3-${tenant}-${nonce}`;
	const r = await env.LOADER.get(id, () => code(B3_SRC, { env: { CAP: cap } }))
		.getEntrypoint().fetch("http://dyn/");
	const text = await r.text();
	return {
		id,
		tenant,
		secretLeaked: text.includes(secret),
		dynamicSaw: JSON.parse(text),
	};
};

let b3argLoads = 0;
const b3arg = async (env: Env, ctx: ExecutionContext, url: URL) => {
	const nonce = url.searchParams.get("nonce") ?? "x";
	const id = `${PREFIX}-b3arg-shared-${nonce}`;
	const api = rpc(
		env.LOADER.get(id, () => {
			b3argLoads++;
			return code(B3ARG_SRC);
		}).getEntrypoint("Api"),
	);
	const mint = (tenant: string) =>
		exportsOf(ctx).Cap({
			props: { tenant, secret: `s3cret-${nonce}-${tenant}` } satisfies CapProps,
		});
	const calls = [];
	for (const t of ["acme", "globex", "acme", "initech"]) {
		calls.push(await api.use(mint(t), t));
	}
	const kept = url.searchParams.get("step") === "later"
		? { useKeptFromEarlierRequest: await attempt(() => api.useKept()) }
		: {
			keep: await api.keep(mint("kept")),
			useKeptSameRequest: await attempt(() => api.useKept()),
		};
	return {
		id,
		loadsThisIsolate: b3argLoads,
		secretLeaked: /s3cret-/.test(JSON.stringify(calls)),
		calls,
		kept,
	};
};

const b4 = async (env: Env, url: URL) => {
	const nonce = url.searchParams.get("nonce") ?? "x";
	const step = url.searchParams.get("step") ?? "write";
	const supA = env.SUPERVISOR.getByName(`${PREFIX}-b4-supA-${nonce}`);
	const supB = env.SUPERVISOR.getByName(`${PREFIX}-b4-supB-${nonce}`);
	if (step === "write") {
		await supA.facetAdd("alpha", "a-1");
		await supA.facetAdd("alpha", "a-2");
		await supA.facetAdd("beta", "b-1");
		return { step };
	}
	return {
		step,
		alpha: await supA.facetList("alpha"),
		beta: await supA.facetList("beta"),
		gammaNew: await supA.facetList("gamma"),
		supB_alpha: await supB.facetList("alpha"),
		supervisorA: await supA.supervisorView(),
	};
};

const b4x = async (env: Env, url: URL) => {
	const nonce = url.searchParams.get("nonce") ?? "x";
	const what = url.searchParams.get("what") ?? "synthetic";
	const sup = env.SUPERVISOR.getByName(`${PREFIX}-b4x-${nonce}`);
	if (what === "synthetic") {
		return await sup.synthetic(url.searchParams.get("step") ?? "write");
	}
	if (what === "cap") {
		return {
			acme: await sup.capIntoFacet("acme"),
			globex: await sup.capIntoFacet("globex"),
		};
	}
	if (what === "limits") {
		return await sup.limits(url.searchParams.get("part") ?? "abort");
	}
	return { error: "unknown what" };
};

const b5 = async (env: Env, url: URL) => {
	const nonce = url.searchParams.get("nonce") ?? "x";
	const n = Number(url.searchParams.get("n") ?? "5");
	return await fanout(env, n, `${PREFIX}-b5-${nonce}`);
};

const b5do = async (env: Env, url: URL) => {
	const nonce = url.searchParams.get("nonce") ?? "x";
	const n = Number(url.searchParams.get("n") ?? "11");
	return await env.SUPERVISOR.getByName(`${PREFIX}-b5do-${nonce}`).concurrency(
		n,
		nonce,
	);
};

const tails = async (env: Env, ctx: ExecutionContext, url: URL) => {
	const nonce = url.searchParams.get("nonce") ?? "x";
	if (url.searchParams.get("step") === "read") {
		return {
			rows: await env.TAILSINK.getByName(`${PREFIX}-tails`).read(
				Number(url.searchParams.get("since") ?? "0"),
			),
		};
	}
	const mk = (install: string, dynId: string) => () =>
		code(TAIL_SRC, {
			tails: [
				exportsOf(ctx).DynTail({
					props: { install, dynId } satisfies TailProps,
				}),
			],
		});
	const idA = `${PREFIX}-tails-A-${nonce}`;
	const idB = `${PREFIX}-tails-B-${nonce}`;
	const a = rpc(env.LOADER.get(idA, mk("A", idA)).getEntrypoint("Api"));
	const b = rpc(env.LOADER.get(idB, mk("B", idB)).getEntrypoint("Api"));
	const out: unknown[] = [];
	for (let k = 0; k < 3; k++) {
		out.push(await a.hello("A", k));
		out.push(await b.hello("B", k));
	}
	out.push({ boomA: await attempt(() => a.boom("A")) });
	return { since: Date.now() - 60_000, ids: [idA, idB], out };
};

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		if (
			!env.SMOKE_KEY || request.headers.get("x-smoke-key") !== env.SMOKE_KEY
		) {
			return new Response("forbidden", { status: 403 });
		}
		const url = new URL(request.url);
		const t0 = Date.now();
		try {
			const routes: Record<string, () => Promise<unknown>> = {
				"/b1": () => b1(env, url),
				"/b1/egress": () => b1egress(env, url),
				"/b1/lat": () => b1lat(env, url),
				"/b2": () => b2(env, request),
				"/b3": () => b3(env, ctx, url),
				"/b3/arg": () => b3arg(env, ctx, url),
				"/b4": () => b4(env, url),
				"/b4x": () => b4x(env, url),
				"/b5": () => b5(env, url),
				"/b5/do": () => b5do(env, url),
				"/tails": () => tails(env, ctx, url),
			};
			const route = routes[url.pathname];
			if (!route) return new Response("not found", { status: 404 });
			return Response.json({
				ok: true,
				serverMs: Date.now() - t0,
				body: await route(),
			});
		} catch (e) {
			return Response.json({
				ok: false,
				serverMs: Date.now() - t0,
				error: errStr(e),
			}, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
