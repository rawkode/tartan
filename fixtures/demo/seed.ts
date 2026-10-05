// Seeding a demo beat (WP20): the base every beat starts
// from, then the beat's own state, through the forge's public API, MCP and
// git smart HTTP only (no private route, no direct storage access). Seeded
// actors are agents named `seeded-<run>-<n>` with model `seeded`, labelled
// as such wherever an agent is shown; their tokens live in memory for the run.
// The real agents' tokens (claude-code, codex) are written only to the
// operator's file given with `--agents-file` (mode 0600, outside the repo),
// never printed.

import { ZERO_SHA } from "@tartan/contract";
import { writePack } from "@tartan/gitproto";
import type { SimPort } from "../../src/kernel/swarm/agent.ts";
import {
	buildCommit,
	type DirEntry,
	normalizeMode,
	treeStateOf,
} from "../../src/kernel/swarm/gittree.ts";
import type { Beat, DemoFixture, ScriptedChange } from "./beats.ts";
import { type ForgeClient, ForgeError, type NodeRef } from "./client.ts";

export type MirrorSource =
	| { readonly url: string }
	| { readonly dir: string };

export type SeedDeps = {
	readonly client: ForgeClient;
	/** An MCP + git port as a given token (`src/kernel/swarm/transport.ts` over HTTPS). */
	portFor(token: string, scope: string): SimPort;
	/** Pushes a local mirror's HEAD to `main` of a repo in import mode (git CLI). */
	pushMirror(repoUrl: string, dir: string): Promise<void>;
	/** Writes the real agents' tokens for the operator (0600). */
	saveAgentTokens(tokens: Record<string, string>): Promise<void>;
	readonly log: (line: string) => void;
	readonly now: () => number;
};

export type SeedOptions = {
	readonly beat: Beat;
	readonly fixture: DemoFixture;
	readonly mirror?: MirrorSource;
	/** Skip what the forge cannot do yet (e.g. seeded advances) instead of failing. */
	readonly allowMissing: boolean;
	/** The swarm's agent cap (`?max=`). */
	readonly swarmMax?: number;
};

export type SeedReport = {
	readonly created: string[];
	readonly existing: string[];
	readonly skipped: string[];
	readonly items: Record<string, string>;
	changes: number;
	swarm?: string;
	/** Seeded Advances (WP10's dev-only seedHistory) and the fake-key positions. */
	seeded?: { advances: number; withFakeKeys: number[] };
};

const parentOf = (path: string) => path.split("/").slice(0, -1).join("/");
const slugOf = (path: string) => path.split("/").at(-1)!;

const ensureGroup = async (
	deps: SeedDeps,
	report: SeedReport,
	path: string,
	description: string,
): Promise<NodeRef> => {
	const found = await deps.client.resolve(path);
	if (found) {
		report.existing.push(path);
		return found;
	}
	const parent = parentOf(path);
	const node = await deps.client.createGroup(
		parent === "" ? undefined : parent,
		slugOf(path),
		description,
	);
	report.created.push(path);
	return node;
};

const ensureInstalled = async (
	deps: SeedDeps,
	report: SeedReport,
	extId: string,
	node: string,
): Promise<void> => {
	if ((await deps.client.installed(node)).includes(extId)) {
		report.existing.push(`${extId}@${node}`);
		return;
	}
	await deps.client.install(extId, node);
	report.created.push(`${extId}@${node}`);
};

const ensureDemoRepo = async (
	deps: SeedDeps,
	opts: SeedOptions,
	report: SeedReport,
): Promise<NodeRef> => {
	const path = opts.fixture.repo;
	const found = await deps.client.resolve(path);
	if (found) {
		report.existing.push(path);
		return found;
	}
	const description =
		"Demo mirror of the rawkode-academy monorepo (binaries replaced by placeholders)";
	const mirror = opts.mirror;
	if (mirror && "url" in mirror) {
		const repo = await deps.client.createRepo(
			parentOf(path),
			slugOf(path),
			description,
			{ url: mirror.url },
		);
		report.created.push(`${path} (imported from ${new URL(mirror.url).host})`);
		return repo;
	}
	if (mirror && "dir" in mirror) {
		const repo = await deps.client.createRepo(
			parentOf(path),
			slugOf(path),
			description,
			{ mode: "push" },
		);
		await deps.pushMirror(`${deps.client.origin}/${path}.git`, mirror.dir);
		await deps.client.importComplete(repo.id);
		report.created.push(`${path} (pushed from the local mirror)`);
		return repo;
	}
	if (!opts.allowMissing) {
		throw new Error(
			`${path} does not exist: give --mirror <dir> or --mirror-url <https url> (or --allow-missing for an empty repo)`,
		);
	}
	const repo = await deps.client.createRepo(
		parentOf(path),
		slugOf(path),
		description,
	);
	report.skipped.push(`${path}: created empty (no mirror given)`);
	return repo;
};

