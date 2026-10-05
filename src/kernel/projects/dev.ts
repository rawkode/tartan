// `/-/dev/projects/<repoId>/<op>` (WP25 live acceptance,
// `scripts/live/wp25-projects.ts`, the WP10 `/-/dev/land` pattern): dev
// stages with dev tools only (`TARTAN_STAGE` ^dev and `TARTAN_DEV_TOOLS=1`)
// and a caller holding the dev key (`hex(HMAC-SHA256(TARTAN_SECRET,
// "tartan:dev:projects"))`); anyone else gets a plain 404. It exercises the
// slice on the edge without a claimed forge: real Artifacts, the RepoProbe
// entrypoint and RepoDO's graph cache.
//
//   POST seed     {files, path?} → an Artifacts repo `r-<repoId>` holding one
//                 commit of `files` (nested paths), RepoDO initialised
//   GET  graph?sha=&paths=a,b → the projects response at `sha` (detected on
//                 a miss), whether RepoDO had it cached, the time it took and
//                 the affected set of `paths`
//   GET  project?sha=&project= → one project's README and nearest agent doc,
//                 read by SHA
//
// No Artifacts token is ever returned.

import {
	httpStatus,
	invalid,
	isSha,
	isUlid,
	notFound,
	type ProjectGraph,
	repoArtifactsName,
	repoDoName,
	toWire,
	trunkRef,
	ZERO_SHA,
} from "@tartan/contract";
import { isRepoStoreError } from "@tartan/contract/kernel.ts";
import {
	encodeCommit,
	encodeTree,
	hashObject,
	type PackObject,
	writePack,
} from "@tartan/gitproto";
import { affectedBy } from "@tartan/monorepo";
import { loopback } from "../../exports.ts";
import type { RouteContext, RouteHandler } from "../../router.ts";
import { openReads } from "../browse/reader.ts";
import { isolateObjectCache } from "../probe/env.ts";
import { createCanonicalAccess } from "../land/upstream.ts";
import { docsOf } from "./docs.ts";
import { projectsMode } from "./mode.ts";
import { projectsResponse, projectView, resolveProject } from "./resolve.ts";

const DEV_KEY_LABEL = "tartan:dev:projects";
const DEV_BRANCH = "main";
/** Bounds of a seeded tree (the demo fixture has ~170 files). */
const SEED_MAX_FILES = 2_000;
const SEED_MAX_FILE_BYTES = 256 * 1024;
const SEED_MAX_BYTES = 8 * 1024 * 1024;
const PATH_RE =
	/^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/;

const encoder = new TextEncoder();
const hex = (buffer: ArrayBuffer): string =>
	[...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0"))
		.join("");

/** `hex(HMAC-SHA256(secret, "tartan:dev:projects"))`. */
export const devProjectsKey = async (secret: string): Promise<string> => {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hex(
		await crypto.subtle.sign("HMAC", key, encoder.encode(DEV_KEY_LABEL)),
	);
};

const constantTimeEqual = (a: string, b: string): boolean => {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
};

const hasDevKey = async (c: RouteContext): Promise<boolean> => {
	const given = c.req.headers.get("x-tartan-dev-key");
	const secret = c.env.TARTAN_SECRET;
	const devTools = /^dev/.test(c.env.TARTAN_STAGE) &&
		c.env.TARTAN_DEV_TOOLS === "1";
	if (!devTools || given === null || !secret) return false;
	return constantTimeEqual(given, await devProjectsKey(secret));
};

const json = (body: unknown, status = 200) =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });

type Dir = Map<string, Dir | string>;

/** The pack of one root commit holding `files`, and its id. */
export const commitOf = async (
	files: Readonly<Record<string, string>>,
	message: string,
): Promise<
	{ readonly pack: Uint8Array; readonly head: string; readonly tree: string }
> => {
	const root: Dir = new Map();
	for (const [path, content] of Object.entries(files)) {
		const segments = path.split("/");
		let dir = root;
		for (const segment of segments.slice(0, -1)) {
			let next = dir.get(segment);
			if (!(next instanceof Map)) {
				next = new Map();
				dir.set(segment, next);
			}
			dir = next;
		}
		dir.set(segments.at(-1)!, content);
	}
	const objects: PackObject[] = [];
	const write = async (dir: Dir): Promise<string> => {
		const entries = [];
		for (const [name, value] of dir) {
			if (value instanceof Map) {
				entries.push({ mode: "40000" as const, name, id: await write(value) });
			} else {
				const blob: PackObject = { type: "blob", data: encoder.encode(value) };
				objects.push(blob);
				entries.push({
					mode: "100644" as const,
					name,
					id: await hashObject("blob", blob.data),
				});
			}
		}
		const tree: PackObject = { type: "tree", data: encodeTree(entries) };
		objects.push(tree);
		return await hashObject("tree", tree.data);
	};
	const tree = await write(root);
	const at = Math.floor(Date.now() / 1000);
	const commit: PackObject = {
		type: "commit",
		data: encodeCommit({
			tree,
			author: { name: "Tartan", email: "tartan@kernel.invalid", at },
			message: `${message}\n`,
		}),
	};
	const { pack, ids } = await writePack([...objects, commit]);
	return { pack, head: ids[ids.length - 1], tree };
};

