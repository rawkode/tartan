/// <reference types="@cloudflare/vitest-pool-workers/types" />
// SLOT CONFORMANCE: the SPA and the kernel agree on every slot of every
// first-party extension.
//
// Through the real Worker entry (`src/index.ts` fetch: router, security
// middleware, ForgeDO, RepoDO, ExtensionDO; only the IdP and Artifacts are
// fakes): a claimed forge, a repo under the Swarm pack and one under the
// Classic pack (the real `extensions/*/tartan.json` manifests), tartan.epics
// and tartan.hud (no pack installs them) at the root group, an agent's
// work item, lane and submitted change in each repo. Then, for every SPA page kind, it calls `GET /-/api/view`, builds the
// page's ctx hint with the SPA's own builders (`web/src/slots/ctx.ts`),
// narrows it per slot with the SPA's `narrowCtx`, renders every instance the
// page hosts (200 and a valid tartan-ui@1 document, never the error chip),
// and submits every form in those documents with the SPA's `formPayload`
// (and moves a board card with the SPA's `boardMovePayload`): all succeed.
// Every renderable contribution of every first-party extension must have
// been rendered on its host page; slots the SPA does not host yet are a
// listed exception.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FileMap, MONOREPO_FILES } from "@tartan/testkit";
import {
	type ActionResponse,
	ChangeStateSchema,
	type InstallationsResponse,
	repoArtifactsName,
	repoDoName,
	type SlotId,
	type SlotInstanceDto,
	SLOTS,
	type StaticContributionDto,
	ulid,
	validateUi,
	type ViewResponse,
} from "@tartan/contract";
import { BUILTIN_SOURCES } from "../../../builtins.ts";
import { b64urlJson } from "../../../../web/src/api/client.ts";
import {
	SLOT_HOSTS,
	SLOTS_NOT_RENDERED,
} from "../../../../web/src/slots/hosts.ts";
import {
	entityCtx,
	narrowCtx,
	nodeCtx,
	repoCtx,
	type SlotCtxHint,
	tabCtx,
} from "../../../../web/src/slots/ctx.ts";
import { formPayload } from "../../../../web/src/ui/context.ts";
import {
	boardMovePayload,
	formDefaults,
} from "../../../../web/src/ui/forms.ts";
import type { UiJson } from "../../../../web/src/ui/nodeTypes.ts";
import {
	call,
	claimForge,
	env,
	jsonOf,
	mcp,
	type McpTool,
	type Patched,
	patchGlobals,
	repoke,
} from "./test/worker.ts";
import { settleBackground } from "../../../../test/env.ts";

/** Slots an SPA page hosts (`web/src/slots/hosts.ts`, checked against the components). */
const HOSTED: ReadonlySet<string> = new Set(Object.keys(SLOT_HOSTS));

const FIRST_PARTY = BUILTIN_SOURCES
	.map((s) => s.manifest as { id: string; kind?: string })
	.filter((m) => m.kind !== "pack")
	.map((m) => m.id);

const REPOS = {
	swarm: "academy/platform/router",
	classic: "academy/docs/site",
} as const;
type Pack = keyof typeof REPOS;
const FILE = "packages/shared/src/money.ts";
/** Every state a change can be in (`changes@1`). */
const CHANGE_STATES: readonly string[] = ChangeStateSchema.options;

type Seeding = {
	seed(name: string, o: { files: FileMap }): Promise<unknown>;
	commit(
		name: string,
		ref: string,
		changes: Record<string, string>,
		message: string,
	): Promise<string>;
	refs(name: string): Promise<Record<string, string>>;
	setRef(name: string, ref: string, oid: string | null): Promise<void>;
};
const artifacts = env.ARTIFACTS as unknown as Seeding;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retries `attempt` until it returns a value: extensions drain events in the
 * background, so a poke lost under the parallel test load is re-sent the way
 * the 5-minute cron does (`repoke`) every few attempts.
 */
const eventually = async <T>(
	what: string,
	attempt: () => Promise<T | undefined>,
): Promise<T> => {
	for (let i = 1; i <= 100; i++) {
		const value = await attempt();
		if (value !== undefined) return value;
		if (i % 10 === 0) await repoke();
		await sleep(150);
	}
	throw new Error(`${what} never happened`);
};

let patched: Patched;
let session = "";
const repoId: Partial<Record<Pack, string>> = {};
const laneId: Partial<Record<Pack, string>> = {};
const changeId: Partial<Record<Pack, string>> = {};

