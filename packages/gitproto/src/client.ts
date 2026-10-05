// Clients the kernel uses against an upstream smart-HTTP remote: v2
// `ls-refs` for reconciliation and lane tips, and a
// ref-only receive-pack (commands plus an empty pack) for the kernel's
// ref-only writes. gitproto never mints, logs or stores a credential: the
// caller passes the `Authorization` value and no error message repeats it.

import type { PushCommand } from "@tartan/contract/kernel.ts";
import { invalid, SHA1_RE, unavailable, ZERO_SHA } from "@tartan/contract";
import {
	asBytes,
	type Bytes,
	concat,
	decodeLenient,
	decodeStrict,
	readCapped,
} from "./bytes.ts";
import {
	chomp,
	decodePktLines,
	encodePktLine,
	encodeSpecialPkt,
} from "./pktline.ts";
import { writePack } from "./pack.ts";
import { parseReportStatus, type RefStatus } from "./report.ts";
import { demuxSideband } from "./sideband.ts";
import { isValidPushRefname } from "./refname.ts";

/**
 * An upstream smart-HTTP remote. The caller supplies the `Authorization`
 * header value (its own scoped token); gitproto never mints or stores one.
 */
export type GitRemote = {
	/** The repository URL (`ArtifactsRepoInfo.remote`). */
	readonly url: string;
	readonly authorization: string;
	/** Defaults to the global `fetch`. */
	readonly fetch?: typeof fetch;
};

export type LsRef = {
	readonly ref: string;
	readonly sha: string;
	readonly peeled?: string;
	readonly symrefTarget?: string;
};

export type ClientOptions = {
	readonly signal?: AbortSignal;
	/** Response body cap (default 16 MiB). */
	readonly maxResponseBytes?: number;
};

/** What the clients send as `agent=` and `User-Agent` (git/ prefix: some hosts gate on it). */
export const CLIENT_AGENT = "git/tartan-gitproto";
const DEFAULT_MAX_RESPONSE = 16 * 1024 * 1024;

const serviceUrl = (remote: GitRemote, path: string): string =>
	`${remote.url.replace(/\/+$/, "")}/${path}`;

const post = async (
	remote: GitRemote,
	service: "git-upload-pack" | "git-receive-pack",
	body: Uint8Array,
	headers: Record<string, string>,
	options: ClientOptions,
): Promise<Uint8Array> => {
	const doFetch = remote.fetch ?? fetch;
	let response: Response;
	try {
		response = await doFetch(serviceUrl(remote, service), {
			method: "POST",
			headers: {
				authorization: remote.authorization,
				"content-type": `application/x-${service}-request`,
				accept: `application/x-${service}-result`,
				"user-agent": CLIENT_AGENT,
				...headers,
			},
			body: asBytes(body),
			signal: options.signal,
		});
	} catch (error) {
		throw unavailable(`${service}: request failed`, {
			cause: error instanceof Error ? error.name : "error",
		});
	}
	if (response.status !== 200) {
		await response.body?.cancel().catch(() => {});
		throw unavailable(`${service}: upstream answered ${response.status}`, {
			status: response.status,
		});
	}
	const type = response.headers.get("content-type") ?? "";
	if (!type.startsWith(`application/x-${service}-result`)) {
		await response.body?.cancel().catch(() => {});
		throw unavailable(`${service}: unexpected content type`, { type });
	}
	if (!response.body) return new Uint8Array(0);
	const read = await readCapped(
		response.body,
		options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE,
	);
	if (!read.ok) throw unavailable(`${service}: response too large`);
	return read.bytes;
};

const LS_LINE_RE = /^([0-9a-f]{40}) ([^ ]+)((?: [^ ]+)*)$/;

/** Parses a v2 `ls-refs` response (`unborn` lines are skipped). */
export const parseLsRefs = (body: Uint8Array): LsRef[] => {
	const { lines } = decodePktLines(body);
	const refs: LsRef[] = [];
	let ended = false;
	for (const line of lines) {
		if (ended) throw invalid("ls-refs: data after the flush");
		if (line.kind === "flush") {
			ended = true;
			continue;
		}
		if (line.kind !== "data") throw invalid(`ls-refs: ${line.kind} packet`);
		const text = decodeStrict(chomp(line.data));
		if (text === null) throw invalid("ls-refs: not UTF-8");
		if (text.startsWith("ERR ")) {
			throw unavailable(`ls-refs: upstream error: ${text.slice(4, 200)}`);
		}
		if (text.startsWith("unborn ")) continue;
		const match = LS_LINE_RE.exec(text);
		if (!match) throw invalid("ls-refs: malformed line");
		let ref: LsRef = { ref: match[2], sha: match[1] };
		for (const attr of match[3].split(" ").filter((a) => a.length > 0)) {
			if (attr.startsWith("peeled:")) {
				const peeled = attr.slice("peeled:".length);
				if (!SHA1_RE.test(peeled)) throw invalid("ls-refs: bad peeled id");
				ref = { ...ref, peeled };
			} else if (attr.startsWith("symref-target:")) {
				ref = { ...ref, symrefTarget: attr.slice("symref-target:".length) };
			}
		}
		refs.push(ref);
	}
	if (!ended) throw invalid("ls-refs: no flush");
	return refs;
};

