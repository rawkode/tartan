// The ref-only receive-pack the kernel's in-Worker writes use: commands, a
// flush and (unless every command is a delete) a pack, with `report-status`
// parsed, built from `packages/gitproto`'s codecs. It asks only for
// capabilities the remote advertises, and an empty answer is an error
// (`unavailable`), never success.

import { invalid, SHA1_RE, unavailable, ZERO_SHA } from "@tartan/contract";
import type { PushCommand } from "@tartan/contract/kernel.ts";
import {
	CLIENT_AGENT,
	demuxSideband,
	encodePktLine,
	encodeSpecialPkt,
	type GitRemote,
	isValidPushRefname,
	parseReportStatus,
	type RefStatus,
	writePack,
} from "@tartan/gitproto";

/** Capabilities the ref-only client asks for: all advertised by the remote. */
export const REF_PUSH_CAPABILITIES = [
	"report-status",
	"side-band-64k",
] as const;

const MAX_RESPONSE_BYTES = 1024 * 1024;

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

/** The request body (exported for tests). */
export const encodeRefPush = async (
	commands: readonly PushCommand[],
	options: { readonly pack?: Uint8Array; readonly atomic?: boolean } = {},
): Promise<Uint8Array> => {
	if (commands.length === 0) throw invalid("a ref push needs a command");
	const seen = new Set<string>();
	for (const c of commands) {
		if (!isValidPushRefname(c.ref)) throw invalid(`invalid refname ${c.ref}`);
		if (!SHA1_RE.test(c.old) || !SHA1_RE.test(c.new)) {
			throw invalid("command ids must be 40 lowercase hex");
		}
		if (c.old === ZERO_SHA && c.new === ZERO_SHA) {
			throw invalid(`${c.ref}: both ids are zero`);
		}
		if (seen.has(c.ref)) throw invalid(`${c.ref} given twice`);
		seen.add(c.ref);
	}
	const caps = [
		...REF_PUSH_CAPABILITIES,
		...(options.atomic ? ["atomic"] : []),
		`agent=${CLIENT_AGENT}`,
	].join(" ");
	const lines = commands.map((c, i) =>
		encodePktLine(
			i === 0
				? `${c.old} ${c.new} ${c.ref}\0${caps}`
				: `${c.old} ${c.new} ${c.ref}`,
		)
	);
	const deleteOnly = commands.every((c) => c.new === ZERO_SHA);
	const pack = deleteOnly
		? new Uint8Array(0)
		: options.pack ?? (await writePack([])).pack;
	return concat([...lines, encodeSpecialPkt("flush"), pack]);
};

/** One `RefStatus` per command, in order. */
export const pushRefsCompat = async (
	remote: GitRemote,
	commands: readonly PushCommand[],
	options: { readonly pack?: Uint8Array; readonly atomic?: boolean } = {},
): Promise<RefStatus[]> => {
	const body = await encodeRefPush(commands, options);
	const doFetch = remote.fetch ?? fetch;
	let response: Response;
	try {
		response = await doFetch(
			`${remote.url.replace(/\/+$/, "")}/git-receive-pack`,
			{
				method: "POST",
				headers: {
					authorization: remote.authorization,
					"content-type": "application/x-git-receive-pack-request",
					accept: "application/x-git-receive-pack-result",
					"user-agent": CLIENT_AGENT,
				},
				body: body as BodyInit,
			},
		);
	} catch (error) {
		throw unavailable("git-receive-pack: request failed", {
			cause: error instanceof Error ? error.name : "error",
		});
	}
	if (response.status !== 200) {
		await response.body?.cancel().catch(() => {});
		throw unavailable(
			`git-receive-pack: upstream answered ${response.status}`,
			{
				status: response.status,
			},
		);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length > MAX_RESPONSE_BYTES) {
		throw unavailable("git-receive-pack: response too large");
	}
	if (bytes.length === 0) {
		// The server dropped the request (no report at all): nothing applied.
		throw unavailable("git-receive-pack: no report from upstream");
	}
	const sidebanded = bytes.length > 4 && bytes[4] >= 1 && bytes[4] <= 3;
	const demuxed = sidebanded ? demuxSideband(bytes) : null;
	if (demuxed && demuxed.band3.length > 0) {
		throw unavailable("git-receive-pack: upstream error");
	}
	const report = parseReportStatus(demuxed ? demuxed.band1 : bytes, {
		report: "report-status",
	});
	const byRef = new Map(report.refs.map((s) => [s.ref, s]));
	return commands.map((c): RefStatus => {
		const status = byRef.get(c.ref);
		if (status) {
			return report.unpack === "ok" || !status.ok
				? status
				: { ref: c.ref, ok: false, reason: `unpack ${report.unpack}` };
		}
		return {
			ref: c.ref,
			ok: false,
			reason: report.unpack === "ok"
				? "no status reported"
				: `unpack ${report.unpack}`,
		};
	});
};
