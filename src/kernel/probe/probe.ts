// RepoProbe's implementation (`RepoProbeApi`, contract services.ts): stateless,
// cacheable git reads. Every read names its repo through `GitSource` → RepoDO
// `upstream({laneId?})` (the canonical repo, or a `repo` lane's current lane
// repo), takes a SHA (K15), and goes through the family object cache and the
// isolate's binding-read bucket. The thin `RepoProbe` WorkerEntrypoint
// delegates here; tests drive it with in-memory ports.

import {
	type AddedLine,
	type Affected,
	diffKey,
	type FileDiff,
	type FileHunks,
	GATE_INPUT_LIMITS,
	type GitSource,
	GitSourceSchema,
	invalid,
	MERGE3_MAX_PER_CALL,
	type Merge3Input,
	type Merge3Result,
	notFound,
	PATCH_LIMITS,
	type PatchOmitted,
	type PathDiff,
	type ProjectConfigAnswer,
	type ProjectGraph,
	PUSH_COMMITS_MAX,
	PUSH_PATHS_MAX,
	type PushDiff,
} from "@tartan/contract";
import {
	type AddedLinesLimits,
	type DiffResult,
	isResolvedSha,
	type RepoProbeApi,
	type ResolvedSha,
	type UpstreamTarget,
} from "@tartan/contract/kernel.ts";
import {
	addedLines as addedLinesOf,
	type Change,
	changeToHunk,
	decodeText,
	diffLines,
	diffStat,
	isBinary,
	merge3Bytes,
	patchHunks,
	splitLines,
} from "@tartan/diff";
import {
	affectedBy,
	createLimiter,
	createTreeView,
	detectProjects,
	diffTrees,
	NO_PROJECT_CONFIG,
	type ProjectConfig,
	touchedPaths,
	type TreeChange,
} from "@tartan/monorepo";
import { BINDING_READS_CONCURRENCY } from "../../constants.ts";
import type { TokenBucket } from "./bucket.ts";
import type { ObjectCache } from "./cache.ts";
import type { ProjectsMode } from "../projects/mode.ts";
import { graphMode } from "./projects.ts";
import { walkLaneRange } from "./range.ts";
import {
	createProbeReader,
	type ProbeReader,
	type ReadEvent,
	type RepoHandle,
} from "./reader.ts";
import { subjectOf, trailersOf } from "./trailers.ts";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** What RepoProbe needs from one repo's RepoDO (core and probe facades). */
export type ProbeRepoPort = {
	/** `core().upstream(target, "read").artifactsName`: never a raw name from input. */
	artifactsName(target: UpstreamTarget): Promise<string>;
	/** `core().trunkSeqs` (K17): one batched call per log page. */
	trunkSeqs(shas: readonly string[]): Promise<Record<string, number>>;
	/** `lanes.base_sha` (the K17 fallback); null for an unknown lane. */
	laneBase(laneId: string): Promise<string | null>;
	/** The default branch tip (the fallback for a non-lane branch). */
	trunkTip(): Promise<string | null>;
	/** `core().resolveRef`: a ref name, lane id or SHA → SHA (K15). */
	resolveRef(ref: string): Promise<string | null>;
	/** `probe().projects` / `putProjects`: the RepoDO graph cache. */
	projects(sha: string): Promise<ProjectGraph | null>;
	putProjects(graph: ProjectGraph): Promise<void>;
	/**
	 * `repoconfig().projectConfig(sha)` (ADR repo config): the configured
	 * projects and global files at a commit's trunk base, or `needsBase`
	 * when the commit is not on trunk and config exists.
	 */
	projectConfig(sha: string): Promise<ProjectConfigAnswer>;
};

/** The R2 subset used for `diffs/`. */
export type DiffStore = {
	get(key: string): Promise<{ text(): Promise<string> } | null>;
	put(key: string, value: string): Promise<unknown>;
};

