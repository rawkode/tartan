// tartan-smoke-git: the git smoke Worker's request handler (A1–A5, S4b) plus
// U45–U48 through `/api/op` and the gateway, S3-raw through the
// synthesized-`ng` route, and the FakeArtifacts conformance suite through
// `/api/conformance`. Every repo name carries the `tartan-smoke-git` prefix.
//
// Routes:
//   /git/<repo>.git/{info/refs,git-upload-pack,git-receive-pack}
//       a minimal smart-HTTP gateway to the repo's Artifacts remote: Basic
//       auth with the smoke key (401 before the body is read), a short-lived
//       upstream token per scope (cached 4 min), receive-pack commands peeked
//       and recorded, bytes and timings recorded.
//   /git-ng/<repo>.git/{info/refs,git-receive-pack}   (S3-raw)
//       the real receive-pack advertisement, then a hand-built 200
//       report-status `ng` for every pushed ref plus band-2 lines; nothing is
//       forwarded.
//   /api/*   Bearer smoke key: binding ops and benches for the drivers.
//
// Dependencies are injected so the handler runs in the Worker (`index.ts`)
// and in Deno with FakeArtifacts (`app.test.ts`, `run.ts --local`).

import { redactSecrets } from "@tartan/contract";
import { runConformance } from "@tartan/testkit";
import {
	checkBearer,
	cleanupRepos,
	errInfo,
	json,
	runOp,
	sameSecret,
	timedOp,
	withRepo,
} from "../../lib/ops.ts";

export const PREFIX = "tartan-smoke-git";

export type RecordRow = {
	readonly seq: number;
	readonly kind: string;
	readonly ts: number;
	readonly data: unknown;
};

/** The Recorder Durable Object's surface (an array locally). */
export type SmokeRecorder = {
	record(kind: string, data: unknown): Promise<number>;
	list(kind?: string, sinceTs?: number): Promise<RecordRow[]>;
	clear(): Promise<number>;
};

export const createMemoryRecorder = (
	now: () => number = Date.now,
): SmokeRecorder & { rows: RecordRow[] } => {
	const rows: RecordRow[] = [];
	return {
		rows,
		record: (kind, data) => {
			const ts = now();
			rows.push({ seq: rows.length + 1, kind, ts, data });
			return Promise.resolve(ts);
		},
		list: (kind, sinceTs = 0) =>
			Promise.resolve(
				rows.filter((r) => (!kind || r.kind === kind) && r.ts >= sinceTs),
			),
		clear: () => {
			const n = rows.length;
			rows.length = 0;
			return Promise.resolve(n);
		},
	};
};

export type GitAppDeps = {
	readonly artifacts: Artifacts;
	readonly smokeKey: string;
	readonly recorder: SmokeRecorder;
	/** Reaches the Artifacts remotes (global fetch live). */
	readonly upstreamFetch: (request: Request) => Promise<Response>;
	/** The push-event Workflow (A5); absent locally. */
	readonly workflow?: Workflow<unknown>;
	/** `bearer` (live default, `UPSTREAM_AUTH`) or `basic`. */
	readonly upstreamAuthMode?: "bearer" | "basic";
	readonly now?: () => number;
};

