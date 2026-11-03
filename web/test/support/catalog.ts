// A sample extension catalog for the mock kernel (`MockOptions.catalog`): the
// mock forge installs no extensions, so the tests of the slot hosts and the
// extensions admin bring their own. Sample ids only; none is a real package.
//
// - `sample.notes` contributes one instance to every slot an SPA page hosts.
// - `sample.gate` is a WASM `ref.advance` gate, in shadow mode at acme.
// - `sample.queue` and `sample.queue-fifo` both provide `queue@1`; the first
//   is in force at acme.

import type {
	InstallationDto,
	NodeDto,
	SlotInstanceDto,
	StaticContributionDto,
} from "@tartan/contract/api.ts";
import type { Manifest } from "@tartan/contract/manifest.ts";
import type { UiDoc } from "@tartan/contract/ui.ts";
import {
	type MockCatalog,
	type MockContributions,
	sampleManifest,
	samplePackage,
	slotInstance,
	staticContribution,
} from "../../src/api/mock/catalog.ts";
import {
	CHANGE_ID,
	MOCK_NOW,
	mockUlid,
	nodeByPath,
	OWNER_ID,
	REPO_ID,
	SHAS,
} from "../../src/api/mock/fixtures.ts";

const HOUR = 3_600_000;

export const NOTES = "sample.notes";
export const GATE = "sample.gate";
export const QUEUE = "sample.queue";
export const FIFO = "sample.queue-fifo";

const queueManifest = (id: string, name: string, extra: Partial<Manifest>) =>
	sampleManifest(id, name, `${name}: a sample queue@1 provider`, {
		provides: ["queue@1"],
		permissions: {
			repo: "read",
			land: ["refs/heads/main"],
			"land.report": true,
		},
		...extra,
	});

const MANIFESTS: readonly Manifest[] = [
	sampleManifest(NOTES, "Notes", "Sample contributor of every page slot", {
		permissions: { repo: "read", notify: true },
	}),
	sampleManifest(GATE, "Gate", "Sample WASM gate on ref.advance", {
		runtime: "wasm",
		entry: { js: "dist/index.js", wasm: ["dist/gate.wasm"] },
		gates: [{ point: "ref.advance", timeoutMs: 1500, default: "allow" }],
	}),
	queueManifest(QUEUE, "Queue", {
		contributes: {
			settings: {
				type: "object",
				properties: {
					batch: { type: "integer", title: "Batch size", default: 1 },
					label: {
						type: "string",
						title: "Queue label <script>",
						default: "main",
					},
				},
			},
		},
	}),
	queueManifest(FIFO, "FIFO", {}),
];

const installation = (
	n: number,
	extId: string,
	nodePath: string,
	extra: Partial<InstallationDto> = {},
): InstallationDto => ({
	id: `i_${mockUlid(n)}`,
	extId,
	version: "0.1.0",
	nodeId: nodeByPath(nodePath)?.id ?? mockUlid(11),
	nodePath,
	mode: "enforce",
	storageScope: "repo",
	config: {},
	grants: MANIFESTS.find((m) => m.id === extId)?.permissions ??
		{ repo: "none" },
	backgroundRole: 20,
	locked: false,
	backfill: "none",
	installedBy: OWNER_ID,
	installedAt: MOCK_NOW - 20 * 24 * HOUR,
	...extra,
});

const INSTALLATIONS: readonly InstallationDto[] = [
	installation(501, NOTES, "acme"),
	installation(506, QUEUE, "acme", {
		backgroundRole: 30,
		config: { batch: 1, label: "main" },
	}),
	installation(509, GATE, "acme", { mode: "shadow" }),
];

export const instId = (extId: string): string =>
	INSTALLATIONS.find((i) => i.extId === extId)?.id ?? `i_${mockUlid(599)}`;

const tab = (
	slot: StaticContributionDto["slot"],
	id: string,
	label: string,
	route?: string,
	extId = NOTES,
): StaticContributionDto =>
	staticContribution(instId(extId), extId, slot, id, label, 0, route);

const slot = (
	s: SlotInstanceDto["slot"],
	id: string,
	order = 0,
	refreshOn: readonly string[] = [],
	extId = NOTES,
	extra: Partial<SlotInstanceDto> = {},
): SlotInstanceDto =>
	slotInstance(instId(extId), extId, s, id, order, refreshOn, extra);

const underAcme = (node: NodeDto): boolean =>
	node.path === "acme" || node.path.startsWith("acme/");

const contribute = (target: NodeDto, view: string): MockContributions => {
	if (!underAcme(target)) return {};
	const [first = "", second] = view.split("/");
	if (first === "hud") {
		return {
			slots: [slot("hud.metric", "count", 1, [], NOTES, { cache: "role" })],
		};
	}
	if (first === "home") {
		return { slots: [slot("home.section", "recent", 0, ["lane.*"])] };
	}
	if (target.kind !== "repo") {
		return {
			tabs: [tab("node.tab", "node-notes", "Notes", "notes")],
			nav: [tab("nav.global", "nav", "Notes", "notes")],
			slots: first === "notes"
				? [slot("node.tab", "node-notes", 0, ["notes.*"])]
				: [],
		};
	}
	// The sample repo only: other repos have nothing installed below acme
	// that contributes there.
	if (target.id !== REPO_ID) return {};
	const tabs = [tab("repo.tab", "notes", "Notes", "notes")];
	const actions = [tab("repo.header.action", "new-note", "New note")];
	const sidebar = slot("repo.sidebar", "summary");
	const repo = (
		slots: SlotInstanceDto[],
		extra: StaticContributionDto[] = [],
	) => ({
		tabs: [...tabs, ...extra],
		actions,
		slots,
	});
	if (first === "changes" && second) {
		return repo([
			slot("change.tab", "diff"),
			slot("change.tab", "revisions"),
			slot("change.panel", "overview", -10, ["changes.*"]),
			slot("change.panel", "threads", 0, ["changes.*"]),
			slot("change.sidebar", "facts", 0, ["checks.*"]),
			slot("change.gate", "gate", 0, [], GATE),
		], [
			tab("change.tab", "diff", "Diff", "diff"),
			tab("change.tab", "revisions", "Revisions", "revisions"),
		]);
	}
	if (first === "work" && second) {
		return repo([
			slot("work.panel", "item", 0, ["work.*"]),
			slot("work.sidebar", "related"),
		]);
	}
	if (/^lanes\/ln_[0-9a-z]{26}$/.test(view)) {
		return repo([slot("lane.badge", "badge"), slot("lane.sidebar", "lane")]);
	}
	if (first === "") return repo([sidebar]);
	if (first === "blob") return repo([slot("file.banner", "editing"), sidebar]);
	if (first === "notes") {
		return repo([slot("repo.tab", "notes", 0, ["notes.*"])]);
	}
	return repo([]);
};

