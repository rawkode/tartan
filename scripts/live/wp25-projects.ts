// WP25 live acceptance: monorepo projects
// from cuenv `#Project`s on a deployed stage
// rendered with `--projects scan`.
//
// Two modes:
//
//   1. Dev (an unclaimed dev stage with dev tools; no sign-in needed):
//
//        TARTAN_DEV_KEY=… deno task live -- --stage dev-wp25 wp25 \
//          --base https://tartan-dev-wp25.<sub>.workers.dev \
//          [--tree <checkout>] [--evidence <file>]
//
//      Seeds a repo through `/-/dev/projects` (real Artifacts: one commit,
//      pushed over smart HTTP) with the demo-shaped fixture, or with the
//      detection files and directory skeleton of a local checkout
//      (`--tree`: every `.cue`, `package.json`, lockfile, README, AGENTS.md
//      and CLAUDE.md, plus one placeholder per directory that holds none of
//      them, so the walk sees every directory). Then, on the edge: the cold
//      detection (RepoProbe → Artifacts reads by SHA → RepoDO cache), the
//      warm read, the affected sets, and a project's README and agent doc.
//      The dev key is `hex(HMAC-SHA256(TARTAN_SECRET, "tartan:dev:projects"))`.
//
//   2. Forge (a claimed forge; the projects API and its filtered lists):
//
//        TARTAN_TOKEN=… deno task live -- --stage dev-demo wp25 \
//          --base https://code.example.com --repo rawkode/academy \
//          [--project rawkode-academy-design-system] [--evidence <file>]
//
//      TARTAN_TOKEN is a PAT or agent token with `api` on the repo. Checks
//      the list (cuenv detector, layers), the project page, and that its
//      Issues and Pull requests answer through the providers.
//
// Credentials come from the environment and are never printed. Every
// response body is scanned for Artifacts tokens (`art_v<n>_`). Exit code 0
// only when every check passes.

import { ulid } from "../../packages/contract/src/index.ts";
import { CUENV_DEMO_FILES } from "../../packages/monorepo/test/fixtures/cuenv-demo.ts";

const arg = (name: string): string | undefined => {
	const i = Deno.args.indexOf(`--${name}`);
	return i >= 0 ? Deno.args[i + 1] : undefined;
};
const fail = (message: string): never => {
	console.error(`wp25: FAIL ${message}`);
	Deno.exit(1);
};

const base = (arg("base") ?? fail("--base is required")).replace(/\/+$/, "");
const evidencePath = arg("evidence");
const DS = arg("project") ?? "rawkode-academy-design-system";
const WEB = "rawkode-academy-website";

const LEAK = /art_v[0-9]+_(?!<redacted>)/;
const leaks: string[] = [];
const results: { name: string; ok: boolean; detail: string }[] = [];
const evidence: Record<string, unknown> = {
	base,
	startedAt: new Date().toISOString(),
};

