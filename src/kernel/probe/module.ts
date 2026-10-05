// RepoDO `probe` module (WP8, migrations 250–299): the
// project-graph cache. A graph is stored once per manifest-set key
// (`manifests_tree_sha`) and every commit it was computed at points to it,
// so K6 can ask for the graph **at a given commit**. `projects` and
// `global_files` mirror the most recently stored graph, for
// in-DO readers that join on project rows. Detection itself runs in
// RepoProbe; `diffPaths` delegates there (reading R2 `diffs/` first).

import { type GitSource, invalid, type ProjectGraph } from "@tartan/contract";
import {
	type DoModule,
	type GlobalFileRow,
	type Migration,
	MIGRATION_RANGES,
	type ModuleDeps,
	type ProjectRow,
	type RepoInternals,
	type RepoProbeFacade,
	type RepoProbeInternal,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { loopback } from "../../exports.ts";
import { storedExtras } from "./projects.ts";

/** Commits remembered (oldest dropped first). */
export const GRAPH_COMMITS_MAX = 2_000;
/** Distinct graphs remembered (oldest dropped first, with their commits). */
export const GRAPHS_MAX = 200;

export const PROBE_MIGRATIONS: readonly Migration[] = [
	{
		n: 250,
		name: "projects, global_files",
		sql:
			`CREATE TABLE projects (name TEXT PRIMARY KEY, root TEXT NOT NULL, deps_json TEXT NOT NULL DEFAULT '[]',
  owners_json TEXT NOT NULL DEFAULT '[]', sensitive INTEGER NOT NULL DEFAULT 0, test_cmd TEXT,
  source TEXT NOT NULL, manifest_path TEXT, manifests_tree_sha TEXT NOT NULL);
CREATE TABLE global_files (glob TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('config','detector-default')))`,
	},
	{
		n: 251,
		name: "project_graphs, project_graph_commits",
		sql:
			`CREATE TABLE project_graphs (manifests_tree_sha TEXT PRIMARY KEY, graph_json TEXT NOT NULL,
  at INTEGER NOT NULL);
CREATE TABLE project_graph_commits (sha TEXT PRIMARY KEY, manifests_tree_sha TEXT NOT NULL,
  at INTEGER NOT NULL);
CREATE INDEX project_graph_commits_at ON project_graph_commits(at);
CREATE INDEX project_graphs_at ON project_graphs(at)`,
	},
];

type StoredGraph = Omit<ProjectGraph, "sha">;

const SHA_RE = /^[0-9a-f]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

const checkGraph = (graph: ProjectGraph): void => {
	if (!SHA_RE.test(graph.sha)) throw invalid("graph sha must be a commit sha");
	if (!HEX64_RE.test(graph.manifestsTreeSha)) {
		throw invalid("manifestsTreeSha must be 64 hex chars");
	}
	if (!Array.isArray(graph.projects) || !Array.isArray(graph.globalFiles)) {
		throw invalid("graph needs projects and globalFiles");
	}
};

export const createProbeModule = (
	deps: ModuleDeps<Env, RepoInternals>,
): { facade: RepoProbeFacade; internal: RepoProbeInternal } => {
	const { sql, ctx, clock } = deps;

	const graphByKey = (key: string): StoredGraph | null => {
		const row = sql.exec<{ graph_json: string }>(
			"SELECT graph_json FROM project_graphs WHERE manifests_tree_sha = ?",
			key,
		).toArray()[0];
		return row ? JSON.parse(row.graph_json) as StoredGraph : null;
	};

	const projectsAt = (sha: string): ProjectGraph | null => {
		const row = sql.exec<{ manifests_tree_sha: string }>(
			"SELECT manifests_tree_sha FROM project_graph_commits WHERE sha = ?",
			sha,
		).toArray()[0];
		const graph = row ? graphByKey(row.manifests_tree_sha) : null;
		return graph ? { ...graph, sha } : null;
	};

	const mirror = (graph: ProjectGraph): void => {
		sql.exec("DELETE FROM projects");
		sql.exec("DELETE FROM global_files");
		for (const p of graph.projects) {
			const row: ProjectRow = {
				name: p.name,
				root: p.root,
				deps_json: JSON.stringify(p.deps),
				owners_json: JSON.stringify(p.owners),
				sensitive: p.sensitive ? 1 : 0,
				test_cmd: p.testCmd ?? null,
				source: p.source,
				manifest_path: p.manifestPath ?? null,
				manifests_tree_sha: graph.manifestsTreeSha,
			};
			sql.exec(
				`INSERT INTO projects (name, root, deps_json, owners_json, sensitive, test_cmd, source,
  manifest_path, manifests_tree_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				row.name,
				row.root,
				row.deps_json,
				row.owners_json,
				row.sensitive,
				row.test_cmd,
				row.source,
				row.manifest_path,
				row.manifests_tree_sha,
			);
		}
		for (const g of graph.globalFiles) {
			const row: GlobalFileRow = { glob: g.glob, source: g.source };
			sql.exec(
				"INSERT OR REPLACE INTO global_files (glob, source) VALUES (?, ?)",
				row.glob,
				row.source,
			);
		}
	};

	const prune = (): void => {
		sql.exec(
			`DELETE FROM project_graph_commits WHERE sha IN (SELECT sha FROM project_graph_commits
  ORDER BY at DESC, sha LIMIT -1 OFFSET ?)`,
			GRAPH_COMMITS_MAX,
		);
		sql.exec(
			`DELETE FROM project_graphs WHERE manifests_tree_sha IN (SELECT manifests_tree_sha
  FROM project_graphs ORDER BY at DESC, manifests_tree_sha LIMIT -1 OFFSET ?)`,
			GRAPHS_MAX,
		);
		sql.exec(
			`DELETE FROM project_graph_commits WHERE manifests_tree_sha NOT IN
  (SELECT manifests_tree_sha FROM project_graphs)`,
		);
	};

	const putProjects = (graph: ProjectGraph): void => {
		checkGraph(graph);
		const stored: StoredGraph = {
			manifestsTreeSha: graph.manifestsTreeSha,
			projects: graph.projects,
			globalFiles: graph.globalFiles,
			// The trunk config the configured projects came from (ADR repo config).
			...(graph.configKey === undefined ? {} : { configKey: graph.configKey }),
			...(graph.provisional === true ? { provisional: true } : {}),
			// The cuenv detector's graph fields (WP25, TARTAN_PROJECTS=scan).
			...storedExtras(graph),
		};
		const at = clock.now();
		ctx.storage.transactionSync(() => {
			sql.exec(
				`INSERT INTO project_graphs (manifests_tree_sha, graph_json, at) VALUES (?, ?, ?)
  ON CONFLICT (manifests_tree_sha) DO UPDATE SET at = excluded.at`,
				graph.manifestsTreeSha,
				JSON.stringify(stored),
				at,
			);
			sql.exec(
				`INSERT INTO project_graph_commits (sha, manifests_tree_sha, at) VALUES (?, ?, ?)
  ON CONFLICT (sha) DO UPDATE SET manifests_tree_sha = excluded.manifests_tree_sha, at = excluded.at`,
				graph.sha,
				graph.manifestsTreeSha,
				at,
			);
			mirror(graph);
			prune();
		});
	};

	const ownRepoId = (): string | null =>
		sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'repo_id'")
			.toArray()[0]
			?.v ?? null;

	const facade: RepoProbeFacade = {
		projects: (sha) =>
			typeof sha === "string" && SHA_RE.test(sha)
				? Promise.resolve(projectsAt(sha))
				: Promise.reject(invalid("projects takes a commit sha")),
		putProjects: (graph) => Promise.resolve(putProjects(graph)),
		diffPaths: (source: GitSource, base, head) => {
			const own = ownRepoId();
			if (own !== null && source.repoId !== own) {
				return Promise.reject(invalid("source is not this repo"));
			}
			return loopback(ctx).RepoProbe.diffPaths(source, base, head);
		},
	};

	const internal: RepoProbeInternal = {
		projectsSync: (manifestsTreeSha) => {
			const graph = graphByKey(manifestsTreeSha);
			if (!graph) return null;
			const latest = sql.exec<{ sha: string }>(
				`SELECT sha FROM project_graph_commits WHERE manifests_tree_sha = ?
  ORDER BY at DESC LIMIT 1`,
				manifestsTreeSha,
			).toArray()[0];
			return latest ? { ...graph, sha: latest.sha } : null;
		},
	};

	return { facade, internal };
};

export const repoProbeModule: DoModule<
	RepoProbeFacade,
	RepoProbeInternal,
	Env,
	RepoInternals
> = {
	name: "probe",
	range: MIGRATION_RANGES.repo.probe,
	migrations: PROBE_MIGRATIONS,
	create: createProbeModule,
};
