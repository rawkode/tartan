// Smart-HTTP for the fake repos' remotes
// (`https://<host>/git/<namespace>/<name>.git/...`):
// - auth: `Bearer <token>` or Basic `x:<token>`, the token with or without
//   `?expires=`; none → 401 `WWW-Authenticate: Basic realm="artifacts"`; a
//   wrong, expired or revoked token, or one minted for another repo → 403
//   "Invalid or expired token"; a read token on receive-pack → 403
//   "Insufficient permissions";
// - upload-pack: protocol v0/v1 and v2 (`ls-refs` with `ref-prefix`,
//   `symrefs`, `peel`; `fetch`); the v0 advertisement carries stock git's
//   capabilities and `symref=HEAD:<default branch>`;
// - receive-pack: report-status and report-status-v2, side-band-64k,
//   per-ref compare-and-swap, an empty pack for ref-only updates, the
//   `0000` probe; one push event per updated ref (`events.ts`).

import { gunzipSync } from "node:zlib";
import { type Bytes, concat, readAll, text } from "../bytes.ts";
import { parseTag, SHA_RE, ZERO_OID } from "../git/objects.ts";
import { isPack, readPack, writePack } from "../git/pack.ts";
import {
	delimPkt,
	flushPkt,
	parsePkts,
	type Pkt,
	pkt,
	pktText,
	sideband,
} from "../git/pktline.ts";
import { reachableObjects } from "../git/store.ts";
import { type FakePushEvent, pushEvent } from "./events.ts";
import type { FakeArtifactsOp, FaultPlan } from "./faults.ts";
import {
	type FakeState,
	findRepo,
	record,
	type RepoState,
	tokenSecret,
	tokenStateName,
} from "./state.ts";

export const FAKE_AGENT = "artifacts-fake/1";

const UPLOAD_CAPS_V0 = [
	"multi_ack",
	"thin-pack",
	"side-band",
	"side-band-64k",
	"ofs-delta",
	"shallow",
	"no-progress",
	"include-tag",
	"multi_ack_detailed",
	"allow-tip-sha1-in-want",
	"allow-reachable-sha1-in-want",
	"object-format=sha1",
	`agent=${FAKE_AGENT}`,
];
const RECEIVE_CAPS = [
	"report-status",
	"report-status-v2",
	"delete-refs",
	"side-band-64k",
	"quiet",
	"atomic",
	"ofs-delta",
	"object-format=sha1",
	`agent=${FAKE_AGENT}`,
];
const V2_CAPS = [
	"version 2",
	`agent=${FAKE_AGENT}`,
	"ls-refs=unborn",
	"fetch=shallow",
	"server-option",
	"object-format=sha1",
];

export type GitServerOptions = {
	readonly state: FakeState;
	readonly faults: FaultPlan;
	readonly onPush: (event: FakePushEvent) => void;
};

const PATH_RE =
	/^\/git\/([^/]+)\/([A-Za-z0-9._-]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

const plain = (status: number, body: string, headers: HeadersInit = {}) =>
	new Response(body, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8", ...headers },
	});

const gitResponse = (type: string, body: Bytes) =>
	new Response(body, {
		status: 200,
		headers: {
			"content-type": `application/x-${type}`,
			"cache-control": "no-cache",
		},
	});

/** The token a request presents, or null when it has no Authorization. */
export const presentedToken = (request: Request): string | null => {
	const header = request.headers.get("authorization");
	if (!header) return null;
	const [scheme, value = ""] = header.split(/\s+/, 2);
	if (scheme.toLowerCase() === "bearer") return value;
	if (scheme.toLowerCase() === "basic") {
		try {
			const decoded = atob(value);
			const colon = decoded.indexOf(":");
			return colon < 0 ? "" : decodeURIComponent(decoded.slice(colon + 1));
		} catch {
			return "";
		}
	}
	return "";
};

const symrefHead = (repo: RepoState): string =>
	`refs/heads/${repo.defaultBranch}`;

const headOid = (repo: RepoState): string | undefined =>
	repo.refs.get(symrefHead(repo));

