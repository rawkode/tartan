// The pull side of `import()`: one `GET info/refs?service=git-upload-pack`
// and one `POST git-upload-pack` with a single v0 `want`, `done`, no
// side-band, user agent `artifacts/1.0`, no `Git-Protocol` header and no
// credentials. The imported repo keeps the source branch's name. A pack
// above `maxBytes` fails with `MEMORY_LIMIT`.
//
// Requests go through a caller-supplied fetch, so tests drive the real
// capability route; URLs of this fake's own remotes are answered in process.

import { readAll } from "../bytes.ts";
import {
	advertisement,
	type FetchLike,
	importerRequestBody,
} from "../git/client.ts";
import { type GitObject, SHA_RE } from "../git/objects.ts";
import { isPack, readPack } from "../git/pack.ts";
import { parsePkts, pktText } from "../git/pktline.ts";
import {
	createObjectStore,
	type ObjectStore,
	reachableObjects,
} from "../git/store.ts";
import { artifactsError } from "./errors.ts";

export const IMPORTER_USER_AGENT = "artifacts/1.0";
/** Default ceiling for tests (any pack above it fails with `MEMORY_LIMIT`). */
export const DEFAULT_IMPORT_MAX_BYTES = 64 * 1024 * 1024;

export type ImportedContent = {
	readonly branch: string;
	readonly head: string;
	readonly store: ObjectStore;
	readonly packBytes: number;
};

export type ImportRequestLog = {
	readonly method: string;
	readonly url: string;
	readonly userAgent: string | null;
	readonly gitProtocol: string | null;
	readonly status: number;
	readonly bytes: number;
};

const classifyStatus = (status: number) =>
	status === 401 || status === 403
		? artifactsError(
			"REMOTE_AUTH_REQUIRED",
			"The remote requires authentication.",
		)
		: status === 404
		? artifactsError("NOT_FOUND", "The remote repository does not exist.")
		: artifactsError("UPSTREAM_UNAVAILABLE", `The remote answered ${status}.`);

/** Pulls `branch` (or the advertised HEAD) from `url` through `fetch`. */
export const pullForImport = async (
	fetch: FetchLike,
	url: string,
	branch: string | undefined,
	maxBytes: number,
	log: (entry: ImportRequestLog) => void,
): Promise<ImportedContent> => {
	const base = url.replace(/\/+$/, "");
	const headers = { "user-agent": IMPORTER_USER_AGENT };
	let adv;
	try {
		adv = await advertisement(
			(r) =>
				fetch(r).then((res) => {
					log({
						method: r.method,
						url: r.url,
						userAgent: r.headers.get("user-agent"),
						gitProtocol: r.headers.get("git-protocol"),
						status: res.status,
						bytes: Number(res.headers.get("content-length") ?? 0),
					});
					return res;
				}),
			base,
			{ headers },
		);
	} catch (e) {
		throw artifactsError(
			"UPSTREAM_UNAVAILABLE",
			`The remote cannot be reached: ${(e as Error).message}`,
		);
	}
	if (adv.status !== 200) throw classifyStatus(adv.status);
	if (adv.refs.size === 0 && adv.caps.length === 0) {
		throw artifactsError("INVALID_URL", "The URL is not a git repository.");
	}
	const chosen = branch ??
		(adv.headSymref?.replace(/^refs\/heads\//, "") ??
			[...adv.refs.entries()].find(([name, oid]) =>
				name.startsWith("refs/heads/") && oid === adv.refs.get("HEAD")
			)?.[0].replace(/^refs\/heads\//, ""));
	const want = chosen === undefined
		? undefined
		: adv.refs.get(`refs/heads/${chosen}`);
	if (chosen === undefined || want === undefined || !SHA_RE.test(want)) {
		throw artifactsError("NOT_FOUND", `Branch not found: ${chosen ?? "HEAD"}.`);
	}
	const request = new Request(`${base}/git-upload-pack`, {
		method: "POST",
		headers: {
			...headers,
			"content-type": "application/x-git-upload-pack-request",
			accept: "application/x-git-upload-pack-result",
		},
		body: importerRequestBody(want),
	});
	let res: Response;
	try {
		res = await fetch(request);
	} catch (e) {
		throw artifactsError(
			"UPSTREAM_UNAVAILABLE",
			`The remote cannot be reached: ${(e as Error).message}`,
		);
	}
	const raw = await readAll(res.body);
	log({
		method: "POST",
		url: request.url,
		userAgent: IMPORTER_USER_AGENT,
		gitProtocol: null,
		status: res.status,
		bytes: raw.length,
	});
	if (res.status !== 200) throw classifyStatus(res.status);
	if (raw.length > maxBytes) throw artifactsError("MEMORY_LIMIT");
	// `NAK` (or `ACK`) then the raw pack: no side-band was asked for.
	let at = 0;
	const first = parsePkts(raw, 0);
	const ack = first.pkts[0];
	const ackText = ack ? pktText(ack) : null;
	if (ackText === "NAK" || ackText?.startsWith("ACK")) {
		at = 4 + (ack.kind === "data" ? ack.data.length : 0);
	}
	if (!isPack(raw, at)) throw artifactsError("INTERNAL_ERROR");
	let objects: Map<string, GitObject>;
	try {
		objects = readPack(raw, at).objects;
	} catch {
		throw artifactsError("INTERNAL_ERROR");
	}
	const store = createObjectStore(objects);
	const { missing } = reachableObjects(store, [want]);
	if (missing.length > 0) throw artifactsError("INTERNAL_ERROR");
	return { branch: chosen, head: want, store, packBytes: raw.length - at };
};