export type RepoProbeDeps = {
	readonly repo: (repoId: string) => ProbeRepoPort;
	/** `env.ARTIFACTS.get`, used only with names `artifactsName` returned. */
	readonly store: {
		get(name: string): Promise<RepoHandle & Partial<Disposable>>;
	};
	readonly diffs: DiffStore;
	readonly cache: ObjectCache;
	readonly bucket: TokenBucket;
	readonly onRead?: (event: ReadEvent) => void;
	/** Graphs by `<repoId>:<sha>:<configKey>`, shared across calls in one isolate. */
	readonly graphMemo?: Map<string, ProjectGraph>;
	/**
	 * `TARTAN_REPO_CONFIG` is on: configured projects come from the trunk
	 * config (ADR repo config). Off (the default): detectors only, no RPC.
	 */
	readonly repoConfig?: boolean;
	/**
	 * `TARTAN_PROJECTS` (WP25): `scan` runs the cuenv detector first. A
	 * cached graph computed under the other mode is recomputed.
	 */
	readonly projects?: ProjectsMode;
};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Files whose hunks a push diff carries (the rest are listed path-level). */
export const PUSH_DIFF_HUNK_FILES = 300;
/** Files whose hunks a diff-of-diffs carries. */
export const COMPARE_HUNK_FILES = 200;
/** Blobs larger than this are compared path-level only. */
export const LINE_DIFF_MAX_BYTES = 1024 * 1024;
/** Graphs memoised per isolate. */
const GRAPH_MEMO_MAX = 256;

/**
 * Path-level answers carry this marker (`truncated` in the gate sense):
 * the contract's `FileHunks`/`Merge3Result` have no field for it yet.
 */
export type PathLevel = { readonly pathLevel: true };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const checkSource = (source: GitSource): GitSource => {
	const parsed = GitSourceSchema.safeParse(source);
	if (!parsed.success) throw invalid("bad git source");
	return parsed.data;
};

const isTextBlobType = (mode: string | undefined): boolean => mode !== "160000";

const encoder = new TextEncoder();

type Session = {
	reader(source: GitSource): Promise<ProbeReader>;
	sha(source: GitSource, ref: string): Promise<ResolvedSha>;
	tree(reader: ProbeReader, commit: ResolvedSha): Promise<string>;
	close(): void;
};

/** Text side of a blob, or why there is none. */
type Side =
	| { readonly kind: "text"; readonly lines: string[] }
	| { readonly kind: "binary" }
	| { readonly kind: "skipped"; readonly why: "large" | "gitlink" };

/** `fileDiffs` options: hunk files, added lines, patches. */
type FileDiffOptions = {
	readonly hunkFiles: number;
	readonly addedLines: AddedLinesLimits | null;
	readonly patch: boolean;
};

/** The `diff --git` header of one change (git's extended header lines). */
const patchHeader = (c: TreeChange): string => {
	const oldPath = c.oldPath ?? c.path;
	let out = `diff --git a/${oldPath} b/${c.path}\n`;
	if (c.change === "added") {
		out += `new file mode ${c.newMode ?? "100644"}\n`;
	} else if (c.change === "deleted") {
		out += `deleted file mode ${c.oldMode ?? "100644"}\n`;
	} else {
		if (c.change === "renamed") {
			out += `rename from ${oldPath}\nrename to ${c.path}\n`;
		}
		if (c.oldMode && c.newMode && c.oldMode !== c.newMode) {
			out += `old mode ${c.oldMode}\nnew mode ${c.newMode}\n`;
		}
	}
	return out;
};

/** The whole patch of one text change: header, `---`/`+++` and hunks. */
const filePatch = (
	c: TreeChange,
	before: readonly string[],
	after: readonly string[],
	changes: readonly Change[],
): string => {
	const hunks = patchHunks(before, after, changes);
	if (hunks === "") return patchHeader(c);
	const from = c.change === "added" ? "/dev/null" : `a/${c.oldPath ?? c.path}`;
	const to = c.change === "deleted" ? "/dev/null" : `b/${c.path}`;
	return `${patchHeader(c)}--- ${from}\n+++ ${to}\n${hunks}`;
};