const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
	const res = await call(path, { ...init, cookie: session });
	const body = await jsonOf<T>(res);
	if (res.status >= 300) {
		throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
	}
	return body;
};

const post = <T>(path: string, body: unknown): Promise<T> =>
	api<T>(path, { method: "POST", body: JSON.stringify(body) });

const tool = async (
	t: McpTool,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
	const out = await t(name, args);
	if (out.isError) throw new Error(`${name}: ${JSON.stringify(out.value)}`);
	return out.value as Record<string, unknown>;
};

/** A repo with an agent's work item #1, its lane with one push, and a submitted change. */
const agentFlow = async (
	pack: Pack,
	agent: { readonly token: string; readonly id: string },
): Promise<void> => {
	const repo = REPOS[pack];
	const t = await mcp(repo, agent.token);
	const created = await tool(t, "work_create", {
		repo,
		kind: "issue",
		title: "Fix money rounding",
		why: "Totals are off by a cent.",
		acceptance: ["sumMoney rounds half-even"],
	});
	const claim = await tool(t, "work_claim", {
		ref: created["ref"],
		footprint: { projects: ["@acme/shared"], prefixes: ["packages/shared/"] },
		plan: "Round in addMoney",
	});
	const lane = claim["lane"] as { id: string; ref: string };
	laneId[pack] = lane.id;
	const id = repoId[pack]!;
	const name = repoArtifactsName(id);
	const trunk = (await artifacts.refs(name))["refs/heads/main"]!;
	if ((await artifacts.refs(name))[lane.ref] === undefined) {
		await artifacts.setRef(name, lane.ref, trunk);
	}
	const head = await artifacts.commit(name, lane.ref, {
		[FILE]: "export const round = (n: number) => Math.round(n);\n",
	}, `fix: round money\n\nTartan-Work: ${created["ref"]}`);
	// The gateway's record step for that push.
	await env.REPO.getByName(repoDoName(id)).core().recordPush({
		target: "repo",
		refs: [{ ref: lane.ref, before: trunk, after: head }],
		principal: agent.id,
		via: "gateway",
		requestId: `req_${ulid()}`,
	} as never);
	changeId[pack] = await eventually(`a draft change for ${repo}`, async () => {
		const out = await t("changes_submit", {
			repo,
			laneId: lane.id,
			title: "Round money",
			summary: "Rounds in addMoney.",
			why: "Totals were off by a cent.",
		});
		return out.isError
			? undefined
			: (out.value as { changeId: string }).changeId;
	});
};

beforeAll(async () => {
	patched = await patchGlobals();
	session = await claimForge(patched);
	for (const group of ["academy", "academy/platform", "academy/docs"]) {
		const parent = group.includes("/") ? group.split("/")[0] : undefined;
		await post("/-/api/nodes", {
			kind: "group",
			slug: group.split("/").at(-1),
			...(parent ? { parent } : {}),
		});
	}
	const source = `conformance-${crypto.randomUUID().slice(0, 8)}`;
	await artifacts.seed(source, { files: MONOREPO_FILES });
	for (const pack of ["swarm", "classic"] as const) {
		const [parent, slug] = [
			REPOS[pack].split("/").slice(0, -1).join("/"),
			REPOS[pack].split("/").at(-1),
		];
		const node = await post<{ id: string }>("/-/api/nodes/repos", {
			parent,
			slug,
			import: {
				url: `https://public.artifacts.fake.test/git/tartan-test/${source}.git`,
			},
		});
		repoId[pack] = node.id;
	}
	for (
		const [extId, node] of [
			["tartan.pack.swarm", "academy/platform"],
			["tartan.pack.classic", "academy/docs"],
			["tartan.epics", "academy"],
			["tartan.hud", "academy"],
		]
	) {
		await post("/-/api/installations", {
			extId,
			version: "0.1.0",
			node,
			mode: "enforce",
		});
	}
	const agent = await post<{ token: string; agent: { id: string } }>(
		"/-/api/agents",
		{ name: "claude-1", tool: "claude-code", node: "academy", maxRole: 30 },
	);
	for (const pack of ["swarm", "classic"] as const) {
		await agentFlow(pack, { token: agent.token, id: agent.agent.id });
	}
}, 120_000);

afterAll(async () => {
	await settleBackground();
	patched?.restore();
});