export type GitApp = {
	fetch(
		request: Request,
		waitUntil?: (p: Promise<unknown>) => void,
	): Promise<Response>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pct = (xs: readonly number[], p: number): number | null => {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

const requirePrefix = (name: unknown): string => {
	if (typeof name !== "string" || !name.toLowerCase().startsWith(PREFIX)) {
		throw new Error(`refusing repo name without prefix ${PREFIX}`);
	}
	return name;
};

/** Basic auth with any user and the smoke key as the password. */
const checkBasic = (request: Request, key: string): boolean => {
	const h = request.headers.get("authorization") ?? "";
	if (!h.toLowerCase().startsWith("basic ")) return false;
	try {
		const decoded = atob(h.slice(6).trim());
		const colon = decoded.indexOf(":");
		return colon >= 0 && sameSecret(decoded.slice(colon + 1), key);
	} catch {
		return false;
	}
};

type RefCmd = { old: string; new: string; ref: string };

/** Peeks receive-pack commands up to the first flush, then replays every byte. */
const peekCommands = async (src: ReadableStream<Uint8Array>) => {
	const reader = src.getReader();
	let buf = new Uint8Array(0);
	let off = 0;
	const cmds: RefCmd[] = [];
	let caps = "";
	let sawFlush = false;
	const need = async (n: number) => {
		while (buf.length - off < n) {
			const { value, done } = await reader.read();
			if (done) return false;
			const next = new Uint8Array(buf.length + value.length);
			next.set(buf);
			next.set(value, buf.length);
			buf = next;
			if (buf.length > 1 << 20) {
				throw new Error("receive-pack command section > 1 MiB");
			}
		}
		return true;
	};
	const dec = new TextDecoder();
	for (;;) {
		if (!(await need(4))) break;
		const len = parseInt(dec.decode(buf.subarray(off, off + 4)), 16);
		off += 4;
		if (Number.isNaN(len)) break;
		if (len === 0) {
			sawFlush = true;
			break;
		}
		if (!(await need(len - 4))) break;
		const line = dec.decode(buf.subarray(off, off + len - 4));
		off += len - 4;
		const [cmd, c] = line.split("\0");
		if (c !== undefined && !caps) caps = c.trim();
		const t = cmd.trimEnd();
		if (t.startsWith("shallow ") || t.startsWith("push-cert")) continue;
		const [o, n, ref] = t.split(" ");
		cmds.push({ old: o, new: n, ref });
	}
	const head = buf;
	let headSent = false;
	const rest = new ReadableStream<Uint8Array>({
		async pull(c) {
			if (!headSent) {
				headSent = true;
				if (head.length) {
					c.enqueue(head);
					return;
				}
			}
			const { value, done } = await reader.read();
			if (done) c.close();
			else c.enqueue(value);
		},
		cancel(r) {
			return reader.cancel(r);
		},
	});
	return { cmds, caps, sawFlush, headBytes: head.length, rest };
};

/** The data lines of a pkt-line body (stops at malformed framing). */
const pktTexts = (raw: Uint8Array): string[] => {
	const dec = new TextDecoder();
	const out: string[] = [];
	let at = 0;
	while (at + 4 <= raw.length) {
		const head = dec.decode(raw.subarray(at, at + 4));
		if (!/^[0-9a-f]{4}$/.test(head)) break;
		const len = parseInt(head, 16);
		if (len < 4) {
			at += 4;
			continue;
		}
		out.push(dec.decode(raw.subarray(at + 4, at + len)).replace(/\n$/, ""));
		at += len;
	}
	return out;
};

const countingStream = (
	onDone: (bytes: number, firstAt: number | null, lastAt: number) => void,
) => {
	let bytes = 0;
	let firstAt: number | null = null;
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, c) {
			if (firstAt === null) firstAt = Date.now();
			bytes += chunk.byteLength;
			c.enqueue(chunk);
		},
		flush() {
			onDone(bytes, firstAt, Date.now());
		},
	});
};

const GIT_RE =
	/^\/(git|git-ng)\/([A-Za-z0-9][A-Za-z0-9._-]*)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const enc = new TextEncoder();
const pkt = (s: string | Uint8Array): Uint8Array => {
	const b = typeof s === "string" ? enc.encode(s) : s;
	const out = new Uint8Array(b.length + 4);
	out.set(enc.encode((b.length + 4).toString(16).padStart(4, "0")));
	out.set(b, 4);
	return out;
};
const concat = (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};
const band = (n: 1 | 2, data: Uint8Array) =>
	pkt(concat([Uint8Array.of(n), data]));

/**
 * S3-raw: a hand-built 200 report-status answer rejecting every pushed ref,
 * with three band-2 lines, as the product gateway will synthesize it.
 */
