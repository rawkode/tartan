// Live: a per-subtree protocol difference. The run's groups carry two
// packs: `e2e/swarm` (Swarm: work, changes, radar, CI, review, Weave) and
// `e2e/classic`
// (Classic: issues and pull requests, a person approves, FIFO lands one at
// a time).
//
// - the Classic subtree speaks Issues and Pull requests (the pack's labels,
//   in the tab bar and the view API), the Swarm subtree its own words;
// - the scoped MCP endpoint `/-/mcp/<path>` answers each scope's protocol
//   card in `initialize` and filters the tools by the interfaces in force;
//   a call into a repo of another protocol is a `protocol_mismatch` naming
//   that repo's MCP URL;
// - an Owner swaps queue@1 from the Weave to FIFO on one Swarm repo in the
//   UI, the repo's tab bar follows, the next change lands through FIFO after
//   a person approves it, and the Owner swaps back.
//
// Labels, versions and cards are read from the manifests in this checkout.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { writeFile } from "node:fs/promises";
import { expect } from "e2e";
import type {
	Change,
	LaneHandle,
	Review,
} from "@tartan/contract/interfaces.ts";
import type {
	EventsResponse,
	InstallationsResponse,
	ReplaceProviderResponse,
	ViewResponse,
} from "@tartan/contract/api.ts";
import { scriptedAgent } from "../../support/agent.ts";
import { sharedStore, test } from "../../support/fixtures.ts";
import { SWAP_FIXTURE } from "../../support/fixture-repo.ts";
import { ok, pageApi, query, tokenApi } from "../../support/http.ts";
import { extensionDir } from "../../support/labels.ts";
import {
	APPROVE_LABEL,
	assessedReview,
	REVIEW_PANEL,
} from "../../support/loop.ts";
import { mcpClient, McpError } from "../../support/mcp.ts";
import { PACK_GROUP } from "../../support/names.ts";
import { expectApiClean, urlOf, viewOf, watchApi } from "../../support/page.ts";
import { fixtureRepo } from "../../support/repos.ts";
import { keyOf, sharedDirOf } from "../../support/shared.ts";
import { type Stage, tokensOf } from "../../support/stage.ts";
import { EXTENSIONS_DIR } from "../../support/tabs.ts";

type Manifest = {
	readonly id: string;
	readonly version: string;
	readonly members?: readonly {
		readonly id: string;
		readonly config?: { readonly labels?: Readonly<Record<string, string>> };
	}[];
	readonly contributes?: {
		readonly slots?: readonly {
			readonly slot: string;
			readonly id: string;
			readonly label?: string;
		}[];
	};
};

const manifestOf = (ext: string): Manifest =>
	JSON.parse(
		readFileSync(path.join(extensionDir(ext), "tartan.json"), "utf8"),
	) as Manifest;
const packOf = (pack: "swarm" | "classic"): Manifest =>
	JSON.parse(
		readFileSync(
			path.join(EXTENSIONS_DIR, "packs", pack, "tartan.json"),
			"utf8",
		),
	) as Manifest;

/** A member's tab label as the pack renames it (`config.labels`), else the manifest's. */
const tabLabel = (
	pack: "swarm" | "classic",
	ext: string,
	tabId: string,
): string => {
	const member = packOf(pack).members?.find((m) => m.id === ext);
	return member?.config?.labels?.[tabId] ??
		manifestOf(ext).contributes?.slots?.find((s) =>
			s.slot === "repo.tab" && s.id === tabId
		)?.label ?? tabId;
};

/** The first line of a protocol card (`protocol.md`). */
const cardLine = (dir: string): string =>
	readFileSync(path.join(dir, "protocol.md"), "utf8").split("\n")[0].trim();