// ---------------------------------------------------------------------------
// The SPA's pages
// ---------------------------------------------------------------------------

type Page = {
	readonly label: string;
	readonly path: string;
	readonly view: string;
	/** The hint the page's view builds (`useNodeView`'s ctx builder). */
	readonly hint: SlotCtxHint;
	/** The slots the page mounts. */
	readonly hosts: readonly SlotId[];
	/** A tab page renders only its own contribution (`SlotOutlet only`). */
	readonly only?: { readonly slot: SlotId; readonly id: string };
};

const tabRoute = (t: StaticContributionDto): string =>
	(t.route ?? t.id).replace(/\*.*$/, "").replace(/\/$/, "");

const viewOf = (path: string, view: string): Promise<ViewResponse> =>
	api<ViewResponse>(
		`/-/api/view?path=${encodeURIComponent(path)}&view=${
			encodeURIComponent(view)
		}`,
	);

/** Every page of a repo, as the SPA routes and builds them. */
const repoPages = async (pack: Pack): Promise<Page[]> => {
	const repo = REPOS[pack];
	const cid = changeId[pack]!;
	const home = await viewOf(repo, "");
	const sha = home.repo!.trunkSha!;
	const change = await viewOf(repo, `changes/${cid}`);
	// ChangeView: the change.tab statics by order; the first is the default.
	const changeTabs = change.static.tabs
		.filter((t) => t.slot === "change.tab")
		.sort((a, b) => a.order - b.order);
	expect(changeTabs.length, `${repo}: change tabs`).toBeGreaterThan(0);
	const changeHosts: SlotId[] = [
		"change.gate",
		"change.tab",
		"change.panel",
		"change.sidebar",
	];
	return [
		{
			label: "repo overview (NodeView, RepoCode)",
			path: repo,
			view: "",
			hint: nodeCtx(repo),
			hosts: ["repo.sidebar"],
		},
		{
			label: "tree (RepoTreeView)",
			path: repo,
			view: "tree/main",
			hint: repoCtx(repo, { ref: "main" }),
			hosts: ["repo.sidebar"],
		},
		{
			label: "file (RepoFileView)",
			path: repo,
			view: `blob/main/${FILE}`,
			hint: repoCtx(repo, { ref: "main", path: FILE }),
			hosts: ["file.banner", "repo.sidebar"],
		},
		{
			label: "history (RepoLogView)",
			path: repo,
			view: "commits/main",
			hint: repoCtx(repo, { ref: "main" }),
			hosts: ["repo.sidebar"],
		},
		{
			label: "commit (RepoCommitView)",
			path: repo,
			view: `commit/${sha}`,
			hint: repoCtx(repo, { ref: sha }),
			hosts: [],
		},
		{
			label: "work item (WorkItemView)",
			path: repo,
			view: "work/1",
			hint: entityCtx(repo, "work", "1"),
			hosts: ["work.panel", "work.sidebar"],
		},
		{
			label: "lane (LanesView, LaneDetail)",
			path: repo,
			view: `lanes/${laneId[pack]}`,
			hint: entityCtx(repo, "lane", laneId[pack]!),
			hosts: ["lane.badge", "lane.sidebar"],
		},
		{
			label: "change, default tab (ChangeView)",
			path: repo,
			view: `changes/${cid}`,
			hint: entityCtx(repo, "change", cid, { route: tabRoute(changeTabs[0]!) }),
			hosts: changeHosts,
			only: { slot: "change.tab", id: changeTabs[0]!.id },
		},
		...changeTabs.map((t): Page => ({
			label: `change, ${t.id} tab (ChangeView)`,
			path: repo,
			view: `changes/${cid}/${tabRoute(t)}`,
			hint: entityCtx(repo, "change", cid, { route: tabRoute(t) }),
			hosts: changeHosts,
			only: { slot: "change.tab", id: t.id },
		})),
		// RepoFrame's tab bar: every static repo.tab is a SlotTabView page.
		...home.static.tabs.filter((t) => t.slot === "repo.tab").map((t): Page => ({
			label: `${t.ext} tab "${t.id}" (SlotTabView)`,
			path: repo,
			view: tabRoute(t),
			hint: tabCtx(repo),
			hosts: ["repo.tab", "repo.sidebar"],
			only: { slot: "repo.tab", id: t.id },
		})),
	];
};