const BOARD: UiDoc = {
	v: 1,
	refreshOn: ["notes.*"],
	root: {
		t: "board",
		columns: [
			{ id: "open", title: "Open" },
			{ id: "doing", title: "Doing", wip: 3 },
			{ id: "done", title: "Done" },
		],
		cards: [
			{
				id: "n_1",
				col: "doing",
				title: "Sample note one",
				badges: ["services/api"],
			},
			{ id: "n_2", col: "open", title: "Sample note two" },
			{ id: "n_3", col: "done", title: "Sample note three" },
		],
		moveAction: { id: "move" },
	},
};

const DOCS: Readonly<Record<string, UiDoc>> = {
	[`${NOTES}/node.tab/node-notes`]: BOARD,
	[`${NOTES}/repo.tab/notes`]: BOARD,
	[`${NOTES}/repo.sidebar/summary`]: {
		v: 1,
		root: { t: "kv", items: [{ k: "packages/shared", v: "3 notes" }] },
	},
	[`${NOTES}/file.banner/editing`]: {
		v: 1,
		root: {
			t: "alert",
			tone: "warning",
			title: "Sample banner on this file",
			body: { t: "text", text: "A note mentions this path." },
		},
	},
	[`${NOTES}/change.tab/diff`]: {
		v: 1,
		root: {
			t: "diff",
			repo: "acme/platform/router",
			base: SHAS.c3,
			head: SHAS.lane,
			source: "lane vs main",
		},
	},
	[`${NOTES}/change.tab/revisions`]: {
		v: 1,
		root: {
			t: "timeline",
			items: [{
				at: MOCK_NOW - 2 * HOUR,
				text: "r1: pushed 2 commits (packages/shared)",
				actor: "claude-1",
			}],
		},
	},
	[`${NOTES}/change.panel/overview`]: {
		v: 1,
		root: {
			t: "stack",
			children: [
				{ t: "heading", text: "api: rate limits on /n", level: 2 },
				{ t: "badge", text: "submitted", tone: "info" },
				{
					t: "button",
					text: "Abandon",
					tone: "danger",
					action: {
						id: "abandon",
						payload: { changeId: CHANGE_ID },
						confirm: "Abandon this change?",
					},
				},
			],
		},
	},
	[`${NOTES}/change.panel/threads`]: {
		v: 1,
		root: {
			t: "stack",
			children: [
				{ t: "text", text: "Rate limit the public API per token, not per IP." },
				{
					t: "form",
					fields: [
						{ t: "textarea", name: "body", label: "Comment", required: true },
						{ t: "input", name: "path", label: "File (optional)" },
					],
					submit: {
						text: "Comment",
						action: { id: "comment", payload: { changeId: CHANGE_ID } },
					},
				},
			],
		},
	},
	[`${NOTES}/change.sidebar/facts`]: {
		v: 1,
		root: { t: "text", text: "No sample facts", tone: "muted" },
	},
	[`${GATE}/change.gate/gate`]: {
		v: 1,
		root: { t: "badge", text: "gate: allow", tone: "success" },
	},
	[`${NOTES}/work.panel/item`]: {
		v: 1,
		root: {
			t: "card",
			title: "Sample work item",
			children: [{
				t: "kv",
				items: [{ k: "Footprint", v: "services/api/**" }],
			}],
		},
	},
	[`${NOTES}/work.sidebar/related`]: {
		v: 1,
		root: { t: "list", items: [{ t: "text", text: "Related notes" }] },
	},
	[`${NOTES}/lane.badge/badge`]: {
		v: 1,
		root: { t: "badge", text: "sample lane badge", tone: "warning" },
	},
	[`${NOTES}/lane.sidebar/lane`]: {
		v: 1,
		root: { t: "text", text: "sample lane sidebar" },
	},
	[`${NOTES}/hud.metric/count`]: {
		v: 1,
		root: { t: "stat", label: "Notes", value: 42 },
	},
	[`${NOTES}/home.section/recent`]: {
		v: 1,
		root: { t: "text", text: "Recent sample notes" },
	},
};

export const SAMPLE_CATALOG: MockCatalog = {
	packages: MANIFESTS.map((m) => samplePackage(m, MOCK_NOW - 30 * 24 * HOUR)),
	installations: INSTALLATIONS,
	contribute,
	docs: DOCS,
	// The header action navigates to the repo's Notes tab.
	act: (extId, action, ctx) =>
		extId === NOTES && action === "new-note" && ctx.node !== undefined
			? { v: 1, navigate: `/${ctx.node}/-/notes` }
			: null,
};