const sortedRefs = (repo: RepoState): [string, string][] =>
	[...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const peeled = (repo: RepoState, oid: string): string | null => {
	const object = repo.store.get(oid);
	return object?.type === "tag" ? parseTag(object.data).object : null;
};

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

const v0Advertisement = (
	repo: RepoState,
	service: "git-upload-pack" | "git-receive-pack",
): Bytes => {
	const head = headOid(repo);
	const caps = (service === "git-upload-pack"
		? [
			...UPLOAD_CAPS_V0,
			...(head ? [`symref=HEAD:${symrefHead(repo)}`] : []),
		]
		: RECEIVE_CAPS).join(" ");
	const lines: [string, string][] = [];
	if (service === "git-upload-pack" && head) lines.push([head, "HEAD"]);
	for (const [ref, oid] of sortedRefs(repo)) {
		lines.push([oid, ref]);
		if (service === "git-upload-pack") {
			const p = peeled(repo, oid);
			if (p) lines.push([p, `${ref}^{}`]);
		}
	}
	const refPkts = lines.length === 0
		? [pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`)]
		: lines.map(([oid, name], i) =>
			pkt(i === 0 ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`)
		);
	return concat([
		pkt(`# service=${service}\n`),
		flushPkt(),
		...refPkts,
		flushPkt(),
	]);
};

const v2Advertisement = (): Bytes =>
	concat([...V2_CAPS.map((c) => pkt(`${c}\n`)), flushPkt()]);

// ---------------------------------------------------------------------------
// Upload-pack
// ---------------------------------------------------------------------------

const packFor = (
	repo: RepoState,
	wants: readonly string[],
	haves: readonly string[],
): Bytes => {
	const { oids } = reachableObjects(repo.store, wants, haves);
	return writePack(oids.map((oid) => repo.store.get(oid)!));
};

const errPkt = (message: string): Bytes => pkt(`ERR ${message}\n`);

const lsRefsV2 = (repo: RepoState, args: readonly string[]): Bytes => {
	const prefixes = args.filter((a) => a.startsWith("ref-prefix "))
		.map((a) => a.slice("ref-prefix ".length));
	const symrefs = args.includes("symrefs");
	const peel = args.includes("peel");
	const unborn = args.includes("unborn");
	const wanted = (name: string) =>
		prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
	const lines: string[] = [];
	const head = headOid(repo);
	if (wanted("HEAD")) {
		if (head) {
			lines.push(
				`${head} HEAD${symrefs ? ` symref-target:${symrefHead(repo)}` : ""}`,
			);
		} else if (unborn) {
			lines.push(`unborn HEAD symref-target:${symrefHead(repo)}`);
		}
	}
	for (const [ref, oid] of sortedRefs(repo)) {
		if (!wanted(ref)) continue;
		const p = peel ? peeled(repo, oid) : null;
		lines.push(`${oid} ${ref}${p ? ` peeled:${p}` : ""}`);
	}
	return concat([...lines.map((l) => pkt(`${l}\n`)), flushPkt()]);
};

const fetchV2 = (repo: RepoState, args: readonly string[]): Bytes => {
	const wants = args.filter((a) => a.startsWith("want ")).map((a) =>
		a.slice(5)
	);
	const haves = args.filter((a) => a.startsWith("have ")).map((a) =>
		a.slice(5)
	);
	const done = args.includes("done");
	const missing = wants.find((w) => !SHA_RE.test(w) || !repo.store.has(w));
	if (missing !== undefined) {
		return concat([errPkt(`upload-pack: not our ref ${missing}`), flushPkt()]);
	}
	const common = haves.filter((h) => repo.store.has(h));
	const ack: Bytes[] = [];
	if (!done && haves.length > 0) {
		ack.push(pkt("acknowledgments\n"));
		if (common.length === 0) {
			return concat([...ack, pkt("NAK\n"), flushPkt()]);
		}
		ack.push(...common.map((c) => pkt(`ACK ${c}\n`)), pkt("ready\n"));
		ack.push(delimPkt());
	}
	return concat([
		...ack,
		pkt("packfile\n"),
		...sideband(1, packFor(repo, wants, common)),
		flushPkt(),
	]);
};

const uploadPackV2 = (repo: RepoState, body: Uint8Array): Bytes => {
	const { pkts } = parsePkts(body);
	const lines = pkts.map((p) => ({ p, t: pktText(p) }));
	const command = lines.find((l) => l.t?.startsWith("command="))?.t?.slice(8);
	const delim = pkts.findIndex((p) => p.kind === "delim");
	const args = (delim < 0 ? [] : pkts.slice(delim + 1))
		.map(pktText)
		.filter((t): t is string => t !== null);
	if (command === "ls-refs") return lsRefsV2(repo, args);
	if (command === "fetch") return fetchV2(repo, args);
	return concat([errPkt(`unknown command ${command}`), flushPkt()]);
};