export const synthesizedNg = (
	cmds: readonly RefCmd[],
	caps: string,
	reason: string,
): Uint8Array<ArrayBuffer> => {
	const report = concat([
		pkt("unpack ok\n"),
		...cmds.map((c) => pkt(`ng ${c.ref} ${reason}\n`)),
		enc.encode("0000"),
	]);
	const sideband = /\bside-band(-64k)?\b/.test(caps);
	if (!sideband) return report;
	return concat([
		band(2, enc.encode("tartan: this push was not forwarded (smoke S3-raw)\n")),
		band(2, enc.encode(`tartan: reason: ${reason}\n`)),
		band(2, enc.encode("tartan: see https://example.invalid/why\n")),
		band(1, report),
		enc.encode("0000"),
	]);
};

export const createGitApp = (deps: GitAppDeps): GitApp => {
	const now = deps.now ?? Date.now;
	const tokenCache = new Map<string, { tok: string; exp: number }>();
	const remoteCache = new Map<string, string>();

	const upstreamToken = async (name: string, scope: "read" | "write") => {
		const k = `${scope}:${name.toLowerCase()}`;
		const c = tokenCache.get(k);
		if (c && c.exp > now()) return { tok: c.tok, mintMs: 0, cached: true };
		const t0 = performance.now();
		const t = await withRepo(
			deps.artifacts,
			name,
			(r) => r.createToken(scope, 300),
		);
		const mintMs = Math.round(performance.now() - t0);
		tokenCache.set(k, { tok: t.plaintext, exp: now() + 240_000 });
		return { tok: t.plaintext, mintMs, cached: false };
	};
	const upstreamRemote = async (name: string) => {
		const c = remoteCache.get(name.toLowerCase());
		if (c) return c;
		const info = await withRepo(deps.artifacts, name, (r) => r.info());
		remoteCache.set(name.toLowerCase(), info.remote);
		return info.remote;
	};

	const gateway = async (
		request: Request,
		m: RegExpExecArray,
		waitUntil: (p: Promise<unknown>) => void,
	): Promise<Response> => {
		const t0 = Date.now();
		const url = new URL(request.url);
		const [, route, name, op] = m;
		const service = op === "info/refs" ? url.searchParams.get("service") : op;
		if (service !== "git-upload-pack" && service !== "git-receive-pack") {
			return new Response("forbidden\n", { status: 403 });
		}
		if (op === "info/refs" && request.method !== "GET") {
			return new Response("method\n", { status: 405 });
		}
		if (op !== "info/refs" && request.method !== "POST") {
			return new Response("method\n", { status: 405 });
		}
		// 401 BEFORE touching the body.
		if (!checkBasic(request, deps.smokeKey)) {
			return new Response("authentication required\n", {
				status: 401,
				headers: {
					"www-authenticate": `Basic realm="${PREFIX}", charset="UTF-8"`,
				},
			});
		}
		if (!name.toLowerCase().startsWith(PREFIX)) {
			return new Response("repo not found\n", { status: 404 });
		}
		const scope = service === "git-receive-pack" ? "write" : "read";
		const log: Record<string, unknown> = {
			route,
			repo: name,
			op,
			service,
			method: request.method,
			gitProtocol: request.headers.get("git-protocol"),
			contentType: request.headers.get("content-type"),
			contentEncoding: request.headers.get("content-encoding"),
			contentLength: request.headers.get("content-length"),
			transferEncoding: request.headers.get("transfer-encoding"),
			userAgent: request.headers.get("user-agent"),
		};
		const finish = () => waitUntil(deps.recorder.record("gateway", log));

		if (route === "git-ng" && op === "git-receive-pack" && request.body) {
			const p = await peekCommands(request.body);
			await p.rest.cancel();
			log.refCommands = p.cmds;
			log.capabilities = p.caps;
			log.synthesized = "ng";
			finish();
			return new Response(
				synthesizedNg(p.cmds, p.caps, "lane-main-only (smoke)"),
				{
					status: 200,
					headers: {
						"content-type": "application/x-git-receive-pack-result",
						"cache-control": "no-cache",
					},
				},
			);
		}

		let tok: string, mintMs: number, cached: boolean, remote: string;
		try {
			({ tok, mintMs, cached } = await upstreamToken(name, scope));
			remote = await upstreamRemote(name);
		} catch (e) {
			log.error = errInfo(e);
			finish();
			return new Response("upstream unavailable\n", { status: 502 });
		}
		log.mintMs = mintMs;
		log.tokenCached = cached;
		const h = new Headers();
		for (
			const k of [
				"content-type",
				"content-encoding",
				"accept",
				"git-protocol",
				"user-agent",
			]
		) {
			const v = request.headers.get(k);
			if (v) h.set(k, v);
		}
		h.set(
			"authorization",
			deps.upstreamAuthMode === "basic"
				? `Basic ${btoa(`x:${tok.split("?")[0]}`)}`
				: `Bearer ${tok}`,
		);
		let body: ReadableStream<Uint8Array> | null = null;
		if (request.method === "POST" && request.body) {
			body = request.body;
			if (op === "git-receive-pack") {
				const tp = Date.now();
				const p = await peekCommands(body);
				log.peekMs = Date.now() - tp;
				log.refCommands = p.cmds;
				log.capabilities = p.caps;
				log.sawFlush = p.sawFlush;
				log.peekHeadBytes = p.headBytes;
				log.isProbe = p.cmds.length === 0 && p.headBytes === 4;
				body = p.rest;
			} else if (!request.headers.get("content-encoding")) {
				// U47: what stock git asks for (v2 command, ref-prefix arguments,
				// v0 wants/haves). Upload-pack requests are small.
				const raw = new Uint8Array(await new Response(body).arrayBuffer());
				const lines = pktTexts(raw);
				log.uploadCommand = lines.find((l) => l.startsWith("command="));
				log.refPrefixes = lines.filter((l) => l.startsWith("ref-prefix "))
					.map((l) => l.slice(11));
				log.wants = lines.filter((l) => l.startsWith("want ")).length;
				log.haves = lines.filter((l) => l.startsWith("have ")).length;
				body = new Response(raw).body!;
			}
			body = body.pipeThrough(
				countingStream((bytes, firstAt, lastAt) => {
					log.reqBytesForwarded = bytes;
					log.reqFirstChunkAtMs = firstAt === null ? null : firstAt - t0;
					log.reqLastChunkAtMs = lastAt - t0;
				}),
			);
		}
		const tf = Date.now();
		let res: Response;
		try {
			// Streamed (`duplex: "half"` is required by Deno, ignored by workerd).
			const init = {
				method: request.method,
				headers: h,
				body,
				redirect: "manual",
				duplex: "half",
			} as RequestInit;
			res = await deps.upstreamFetch(
				new Request(`${remote}/${op}${url.search}`, init),
			);
		} catch (e) {
			log.error = errInfo(e);
			finish();
			return new Response("upstream fetch failed\n", { status: 502 });
		}
		log.upstreamStatus = res.status;
		log.upstreamTtfbMs = Date.now() - tf;
		log.upstreamContentType = res.headers.get("content-type");
		const out = new Headers();
		for (const k of ["content-type", "content-encoding", "expires", "pragma"]) {
			const v = res.headers.get(k);
			if (v) out.set(k, v);
		}
		out.set("cache-control", "no-cache, max-age=0, must-revalidate");
		out.set("x-tartan-mint-ms", String(mintMs));
		out.set("x-tartan-upstream-ttfb-ms", String(log.upstreamTtfbMs));
		if (res.status === 401 || res.status === 403) {
			log.note = "upstream rejected credentials";
			finish();
			return new Response(`upstream rejected credentials (${res.status})\n`, {
				status: 502,
				headers: out,
			});
		}
		const resBody = res.body
			? res.body.pipeThrough(
				countingStream((bytes, firstAt, lastAt) => {
					log.resBytes = bytes;
					log.resFirstChunkAtMs = firstAt === null ? null : firstAt - t0;
					log.totalMs = lastAt - t0;
					finish();
				}),
			)
			: (finish(), null);
		return new Response(resBody, { status: res.status, headers: out });
	};

	const mintBench = async (body: Record<string, unknown>) => {
		const name = requirePrefix(body.name);
		const n = Math.min(Number(body.n ?? 20), 50);
		const scope = body.scope === "write" ? "write" : "read";
		const ms: number[] = [];
		const getMs: number[] = [];
		const errs: unknown[] = [];
		for (let i = 0; i < n; i++) {
			const tg = performance.now();
			const repo = await deps.artifacts.get(name);
			getMs.push(Math.round(performance.now() - tg));
			const r = await timedOp(() => repo.createToken(scope, 60));
			(repo as unknown as { [Symbol.dispose]?: () => void })
				[Symbol.dispose]?.();
			if (r.ok) ms.push(r.ms);
			else errs.push(r.error);
		}
		return {
			n,
			scope,
			ok: ms.length,
			errs: errs.slice(0, 3),
			createToken_p50: pct(ms, 50),
			createToken_p95: pct(ms, 95),
			createToken_max: ms.length ? Math.max(...ms) : null,
			get_p50: pct(getMs, 50),
			get_p95: pct(getMs, 95),
		};
	};

	/** S4b: sustained binding reads at `ratePerSec` for `durationMs`. */
	const readBurst = async (body: Record<string, unknown>) => {
		const name = requirePrefix(body.name);
		const ratePerSec = Number(body.ratePerSec ?? 50);
		const durationMs = Number(body.durationMs ?? 10_000);
		if ((ratePerSec * durationMs) / 1000 > 3000) {
			throw new Error("cap 3000 ops per invocation");
		}
		const tree = String(body.tree);
		const blob = String(body.blob);
		const repo = await deps.artifacts.get(name);
		const t0 = performance.now();
		const interval = 1000 / ratePerSec;
		const total = Math.floor((ratePerSec * durationMs) / 1000);
		const lat: number[] = [];
		const errCodes: Record<string, number> = {};
		const ps: Promise<void>[] = [];
		let firstErrAtMs: number | null = null;
		for (let i = 0; i < total; i++) {
			const due = i * interval;
			const elapsed = performance.now() - t0;
			if (due > elapsed) await sleep(due - elapsed);
			const isTree = i % 2 === 0;
			ps.push((async () => {
				const s = performance.now();
				try {
					if (isTree) {
						if (!(await repo.readTree(tree))) {
							throw Object.assign(new Error("readTree null"), { code: "NULL" });
						}
					} else {
						const b = await repo.readBlob(blob);
						if (!b) {
							throw Object.assign(new Error("readBlob null"), { code: "NULL" });
						}
						await b.arrayBuffer();
					}
					lat.push(performance.now() - s);
				} catch (e) {
					const ei = errInfo(e);
					const k = `${ei.code ?? ei.name}:${ei.numericCode ?? ""}`;
					errCodes[k] = (errCodes[k] ?? 0) + 1;
					firstErrAtMs ??= Math.round(performance.now() - t0);
				}
			})());
		}
		const issuedMs = Math.round(performance.now() - t0);
		await Promise.all(ps);
		(repo as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
		const L = lat.map((x) => Math.round(x));
		return {
			ratePerSec,
			durationMs,
			total,
			ok: L.length,
			errors: total - L.length,
			errCodes,
			firstErrAtMs,
			issuedMs,
			wallMs: Math.round(performance.now() - t0),
			lat_p50: pct(L, 50),
			lat_p95: pct(L, 95),
			lat_p99: pct(L, 99),
			lat_max: L.length ? Math.max(...L) : null,
		};
	};

	/** A5b: createBatch with duplicate ids. */
	const wfBatchDup = async (wf: Workflow<unknown>) => {
		const tag = now().toString(36);
		const dupId = `smoke-dup-${tag}`;
		const out: Record<string, unknown> = { dupId };
		out.batchWithDuplicateInside = await timedOp(async () => {
			const r = await wf.createBatch([
				{ id: dupId, params: { smokeTest: "dup-a" } },
				{ id: dupId, params: { smokeTest: "dup-b" } },
				{ id: `${dupId}-other`, params: { smokeTest: "other" } },
			]);
			return { returned: r.length, ids: r.map((i) => i.id) };
		});
		out.batchWithExistingId = await timedOp(async () => {
			const r = await wf.createBatch([
				{ id: dupId, params: { smokeTest: "dup-c-existing" } },
				{ id: `${dupId}-new`, params: { smokeTest: "new" } },
			]);
			return { returned: r.length, ids: r.map((i) => i.id) };
		});
		out.createWithExistingId = await timedOp(async () => ({
			id:
				(await wf.create({ id: dupId, params: { smokeTest: "dup-d-create" } }))
					.id,
		}));
		await sleep(5000);
		const statuses: Record<string, unknown> = {};
		for (const id of [dupId, `${dupId}-other`, `${dupId}-new`]) {
			statuses[id] = await timedOp(async () => (await wf.get(id)).status());
		}
		out.statusesAfter5s = statuses;
		return out;
	};

	const api = async (request: Request): Promise<Response> => {
		if (!checkBearer(request, deps.smokeKey)) {
			return json({ error: "unauthorized" }, 401);
		}
		const url = new URL(request.url);
		const body = request.method === "POST"
			? (await request.json().catch(() => ({}))) as Record<string, unknown>
			: {};
		const wf = deps.workflow;
		try {
			switch (url.pathname) {
				case "/api/op":
					return json(
						await timedOp(() => runOp(deps.artifacts, PREFIX, body as never)),
					);
				case "/api/mint-bench":
					return json(await mintBench(body));
				case "/api/import":
					// U57: imports into this namespace, whose push trigger is watched.
					return json(
						await timedOp(() =>
							deps.artifacts.import({
								source: {
									url: String(body.url),
									branch: body.branch as string | undefined,
								},
								target: { name: requirePrefix(body.target) },
							})
						),
					);
				case "/api/read-burst":
					return json(await readBurst(body));
				case "/api/conformance":
					return json(
						await runConformance({
							artifacts: deps.artifacts,
							fetch: deps.upstreamFetch,
							prefix: `${PREFIX}-conf-${now().toString(36)}`,
							importSource: body.importSource as never,
						}),
					);
				case "/api/wf-wait-test": {
					if (!wf) return json({ error: "no workflow binding" }, 501);
					const tag = now().toString(36);
					const early = await wf.create({
						id: `smoke-wait-early-${tag}`,
						params: { waitTest: "early", sleepS: 8 },
					});
					const tc = now();
					const send = await timedOp(() =>
						early.sendEvent({
							type: "smoke-ping",
							payload: { sentAt: tc, which: "early" },
						})
					);
					const late = await wf.create({
						id: `smoke-wait-late-${tag}`,
						params: { waitTest: "late", sleepS: 2 },
					});
					return json({ early: early.id, earlySend: send, late: late.id });
				}
				case "/api/wf-send": {
					if (!wf) return json({ error: "no workflow binding" }, 501);
					return json(
						await timedOp(async () =>
							(await wf.get(String(body.id))).sendEvent({
								type: "smoke-ping",
								payload: { sentAt: now(), which: "late" },
							})
						),
					);
				}
				case "/api/wf-batch-dup":
					if (!wf) return json({ error: "no workflow binding" }, 501);
					return json(await wfBatchDup(wf));
				case "/api/wf-status": {
					if (!wf) return json({ error: "no workflow binding" }, 501);
					const id = url.searchParams.get("id") ?? "";
					return json(await timedOp(async () => (await wf.get(id)).status()));
				}
				case "/api/records":
					return json(
						JSON.parse(
							redactSecrets(
								JSON.stringify(
									await deps.recorder.list(
										url.searchParams.get("kind") ?? undefined,
										Number(url.searchParams.get("since") ?? 0),
									),
								),
							),
						),
					);
				case "/api/records/clear":
					return json({ cleared: await deps.recorder.clear() });
				case "/api/cleanup":
					return json(
						await cleanupRepos(
							deps.artifacts,
							PREFIX,
							String(body.startsWith ?? PREFIX),
						),
					);
				case "/api/now":
					return json({ now: now() });
			}
			return json({ error: "not found" }, 404);
		} catch (e) {
			return json({ error: errInfo(e) }, 500);
		}
	};

	return {
		fetch: (request, waitUntil = (p) => void p.catch(() => {})) => {
			const url = new URL(request.url);
			const g = GIT_RE.exec(url.pathname);
			if (g) return gateway(request, g, waitUntil);
			if (url.pathname.startsWith("/api/")) return api(request);
			return Promise.resolve(new Response(`${PREFIX}\n`));
		},
	};
};