/** The v2 `ls-refs` request body. */
export const encodeLsRefsRequest = (options: {
	readonly refPrefixes?: readonly string[];
	readonly peel?: boolean;
	readonly symrefs?: boolean;
} = {}): Bytes => {
	for (const prefix of options.refPrefixes ?? []) {
		if (prefix.length === 0 || /[\s\0]/.test(prefix)) {
			throw invalid("ref-prefix must be a non-empty token");
		}
	}
	return concat([
		encodePktLine("command=ls-refs\n"),
		encodePktLine(`agent=${CLIENT_AGENT}\n`),
		encodeSpecialPkt("delim"),
		...(options.peel ? [encodePktLine("peel\n")] : []),
		...(options.symrefs ? [encodePktLine("symrefs\n")] : []),
		...(options.refPrefixes ?? []).map((p) =>
			encodePktLine(`ref-prefix ${p}\n`)
		),
		encodeSpecialPkt("flush"),
	]);
};

/** v2 `ls-refs` with `ref-prefix`, `peel` and `symrefs`; `[]` for an empty repo. */
export const lsRefs = async (
	remote: GitRemote,
	options: {
		readonly refPrefixes?: readonly string[];
		readonly peel?: boolean;
		readonly symrefs?: boolean;
	} & ClientOptions = {},
): Promise<readonly LsRef[]> => {
	const body = await post(
		remote,
		"git-upload-pack",
		encodeLsRefsRequest(options),
		{ "git-protocol": "version=2" },
		options,
	);
	return parseLsRefs(body);
};

/** What a ref-only push asks for (plus `atomic` when requested): capabilities the remote advertises. */
export const PUSH_REQUEST_CAPABILITIES = [
	"report-status",
	"side-band-64k",
] as const;

/** The ref-only receive-pack request: commands, flush and (unless delete-only) a pack. */
export const encodePushRequest = async (
	commands: readonly PushCommand[],
	options: { readonly pack?: Uint8Array; readonly atomic?: boolean } = {},
): Promise<Uint8Array> => {
	if (commands.length === 0) {
		throw invalid("pushRefs needs at least one command");
	}
	const refs = new Set<string>();
	for (const command of commands) {
		if (!isValidPushRefname(command.ref)) {
			throw invalid(`invalid refname ${command.ref}`);
		}
		if (!SHA1_RE.test(command.old) || !SHA1_RE.test(command.new)) {
			throw invalid("command ids must be 40 lowercase hex");
		}
		if (command.old === ZERO_SHA && command.new === ZERO_SHA) {
			throw invalid(`${command.ref}: both ids are zero`);
		}
		if (refs.has(command.ref)) throw invalid(`${command.ref} given twice`);
		refs.add(command.ref);
	}
	// Ask only for capabilities the remote advertises (report-status,
	// report-status-v2, delete-refs, atomic, ofs-delta, side-band,
	// side-band-64k). An answer without a report means nothing was applied.
	const caps = [
		...PUSH_REQUEST_CAPABILITIES,
		...(options.atomic ? ["atomic"] : []),
		`agent=${CLIENT_AGENT}`,
	].join(" ");
	const lines = commands.map((command, index) =>
		encodePktLine(
			index === 0
				? `${command.old} ${command.new} ${command.ref}\0${caps}`
				: `${command.old} ${command.new} ${command.ref}`,
		)
	);
	const deleteOnly = commands.every((command) => command.new === ZERO_SHA);
	const pack = deleteOnly
		? new Uint8Array(0)
		: options.pack ?? (await writePack([])).pack;
	return concat([...lines, encodeSpecialPkt("flush"), pack]);
};

/**
 * Ref-only receive-pack: the commands plus an empty pack (or `pack`), with
 * `report-status` parsed. One `RefStatus` per command, in order (`ok: false`
 * with the upstream's `ng` reason, e.g. a wrong old SHA).
 */
export const pushRefs = async (
	remote: GitRemote,
	commands: readonly PushCommand[],
	options: {
		readonly pack?: Uint8Array;
		readonly atomic?: boolean;
	} & ClientOptions = {},
): Promise<readonly RefStatus[]> => {
	const request = await encodePushRequest(commands, options);
	const response = await post(remote, "git-receive-pack", request, {}, options);
	if (response.length === 0) {
		// No report at all: the server dropped the request and applied nothing.
		throw unavailable("git-receive-pack: no report from upstream");
	}
	// A server that ignored side-band-64k answers the report as plain pkt-lines.
	const sidebanded = response.length > 4 && response[4] >= 1 &&
		response[4] <= 3;
	const demuxed = sidebanded ? demuxSideband(response) : null;
	if (demuxed && demuxed.band3.length > 0) {
		throw unavailable(
			`git-receive-pack: upstream error: ${
				decodeLenient(demuxed.band3[0]).slice(0, 200).trim()
			}`,
		);
	}
	const report = parseReportStatus(demuxed ? demuxed.band1 : response, {
		report: "report-status",
	});
	const byRef = new Map(report.refs.map((status) => [status.ref, status]));
	return commands.map((command): RefStatus => {
		const status = byRef.get(command.ref);
		if (status) {
			return report.unpack === "ok" || !status.ok
				? status
				: { ref: command.ref, ok: false, reason: `unpack ${report.unpack}` };
		}
		return {
			ref: command.ref,
			ok: false,
			reason: report.unpack === "ok"
				? "no status reported"
				: `unpack ${report.unpack}`,
		};
	});
};