const readFiles = (body: unknown): Record<string, string> => {
	const files = (body as { files?: unknown } | null)?.files;
	if (typeof files !== "object" || files === null || Array.isArray(files)) {
		throw invalid("files is {path: content}");
	}
	const entries = Object.entries(files);
	let bytes = 0;
	if (entries.length === 0 || entries.length > SEED_MAX_FILES) {
		throw invalid(`1–${SEED_MAX_FILES} files`);
	}
	for (const [path, content] of entries) {
		if (path.length > 512 || !PATH_RE.test(path)) {
			throw invalid(`bad path ${path.slice(0, 80)}`);
		}
		if (typeof content !== "string" || content.length > SEED_MAX_FILE_BYTES) {
			throw invalid(`${path}: a string of at most 256 KiB`);
		}
		bytes += content.length;
	}
	if (bytes > SEED_MAX_BYTES) throw invalid("at most 8 MiB in all");
	return files as Record<string, string>;
};

const seed = async (c: RouteContext, repoId: string) => {
	const started = Date.now();
	const body = await c.req.json().catch(() => {
		throw invalid("the body must be JSON");
	});
	const files = readFiles(body);
	const name = repoArtifactsName(repoId);
	try {
		await c.env.ARTIFACTS.create(name, { setDefaultBranch: DEV_BRANCH });
	} catch (error) {
		if (!isRepoStoreError(error, "ALREADY_EXISTS")) throw error;
	}
	const path = typeof (body as { path?: unknown }).path === "string"
		? (body as { path: string }).path
		: `dev/${repoId}`;
	await c.env.REPO.getByName(repoDoName(repoId)).core().init({
		repoId,
		nodeId: repoId,
		path,
		defaultBranch: DEV_BRANCH,
	});
	const { pack, head } = await commitOf(files, "WP25 live: demo-shaped tree");
	const access = createCanonicalAccess({ artifacts: c.env.ARTIFACTS, repoId });
	const [status] = await access.pushRefs(
		[{ ref: trunkRef(DEV_BRANCH), old: ZERO_SHA, new: head }],
		{ pack },
	);
	if (status?.ok !== true) {
		throw invalid(`push refused: ${status?.reason ?? "no status"}`);
	}
	return {
		repoId,
		sha: head,
		files: Object.keys(files).length,
		packBytes: pack.length,
		ms: Date.now() - started,
	};
};

const graphAt = async (c: RouteContext, repoId: string, sha: string) => {
	const cachedBefore = await c.env.REPO.getByName(repoDoName(repoId)).probe()
		.projects(sha) !== null;
	const before = isolateObjectCache().stats();
	const started = Date.now();
	const graph = await loopback(c.ctx).RepoProbe.projectGraph(
		repoId,
		sha,
	) as ProjectGraph;
	const after = isolateObjectCache().stats();
	return {
		graph,
		cachedBefore,
		ms: Date.now() - started,
		// This isolate's object-cache counters over the call (RepoProbe runs
		// in the same isolate when it is reached through `ctx.exports`).
		cache: {
			hits: after.hits - before.hits,
			edgeHits: after.edgeHits - before.edgeHits,
			misses: after.misses - before.misses,
		},
	};
};

const shaParam = (url: URL): string => {
	const sha = url.searchParams.get("sha") ?? "";
	if (!isSha(sha)) throw invalid("sha is a 40-hex commit sha");
	return sha;
};

export const handleDevProjects: RouteHandler = async (c) => {
	if (!(await hasDevKey(c))) {
		return json({ error: "not_found", message: "not found" }, 404);
	}
	try {
		const [repoId = "", op = ""] = (c.params.rest ?? "").split("/");
		if (!isUlid(repoId)) throw notFound("no such repo");
		const method = c.req.method.toUpperCase();
		if (method === "POST" && op === "seed") return json(await seed(c, repoId));
		if (method === "GET" && op === "graph") {
			const { graph, cachedBefore, ms, cache } = await graphAt(
				c,
				repoId,
				shaParam(c.url),
			);
			const paths = (c.url.searchParams.get("paths") ?? "").split(",")
				.filter((p) => p !== "");
			return json({
				mode: projectsMode(c.env),
				ms,
				cachedBefore,
				cache,
				graphBytes: JSON.stringify(graph).length,
				response: projectsResponse(
					{ id: repoId, path: `dev/${repoId}` },
					graph,
				),
				affected: affectedBy(graph, paths),
			});
		}
		if (method === "GET" && op === "project") {
			const sha = shaParam(c.url);
			const { graph } = await graphAt(c, repoId, sha);
			const project = resolveProject(
				projectView(graph),
				c.url.searchParams.get("project") ?? "",
			);
			if (project === null) throw notFound("no such project");
			const reads = await openReads(c.env.ARTIFACTS, repoArtifactsName(repoId));
			try {
				return json({ project, ...(await docsOf(reads, sha, project.root)) });
			} finally {
				reads.close();
			}
		}
		throw notFound("no such dev projects operation");
	} catch (error) {
		const wire = toWire(error);
		if (wire.error === "internal") {
			console.error("[tartan] dev projects:", String(error));
		}
		return json(wire, httpStatus(wire.error));
	}
};