const CLASSIC = {
	issues: tabLabel("classic", "tartan.work", "work"),
	pulls: tabLabel("classic", "tartan.changes", "changes"),
	newIssue: packOf("classic").members?.find((m) => m.id === "tartan.work")
		?.config?.labels?.["new-work"] ?? "",
	card: cardLine(path.join(EXTENSIONS_DIR, "packs", "classic")),
};
const SWARM = {
	work: tabLabel("swarm", "tartan.work", "work"),
	changes: tabLabel("swarm", "tartan.changes", "changes"),
	radar: tabLabel("swarm", "tartan.radar", "radar"),
	weave: tabLabel("swarm", "tartan.weave", "weave"),
	card: cardLine(extensionDir("tartan.radar")),
};
const FIFO = {
	id: "tartan.fifo",
	version: manifestOf("tartan.fifo").version,
	tab: tabLabel("classic", "tartan.fifo", "queue"),
};
const WEAVE = {
	id: "tartan.weave",
	version: manifestOf("tartan.weave").version,
};
/** radar's conflicts@1 tools: only where radar is in force. */
const RADAR_TOOLS = ["conflicts_check", "conflicts_list"];
/** Tools both packs serve (work@1, changes@1, queue@1). */
const SHARED_TOOLS = ["work_claim", "changes_submit", "queue_status"];
const QUEUE = "queue@1";
const PROTOCOL_MISMATCH = "protocol_mismatch";
const LANDED: Change["state"] = "landed";
const HUMAN: Review["route"] = "human";
const APPROVE: NonNullable<Review["decision"]> = "approve";
const MIN = 60_000;

type Repos = {
	readonly classic: { readonly path: string; readonly id: string };
	readonly swarm: { readonly path: string; readonly id: string };
};

const reposOf = (stage: Stage, index: number): Promise<Repos> =>
	sharedStore().once(`classic-${index}-repos`, async (): Promise<Repos> => {
		const suffix = index === 0 ? "" : `-${index}`;
		const [classic, swarm] = await Promise.all([
			fixtureRepo(stage, "classic", `classic${suffix}`),
			fixtureRepo(stage, "swarm", `classic-sw${suffix}`),
		]);
		return {
			classic: { path: classic.path, id: classic.id },
			swarm: { path: swarm.path, id: swarm.id },
		};
	});

const reposFor = async (stage: Stage, title: string) =>
	reposOf(
		stage,
		await sharedStore().claimIndex(`claim-classic-${keyOf(title)}`),
	);

const T = {
	words:
		"the Classic subtree speaks Issues and Pull requests; the Swarm subtree its own words",
	card: "the scoped MCP endpoint answers each scope's protocol card",
	tools:
		"the scoped MCP endpoint lists only the tools of the interfaces in force",
	mismatch:
		"a call into a repo of another protocol is a protocol_mismatch naming its MCP URL",
	swap:
		"an Owner swaps queue@1 from the Weave to FIFO on a live repo; the next change lands through FIFO",
} as const;

