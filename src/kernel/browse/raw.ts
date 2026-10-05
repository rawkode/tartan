// Raw files (WP3): `GET /<repoPath>/-/raw/<ref>/<file>`.
// Repo content never renders on the forge origin: text is served as
// `text/plain; charset=utf-8`, anything else as `application/octet-stream`
// with `Content-Disposition: attachment`, always with
// `Content-Security-Policy: sandbox; default-src 'none'` and `nosniff`. The
// ref may contain slashes (`release/1.x`): the longest prefix of the path
// that names a ref wins; a 40-hex first segment is a commit. The blob is
// reached by a tree walk from that commit, in the caller's view (members,
// or the public view of a public repo).

import {
	invalid,
	isSha,
	notFound,
	repoArtifactsName,
	type TartanError,
} from "@tartan/contract";
import type { ResolvedSha } from "@tartan/contract/kernel.ts";
import type { RouteHandler } from "../../router.ts";
import { createResolver, repoView } from "./access.ts";
import { browseDepsOf } from "./deps.ts";
import { failure } from "./http.ts";
import { hasControlChars, openReads, walk } from "./reader.ts";
import type { BrowseDepsFor } from "./repo.ts";

export const RAW_CSP = "sandbox; default-src 'none'";
/** Bytes sniffed for NUL to tell text from binary. */
const SNIFF_BYTES = 8000;
/** Ref segments tried before the file path. */
const REF_SEGMENTS_MAX = 8;

const decodeSegment = (raw: string): string => {
	let value: string;
	try {
		value = decodeURIComponent(raw);
	} catch {
		throw invalid("malformed path encoding");
	}
	if (
		value === "" || value.includes("/") || hasControlChars(value)
	) {
		throw invalid("invalid path segment");
	}
	if (value === "." || value === "..") throw invalid("invalid path segment");
	return value;
};

/** `attachment; filename="safe"; filename*=UTF-8''exact` (RFC 6266). */
export const attachment = (name: string): string => {
	const safe = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200) || "file";
	return `attachment; filename="${safe}"; filename*=UTF-8''${
		encodeURIComponent(name)
	}`;
};

const isNotFound = (error: unknown): boolean =>
	(error as TartanError | undefined)?.code === "not_found";

export const createRawHandler = (
	depsFor: BrowseDepsFor = (c) => browseDepsOf(c.env, c.ctx),
): RouteHandler =>
async (c) => {
	try {
		const deps = depsFor(c);
		const repoPath = c.params.repo ?? "";
		const rest = c.params.rest ?? "";
		const view = await repoView(deps, c.auth, repoPath);
		if ("moved" in view) {
			return new Response(null, {
				status: 301,
				headers: {
					location: `/${view.moved}/-/raw/${rest}`,
					"cache-control": "no-store",
				},
			});
		}
		const segments = rest.split("/").map(decodeSegment);
		if (segments.length < 2) throw notFound("raw needs a ref and a file");
		const reads = await openReads(
			deps.artifacts,
			repoArtifactsName(view.node.id),
		);
		try {
			const resolver = createResolver(view, reads);
			let commit: ResolvedSha | null = null;
			let fileAt = 1;
			if (isSha(segments[0])) {
				commit = await resolver.commit(segments[0]);
			} else {
				for (
					let k = Math.min(segments.length - 1, REF_SEGMENTS_MAX);
					k >= 1 && commit === null;
					k--
				) {
					try {
						commit = await resolver.commit(segments.slice(0, k).join("/"));
						fileAt = k;
					} catch (error) {
						if (!isNotFound(error)) throw error;
					}
				}
			}
			if (commit === null) throw notFound("unknown ref");
			const meta = await reads.commit(commit);
			if (meta === null) throw notFound(`no commit ${commit}`);
			const file = segments.slice(fileAt);
			const walked = await walk(reads, meta.treeHash as ResolvedSha, file);
			if (walked === null || walked.kind !== "blob") {
				throw notFound(`no file ${file.join("/")}`);
			}
			const blob = await reads.blob(walked.sha);
			if (blob === null) throw notFound("the file is not readable");
			const head = new Uint8Array(
				await blob.slice(0, SNIFF_BYTES).arrayBuffer(),
			);
			const text = !head.includes(0);
			const headers = new Headers({
				"content-type": text
					? "text/plain; charset=utf-8"
					: "application/octet-stream",
				"content-security-policy": RAW_CSP,
				"x-content-type-options": "nosniff",
				"cache-control": "no-store",
				"content-length": String(blob.size),
			});
			if (!text) {
				headers.set("content-disposition", attachment(file[file.length - 1]));
			}
			return new Response(blob.stream(), { status: 200, headers });
		} finally {
			reads.close();
		}
	} catch (error) {
		const response = failure(error);
		response.headers.set("content-security-policy", RAW_CSP);
		return response;
	}
};
