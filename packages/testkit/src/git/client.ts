// A small smart-HTTP git client for tests: reads advertisements, fetches
// packs (v0 and v2) and pushes, through any `fetch` (the FakeArtifacts
// server, a gateway under test, or the network). It builds requests the way
// stock git and Artifacts' importer do, so tests can drive real routes.

import { type Bytes, concat, text } from "../bytes.ts";
import { ZERO_OID } from "./objects.ts";
import { type GitObject } from "./objects.ts";
import { isPack, readPack, writePack } from "./pack.ts";
import {
	delimPkt,
	demuxSideband,
	flushPkt,
	parsePkts,
	type Pkt,
	pkt,
	pktText,
} from "./pktline.ts";

export type FetchLike = (request: Request) => Promise<Response>;

export type Auth =
	| { readonly bearer: string }
	| { readonly basic: { readonly user: string; readonly password: string } }
	| null;

export const authHeaders = (auth: Auth | undefined): Record<string, string> => {
	if (!auth) return {};
	if ("bearer" in auth) return { authorization: `Bearer ${auth.bearer}` };
	return {
		authorization: `Basic ${btoa(`${auth.basic.user}:${auth.basic.password}`)}`,
	};
};

export type Advertisement = {
	readonly status: number;
	readonly refs: ReadonlyMap<string, string>;
	readonly caps: readonly string[];
	/** `symref=HEAD:<ref>` when advertised. */
	readonly headSymref: string | null;
	readonly raw: Uint8Array;
};

/** GET `<url>/info/refs?service=<service>` (protocol v0) and parses it. */
export const advertisement = async (
	fetch: FetchLike,
	url: string,
	options: {
		readonly service?: "git-upload-pack" | "git-receive-pack";
		readonly auth?: Auth;
		readonly headers?: Record<string, string>;
	} = {},
): Promise<Advertisement> => {
	const service = options.service ?? "git-upload-pack";
	const res = await fetch(
		new Request(`${url}/info/refs?service=${service}`, {
			headers: { ...authHeaders(options.auth), ...options.headers },
		}),
	);
	const raw = new Uint8Array(await res.arrayBuffer());
	if (!res.ok) {
		return {
			status: res.status,
			refs: new Map(),
			caps: [],
			headSymref: null,
			raw,
		};
	}
	const { pkts } = parsePkts(raw);
	const lines = pkts.map(pktText).filter((t): t is string => t !== null)
		.filter((t) => !t.startsWith("# service="));
	const refs = new Map<string, string>();
	let caps: string[] = [];
	lines.forEach((line, i) => {
		const [head, capPart] = line.split("\0");
		if (i === 0 && capPart !== undefined) caps = capPart.split(" ");
		const [oid, name] = head.split(" ");
		if (name && name !== "capabilities^{}") refs.set(name, oid);
	});
	const symref = caps.find((c) => c.startsWith("symref=HEAD:"));
	return {
		status: res.status,
		refs,
		caps,
		headSymref: symref ? symref.slice("symref=HEAD:".length) : null,
		raw,
	};
};

export type FetchResult = {
	readonly status: number;
	readonly objects: Map<string, GitObject>;
	/** Bytes after the pack trailer (empty for a well-formed response). */
	readonly trailing: Uint8Array;
	readonly lines: readonly string[];
	readonly raw: Uint8Array;
};

/** A minimal v0 upload-pack request body: one want, a flush, `done`. */
export const importerRequestBody = (want: string): Bytes =>
	concat([pkt(`want ${want} ofs-delta\n`), flushPkt(), pkt("done\n")]);

/** POST `<url>/git-upload-pack` (protocol v0): wants, optional haves, `done`. */
export const fetchPack = async (
	fetch: FetchLike,
	url: string,
	wants: readonly string[],
	options: {
		readonly haves?: readonly string[];
		readonly caps?: readonly string[];
		readonly auth?: Auth;
		readonly headers?: Record<string, string>;
		readonly body?: Bytes;
	} = {},
): Promise<FetchResult> => {
	const caps = options.caps ?? ["side-band-64k", "ofs-delta"];
	const body = options.body ?? concat([
		...wants.map((w, i) =>
			pkt(
				i === 0 && caps.length > 0
					? `want ${w} ${caps.join(" ")}\n`
					: `want ${w}\n`,
			)
		),
		flushPkt(),
		...(options.haves ?? []).map((h) => pkt(`have ${h}\n`)),
		pkt("done\n"),
	]);
	const res = await fetch(
		new Request(`${url}/git-upload-pack`, {
			method: "POST",
			headers: {
				"content-type": "application/x-git-upload-pack-request",
				accept: "application/x-git-upload-pack-result",
				...authHeaders(options.auth),
				...options.headers,
			},
			body,
		}),
	);
	const raw = new Uint8Array(await res.arrayBuffer());
	const empty = {
		status: res.status,
		objects: new Map(),
		trailing: new Uint8Array(0),
		lines: [],
		raw,
	};
	if (!res.ok) return empty;
	// Leading ACK/NAK lines, then either side-band packets or a raw pack.
	const head = parsePkts(raw);
	let at = 0;
	const lines: string[] = [];
	for (const p of head.pkts) {
		const t = pktText(p);
		if (
			t === null || !(t.startsWith("ACK") || t === "NAK" || t.startsWith("ERR"))
		) {
			break;
		}
		lines.push(t);
		at += 4 + (p.kind === "data" ? p.data.length : 0);
	}
	if (lines.some((l) => l.startsWith("ERR"))) return { ...empty, lines };
	if (isPack(raw, at)) {
		const parsed = readPack(raw, at);
		return {
			status: res.status,
			objects: parsed.objects,
			trailing: raw.subarray(parsed.end),
			lines,
			raw,
		};
	}
	const { pkts } = parsePkts(raw, at);
	const { data } = demuxSideband(pkts);
	const parsed = data.length > 0 ? readPack(data) : null;
	return {
		status: res.status,
		objects: parsed?.objects ?? new Map(),
		trailing: new Uint8Array(0),
		lines,
		raw,
	};
};