test.describe("Classic and Swarm subtrees", {
	tags: ["classic", "m2", "mcp", "regression", "developer"],
	session: "developer",
}, () => {
	test(T.words, { tags: ["ui", "smoke"], timeout: 5 * MIN }, async ({
		app,
		browser,
		screen,
		stage,
	}) => {
		const r = await reposFor(stage, T.words);
		// API: the view's static tabs carry the pack's labels.
		await app.open(`/${r.classic.path}`);
		await watchApi(browser);
		const classic = await viewOf(browser, r.classic.path, "");
		const labels = (v: ViewResponse) =>
			v.static.tabs.filter((t) => t.slot === "repo.tab").map((t) => t.label);
		expect(labels(classic)).toEqual(
			expect.arrayContaining([CLASSIC.issues, CLASSIC.pulls]),
		);
		expect(labels(classic)).not.toContain(SWARM.radar);
		// UI: the tab bar says Issues and Pull requests.
		const nav = screen.getByRole("navigation", "Repository");
		await expect(nav.getByRole("link", CLASSIC.issues)).toBeVisible();
		await expect(nav.getByRole("link", CLASSIC.pulls)).toBeVisible();
		await expect(nav.getByRole("link", SWARM.work)).toHaveCount(0);
		await nav.getByRole("link", CLASSIC.issues).tap();
		await expect(browser).toHaveURL(
			urlOf(stage.origin, `/${r.classic.path}/-/work`),
		);
		if (CLASSIC.newIssue !== "") {
			await expect(screen.getByText(CLASSIC.newIssue).first()).toBeVisible();
		}
		await expectApiClean(browser);
		// The Swarm repo next door: its own words and radar.
		await app.open(`/${r.swarm.path}`);
		const swarm = await viewOf(browser, r.swarm.path, "");
		expect(labels(swarm)).toEqual(
			expect.arrayContaining([SWARM.work, SWARM.changes, SWARM.radar]),
		);
		expect(labels(swarm)).not.toContain(CLASSIC.issues);
		const swarmNav = screen.getByRole("navigation", "Repository");
		await expect(swarmNav.getByRole("link", SWARM.radar)).toBeVisible();
		await expect(swarmNav.getByRole("link", CLASSIC.pulls)).toHaveCount(0);
	});

	test(T.card, { tags: ["agent"], timeout: 2 * MIN }, async ({ stage }) => {
		const token = tokensOf(stage).developerAgent;
		const classic = await mcpClient(stage.origin, PACK_GROUP.classic, token)
			.initialize();
		const swarm = await mcpClient(stage.origin, PACK_GROUP.swarm, token)
			.initialize();
		expect(classic.instructions).toContain(CLASSIC.card);
		expect(classic.instructions).not.toContain(SWARM.card);
		expect(swarm.instructions).toContain(SWARM.card);
		expect(swarm.instructions).not.toContain(CLASSIC.card);
		// Each names its own scope's MCP URL (the kernel card).
		expect(classic.instructions).toContain(
			`${stage.origin}/-/mcp/${PACK_GROUP.classic}`,
		);
		expect(swarm.instructions).toContain(
			`${stage.origin}/-/mcp/${PACK_GROUP.swarm}`,
		);
	});

	test(T.tools, { tags: ["agent"], timeout: 2 * MIN }, async ({ stage }) => {
		const token = tokensOf(stage).developerAgent;
		const classic = await mcpClient(stage.origin, PACK_GROUP.classic, token)
			.listTools();
		const swarm = await mcpClient(stage.origin, PACK_GROUP.swarm, token)
			.listTools();
		for (const tool of SHARED_TOOLS) {
			expect(classic, `classic lists ${tool}`).toContain(tool);
			expect(swarm, `swarm lists ${tool}`).toContain(tool);
		}
		for (const tool of RADAR_TOOLS) {
			expect(swarm, `swarm lists ${tool}`).toContain(tool);
			expect(classic, `classic does not list ${tool}`).not.toContain(tool);
		}
	});

	test(T.mismatch, { tags: ["agent"], timeout: 3 * MIN }, async ({ stage }) => {
		const r = await reposFor(stage, T.mismatch);
		const swarmAgent = mcpClient(
			stage.origin,
			PACK_GROUP.swarm,
			tokensOf(stage).developerAgent,
		);
		let failure: McpError | null = null;
		try {
			await swarmAgent.call("lanes_list", { repo: r.classic.path });
		} catch (error) {
			if (!(error instanceof McpError)) throw error;
			failure = error;
		}
		expect(failure?.code, "the Swarm scope refuses a Classic repo").toBe(
			PROTOCOL_MISMATCH,
		);
		expect(failure?.structured?.mcpUrl).toBe(
			`${stage.origin}/-/mcp/${r.classic.path}`,
		);
		// The same call at the Classic scope is served.
		const classicAgent = mcpClient(
			stage.origin,
			PACK_GROUP.classic,
			tokensOf(stage).developerAgent,
		);
		const listed = await classicAgent.call<{ repo: string }>("lanes_list", {
			repo: r.classic.path,
		});
		expect(listed.repo).toBe(r.classic.path);
	});
});

// ---------------------------------------------------------------------------
// The Owner's live queue@1 swap
// ---------------------------------------------------------------------------