const uploadPackV0 = (repo: RepoState, body: Uint8Array): Bytes => {
	const { pkts } = parsePkts(body);
	const texts = pkts.map(pktText).filter((t): t is string => t !== null);
	const wantLines = texts.filter((t) => t.startsWith("want "));
	if (wantLines.length === 0) return new Uint8Array(0);
	const caps = wantLines[0].split(" ").slice(2);
	const wants = wantLines.map((l) => l.split(" ")[1]);
	const haves = texts.filter((t) => t.startsWith("have ")).map((t) =>
		t.split(" ")[1]
	);
	const missing = wants.find((w) => !SHA_RE.test(w) || !repo.store.has(w));
	if (missing !== undefined) {
		return errPkt(`upload-pack: not our ref ${missing}`);
	}
	const common = haves.filter((h) => repo.store.has(h));
	const ack = common.length > 0 ? pkt(`ACK ${common[0]}\n`) : pkt("NAK\n");
	const pack = packFor(repo, wants, common);
	const band = caps.includes("side-band-64k") || caps.includes("side-band");
	if (band) {
		const max = caps.includes("side-band-64k") ? 65515 : 999;
		return concat([ack, ...sideband(1, pack, max), flushPkt()]);
	}
	return concat([ack, pack]);
};

// ---------------------------------------------------------------------------
// Receive-pack
// ---------------------------------------------------------------------------

type Command = { old: string; new: string; ref: string };

const parseCommands = (
	body: Uint8Array,
): { commands: Command[]; caps: string[]; packAt: number } => {
	const { pkts, offset } = parsePkts(body, 0, 1);
	const datas = pkts.filter((p): p is Extract<Pkt, { kind: "data" }> =>
		p.kind === "data"
	);
	let caps: string[] = [];
	const commands: Command[] = [];
	for (const [i, p] of datas.entries()) {
		const raw = text(p.data).replace(/\n$/, "");
		const [line, capPart] = raw.split("\0");
		if (i === 0 && capPart !== undefined) caps = capPart.trim().split(" ");
		if (line.startsWith("shallow ")) continue;
		const [o, n, ref] = line.split(" ");
		commands.push({ old: o, new: n, ref });
	}
	let packAt = offset;
	if (caps.includes("push-options")) {
		packAt = parsePkts(body, offset, 1).offset;
	}
	return { commands, caps, packAt };
};

