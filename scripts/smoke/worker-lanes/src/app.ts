// tartan-smoke-lanes: the lane smoke Worker's request handler (U51–U55, U57,
// U59). It serves the v1 capability shape
// `/-/cap/v1/<exp>/<laneId>/<nonce>/<mac>/<repoId>.git/{info/refs,
// git-upload-pack}` the way the product route does:
//
// 1. syntax (`parseCapPath`), 2. time (`now < exp ≤ now + TTL + 5 s`),
// 3. a constant-time HMAC check over every path segment with a dedicated
//    key, 4. a plain 404 for every failure of 1–3, with per-IP and
//    per-isolate failure buckets (429 above them; a verified MAC is never
//    throttled), and only then 5. one atomic state call (`use`): the nonce
//    is open, at most 3 info uses, and the pack request is single-use.
//
// Only smart upload-pack is served. The advertisement is synthesized:
// `HEAD` → `refs/heads/main` at the attempt's base, whatever the trunk's
// default branch is called; upstream's ref list is never forwarded. The pack
// request must carry exactly one `want`, equal to the base, and `done`
// (`have`, `shallow`, `deepen*`, `filter`, `want-ref` or a second `want` are
// refused and nothing is forwarded). Each upstream request mints its own
// read token, revoked when the response finishes, when it is cancelled, and
// by a `waitUntil` backstop. The response passes through the product's
// `stripV0Trailer`.
//
// The handler takes its dependencies (binding, state, fetch, clock), so the
// same code runs in the Worker (`index.ts`) and in Deno with FakeArtifacts.

import {
	capMacInput,
	capPath,
	laneId as toLaneId,
	parseCapPath,
	redactSecrets,
	ulid,
} from "@tartan/contract";
import {
	checkBearer,
	cleanupRepos,
	errInfo,
	json,
	requirePrefixed,
	runOp,
	timedOp,
	withRepo,
} from "../../lib/ops.ts";
import { CAP_FAILURE_LIMITS } from "@tartan/contract/kernel.ts";
import { stripV0Trailer } from "@tartan/gitproto";

export const PREFIX = "tartan-smoke-lanes";
export const DEFAULT_CAP_TTL_S = 120;
export const CAP_INFO_USES_MAX = 3;
const REQUEST_BODY_MAX = 4 * 1024 * 1024;

export type CapRecord = {
	readonly laneId: string;
	readonly nonce: string;
	readonly repoId: string;
	/** The trunk's Artifacts repo name. */
	readonly repoName: string;
	readonly base: string;
	readonly exp: number;
	readonly infoUses: number;
	readonly consumedAt: number | null;
	readonly closed: boolean;
	/** Smoke knob per capability (U55): serve the base when trunk moved. */
	readonly pinBase?: boolean;
};

/** Capability state (a Durable Object live; a Map locally). */
export type CapStore = {
	put(record: CapRecord): Promise<void>;
	/** Atomic check-and-update for one request; null = refuse (404). */
	use(
		laneId: string,
		nonce: string,
		repoId: string,
		op: "info" | "pack",
		now: number,
	): Promise<CapRecord | null>;
	close(nonce: string): Promise<boolean>;
};

export type CapLog = {
	readonly at: number;
	readonly method: string;
	readonly op: string;
	readonly status: number;
	readonly reason?: string;
	readonly userAgent: string | null;
	readonly gitProtocol: string | null;
	readonly outcome?: string;
	readonly bytes?: number;
	readonly tokenRevoked?: boolean | string;
	readonly stateCalls?: number;
};

export type LanesAppDeps = {
	readonly artifacts: Artifacts;
	/** The dedicated capability key (never a deploy password). */
	readonly capKey: string;
	/** The drivers' bearer key for `/api/*`. */
	readonly smokeKey: string;
	readonly store: CapStore;
	/** Reaches the trunk repos' remotes (global fetch live). */
	readonly upstreamFetch: (request: Request) => Promise<Response>;
	readonly now?: () => number;
	readonly waitUntil?: (p: Promise<unknown>) => void;
	readonly ttlS?: number;
	/** Serve the base even when trunk moved (U55's `LANE_CAP_PIN_BASE`). */
	readonly pinBase?: boolean;
	/** Revoke-anyway backstop delay (default the TTL; 0 disables it in tests). */
	readonly backstopMs?: number;
};