/** Everything every beat starts from. */
export const seedBase = async (
	deps: SeedDeps,
	opts: SeedOptions,
	report: SeedReport,
): Promise<NodeRef> => {
	const f = opts.fixture;
	if (!(await deps.client.resolve(f.namespace))) {
		throw new Error(
			`no namespace ${f.namespace}: claim the forge as its owner first`,
		);
	}
	await ensureInstalled(deps, report, "tartan.hud", f.namespace);
	await ensureGroup(deps, report, f.platformGroup, "Platform team");
	await ensureGroup(deps, report, parentOf(f.repo), "Edge services");
	await ensureInstalled(deps, report, "tartan.pack.swarm", f.platformGroup);
	await ensureGroup(deps, report, parentOf(f.docsRepo), "Documentation");
	await ensureInstalled(
		deps,
		report,
		"tartan.pack.classic",
		parentOf(f.docsRepo),
	);
	const repo = await ensureDemoRepo(deps, opts, report);
	if (!(await deps.client.resolve(f.docsRepo))) {
		await deps.client.createRepo(
			parentOf(f.docsRepo),
			slugOf(f.docsRepo),
			"Documentation site (Classic protocol: human approval, FIFO)",
		);
		report.created.push(f.docsRepo);
	} else report.existing.push(f.docsRepo);
	const existing = new Set(
		(await deps.client.agents()).agents.filter((a) => !a.disabled).map((a) =>
			a.handle
		),
	);
	const tokens: Record<string, string> = {};
	for (const agent of f.agents) {
		if (existing.has(agent.name)) {
			report.existing.push(`agent ${agent.name}`);
			continue;
		}
		const created = await deps.client.createAgent({
			name: agent.name,
			tool: agent.tool,
			...(agent.model ? { model: agent.model } : {}),
			node: f.platformGroup,
			ttlDays: 7,
		});
		tokens[agent.name] = created.token;
		report.created.push(`agent ${agent.name}`);
	}
	if (Object.keys(tokens).length > 0) await deps.saveAgentTokens(tokens);
	return repo;
};

const record = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null
		? value as Record<string, unknown>
		: {};

/** Opens the beat's work items as the owner (by title: an open item is reused). */
const seedItems = async (
	opts: SeedOptions,
	report: SeedReport,
	owner: SimPort,
): Promise<void> => {
	const listed = await owner.tool("work_list", {
		repo: opts.fixture.repo,
		state: "open",
		limit: 200,
	});
	const open = new Map(
		(Array.isArray(listed["items"]) ? listed["items"] : []).map(record).map((
			i,
		) => [String(i["title"]), String(i["ref"])]),
	);
	for (const key of opts.beat.items) {
		const item = opts.fixture.items[key];
		if (!item) throw new Error(`the fixture has no item ${key}`);
		const ref = open.get(item.title) ?? String(
			(await owner.tool("work_create", {
				repo: opts.fixture.repo,
				kind: "issue",
				title: item.title,
				why: item.why,
				acceptance: [...item.acceptance],
				footprint: {
					projects: [...item.projects],
					prefixes: [...item.prefixes],
				},
			}))["ref"],
		);
		report.items[key] = ref;
	}
};

/** Lists a directory of a commit over MCP (`repo_tree`); null when missing. */
const readerOf =
	(port: SimPort, repo: string) =>
	async (commit: string, path: string): Promise<readonly DirEntry[] | null> => {
		try {
			const out = await port.tool("repo_tree", { repo, ref: commit, path });
			return (Array.isArray(out["entries"]) ? out["entries"] : []).map(record)
				.map((e) => ({
					name: String(e["name"]),
					mode: normalizeMode(String(e["mode"])),
					id: String(e["hash"]),
				}));
		} catch {
			return null;
		}
	};

const readText = async (
	port: SimPort,
	repo: string,
	commit: string,
	path: string,
): Promise<string> => {
	try {
		const out = await port.tool("repo_read", { repo, ref: commit, path });
		return typeof out["text"] === "string" ? out["text"] : "";
	} catch {
		return "";
	}
};