/** Protocol v2 `ls-refs` (`Git-Protocol: version=2`). */
export const lsRefsV2 = async (
	fetch: FetchLike,
	url: string,
	options: {
		readonly prefixes?: readonly string[];
		readonly symrefs?: boolean;
		readonly peel?: boolean;
		readonly auth?: Auth;
	} = {},
): Promise<{ status: number; lines: string[] }> => {
	const body = concat([
		pkt("command=ls-refs\n"),
		pkt("object-format=sha1\n"),
		delimPkt(),
		...(options.symrefs ? [pkt("symrefs\n")] : []),
		...(options.peel ? [pkt("peel\n")] : []),
		...(options.prefixes ?? []).map((p) => pkt(`ref-prefix ${p}\n`)),
		flushPkt(),
	]);
	const res = await fetch(
		new Request(`${url}/git-upload-pack`, {
			method: "POST",
			headers: {
				"content-type": "application/x-git-upload-pack-request",
				"git-protocol": "version=2",
				...authHeaders(options.auth),
			},
			body,
		}),
	);
	const raw = new Uint8Array(await res.arrayBuffer());
	return {
		status: res.status,
		lines: parsePkts(raw).pkts.map(pktText).filter((t): t is string =>
			t !== null
		),
	};
};

export type RefUpdate = {
	readonly ref: string;
	readonly old?: string;
	readonly new: string;
};

export type PushReport = {
	readonly status: number;
	readonly unpack: string | null;
	/** ref → "ok" or the `ng` reason. */
	readonly refs: ReadonlyMap<string, string>;
	readonly progress: readonly string[];
	readonly raw: Uint8Array;
};

/**
 * POST `<url>/git-receive-pack` with `updates` and a pack of `objects`
 * (undeltified; an empty pack when `objects` is empty and some update is not
 * a delete, as stock git sends for a ref-only create).
 */
export const push = async (
	fetch: FetchLike,
	url: string,
	updates: readonly RefUpdate[],
	objects: readonly GitObject[],
	options: {
		readonly auth?: Auth;
		readonly caps?: readonly string[];
		readonly headers?: Record<string, string>;
	} = {},
): Promise<PushReport> => {
	const caps = options.caps ?? ["report-status", "side-band-64k"];
	const commands = updates.map((u, i) => {
		const line = `${u.old ?? ZERO_OID} ${u.new} ${u.ref}`;
		return pkt(i === 0 ? `${line}\0${caps.join(" ")}\n` : `${line}\n`);
	});
	const deletesOnly = updates.every((u) => u.new === ZERO_OID);
	const body = concat([
		...commands,
		flushPkt(),
		...(deletesOnly ? [] : [writePack(objects)]),
	]);
	const res = await fetch(
		new Request(`${url}/git-receive-pack`, {
			method: "POST",
			headers: {
				"content-type": "application/x-git-receive-pack-request",
				accept: "application/x-git-receive-pack-result",
				...authHeaders(options.auth),
				...options.headers,
			},
			body,
		}),
	);
	const raw = new Uint8Array(await res.arrayBuffer());
	return { status: res.status, ...parseReport(raw, caps), raw };
};

/** Parses a report-status answer (side-band or plain). */
export const parseReport = (
	raw: Uint8Array,
	caps: readonly string[] = ["side-band-64k"],
): Omit<PushReport, "status" | "raw"> => {
	let pkts: Pkt[] = parsePkts(raw).pkts;
	let progress: string[] = [];
	if (caps.includes("side-band-64k") || caps.includes("side-band")) {
		const demuxed = demuxSideband(pkts);
		progress = demuxed.progress;
		pkts = parsePkts(demuxed.data).pkts;
	}
	const lines = pkts.map(pktText).filter((t): t is string => t !== null);
	const unpackLine = lines.find((l) => l.startsWith("unpack "));
	const refs = new Map<string, string>();
	for (const l of lines) {
		if (l.startsWith("ok ")) refs.set(l.slice(3), "ok");
		else if (l.startsWith("ng ")) {
			const rest = l.slice(3);
			const space = rest.indexOf(" ");
			refs.set(rest.slice(0, space), rest.slice(space + 1));
		}
	}
	return {
		unpack: unpackLine ? unpackLine.slice(7) : null,
		refs,
		progress,
	};
};

/** Decodes a raw upload-pack/receive-pack body to printable lines (captures, evidence). */
export const describePkts = (raw: Uint8Array): string[] =>
	parsePkts(raw).pkts.map((p) =>
		p.kind === "data"
			? JSON.stringify(text(p.data))
			: p.kind === "flush"
			? "0000"
			: p.kind === "delim"
			? "0001"
			: "0002"
	);