/** A group's pages: its overview (node.section) and every node.tab page. */
const groupPages = async (group: string): Promise<Page[]> => {
	const home = await viewOf(group, "");
	return [
		{
			label: `group ${group} (NodeView)`,
			path: group,
			view: "",
			hint: nodeCtx(group),
			hosts: ["node.section"],
		},
		...home.static.tabs.filter((t) => t.slot === "node.tab").map((t): Page => ({
			label: `group ${group} tab "${t.id}" (SlotTabView)`,
			path: group,
			view: tabRoute(t),
			hint: tabCtx(group),
			hosts: ["node.tab"],
			only: { slot: "node.tab", id: t.id },
		})),
	];
};

/** The HUD page of a node (HudView, HudNode): its `hud` and `home` views. */
const hudPages = (path: string): Page[] => [
	{
		label: `HUD of ${path} (HudNode, hud)`,
		path,
		view: "hud",
		hint: nodeCtx(path),
		hosts: ["hud.metric"],
	},
	{
		label: `HUD of ${path} (HudNode, home)`,
		path,
		view: "home",
		hint: nodeCtx(path),
		hosts: ["home.section"],
	},
];

// ---------------------------------------------------------------------------
// Rendering and acting as the SPA does
// ---------------------------------------------------------------------------

type Node = Record<string, unknown> & { t?: string };

const walk = (value: unknown, visit: (node: Node) => void): void => {
	if (Array.isArray(value)) {
		for (const item of value) walk(item, visit);
	} else if (typeof value === "object" && value !== null) {
		if (typeof (value as Node).t === "string") visit(value as Node);
		for (const child of Object.values(value)) walk(child, visit);
	}
};

type Rendered = {
	readonly page: Page;
	readonly instance: SlotInstanceDto;
	readonly ctx: SlotCtxHint;
	readonly doc: Record<string, unknown>;
};

const render = async (
	page: Page,
	instance: SlotInstanceDto,
): Promise<Rendered> => {
	const ctx = narrowCtx(instance.slot, page.hint);
	const where =
		`${page.label}: ${instance.ext} ${instance.slot}/${instance.id}`;
	const res = await call(
		`/-/api/slot/${instance.installationId}/${instance.id}?ctx=${
			b64urlJson(ctx)
		}`,
		{ cookie: session },
	);
	const { cursor, ...doc } = await jsonOf<Record<string, unknown>>(res);
	expect(res.status, `${where} ${JSON.stringify(doc)}`).toBe(200);
	expect((doc["root"] as Node | undefined)?.t, `${where}: error chip`).not.toBe(
		"error-chip",
	);
	// A slot with a repo carries the repo's event head read through RepoDO
	// (the live channel's `since`), beside the document.
	if (ctx.repo !== undefined) {
		expect(Number.isSafeInteger(cursor), `${where}: cursor ${cursor}`).toBe(
			true,
		);
	}
	if (cursor !== undefined) expect(cursor as number).toBeGreaterThanOrEqual(0);
	const valid = validateUi(doc);
	expect(valid.ok ? [] : valid.errors, where).toEqual([]);
	return { page, instance, ctx, doc };
};

const act = async (
	r: Rendered,
	action: string,
	payload: UiJson,
	what: string,
): Promise<ActionResponse> => {
	const where =
		`${r.page.label}: ${r.instance.ext} ${r.instance.id} ${what} "${action}"`;
	const res = await call(
		`/-/api/slot/${r.instance.installationId}/${r.instance.id}/action`,
		{
			method: "POST",
			cookie: session,
			body: JSON.stringify({ action, payload, ctx: r.ctx }),
		},
	);
	const body = await jsonOf<ActionResponse>(res);
	expect(res.status, `${where} ${JSON.stringify(body)}`).toBe(200);
	expect(body.toast?.tone, `${where} ${JSON.stringify(body)}`).not.toBe(
		"danger",
	);
	return body;
};

/** What a viewer types into a form: every required field, nothing else. */
const typed = (fields: readonly unknown[]): Record<string, UiJson> => {
	const values: Record<string, UiJson> = {};
	walk(fields, (node) => {
		if (node["required"] === true && typeof node["name"] === "string") {
			values[node["name"]] = `Conformance ${node["name"]}`;
		}
	});
	return values;
};