/** One seeded actor's change: its own item, claim, one commit to its lane, submit. */
const seedChange = async (
	port: SimPort,
	opts: SeedOptions,
	change: ScriptedChange,
	actor: string,
	now: number,
): Promise<void> => {
	const repo = opts.fixture.repo;
	const item = opts.fixture.items[change.item]!;
	const created = await port.tool("work_create", {
		repo,
		kind: "intent",
		title: `${item.title} (${actor}, seeded)`,
		why: `${item.why} Seeded for the demo.`,
		acceptance: [...item.acceptance],
		footprint: { projects: [...item.projects], prefixes: [...item.prefixes] },
		labels: ["seeded"],
	});
	const claimed = await port.tool("work_claim", {
		ref: created["ref"],
		footprint: { projects: [...item.projects], prefixes: [...item.prefixes] },
	});
	const lane = record(claimed["lane"]);
	const base = String(lane["base"]);
	const edits = [];
	for (const edit of change.edits) {
		const current = await readText(port, repo, base, edit.path);
		edits.push({ path: edit.path, content: `${current}${edit.append}` });
	}
	const built = await buildCommit({
		state: treeStateOf(base),
		read: readerOf(port, repo),
		edits,
		message: `${item.title}\n\nSeeded change by ${actor} for the demo.`,
		author: {
			name: actor,
			email: `${actor}@seeded.tartan.invalid`,
			at: Math.floor(now / 1000),
		},
	});
	const { pack } = await writePack(built.objects);
	const [status] = await port.push(
		String(lane["remote"]),
		[{ ref: String(lane["ref"]), old: ZERO_SHA, new: built.commit }],
		pack,
	);
	if (!status?.ok) {
		throw new Error(
			`${actor}: push refused (${status?.reason ?? "no status"})`,
		);
	}
	if (change.submit) {
		await port.tool("changes_submit", {
			repo,
			laneId: String(lane["id"]),
			title: `${item.title} (${actor})`,
			summary: `Seeded change by ${actor}.`,
			why: item.why,
		});
	}
};

export const seedBeat = async (
	deps: SeedDeps,
	opts: SeedOptions,
): Promise<SeedReport> => {
	const report: SeedReport = {
		created: [],
		existing: [],
		skipped: [],
		items: {},
		changes: 0,
	};
	await seedBase(deps, opts, report);
	const owner = deps.portFor(deps.client.token, opts.fixture.repo);
	await seedItems(opts, report, owner);
	if (opts.beat.changes.length > 0) {
		const run = deps.now().toString(36).slice(-6);
		const actors = new Map<string, string>();
		for (const change of opts.beat.changes) {
			if (!actors.has(change.actor)) {
				const name = `${change.actor.replace(/^seeded-/, `seeded-${run}-`)}`;
				const created = await deps.client.createAgent({
					name,
					tool: "other",
					model: "seeded",
					node: opts.fixture.platformGroup,
					ttlDays: 1,
				});
				actors.set(change.actor, created.token);
				report.created.push(`agent ${name}`);
			}
		}
		for (const change of opts.beat.changes) {
			const token = actors.get(change.actor)!;
			await seedChange(
				deps.portFor(token, opts.fixture.repo),
				opts,
				change,
				change.actor,
				deps.now(),
			);
			report.changes++;
		}
	}
	if (opts.beat.swarm) {
		const started = await deps.client.startSwarm({
			repo: opts.fixture.repo,
			agents: opts.beat.swarm.agents,
			workItems: opts.beat.swarm.workItems,
			minutes: opts.beat.swarm.minutes,
		}, opts.swarmMax);
		report.swarm = started.id;
	}
	if (opts.beat.seededAdvances) {
		try {
			const seeded = await deps.client.seedHistory(
				opts.fixture.repo,
				opts.beat.seededAdvances,
			);
			report.seeded = {
				advances: seeded.advances,
				withFakeKeys: seeded.withFakeKeys,
			};
		} catch (error) {
			// 404: the forge has no dev tools (or predates seedHistory).
			if (!(error instanceof ForgeError) || error.status !== 404) throw error;
			const missing =
				`${opts.beat.seededAdvances} seeded advances need WP10's dev-only seedHistory, which this forge does not serve (no dev tools)`;
			if (!opts.allowMissing) throw new Error(missing);
			report.skipped.push(missing);
		}
	}
	deps.log(
		`beat ${opts.beat.n} (${opts.beat.name}): ${report.created.length} created, ${report.existing.length} existing, ${report.changes} changes${
			report.swarm ? `, swarm ${report.swarm}` : ""
		}`,
	);
	return report;
};