export const createMemoryCapStore = (): CapStore & {
	readonly records: Map<string, CapRecord>;
	stateCalls: number;
} => {
	const records = new Map<string, CapRecord>();
	const store = {
		records,
		stateCalls: 0,
		put: (r: CapRecord) => {
			records.set(r.nonce, r);
			return Promise.resolve();
		},
		use: (
			laneId: string,
			nonce: string,
			repoId: string,
			op: "info" | "pack",
			now: number,
		) => {
			store.stateCalls++;
			const r = records.get(nonce);
			if (
				!r || r.laneId !== laneId || r.repoId !== repoId || r.closed ||
				r.consumedAt !== null || now >= r.exp * 1000
			) {
				return Promise.resolve(null);
			}
			if (op === "info" && r.infoUses >= CAP_INFO_USES_MAX) {
				return Promise.resolve(null);
			}
			const next = op === "info"
				? { ...r, infoUses: r.infoUses + 1 }
				: { ...r, consumedAt: now };
			records.set(nonce, next);
			return Promise.resolve(next);
		},
		close: (nonce: string) => {
			const r = records.get(nonce);
			if (!r) return Promise.resolve(false);
			records.set(nonce, { ...r, closed: true });
			return Promise.resolve(true);
		},
	};
	return store;
};

const hex = (buf: ArrayBuffer): string =>
	Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);
const unhex = (s: string): Uint8Array<ArrayBuffer> =>
	Uint8Array.from(
		{ length: s.length / 2 },
		(_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16),
	);

const enc = new TextEncoder();
const dec = new TextDecoder();

const pkt = (s: string): Uint8Array => {
	const b = enc.encode(s);
	return concat([enc.encode((b.length + 4).toString(16).padStart(4, "0")), b]);
};
const FLUSH = enc.encode("0000");

const concat = (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
};

/** pkt-lines of a request body; null on malformed framing. */
const pktLines = (
	body: Uint8Array,
): ({ kind: "data"; text: string } | { kind: "flush" | "delim" })[] | null => {
	const out: ({ kind: "data"; text: string } | { kind: "flush" | "delim" })[] =
		[];
	let at = 0;
	while (at < body.length) {
		const head = dec.decode(body.subarray(at, at + 4));
		if (!/^[0-9a-f]{4}$/.test(head)) return null;
		const len = parseInt(head, 16);
		if (len === 0) out.push({ kind: "flush" });
		else if (len === 1) out.push({ kind: "delim" });
		else if (len < 4 || at + len > body.length) return null;
		else {
			out.push({
				kind: "data",
				text: dec.decode(body.subarray(at + 4, at + len)).replace(/\n$/, ""),
			});
		}
		at += len < 4 ? 4 : len;
	}
	return out;
};

export type ParsedCapRequest =
	| { readonly kind: "ls-refs"; readonly args: readonly string[] }
	| {
		readonly kind: "fetch";
		readonly v2: boolean;
		readonly want: string;
		readonly sideBand: boolean;
	}
	| { readonly kind: "refused"; readonly reason: string };

const V2_FETCH_ARGS = new Set([
	"done",
	"ofs-delta",
	"thin-pack",
	"no-progress",
	"include-tag",
]);
const V2_CAP_LINE = /^(agent=|object-format=sha1$|server-option=)/;