const validRef = (ref: string | undefined): ref is string =>
	typeof ref === "string" && ref.startsWith("refs/") &&
	!ref.includes("..") && !ref.endsWith("/") && !/[\s~^:?*[\\]/.test(ref);

const receivePack = (
	opts: GitServerOptions,
	repo: RepoState,
	body: Uint8Array,
): Bytes => {
	const { commands, caps, packAt } = parseCommands(body);
	if (commands.length === 0) return new Uint8Array(0); // probe or empty push
	let unpack = "ok";
	const objects = new Map<string, ReturnType<typeof repo.store.get>>();
	if (isPack(body, packAt)) {
		try {
			const parsed = readPack(body, packAt, (oid) => repo.store.get(oid));
			parsed.objects.forEach((o, oid) => objects.set(oid, o));
		} catch (e) {
			unpack = `unpack error ${(e as Error).message}`;
		}
	}
	const has = (oid: string) => objects.has(oid) || repo.store.has(oid);
	const results = commands.map((c) => {
		if (unpack !== "ok") return { c, error: "unpacker error" };
		if (!validRef(c.ref)) return { c, error: "funny refname" };
		if (!SHA_RE.test(c.old) || !SHA_RE.test(c.new)) {
			return { c, error: "malformed command" };
		}
		const current = repo.refs.get(c.ref) ?? ZERO_OID;
		if (current !== c.old) return { c, error: "failed to update ref" };
		if (c.new !== ZERO_OID && !has(c.new)) {
			return { c, error: "missing necessary objects" };
		}
		return { c, error: null as string | null };
	});
	const atomic = caps.includes("atomic");
	const anyFailed = results.some((r) => r.error !== null);
	const final = atomic && anyFailed
		? results.map((r) => ({
			c: r.c,
			error: r.error ?? "atomic push failure",
		}))
		: results;
	if (unpack === "ok") {
		objects.forEach((o) => o && repo.store.put(o));
	}
	const applied: { ref: string; before: string; after: string }[] = [];
	for (const r of final) {
		if (r.error !== null) continue;
		const before = repo.refs.get(r.c.ref) ?? ZERO_OID;
		if (r.c.new === ZERO_OID) repo.refs.delete(r.c.ref);
		else repo.refs.set(r.c.ref, r.c.new);
		if (before !== r.c.new) {
			applied.push({ ref: r.c.ref, before, after: r.c.new });
		}
	}
	for (const a of applied) {
		opts.onPush(
			pushEvent(opts.state.namespace, repo, a.ref, a.before, a.after),
		);
	}
	const reporting = caps.includes("report-status") ||
		caps.includes("report-status-v2");
	if (!reporting) return new Uint8Array(0);
	const report = concat([
		pkt(`unpack ${unpack}\n`),
		...final.map((r) =>
			pkt(r.error === null ? `ok ${r.c.ref}\n` : `ng ${r.c.ref} ${r.error}\n`)
		),
		flushPkt(),
	]);
	return caps.includes("side-band-64k") || caps.includes("side-band")
		? concat([...sideband(1, report), flushPkt()])
		: report;
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const authorize = (
	state: FakeState,
	request: Request,
	repo: RepoState,
	write: boolean,
): Response | null => {
	const presented = presentedToken(request);
	if (presented === null) {
		return plain(401, "Authentication required\n", {
			"www-authenticate": 'Basic realm="artifacts"',
		});
	}
	const secret = tokenSecret(presented);
	const token = repo.tokens.find((t) => t.secret === secret);
	if (!token || tokenStateName(state, token) !== "active") {
		return plain(403, "Invalid or expired token\n");
	}
	if (write && (token.scope !== "write" || repo.readOnly)) {
		return plain(403, "Insufficient permissions\n");
	}
	return null;
};

const decodeBody = async (request: Request): Promise<Uint8Array> => {
	const raw = await readAll(request.body);
	return (request.headers.get("content-encoding") ?? "").includes("gzip")
		? new Uint8Array(gunzipSync(raw))
		: raw;
};

export const createGitServer = (opts: GitServerOptions) => {
	const { state, faults } = opts;
	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const m = url.origin === state.origin ? PATH_RE.exec(url.pathname) : null;
		const service = m?.[3] === "info/refs"
			? url.searchParams.get("service")
			: m?.[3];
		const op: FakeArtifactsOp = m?.[3] === "info/refs"
			? "git.info-refs"
			: m?.[3] === "git-receive-pack"
			? "git.receive-pack"
			: "git.upload-pack";
		const detail = `${request.method} ${url.pathname}${url.search}`;
		const respond = (response: Response) => {
			record(state, op, `${detail} → ${response.status}`);
			return response;
		};
		if (!m || m[1] !== state.namespace) {
			return respond(plain(404, "Not found\n"));
		}
		if (service !== "git-upload-pack" && service !== "git-receive-pack") {
			return respond(plain(403, "Smart HTTP only\n"));
		}
		const expected = m[3] === "info/refs" ? "GET" : "POST";
		if (request.method !== expected) {
			return respond(plain(405, "Method not allowed\n"));
		}
		const repo = findRepo(state, m[2]);
		if (!repo) return respond(plain(404, "Repository not found\n"));
		const denied = authorize(
			state,
			request,
			repo,
			service === "git-receive-pack",
		);
		if (denied) return respond(denied);
		const fault = faults.take(op, [repo.name]);
		if (fault?.kind === "rate-limit") {
			return respond(plain(429, "Too Many Requests\n"));
		}
		if (fault?.kind === "error") {
			return respond(plain(500, `${fault.code}\n`));
		}
		if (fault?.kind === "latency" || fault?.kind === "timeout") {
			await new Promise((r) => setTimeout(r, fault.ms));
			if (fault.kind === "timeout") {
				return respond(plain(504, "Gateway Timeout\n"));
			}
		}
		const v2 = (request.headers.get("git-protocol") ?? "").includes(
			"version=2",
		);
		if (m[3] === "info/refs") {
			return respond(
				gitResponse(
					`${service}-advertisement`,
					v2 && service === "git-upload-pack"
						? v2Advertisement()
						: v0Advertisement(repo, service),
				),
			);
		}
		const body = await decodeBody(request);
		if (service === "git-upload-pack") {
			return respond(
				gitResponse(
					"git-upload-pack-result",
					v2 ? uploadPackV2(repo, body) : uploadPackV0(repo, body),
				),
			);
		}
		return respond(
			gitResponse("git-receive-pack-result", receivePack(opts, repo, body)),
		);
	};
};