export const createRepoProbe = (deps: RepoProbeDeps): RepoProbeApi => {
	const graphMemo = deps.graphMemo ?? new Map<string, ProjectGraph>();

	const session = (): Session => {
		const limit = createLimiter(BINDING_READS_CONCURRENCY);
		const readers = new Map<string, Promise<ProbeReader>>();
		const handles: Partial<Disposable>[] = [];
		const reader = (raw: GitSource): Promise<ProbeReader> => {
			const source = checkSource(raw);
			const key = `${source.repoId}/${source.laneId ?? ""}`;
			const existing = readers.get(key);
			if (existing) return existing;
			const created = (async () => {
				const port = deps.repo(source.repoId);
				const artifactsName = await port.artifactsName(
					source.laneId ? { laneId: source.laneId } : {},
				);
				const repo = await deps.store.get(artifactsName);
				handles.push(repo);
				return createProbeReader({
					source,
					artifactsName,
					repo,
					cache: deps.cache,
					bucket: deps.bucket,
					limit,
					onRead: deps.onRead,
				});
			})();
			readers.set(key, created);
			return created;
		};
		const sha = async (
			source: GitSource,
			ref: string,
		): Promise<ResolvedSha> => {
			if (isResolvedSha(ref)) return ref;
			const resolved = await deps.repo(source.repoId).resolveRef(ref);
			if (resolved === null || !isResolvedSha(resolved)) {
				throw notFound(`unknown ref ${ref}`);
			}
			return resolved;
		};
		const tree = async (
			r: ProbeReader,
			commit: ResolvedSha,
		): Promise<string> => {
			const meta = await r.readCommit(commit);
			if (meta === null) {
				throw notFound(`commit ${commit} is not in ${r.artifactsName}`);
			}
			return meta.treeHash;
		};
		const close = () => {
			for (const h of handles) {
				try {
					h[Symbol.dispose]?.();
				} catch {
					// RPC stubs may already be released
				}
			}
		};
		return { reader, sha, tree, close };
	};

	const withSession = async <T>(
		run: (s: Session) => Promise<T>,
	): Promise<T> => {
		const s = session();
		try {
			return await run(s);
		} finally {
			s.close();
		}
	};

	const readSide = async (
		r: ProbeReader,
		hash: string | undefined,
		mode: string | undefined,
	): Promise<Side> => {
		if (!hash) return { kind: "text", lines: [] };
		if (!isTextBlobType(mode)) return { kind: "skipped", why: "gitlink" };
		const bytes = await r.readBlobBytes(hash as ResolvedSha);
		if (bytes === null) {
			throw notFound(`blob ${hash} is not in ${r.artifactsName}`);
		}
		if (bytes.length > LINE_DIFF_MAX_BYTES) {
			return { kind: "skipped", why: "large" };
		}
		if (isBinary(bytes)) return { kind: "binary" };
		return { kind: "text", lines: splitLines(decodeText(bytes)) };
	};

	/**
	 * File diffs (with hunks for the first `hunkFiles` text files and, when
	 * asked, their patches within `PATCH_LIMITS`).
	 */
	const fileDiffs = async (
		oldReader: ProbeReader,
		newReader: ProbeReader,
		changes: readonly TreeChange[],
		options: FileDiffOptions,
	): Promise<{ files: FileDiff[]; added: AddedLine[]; truncated: boolean }> => {
		const { hunkFiles, addedLines: wantAdded } = options;
		const files: FileDiff[] = [];
		const added: AddedLine[] = [];
		let addedBytes = 0;
		let addedFull = false;
		let truncated = false;
		let patchBytes = 0;
		const omitted = (why: PatchOmitted) =>
			options.patch ? { patchOmitted: why } : {};
		for (const [i, c] of changes.entries()) {
			const base = {
				path: c.path,
				...(c.oldPath ? { oldPath: c.oldPath } : {}),
				change: c.change,
			};
			if (i >= hunkFiles) {
				files.push({
					...base,
					binary: false,
					additions: 0,
					deletions: 0,
					hunks: [],
					...omitted("budget"),
				});
				truncated = true;
				continue;
			}
			const [before, after] = await Promise.all([
				readSide(oldReader, c.oldHash, c.oldMode),
				readSide(newReader, c.newHash, c.newMode),
			]);
			if (before.kind === "binary" || after.kind === "binary") {
				files.push({
					...base,
					binary: true,
					additions: 0,
					deletions: 0,
					hunks: [],
				});
				continue;
			}
			if (before.kind !== "text" || after.kind !== "text") {
				const large = (before.kind === "skipped" && before.why === "large") ||
					(after.kind === "skipped" && after.why === "large");
				files.push({
					...base,
					binary: false,
					additions: 0,
					deletions: 0,
					hunks: [],
					...omitted(large ? "too-large" : "path-level"),
				});
				truncated = true;
				continue;
			}
			const lineChanges: Change[] = diffLines(before.lines, after.lines);
			const stat = diffStat(lineChanges);
			let patch: { patch: string } | { patchOmitted: PatchOmitted } | null =
				null;
			if (options.patch && patchBytes >= PATCH_LIMITS.responseBytes) {
				patch = { patchOmitted: "budget" };
			} else if (options.patch) {
				const text = filePatch(c, before.lines, after.lines, lineChanges);
				const size = encoder.encode(text).length;
				if (size > PATCH_LIMITS.fileBytes) {
					patch = { patchOmitted: "too-large" };
				} else if (patchBytes + size > PATCH_LIMITS.responseBytes) {
					patch = { patchOmitted: "budget" };
				} else {
					patchBytes += size;
					patch = { patch: text };
				}
			}
			files.push({
				...base,
				binary: false,
				additions: stat.additions,
				deletions: stat.deletions,
				hunks: lineChanges.map(changeToHunk),
				...patch,
			});
			if (wantAdded && !addedFull) {
				for (const line of addedLinesOf(after.lines, lineChanges)) {
					const size = encoder.encode(line.text).length;
					if (
						added.length >= wantAdded.lines ||
						addedBytes + size > wantAdded.bytes
					) {
						truncated = true;
						addedFull = true;
						break;
					}
					added.push({ path: c.path, line: line.line, text: line.text });
					addedBytes += size;
				}
			}
		}
		return { files, added, truncated };
	};

	const treeDiff = async (
		s: Session,
		oldSource: GitSource,
		oldSha: ResolvedSha,
		newSource: GitSource,
		newSha: ResolvedSha,
	) => {
		const [oldReader, newReader] = await Promise.all([
			s.reader(oldSource),
			s.reader(newSource),
		]);
		const [oldTree, newTree] = await Promise.all([
			s.tree(oldReader, oldSha),
			s.tree(newReader, newSha),
		]);
		const diff = await diffTrees(
			{ objects: oldReader.objects, tree: oldTree },
			{ objects: newReader.objects, tree: newTree },
		);
		return { ...diff, oldReader, newReader };
	};

	const readPushDiff = async (key: string): Promise<PushDiff | null> => {
		const object = await deps.diffs.get(key);
		if (!object) return null;
		try {
			return JSON.parse(await object.text()) as PushDiff;
		} catch {
			return null;
		}
	};

	const pathDiffOf = (
		files: readonly FileDiff[],
		truncated: boolean,
	): PathDiff => ({
		paths: files.map((f) => ({
			path: f.path,
			change: f.change,
			...(f.oldPath ? { oldPath: f.oldPath } : {}),
		})),
		truncated,
	});

	/**
	 * The configured projects and global files at a commit's trunk base
	 * (ADR repo config): the commit itself when it is on trunk, else its K17
	 * merge base with trunk (the lane's base, or the trunk tip, as fallback).
	 * The probe never runs CUE and never parses it.
	 */
	const projectConfigAt = async (
		s: Session,
		source: GitSource,
		commit: ResolvedSha,
	): Promise<ProjectConfig & { readonly provisional: boolean }> => {
		const none = { ...NO_PROJECT_CONFIG, provisional: false };
		if (deps.repoConfig !== true) return { ...none, key: "off" };
		const port = deps.repo(source.repoId);
		let answer = await port.projectConfig(commit);
		if ("needsBase" in answer) {
			const reader = await s.reader(source);
			const walk = await walkLaneRange(
				{
					log: (from, o) => reader.log(from, o),
					trunkSeqs: (shas) => port.trunkSeqs(shas),
				},
				commit,
			);
			const base = walk.rangeBase ??
				(source.laneId
					? await port.laneBase(source.laneId)
					: await port.trunkTip());
			if (base === null || !isResolvedSha(base)) return none;
			answer = await port.projectConfig(base);
			if ("needsBase" in answer) return none;
		}
		return answer;
	};

	const graphAt = async (
		s: Session,
		source: GitSource,
		commit: ResolvedSha,
	): Promise<ProjectGraph> => {
		const config = await projectConfigAt(s, source, commit);
		const memoKey = `${source.repoId}:${commit}:${config.key}`;
		const memo = graphMemo.get(memoKey);
		if (memo) return memo;
		const port = deps.repo(source.repoId);
		let graph = await port.projects(commit);
		if (graph !== null && (graph.configKey ?? "off") !== config.key) {
			graph = null; // computed under another trunk config
		}
		const mode = deps.projects ?? "off";
		if (graph !== null && graphMode(graph) !== mode) {
			graph = null; // computed under the other TARTAN_PROJECTS mode
		}
		if (graph === null) {
			const reader = await s.reader(source);
			const tree = await s.tree(reader, commit);
			const detected = await detectProjects(
				createTreeView(reader.objects, tree),
				config,
				{ cuenv: mode === "scan" },
			);
			graph = {
				sha: commit,
				manifestsTreeSha: detected.manifestsTreeSha,
				projects: detected.projects,
				globalFiles: detected.globalFiles,
				configKey: config.key,
				...(config.provisional ? { provisional: true } : {}),
				...detected.extras,
			};
			await port.putProjects(graph);
		}
		if (graphMemo.size >= GRAPH_MEMO_MAX) {
			graphMemo.delete(graphMemo.keys().next().value!);
		}
		graphMemo.set(memoKey, graph);
		return graph;
	};

	const diffPathsIn = async (
		s: Session,
		source: GitSource,
		base: string,
		head: string,
	): Promise<PathDiff> => {
		const [baseSha, headSha] = await Promise.all([
			s.sha(source, base),
			s.sha(source, head),
		]);
		const stored = await readPushDiff(diffKey(source.repoId, baseSha, headSha));
		if (stored) return pathDiffOf(stored.files, stored.truncated);
		const diff = await treeDiff(s, source, baseSha, source, headSha);
		return {
			paths: diff.changes.map((c) => ({
				path: c.path,
				change: c.change,
				...(c.oldPath ? { oldPath: c.oldPath } : {}),
			})),
			truncated: diff.truncated,
		};
	};

	const pathLevelHunks = (path: string): FileHunks & PathLevel => ({
		path,
		binary: false,
		hunks: [],
		pathLevel: true,
	});

	const pathLevelMerge = (path: string): Merge3Result & PathLevel => ({
		path,
		clean: false,
		binary: false,
		regions: [],
		pathLevel: true,
	});

	return {
		laneDiff: (source, after, options) =>
			withSession(async (s): Promise<DiffResult> => {
				const src = checkSource(source);
				if (!isResolvedSha(after)) {
					throw invalid(`after must be a sha: ${after}`);
				}
				const port = deps.repo(src.repoId);
				const reader = await s.reader(src);
				const walk = await walkLaneRange(
					{
						log: (from, o) => reader.log(from, o),
						trunkSeqs: (shas) => port.trunkSeqs(shas),
					},
					after,
				);
				let rangeBase = walk.rangeBase;
				if (rangeBase === null) {
					rangeBase = src.laneId
						? await port.laneBase(src.laneId)
						: await port.trunkTip();
				}
				if (rangeBase === null || !isResolvedSha(rangeBase)) {
					throw notFound("no merge base with trunk and no fallback base");
				}
				const key = diffKey(src.repoId, rangeBase, after);
				let stored = await readPushDiff(key);
				if (stored === null || (options?.addedLines && !stored.addedLines)) {
					const diff = await treeDiff(s, src, rangeBase, src, after);
					const details = await fileDiffs(
						diff.oldReader,
						diff.newReader,
						diff.changes,
						{
							hunkFiles: PUSH_DIFF_HUNK_FILES,
							addedLines: options?.addedLines
								? {
									lines: GATE_INPUT_LIMITS.addedLines,
									bytes: GATE_INPUT_LIMITS.addedBytes,
								}
								: null,
							patch: false,
						},
					);
					stored = {
						repoId: src.repoId,
						target: src.laneId ?? "repo",
						rangeBase,
						rangeTruncated: walk.truncated,
						after,
						files: details.files,
						...(options?.addedLines ? { addedLines: details.added } : {}),
						truncated: diff.truncated || details.truncated,
					};
					await deps.diffs.put(key, JSON.stringify(stored));
				}
				const paths = touchedPaths(
					stored.files.map((f) => ({
						path: f.path,
						change: f.change,
						...(f.oldPath ? { oldPath: f.oldPath } : {}),
					})),
				);
				return {
					rangeBase,
					rangeTruncated: walk.truncated,
					diffKey: key,
					commits: walk.commits.slice(0, PUSH_COMMITS_MAX).map((c) => ({
						sha: c.hash,
						subject: subjectOf(c.message),
						trailers: trailersOf(c.message),
					})),
					paths: paths.slice(0, PUSH_PATHS_MAX),
					truncated: stored.truncated || paths.length > PUSH_PATHS_MAX,
				};
			}),

		diffPaths: (source, base, head) =>
			withSession((s) => diffPathsIn(s, checkSource(source), base, head)),

		hunks: (source, base, head, paths) =>
			withSession(async (s): Promise<FileHunks[]> => {
				const src = checkSource(source);
				const reader = await s.reader(src);
				const [baseSha, headSha] = await Promise.all([
					s.sha(src, base),
					s.sha(src, head),
				]);
				const [oldTree, newTree] = await Promise.all([
					s.tree(reader, baseSha),
					s.tree(reader, headSha),
				]);
				const oldView = createTreeView(reader.objects, oldTree);
				const newView = createTreeView(reader.objects, newTree);
				const out: FileHunks[] = [];
				for (const [i, path] of paths.entries()) {
					if (i >= MERGE3_MAX_PER_CALL) {
						out.push(pathLevelHunks(path));
						continue;
					}
					const [o, n] = await Promise.all([
						oldView.entry(path),
						newView.entry(path),
					]);
					const blobs = [o, n].map((e) =>
						e?.type === "tree" ? undefined : e?.hash
					);
					const cached = await Promise.all(
						blobs.map((h) => h ? reader.cachedBlob(h) : null),
					);
					const misses = blobs.filter((h, k) => h && cached[k] === null).length;
					if (deps.bucket.available() < misses) {
						// Optional detail: an empty bucket degrades to path level.
						out.push(pathLevelHunks(path));
						continue;
					}
					const [before, after] = await Promise.all([
						readSide(reader, blobs[0], o?.mode),
						readSide(reader, blobs[1], n?.mode),
					]);
					if (before.kind === "binary" || after.kind === "binary") {
						out.push({ path, binary: true, hunks: [] });
					} else if (before.kind !== "text" || after.kind !== "text") {
						out.push(pathLevelHunks(path));
					} else {
						out.push({
							path,
							binary: false,
							hunks: diffLines(before.lines, after.lines).map(changeToHunk),
						});
					}
				}
				return out;
			}),

		merge3: (inputs: readonly Merge3Input[]) =>
			withSession(async (s): Promise<Merge3Result[]> => {
				const out: Merge3Result[] = [];
				for (const [i, input] of inputs.entries()) {
					if (i >= MERGE3_MAX_PER_CALL) {
						out.push(pathLevelMerge(input.path));
						continue;
					}
					const reader = await s.reader({ repoId: input.repoId });
					const hashes = [input.base, input.ours, input.theirs];
					if (hashes.some((h) => h !== null && !isResolvedSha(h))) {
						throw invalid("merge3 takes blob shas");
					}
					const cached = await Promise.all(
						hashes.map((h) => h === null ? null : reader.cachedBlob(h)),
					);
					const misses = hashes.filter((h, k) =>
						h !== null && cached[k] === null
					).length;
					if (deps.bucket.available() < misses) {
						out.push(pathLevelMerge(input.path));
						continue;
					}
					const blobs = await Promise.all(hashes.map((h, k) =>
						h === null
							? Promise.resolve(null)
							: cached[k] ?? reader.readBlobBytes(h as ResolvedSha)
					));
					const [base, ours, theirs] = blobs;
					// A blob only a lane repo holds is not readable through the
					// canonical repo unless the family cache has it (Merge3Input
					// names no lane): answer path-level rather than guess.
					if (
						ours === null || theirs === null ||
						(input.base !== null && base === null)
					) {
						out.push(pathLevelMerge(input.path));
						continue;
					}
					const tooBig = [base, ours, theirs].some((b) =>
						b !== null && b.length > LINE_DIFF_MAX_BYTES
					);
					if (tooBig) {
						out.push(pathLevelMerge(input.path));
						continue;
					}
					const merged = merge3Bytes(base, ours, theirs);
					out.push({
						path: input.path,
						clean: merged.clean,
						binary: merged.binary,
						regions: merged.regions,
					});
				}
				return out;
			}),

		diff: (a, b, options) =>
			withSession(async (s): Promise<FileDiff[]> => {
				const patch = options?.patch === true;
				const sa = checkSource({
					repoId: a.repoId,
					...(a.laneId ? { laneId: a.laneId } : {}),
				});
				const sb = checkSource({
					repoId: b.repoId,
					...(b.laneId ? { laneId: b.laneId } : {}),
				});
				if (sa.repoId !== sb.repoId) {
					throw invalid("diff-of-diffs stays within one repo family");
				}
				const [shaA, shaB] = await Promise.all([
					s.sha(sa, a.sha),
					s.sha(sb, b.sha),
				]);
				// With patches under their own key: an answer cached without them
				// never satisfies a request for them.
				const key = `diffs/${sa.repoId}/${shaA}..${shaB}.${
					patch ? "patch" : "files"
				}.json`;
				const cached = await deps.diffs.get(key);
				if (cached) {
					try {
						return JSON.parse(await cached.text()) as FileDiff[];
					} catch {
						// recompute
					}
				}
				const diff = await treeDiff(s, sa, shaA, sb, shaB);
				const { files } = await fileDiffs(
					diff.oldReader,
					diff.newReader,
					diff.changes,
					{ hunkFiles: COMPARE_HUNK_FILES, addedLines: null, patch },
				);
				await deps.diffs.put(key, JSON.stringify(files));
				return files;
			}),

		projectGraph: (repoId, sha) =>
			withSession(async (s) => {
				const source = checkSource({ repoId });
				return await graphAt(s, source, await s.sha(source, sha));
			}),

		affected: (repoId, base, head, options) =>
			withSession(async (s): Promise<Affected> => {
				const source = checkSource(options?.source ?? { repoId });
				if (source.repoId !== repoId) {
					throw invalid("source is not in this repo");
				}
				const paths = await diffPathsIn(s, source, base, head);
				const graph = options?.graphAt
					? await graphAt(
						s,
						{ repoId },
						await s.sha({ repoId }, options.graphAt),
					)
					: await graphAt(s, source, await s.sha(source, head));
				if (paths.truncated) {
					return {
						projects: graph.projects.map((p) => p.name).sort(),
						global: true,
					};
				}
				return affectedBy(
					graph,
					paths.paths.flatMap((p) =>
						p.oldPath ? [p.oldPath, p.path] : [p.path]
					),
				);
			}),

		treeHash: (source, sha, path) =>
			withSession(async (s) => {
				const src = checkSource(source);
				const reader = await s.reader(src);
				const tree = await s.tree(reader, await s.sha(src, sha));
				const normalised = path.replace(/^\/+|\/+$/g, "");
				const entry = await createTreeView(reader.objects, tree).entry(
					normalised,
				);
				return entry?.hash ?? null;
			}),

		addedLines: (source, base, head, limits) =>
			withSession(async (s) => {
				const src = checkSource(source);
				const [baseSha, headSha] = await Promise.all([
					s.sha(src, base),
					s.sha(src, head),
				]);
				const diff = await treeDiff(s, src, baseSha, src, headSha);
				const caps = limits ?? {
					lines: GATE_INPUT_LIMITS.addedLines,
					bytes: GATE_INPUT_LIMITS.addedBytes,
				};
				const relevant = diff.changes.filter((c) => c.change !== "deleted");
				const details = await fileDiffs(
					diff.oldReader,
					diff.newReader,
					relevant,
					{ hunkFiles: PUSH_DIFF_HUNK_FILES, addedLines: caps, patch: false },
				);
				return {
					lines: details.added,
					truncated: diff.truncated || details.truncated,
				};
			}),
	};
};