const check = (name: string, ok: boolean, detail = "") => {
	results.push({ name, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

const request = async <T>(
	method: string,
	path: string,
	headers: Record<string, string>,
	body?: unknown,
): Promise<{ status: number; json: T; ms: number }> => {
	const started = performance.now();
	const res = await fetch(`${base}${path}`, {
		method,
		headers: {
			...headers,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	const ms = Math.round(performance.now() - started);
	if (LEAK.test(text)) leaks.push(`${method} ${path}`);
	let json: unknown = text;
	try {
		json = JSON.parse(text);
	} catch {
		// keep the text
	}
	return { status: res.status, json: json as T, ms };
};

// ---------------------------------------------------------------------------
// The detection files of a local checkout (`--tree`)
// ---------------------------------------------------------------------------

const DETECTION_FILE = (name: string): boolean =>
	name.endsWith(".cue") ||
	[
		"package.json",
		"bun.lock",
		"pnpm-workspace.yaml",
		"pnpm-lock.yaml",
		"package-lock.json",
		"deno.json",
		"deno.jsonc",
		"Cargo.toml",
		"go.work",
		"go.mod",
		"README.md",
		"AGENTS.md",
		"CLAUDE.md",
		"CODEOWNERS",
	].includes(name);
const SAFE_SEGMENT = /^[A-Za-z0-9._@-]+$/;
const FILE_MAX = 200 * 1024;

const treeFiles = async (
	root: string,
): Promise<{ files: Record<string, string>; skipped: number }> => {
	const files: Record<string, string> = {};
	let skipped = 0;
	const visit = async (dir: string, rel: string): Promise<void> => {
		let held = false;
		const subdirs: [string, string][] = [];
		for await (const entry of Deno.readDir(dir)) {
			if (entry.name === ".git") continue;
			const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (!SAFE_SEGMENT.test(entry.name)) {
				skipped++;
				continue;
			}
			if (entry.isDirectory) subdirs.push([`${dir}/${entry.name}`, path]);
			else if (entry.isFile && DETECTION_FILE(entry.name)) {
				const text = await Deno.readTextFile(`${dir}/${entry.name}`);
				if (text.length > FILE_MAX) {
					skipped++;
					continue;
				}
				files[path] = text;
				held = true;
			}
		}
		if (!held && rel !== "") files[`${rel}/.wp25-placeholder`] = "";
		for (const [d, r] of subdirs) await visit(d, r);
	};
	await visit(root.replace(/\/+$/, ""), "");
	return { files, skipped };
};

// ---------------------------------------------------------------------------
// Mode 1: dev
// ---------------------------------------------------------------------------

type GraphAnswer = {
	mode: string;
	ms: number;
	cachedBefore: boolean;
	cache?: { hits: number; edgeHits: number; misses: number };
	graphBytes: number;
	response: {
		sha: string;
		detector: string | null;
		fidelity: string | null;
		projects: {
			name: string;
			slug: string;
			root: string;
			dependents: string[];
		}[];
		layers: { root: string; paths: string[] }[];
		skipped: string[];
		warnings: { code: string; path?: string }[];
		truncated: boolean;
	};
	affected: { projects: string[]; global: boolean };
};

const devMode = async (key: string): Promise<void> => {
	const headers = { "x-tartan-dev-key": key };
	const tree = arg("tree");
	const { files, skipped } = tree
		? await treeFiles(tree)
		: { files: { ...CUENV_DEMO_FILES }, skipped: 0 };
	evidence.source = tree ? "checkout (detection files)" : "fixture";
	evidence.files = Object.keys(files).length;
	evidence.skippedPaths = skipped;
	const repoId = ulid().toLowerCase();
	evidence.repoId = repoId;
	const seeded = await request<
		{ sha: string; files: number; packBytes: number; ms: number }
	>("POST", `/-/dev/projects/${repoId}/seed`, headers, { files });
	check(
		"seed: one commit of the tree in a new Artifacts repo",
		seeded.status === 200 && typeof seeded.json.sha === "string",
		`${seeded.status}; ${seeded.json.files} files, ${seeded.json.packBytes} pack bytes, ${seeded.ms} ms`,
	);
	if (seeded.status !== 200) return;
	const sha = seeded.json.sha;
	evidence.seed = seeded.json;

	const graphOf = (paths: string[]) =>
		request<GraphAnswer>(
			"GET",
			`/-/dev/projects/${repoId}/graph?sha=${sha}&paths=${
				encodeURIComponent(paths.join(","))
			}`,
			headers,
		);
	const cold = await graphOf(["packages/design-system/src/button.ts"]);
	const g = cold.json.response;
	evidence.cold = {
		status: cold.status,
		ms: cold.json.ms,
		roundTripMs: cold.ms,
		cachedBefore: cold.json.cachedBefore,
		cache: cold.json.cache,
		graphBytes: cold.json.graphBytes,
		projects: g?.projects.length,
		layers: g?.layers.map((l) => l.root),
		skipped: g?.skipped,
		warnings: g?.warnings.map((w) => `${w.code}:${w.path ?? ""}`),
	};
	check(
		"mode: the stage renders TARTAN_PROJECTS=scan",
		cold.json.mode === "scan",
		cold.json.mode,
	);
	check(
		"cold: detected on the first read (RepoProbe, Artifacts by SHA)",
		cold.status === 200 && cold.json.cachedBefore === false,
		`${cold.json.ms} ms in the Worker, ${cold.ms} ms round trip; cache ${
			JSON.stringify(cold.json.cache ?? {})
		}`,
	);
	check(
		"graph: the cuenv detector, textual scan",
		g?.detector === "cuenv" && g?.fidelity === "scan",
	);
	check(
		"graph: 38 projects",
		g?.projects.length === 38,
		String(g?.projects.length),
	);
	check(
		"graph: 3 layers (root, projects, projects/rawkode.academy)",
		JSON.stringify(g?.layers.map((l) => l.root)) ===
			JSON.stringify(["", "projects", "projects/rawkode.academy"]),
	);
	check(
		"graph: the nested module is skipped",
		g?.skipped.includes("projects/code.rawkode.academy/config") === true,
		JSON.stringify(g?.skipped),
	);
	check("graph: not truncated", g?.truncated === false);
	const ds = g?.projects.find((p) => p.name === DS);
	check(
		"graph: design-system's dependents",
		ds?.dependents.includes(WEB) === true,
		JSON.stringify(ds?.dependents),
	);
	check(
		"affected: a design-system edit is design-system + website",
		JSON.stringify(cold.json.affected) ===
			JSON.stringify({ projects: [DS, WEB], global: false }),
		JSON.stringify(cold.json.affected),
	);
	const warm = await graphOf(["bun.lock"]);
	evidence.warm = { ms: warm.json.ms, roundTripMs: warm.ms };
	check(
		"warm: served from RepoDO's cache",
		warm.status === 200 && warm.json.cachedBefore === true,
		`${warm.json.ms} ms in the Worker`,
	);
	check(
		"affected: bun.lock is global (every project)",
		warm.json.affected?.global === true &&
			warm.json.affected.projects.length === 38,
	);
	const page = await request<
		{
			project: { name: string };
			readme?: { path: string };
			agentsDoc?: { path: string };
		}
	>(
		"GET",
		`/-/dev/projects/${repoId}/project?sha=${sha}&project=${DS}`,
		headers,
	);
	evidence.project = {
		status: page.status,
		readme: page.json.readme?.path,
		agentsDoc: page.json.agentsDoc?.path,
	};
	check(
		"project: the nearest agent doc, read by SHA",
		page.status === 200 && page.json.agentsDoc?.path === "AGENTS.md",
		JSON.stringify(page.json.agentsDoc),
	);
	if (!tree) {
		check(
			"project: the root's README",
			page.json.readme?.path === "packages/design-system/README.md",
		);
	}
};

// ---------------------------------------------------------------------------
// Mode 2: forge
// ---------------------------------------------------------------------------

const forgeMode = async (token: string, repo: string): Promise<void> => {
	const headers = { authorization: `Bearer ${token}` };
	const view = await request<{ repo?: { id: string } }>(
		"GET",
		`/-/api/view?path=${encodeURIComponent(repo)}&view=`,
		headers,
	);
	const repoId = view.json.repo?.id ?? fail(`no repo ${repo} (${view.status})`);
	const list = await request<
		{
			detector: string;
			projects: { name: string; slug: string }[];
			layers: unknown[];
		}
	>("GET", `/-/api/repos/${repoId}/projects`, headers);
	evidence.list = {
		status: list.status,
		ms: list.ms,
		detector: list.json.detector,
		projects: list.json.projects?.length,
		layers: list.json.layers?.length,
	};
	check(
		"list: cuenv projects at the trunk tip",
		list.status === 200 && list.json.detector === "cuenv" &&
			list.json.projects.length > 0,
		`${list.json.projects?.length} projects, ${list.ms} ms`,
	);
	const slug = list.json.projects?.find((p) => p.name === DS)?.slug ?? DS;
	const page = await request<{ project: { name: string }; total: number }>(
		"GET",
		`/-/api/repos/${repoId}/projects/${slug}`,
		headers,
	);
	check("page: the project's page", page.status === 200, `${page.ms} ms`);
	for (const list of ["issues", "changes"] as const) {
		const out = await request<
			{
				provider: string | null;
				scanned: number;
				items?: unknown[];
				changes?: unknown[];
			}
		>("GET", `/-/api/repos/${repoId}/projects/${slug}/${list}`, headers);
		evidence[list] = {
			status: out.status,
			provider: out.json.provider,
			scanned: out.json.scanned,
			kept: (out.json.items ?? out.json.changes)?.length,
		};
		check(
			`${list}: read through the provider as the viewer`,
			out.status === 200 && out.json.provider !== null,
			`${out.json.provider}; ${
				(out.json.items ?? out.json.changes)?.length
			} of ${out.json.scanned}`,
		);
	}
};

const devKey = Deno.env.get("TARTAN_DEV_KEY");
const token = Deno.env.get("TARTAN_TOKEN");
const repo = arg("repo");
if (repo !== undefined) {
	await forgeMode(token ?? fail("TARTAN_TOKEN unset"), repo);
} else {
	await devMode(devKey ?? fail("TARTAN_DEV_KEY unset (or pass --repo)"));
}

check(
	"no Artifacts token in any response",
	leaks.length === 0,
	leaks.join(", "),
);
evidence.results = results;
evidence.finishedAt = new Date().toISOString();
if (evidencePath) {
	await Deno.writeTextFile(
		evidencePath,
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
	console.log(`wp25: evidence written to ${evidencePath}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`wp25: ${results.length - failed.length}/${results.length} PASS`);
Deno.exit(failed.length === 0 ? 0 : 1);
