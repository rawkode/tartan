// A project's documents at a commit (WP25 slice A′): the first of
// `README.md`, `readme.md`, `README` in its root (text, capped) and the
// nearest `AGENTS.md` or `CLAUDE.md` at or above it. Trees are walked from
// the commit and blobs read by the SHAs they name (K15).

import type { ProjectDetailResponse } from "@tartan/contract";
import type { ResolvedSha } from "@tartan/contract/kernel.ts";
import { isText, type RepoReads, walk } from "../browse/reader.ts";

/** README text inlined in the detail response. */
export const README_MAX_BYTES = 64 * 1024;
const README_NAMES = ["README.md", "readme.md", "README"];
const AGENTS_NAMES = ["AGENTS.md", "CLAUDE.md"];

const readText = async (
	reads: RepoReads,
	sha: string,
	max: number,
): Promise<{ text: string; truncated: boolean } | null> => {
	const blob = await reads.blob(sha as ResolvedSha);
	if (blob === null) return null;
	const truncated = blob.size > max;
	const bytes = new Uint8Array(
		await (truncated ? blob.slice(0, max) : blob).arrayBuffer(),
	);
	if (!truncated && !isText(bytes)) return null;
	if (truncated && bytes.subarray(0, 8000).includes(0)) return null;
	return { text: new TextDecoder().decode(bytes), truncated };
};

export const docsOf = async (
	reads: RepoReads,
	commitSha: string,
	root: string,
): Promise<Pick<ProjectDetailResponse, "readme" | "agentsDoc">> => {
	const commit = await reads.commit(commitSha as ResolvedSha);
	if (commit === null) return {};
	const treeSha = commit.treeHash as ResolvedSha;
	const segments = root === "" ? [] : root.split("/");
	const listing = async (depth: number) => {
		const walked = await walk(reads, treeSha, segments.slice(0, depth));
		return walked?.kind === "tree" ? walked.entries : [];
	};
	const own = await listing(segments.length);
	let readme: ProjectDetailResponse["readme"];
	for (const name of README_NAMES) {
		const entry = own.find((e) =>
			e.name === name && (e.type === "blob" || e.type === "exec")
		);
		if (!entry) continue;
		const text = await readText(reads, entry.hash, README_MAX_BYTES);
		if (text) {
			readme = { path: [...segments, name].join("/"), ...text };
			break;
		}
	}
	let agentsDoc: ProjectDetailResponse["agentsDoc"];
	for (let depth = segments.length; depth >= 0 && !agentsDoc; depth--) {
		const entries = depth === segments.length ? own : await listing(depth);
		const found = AGENTS_NAMES.find((name) =>
			entries.some((e) =>
				e.name === name && (e.type === "blob" || e.type === "exec")
			)
		);
		if (found) {
			agentsDoc = { path: [...segments.slice(0, depth), found].join("/") };
		}
	}
	return {
		...(readme ? { readme } : {}),
		...(agentsDoc ? { agentsDoc } : {}),
	};
};