/** The single-want parser (the fail-closed twin of the public-view parser). */
export const parseCapRequest = (
	body: Uint8Array,
	v2: boolean,
): ParsedCapRequest => {
	const lines = pktLines(body);
	if (lines === null) return { kind: "refused", reason: "malformed pkt-line" };
	const data = (l: (typeof lines)[number]) => l.kind === "data" ? l.text : null;
	if (v2) {
		const command = lines.map(data).find((t) => t?.startsWith("command="));
		const delim = lines.findIndex((l) => l.kind === "delim");
		const head = lines.slice(0, delim < 0 ? lines.length : delim);
		if (
			head.some((l) =>
				l.kind === "data" && !l.text.startsWith("command=") &&
				!V2_CAP_LINE.test(l.text)
			)
		) {
			return { kind: "refused", reason: "unexpected capability line" };
		}
		const args = (delim < 0 ? [] : lines.slice(delim + 1))
			.map(data).filter((t): t is string => t !== null);
		if (command === "command=ls-refs") return { kind: "ls-refs", args };
		if (command !== "command=fetch") {
			return { kind: "refused", reason: `command ${command}` };
		}
		const wants = args.filter((a) => a.startsWith("want "));
		const other = args.filter((a) =>
			!a.startsWith("want ") && !V2_FETCH_ARGS.has(a)
		);
		if (other.length > 0) {
			return { kind: "refused", reason: other[0].split(" ")[0] };
		}
		if (wants.length !== 1 || !args.includes("done")) {
			return { kind: "refused", reason: `wants=${wants.length}` };
		}
		return {
			kind: "fetch",
			v2: true,
			want: wants[0].slice(5),
			sideBand: true,
		};
	}
	const texts = lines.map(data);
	const wantLines = texts.filter((t): t is string =>
		t?.startsWith("want ") ?? false
	);
	const other = texts.filter((t): t is string =>
		t !== null && !t.startsWith("want ") && t !== "done"
	);
	if (other.length > 0) {
		return { kind: "refused", reason: other[0].split(" ")[0] };
	}
	if (wantLines.length !== 1 || !texts.includes("done")) {
		return { kind: "refused", reason: `wants=${wantLines.length}` };
	}
	const [, want, ...caps] = wantLines[0].split(" ");
	return {
		kind: "fetch",
		v2: false,
		want,
		sideBand: caps.includes("side-band") || caps.includes("side-band-64k"),
	};
};

/** Capabilities forwarded from upstream's v0 advertisement (never refs). */
const CAP_ALLOWLIST = new Set([
	"multi_ack",
	"multi_ack_detailed",
	"thin-pack",
	"side-band",
	"side-band-64k",
	"ofs-delta",
	"no-progress",
	"include-tag",
	"allow-tip-sha1-in-want",
	"allow-reachable-sha1-in-want",
	"object-format=sha1",
]);

/** Upstream's v0 advertisement: refs and first-line capabilities. */
const readAdvertisement = (body: Uint8Array) => {
	const lines = pktLines(body) ?? [];
	const refs = new Map<string, string>();
	let caps: string[] = [];
	let first = true;
	for (const l of lines) {
		if (l.kind !== "data" || l.text.startsWith("# service=")) continue;
		const [head, capPart] = l.text.split("\0");
		if (first && capPart !== undefined) caps = capPart.split(" ");
		first = false;
		const [oid, name] = head.split(" ");
		if (name) refs.set(name, oid);
	}
	return { refs, caps };
};

/** The synthesized v0 advertisement: `HEAD` → `refs/heads/main` at `base`. */
export const synthesizeV0 = (base: string, upstreamCaps: readonly string[]) => {
	const caps = [
		...upstreamCaps.filter((c) => CAP_ALLOWLIST.has(c)),
		"symref=HEAD:refs/heads/main",
		"agent=tartan-smoke-lanes",
	].join(" ");
	return concat([
		pkt("# service=git-upload-pack\n"),
		FLUSH,
		pkt(`${base} HEAD\0${caps}\n`),
		pkt(`${base} refs/heads/main\n`),
		FLUSH,
	]);
};

const V2_ADVERTISEMENT = concat([
	pkt("version 2\n"),
	pkt("agent=tartan-smoke-lanes\n"),
	pkt("ls-refs\n"),
	pkt("fetch\n"),
	pkt("object-format=sha1\n"),
	FLUSH,
]);