describe("slot conformance: every first-party slot through the real routes", () => {
	const rendered: Rendered[] = [];

	it(
		"renders every hosted slot instance of every page with the SPA's ctx",
		async () => {
			const pages = [
				...await repoPages("swarm"),
				...await repoPages("classic"),
				...await groupPages("academy/platform"),
				...await groupPages("academy/docs"),
				...await groupPages("academy"),
				...hudPages("academy"),
				...hudPages(REPOS.swarm),
				...hudPages(REPOS.classic),
			];
			for (const page of pages) {
				const view = await viewOf(page.path, page.view);
				// The change page lists its change.tab pages.
				if (page.only?.slot === "change.tab") {
					expect(
						view.slots.some((s) =>
							s.slot === "change.tab" && s.id === page.only!.id
						),
						`${page.label}: change.tab ${page.only.id} listed`,
					).toBe(true);
				}
				for (const instance of view.slots) {
					if (!page.hosts.includes(instance.slot)) continue;
					if (
						page.only?.slot === instance.slot && page.only.id !== instance.id
					) continue;
					rendered.push(await render(page, instance));
				}
			}
			expect(rendered.length).toBeGreaterThan(30);
		},
		120_000,
	);

	it("shows the change on its page: title, state and an Abandon action", () => {
		// Only the change page delivers a change entity, so a document that
		// shows the change must come from one of its hosted slots; an
		// extension branch the catalogue never reaches fails here.
		for (const pack of ["swarm", "classic"] as const) {
			const onPage = rendered.filter((r) =>
				r.page.path === REPOS[pack] && r.page.view.startsWith("changes/")
			);
			const labels = new Set(onPage.map((r) => r.page.label));
			expect(labels.size, `${pack}: change pages`).toBeGreaterThan(1);
			for (const label of labels) {
				const nodes: Node[] = [];
				walk(
					onPage.filter((r) => r.page.label === label).map((r) => r.doc),
					(node) => nodes.push(node),
				);
				expect(
					nodes.some((n) => n.t === "heading" && n["text"] === "Round money"),
					`${label}: the change's title`,
				).toBe(true);
				expect(
					nodes.some((n) =>
						n.t === "badge" && CHANGE_STATES.includes(String(n["text"]))
					),
					`${label}: the change's state`,
				).toBe(true);
				expect(
					nodes.some((n) =>
						n.t === "button" &&
						(n["action"] as { id?: string } | undefined)?.id === "abandon"
					),
					`${label}: an Abandon action`,
				).toBe(true);
			}
		}
	});

	it("in force without a node answers at a node that exists (the Extensions page's first call, e2e)", async () => {
		const start = await api<InstallationsResponse>("/-/api/installations");
		// The owner's first granted root, through ForgeDO's tree listing.
		expect(start.node.parentId).toBeNull();
		const resolved = await api<{ node: { id: string } }>(
			`/-/api/nodes/resolve?path=${encodeURIComponent(start.node.path)}`,
		);
		expect(resolved.node.id).toBe(start.node.id);
		const missing = await call("/-/api/installations?node=nobody-here", {
			cookie: session,
		});
		expect(missing.status).toBe(404);
		expect((await jsonOf<{ message: string }>(missing)).message).toBe(
			"no node at nobody-here",
		);
	});

	it("covers every renderable contribution of every first-party extension", async () => {
		const done = new Set(
			rendered.map((r) =>
				`${r.instance.ext}|${r.instance.slot}|${r.instance.id}`
			),
		);
		const inForce = await api<InstallationsResponse>(
			`/-/api/installations?node=${encodeURIComponent(REPOS.swarm)}`,
		);
		const classic = await api<InstallationsResponse>(
			`/-/api/installations?node=${encodeURIComponent(REPOS.classic)}`,
		);
		const exts = new Set(
			[...inForce.installations, ...classic.installations].map((i) =>
				i.installation.extId
			),
		);
		for (const id of FIRST_PARTY) expect(exts, `${id} installed`).toContain(id);
		const missing: string[] = [];
		const unhosted = new Set<string>();
		for (const source of BUILTIN_SOURCES) {
			const m = source.manifest as {
				id: string;
				kind?: string;
				contributes?: {
					slots?: { slot: SlotId; id: string; dynamic?: boolean }[];
				};
			};
			if (m.kind === "pack") continue;
			for (const c of m.contributes?.slots ?? []) {
				if (!HOSTED.has(c.slot)) {
					unhosted.add(c.slot);
					continue;
				}
				const kind = SLOTS[c.slot].kind;
				const renderable = c.dynamic === true || kind === "static+route";
				if (renderable && !done.has(`${m.id}|${c.slot}|${c.id}`)) {
					missing.push(`${m.id} ${c.slot}/${c.id}`);
				}
			}
		}
		expect(missing, "contributions never rendered on a host page").toEqual([]);
		// A slot no SPA page hosts is a listed exception, never a silent one.
		for (const slot of unhosted) {
			expect(Object.keys(SLOTS_NOT_RENDERED), `${slot} has no host`).toContain(
				slot,
			);
		}
	});

	it(
		"submits every form the documents carry with the SPA's formPayload",
		async () => {
			let forms = 0;
			for (const r of rendered) {
				const found: Node[] = [];
				walk(r.doc, (node) => {
					if (node.t === "form") found.push(node);
				});
				for (const form of found) {
					const fields = form["fields"] as unknown[];
					const submit = form["submit"] as {
						action: { id: string; payload?: UiJson };
					};
					const payload = formPayload(submit.action.payload, {
						...formDefaults(fields),
						...typed(fields),
					});
					await act(r, submit.action.id, payload, "form");
					forms++;
				}
			}
			// The Work tab's create form and the comment forms of work items and
			// changes, in both packs.
			expect(forms).toBeGreaterThanOrEqual(6);
		},
		120_000,
	);

	it("moves a board card with the SPA's boardMovePayload", async () => {
		type Board = Node & {
			cards: { id: string; col: string }[];
			columns: { id: string }[];
			moveAction: { id: string; payload?: UiJson };
		};
		const boardOf = (doc: unknown): Board | undefined => {
			let found: Board | undefined;
			walk(doc, (node) => {
				if (node.t === "board" && node["moveAction"] && !found) {
					found = node as Board;
				}
			});
			return found;
		};
		let moves = 0;
		for (const r of rendered) {
			if (boardOf(r.doc) === undefined) continue;
			// Cards come from work.* events the board drains in the background:
			// render again (as the slot's refreshOn would) until they are in.
			const { board, at } = await eventually(
				`cards on ${r.page.label}`,
				async () => {
					const again = await render(r.page, r.instance);
					const board = boardOf(again.doc);
					return board && board.cards.length > 0
						? { board, at: again }
						: undefined;
				},
			);
			const card = board.cards[0]!;
			const to = board.columns.find((c) => c.id !== card.col)!;
			await act(
				at,
				board.moveAction.id,
				boardMovePayload(board.moveAction.payload, card, to.id),
				"board move",
			);
			moves++;
		}
		// The Board tab of both repos and the Board tab of both groups.
		expect(moves).toBeGreaterThanOrEqual(4);
	}, 120_000);

	it("posts the repo header actions with the SPA's narrowed ctx", async () => {
		for (const repo of Object.values(REPOS)) {
			const home = await viewOf(repo, "");
			expect(home.static.actions.length, repo).toBeGreaterThan(0);
			for (const a of home.static.actions) {
				const res = await call(
					`/-/api/slot/${a.installationId}/${a.id}/action`,
					{
						method: "POST",
						cookie: session,
						body: JSON.stringify({
							action: a.id,
							ctx: narrowCtx(a.slot, nodeCtx(repo)),
						}),
					},
				);
				expect(res.status, `${repo} ${a.ext} ${a.id}`).toBe(200);
			}
		}
	});

	// Last: it ends the swarm repo's change.
	it("abandons a change from its overview through the action route", async () => {
		const overview = rendered.find((r) =>
			r.page.path === REPOS.swarm &&
			r.page.view === `changes/${changeId.swarm}` &&
			r.instance.slot === "change.panel" && r.instance.id === "overview"
		);
		expect(overview, "the swarm change's overview").toBeDefined();
		let abandon: { id: string; payload?: UiJson } | undefined;
		walk(overview!.doc, (node) => {
			const action = node["action"] as { id: string; payload?: UiJson };
			if (node.t === "button" && action?.id === "abandon") abandon = action;
		});
		expect(abandon, "Abandon button").toBeDefined();
		const out = await act(
			overview!,
			abandon!.id,
			abandon!.payload ?? null,
			"button",
		);
		expect(out.toast?.text).toBe("Change abandoned");
		const again = await render(overview!.page, overview!.instance);
		const badges: string[] = [];
		walk(again.doc, (node) => {
			if (node.t === "badge") badges.push(String(node["text"]));
		});
		expect(badges).toContain("abandoned");
	});
});