/** The queue@1 provider in force (enforce) at a node, from the Owner's page. */
const queueProviderAt = async (
	browser: Parameters<typeof pageApi>[0],
	node: string,
): Promise<string | null> => {
	const list = ok(
		"GET",
		"/-/api/installations",
		await pageApi(browser).get<InstallationsResponse>(
			`/-/api/installations?${query({ node })}`,
		),
	);
	const providers = list.installations.filter((i) =>
		(i.manifest.provides ?? []).includes(QUEUE) &&
		i.installation.mode === "enforce"
	).sort((a, b) => b.depth - a.depth);
	return providers[0]?.installation.extId ?? null;
};

test.describe("the Owner's queue@1 swap", {
	tags: ["classic", "m2", "queue", "regression", "owner"],
	session: "owner",
}, () => {
	test(T.swap, {
		tags: ["containers", "agent", "ui", "land"],
		timeout: 30 * MIN,
	}, async ({ app, browser, screen, stage }) => {
		test.skip(
			!stage.containers,
			"landing needs CI and the Advance, which run in containers",
		);
		const index = await sharedStore().claimIndex(`claim-${keyOf(T.swap)}`);
		const repo = await fixtureRepo(
			stage,
			"swarm",
			index === 0 ? "queue-swap" : `queue-swap-${index}`,
			SWAP_FIXTURE,
		);
		await app.open("/-/extensions");
		expect(await queueProviderAt(browser, repo.path)).toBe(WEAVE.id);

		// UI: the Extensions page at the repo, Swap queue@1…, the sheet, apply.
		await watchApi(browser);
		await screen.getByLabel("In force at").fill(repo.path);
		await screen.getByRole("button", "Show").tap();
		const weaveRow = browser.locator("tr").filter({ hasText: WEAVE.id });
		await weaveRow.getByRole("button", `Swap ${QUEUE}…`).tap();
		const form = screen.getByRole("form", "Swap provider");
		await form.getByLabel("New provider").selectOption({
			value: `${FIFO.id}@${FIFO.version}`,
		});
		await expect(form.getByLabel("At")).toHaveValue(repo.path);
		await form.getByRole("button", "Review swap").tap();
		await expect(form.getByRole("region", "Swap sheet")).toBeVisible();
		await form.getByRole("button", "Swap provider").tap();
		await expect(screen.getByText(
			`${QUEUE} at ${repo.path} is now provided by ${FIFO.id}.`,
		)).toBeVisible({ timeout: 30_000 });
		await expectApiClean(browser);
		// API: FIFO provides queue@1 at the repo; the group keeps the Weave.
		expect(await queueProviderAt(browser, repo.path)).toBe(FIFO.id);
		expect(await queueProviderAt(browser, PACK_GROUP.swarm)).toBe(WEAVE.id);
		// UI: the repo's tab bar follows (FIFO's tab, not the Weave's).
		await app.open(`/${repo.path}`);
		const nav = screen.getByRole("navigation", "Repository");
		await expect(nav.getByRole("link", FIFO.tab)).toBeVisible();
		await expect(nav.getByRole("link", tabLabel("swarm", WEAVE.id, "weave")))
			.toHaveCount(0);

		// The repo now runs another protocol than its group: the group's MCP
		// scope answers protocol_mismatch with the repo's own MCP URL, which
		// is where an agent works from now on.
		let mismatch: McpError | null = null;
		try {
			await scriptedAgent(stage, PACK_GROUP.swarm, "A").mcp.call(
				"lanes_list",
				{ repo: repo.path },
			);
		} catch (error) {
			if (!(error instanceof McpError)) throw error;
			mismatch = error;
		}
		expect(mismatch?.code).toBe(PROTOCOL_MISMATCH);
		expect(mismatch?.structured?.mcpUrl).toBe(
			`${stage.origin}/-/mcp/${repo.path}`,
		);
		// The next change: an agent pushes and submits, a person approves on
		// the change page, and FIFO lands it.
		const agent = scriptedAgent(stage, repo.path, "A");
		const { lane: first } = await agent.mcp.call<{ lane: LaneHandle }>(
			"lanes_open",
			{ repo: repo.path, purpose: "queue swap: the next change" },
		);
		const lane = await agent.awaitOpen(repo.path, first);
		const scratch = path.join(
			sharedDirOf(tmpdir(), stage.runId),
			`scratch-queue-swap-${index}`,
		);
		const clone = await agent.clone(scratch, repo.remote);
		await agent.runLane(lane.git.start, clone);
		await writeFile(path.join(clone, "swap.txt"), `${stage.runId}\n`);
		await agent.commit(clone, "queue swap: one file");
		await agent.runLane(lane.git.push, clone);
		const { changeId } = await agent.mcp.call<{ changeId: string }>(
			"changes_submit",
			{
				repo: repo.path,
				laneId: lane.id,
				title: `queue swap ${stage.runId}/${index}`,
				summary: "One file, landed by FIFO.",
			},
		);
		// review_get's default already says `route: human` (evidence
		// pending): wait for the assessment after CI, then read the route.
		const assessed = await assessedReview(() =>
			agent.mcp.call<Review>("review_get", { repo: repo.path, changeId })
		);
		expect(assessed.route, "review routes the change to a person").toBe(
			HUMAN,
		);
		await app.open(`/${repo.path}/-/changes/${changeId}`);
		const approve = browser.locator(REVIEW_PANEL).getByRole(
			"button",
			APPROVE_LABEL,
		);
		await expect(approve).toBeVisible({ timeout: 30_000 });
		await approve.tap();
		await expect.poll(async () =>
			(await agent.mcp.call<Review>("review_get", {
				repo: repo.path,
				changeId,
			})).decision, { timeout: 60_000, message: "the approval" }).toBe(
				APPROVE,
			);
		await expect.poll(async () =>
			(await agent.mcp.call<Change>("changes_get", {
				repo: repo.path,
				changeId,
			})).state, {
			timeout: 15 * MIN,
			interval: 5_000,
			message: "FIFO to land the change",
		}).toBe(LANDED);
		// The queue events of this change came from FIFO, none from the Weave.
		const owner = tokenApi(stage.origin, tokensOf(stage).ownerPat);
		const events = ok(
			"GET",
			"/-/api/events",
			await owner.get<EventsResponse>(
				`/-/api/events?${query({ repo: repo.id, limit: "500" })}`,
			),
		).events.filter((e) => {
			const d = e.data as { changeId?: string; changes?: string[] };
			return e.type.startsWith("queue.") &&
				(d.changeId === changeId || (d.changes ?? []).includes(changeId));
		});
		const sourceOf = (e: (typeof events)[number]) =>
			e.source.kind === "installation" ? e.source.ext.split("@")[0] : "kernel";
		// FIFO enqueued, batched and landed it. The replaced Weave may still
		// say queue.enqueued for the approval it saw (it releases the entry
		// quietly before any batch: extensions/weave/test/handover.test.ts),
		// but it never batches or lands it.
		const fromFifo = events.filter((e) => sourceOf(e) === FIFO.id).map((e) =>
			e.type
		);
		expect(fromFifo).toEqual(
			expect.arrayContaining([
				"queue.enqueued",
				"queue.batched",
				"queue.landed",
			]),
		);
		expect(
			events.filter((e) => sourceOf(e) !== FIFO.id).map((e) =>
				`${sourceOf(e)} ${e.type}`
			),
			"no other queue batched or landed the change",
		).toEqual(
			events.filter((e) =>
				sourceOf(e) !== FIFO.id && e.type === "queue.enqueued"
			).map((e) => `${sourceOf(e)} ${e.type}`),
		);

		// The Owner swaps back: the repo inherits the group's Weave again.
		const back = ok(
			"POST",
			"/-/api/installations/replace",
			await pageApi(browser).send<ReplaceProviderResponse>(
				"POST",
				"/-/api/installations/replace",
				{
					node: repo.path,
					iface: QUEUE,
					extId: WEAVE.id,
					version: WEAVE.version,
				},
			),
		);
		expect(back.dryRun).toBe(false);
		expect(await queueProviderAt(browser, repo.path)).toBe(WEAVE.id);
	});
});