const synthesizeLsRefs = (base: string, args: readonly string[]) => {
	const prefixes = args.filter((a) => a.startsWith("ref-prefix "))
		.map((a) => a.slice(11));
	const wanted = (n: string) =>
		prefixes.length === 0 || prefixes.some((p) => n.startsWith(p));
	const symrefs = args.includes("symrefs");
	return concat([
		...(wanted("HEAD")
			? [
				pkt(`${base} HEAD${symrefs ? " symref-target:refs/heads/main" : ""}\n`),
			]
			: []),
		...(wanted("refs/heads/main") ? [pkt(`${base} refs/heads/main\n`)] : []),
		FLUSH,
	]);
};

/** Passes every chunk on; reports the byte count at the end, or a cancel. */
const meter = (
	onEnd: (bytes: number) => void,
	onCancel: () => void,
) => {
	let bytes = 0;
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, ctl) {
			bytes += chunk.byteLength;
			ctl.enqueue(chunk);
		},
		flush() {
			onEnd(bytes);
		},
		cancel() {
			onCancel();
		},
	});
};

const notFound = () => new Response("not found\n", { status: 404 });

export type LanesApp = {
	/** `waitUntil` is the request's own (Worker `ctx.waitUntil`). */
	fetch(
		request: Request,
		waitUntil?: (p: Promise<unknown>) => void,
	): Promise<Response>;
	readonly logs: CapLog[];
	/** Failure-bucket state for tests. */
	readonly failures: { isolate: number };
};

export const createLanesApp = (deps: LanesAppDeps): LanesApp => {
	const now = deps.now ?? Date.now;
	const ttlS = deps.ttlS ?? DEFAULT_CAP_TTL_S;
	const waitUntil = deps.waitUntil ?? ((p) => void p.catch(() => {}));
	const logs: CapLog[] = [];
	// The spy for S16-style checks: state calls made by the route.
	let stateCalls = 0;
	const useState = (...args: Parameters<CapStore["use"]>) => {
		stateCalls++;
		return deps.store.use(...args);
	};
	let keyPromise: Promise<CryptoKey> | null = null;
	const key = () =>
		keyPromise ??= crypto.subtle.importKey(
			"raw",
			enc.encode(deps.capKey),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign", "verify"],
		);
	const sign = async (fields: Parameters<typeof capMacInput>[0]) =>
		hex(
			await crypto.subtle.sign(
				"HMAC",
				await key(),
				enc.encode(capMacInput(fields)),
			),
		);

	// Failure buckets (per minute): per client IP and per isolate.
	const failures = {
		isolate: 0,
		windowStart: 0,
		perIp: new Map<string, number>(),
	};
	const fail = (request: Request, reason: string, op: string): Response => {
		const t = now();
		if (t - failures.windowStart >= 60_000) {
			failures.windowStart = t;
			failures.isolate = 0;
			failures.perIp.clear();
		}
		const ip = request.headers.get("cf-connecting-ip") ?? "local";
		const n = (failures.perIp.get(ip) ?? 0) + 1;
		failures.perIp.set(ip, n);
		failures.isolate++;
		const throttled = n > CAP_FAILURE_LIMITS.perIpPerMin ||
			failures.isolate > CAP_FAILURE_LIMITS.perIsolatePerMin;
		const status = throttled ? 429 : 404;
		if (!throttled) {
			logs.push({
				at: t,
				method: request.method,
				op,
				status,
				reason,
				userAgent: request.headers.get("user-agent"),
				gitProtocol: request.headers.get("git-protocol"),
			});
		}
		return throttled
			? new Response("too many requests\n", { status })
			: notFound();
	};

	const mintRead = (repoName: string) =>
		withRepo(deps.artifacts, repoName, async (r) => {
			const t = await r.createToken("read", Math.max(60, ttlS));
			const info = await r.info();
			return {
				token: t,
				remote: info.remote,
				defaultBranch: info.defaultBranch,
			};
		});
	const revoke = (repoName: string, id: string) =>
		withRepo(deps.artifacts, repoName, (r) => r.revokeToken(id)).then(
			(ok) => ok,
			(e) => `error: ${errInfo(e).message}`,
		);

	const capRoute = async (
		request: Request,
		wu: (p: Promise<unknown>) => void,
	): Promise<Response> => {
		const url = new URL(request.url);
		const parts = parseCapPath(url.pathname);
		const opName = url.pathname.endsWith("/info/refs")
			? "info/refs"
			: "git-upload-pack";
		// 1. syntax
		if (!parts) return fail(request, "syntax", opName);
		// 2. time
		const nowS = Math.floor(now() / 1000);
		if (!(nowS < parts.exp && parts.exp <= nowS + ttlS + 5)) {
			return fail(request, "time", opName);
		}
		// 3. MAC over every segment, constant time (WebCrypto verify)
		let macOk = false;
		try {
			macOk = parts.mac.length === 64 &&
				await crypto.subtle.verify(
					"HMAC",
					await key(),
					unhex(parts.mac),
					enc.encode(capMacInput(parts)),
				);
		} catch {
			macOk = false;
		}
		if (!macOk) return fail(request, "mac", opName);
		// Only smart upload-pack.
		const v2 = (request.headers.get("git-protocol") ?? "").includes(
			"version=2",
		);
		const log = (
			entry: Omit<CapLog, "at" | "method" | "userAgent" | "gitProtocol">,
		) => {
			logs.push({
				at: now(),
				method: request.method,
				userAgent: request.headers.get("user-agent"),
				gitProtocol: request.headers.get("git-protocol"),
				...entry,
			});
		};
		if (parts.op === "info/refs") {
			if (
				request.method !== "GET" ||
				url.searchParams.get("service") !== "git-upload-pack"
			) {
				log({ op: "info/refs", status: 404, reason: "service" });
				return notFound();
			}
			const rec = await useState(
				parts.laneId,
				parts.nonce,
				parts.repoId,
				"info",
				now(),
			);
			if (!rec) {
				log({ op: "info/refs", status: 404, reason: "state" });
				return notFound();
			}
			if (v2) {
				log({ op: "info/refs", status: 200, outcome: "v2-advertisement" });
				return gitResponse("git-upload-pack-advertisement", V2_ADVERTISEMENT);
			}
			return await advertise(rec, log, wu);
		}
		if (request.method !== "POST") {
			log({ op: "git-upload-pack", status: 404, reason: "method" });
			return notFound();
		}
		let body: Uint8Array;
		try {
			body = await readBody(request);
		} catch (e) {
			log({ op: "git-upload-pack", status: 413, reason: errInfo(e).message });
			return new Response("request too large\n", { status: 413 });
		}
		const parsed = parseCapRequest(body, v2);
		const op = parsed.kind === "ls-refs" ? "info" : "pack";
		const rec = await useState(
			parts.laneId,
			parts.nonce,
			parts.repoId,
			op,
			now(),
		);
		if (!rec) {
			log({ op: "git-upload-pack", status: 404, reason: "state" });
			return notFound();
		}
		if (parsed.kind === "ls-refs") {
			log({ op: "ls-refs", status: 200, outcome: "synthesized" });
			return gitResponse(
				"git-upload-pack-result",
				synthesizeLsRefs(rec.base, parsed.args),
			);
		}
		if (parsed.kind === "refused" || parsed.want !== rec.base) {
			const reason = parsed.kind === "refused"
				? parsed.reason
				: "want-not-base";
			log({ op: "git-upload-pack", status: 400, reason, outcome: "refused" });
			return new Response(`refused: ${reason}\n`, { status: 400 });
		}
		return await proxyPack(request, rec, parsed, body, log, wu);
	};

	const readBody = async (request: Request): Promise<Uint8Array> => {
		const raw = new Uint8Array(await request.arrayBuffer());
		if (raw.length > REQUEST_BODY_MAX) throw new Error("body above 4 MiB");
		if (!(request.headers.get("content-encoding") ?? "").includes("gzip")) {
			return raw;
		}
		const stream = new Blob([raw]).stream().pipeThrough(
			new DecompressionStream("gzip"),
		);
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > REQUEST_BODY_MAX) {
				await reader.cancel();
				throw new Error("decoded body above 4 MiB");
			}
			chunks.push(value);
		}
		return concat(chunks);
	};

	const advertise = async (
		rec: CapRecord,
		log: (
			e: Omit<CapLog, "at" | "method" | "userAgent" | "gitProtocol">,
		) => void,
		wu: (p: Promise<unknown>) => void,
	): Promise<Response> => {
		let minted;
		try {
			minted = await mintRead(rec.repoName);
		} catch (e) {
			log({ op: "info/refs", status: 502, reason: errInfo(e).message });
			return new Response("upstream unavailable\n", { status: 502 });
		}
		try {
			const res = await deps.upstreamFetch(
				new Request(`${minted.remote}/info/refs?service=git-upload-pack`, {
					headers: { authorization: `Bearer ${minted.token.plaintext}` },
				}),
			);
			const adv = readAdvertisement(new Uint8Array(await res.arrayBuffer()));
			const tip = adv.refs.get(`refs/heads/${minted.defaultBranch}`);
			if (res.status !== 200 || tip === undefined) {
				log({ op: "info/refs", status: 502, reason: `upstream ${res.status}` });
				return new Response("upstream unavailable\n", { status: 502 });
			}
			if (tip !== rec.base && !(rec.pinBase ?? deps.pinBase)) {
				log({ op: "info/refs", status: 503, outcome: "trunk-moved" });
				return new Response("trunk moved\n", { status: 503 });
			}
			log({
				op: "info/refs",
				status: 200,
				outcome: tip === rec.base ? "advertised" : "advertised-pinned-base",
			});
			return gitResponse(
				"git-upload-pack-advertisement",
				synthesizeV0(rec.base, adv.caps),
			);
		} finally {
			wu(revoke(rec.repoName, minted.token.id));
		}
	};

	const proxyPack = async (
		request: Request,
		rec: CapRecord,
		parsed: Extract<ParsedCapRequest, { kind: "fetch" }>,
		body: Uint8Array,
		log: (
			e: Omit<CapLog, "at" | "method" | "userAgent" | "gitProtocol">,
		) => void,
		wu: (p: Promise<unknown>) => void,
	): Promise<Response> => {
		let minted;
		try {
			minted = await mintRead(rec.repoName);
		} catch (e) {
			log({ op: "git-upload-pack", status: 502, reason: errInfo(e).message });
			return new Response("upstream unavailable\n", { status: 502 });
		}
		let revoked: Promise<boolean | string> | null = null;
		const revokeOnce =
			() => (revoked ??= revoke(rec.repoName, minted.token.id));
		// Backstop: whatever happens to the stream, the token is revoked.
		const backstopMs = deps.backstopMs ?? ttlS * 1000;
		if (backstopMs > 0) {
			wu(new Promise((r) => setTimeout(r, backstopMs)).then(revokeOnce));
		}
		request.signal?.addEventListener("abort", () => void revokeOnce());
		let res: Response;
		try {
			res = await deps.upstreamFetch(
				new Request(`${minted.remote}/git-upload-pack`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${minted.token.plaintext}`,
						"content-type": "application/x-git-upload-pack-request",
						...(parsed.v2 ? { "git-protocol": "version=2" } : {}),
					},
					body: concat([body]),
				}),
			);
		} catch (e) {
			await revokeOnce();
			log({
				op: "git-upload-pack",
				status: 502,
				reason: errInfo(e).message,
				outcome: "upstream-error",
			});
			return new Response("upstream fetch failed\n", { status: 502 });
		}
		if (!res.ok || !res.body) {
			await revokeOnce();
			log({
				op: "git-upload-pack",
				status: 502,
				reason: `upstream ${res.status}`,
				outcome: "upstream-error",
			});
			return new Response("upstream unavailable\n", { status: 502 });
		}
		const out = res.body.pipeThrough(stripV0Trailer(parsed)).pipeThrough(
			meter(
				(bytes) => {
					wu(
						revokeOnce().then((tokenRevoked) =>
							log({
								op: "git-upload-pack",
								status: 200,
								outcome: "served",
								bytes,
								tokenRevoked,
							})
						),
					);
				},
				() => {
					wu(
						revokeOnce().then((tokenRevoked) =>
							log({
								op: "git-upload-pack",
								status: 200,
								outcome: "aborted",
								tokenRevoked,
							})
						),
					);
				},
			),
		);
		return new Response(out, {
			status: 200,
			headers: {
				"content-type": "application/x-git-upload-pack-result",
				"cache-control": "no-cache",
			},
		});
	};

	const api = async (request: Request): Promise<Response> => {
		if (!checkBearer(request, deps.smokeKey)) {
			return json({ error: "unauthorized" }, 401);
		}
		const url = new URL(request.url);
		const body = request.method === "POST"
			? await request.json().catch(() => ({})) as Record<string, unknown>
			: {};
		try {
			switch (url.pathname) {
				case "/api/op":
					return json(
						await timedOp(() => runOp(deps.artifacts, PREFIX, body as never)),
					);
				case "/api/cap":
					return json(await mintCapability(url, body));
				case "/api/cap/close":
					return json({ closed: await deps.store.close(String(body.nonce)) });
				case "/api/import":
					return json(
						await timedOp(() =>
							deps.artifacts.import({
								source: {
									url: String(body.url),
									branch: body.branch as string | undefined,
								},
								target: { name: requirePrefixed(PREFIX, body.target) },
							})
						),
					);
				case "/api/records":
					return json(
						logs.map((l) => ({
							...l,
							reason: l.reason && redactSecrets(l.reason),
						})),
					);
				case "/api/cleanup":
					return json(
						await cleanupRepos(
							deps.artifacts,
							PREFIX,
							String(body.startsWith ?? PREFIX),
						),
					);
				case "/api/stats":
					return json({ stateCalls, failures: { isolate: failures.isolate } });
				case "/api/now":
					return json({ now: now() });
			}
			return json({ error: "not found" }, 404);
		} catch (e) {
			return json({ error: errInfo(e) }, 500);
		}
	};

	/** Mints one seed attempt's capability for a trunk repo (the seeder's job in the product). */
	const mintCapability = async (url: URL, body: Record<string, unknown>) => {
		const repoName = requirePrefixed(PREFIX, body.repo);
		const base = typeof body.base === "string"
			? body.base
			: await withRepo(deps.artifacts, repoName, async (r) => {
				const info = await r.info();
				const tip = await r.log({ ref: info.defaultBranch, limit: 1 });
				if (!tip[0]) throw new Error("trunk has no commits");
				return tip[0].hash;
			});
		const fields = {
			exp: Math.floor(now() / 1000) + Math.min(Number(body.ttlS ?? ttlS), ttlS),
			laneId: typeof body.laneId === "string" ? body.laneId : toLaneId(ulid()),
			nonce: hex(crypto.getRandomValues(new Uint8Array(16)).buffer),
			repoId: typeof body.repoId === "string" ? body.repoId : ulid(),
		};
		const mac = await sign(fields);
		await deps.store.put({
			...fields,
			repoName,
			base,
			infoUses: 0,
			consumedAt: null,
			closed: false,
			pinBase: typeof body.pinBase === "boolean" ? body.pinBase : undefined,
		});
		return {
			url: `${url.origin}${capPath({ ...fields, mac })}`,
			...fields,
			mac,
			base,
		};
	};

	return {
		logs,
		get failures() {
			return { isolate: failures.isolate };
		},
		fetch: (request, requestWaitUntil) => {
			const path = new URL(request.url).pathname;
			if (path.startsWith("/-/cap/")) {
				return capRoute(request, requestWaitUntil ?? waitUntil);
			}
			if (path.startsWith("/api/")) return api(request);
			return Promise.resolve(new Response(`${PREFIX}\n`));
		},
	};
};

const gitResponse = (type: string, body: Uint8Array<ArrayBuffer>) =>
	new Response(body, {
		status: 200,
		headers: {
			"content-type": `application/x-${type}`,
			"cache-control": "no-cache",
		},
	});
