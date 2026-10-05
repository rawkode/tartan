// Which dynamic slot instances a page renders, from its `/-/api/view` answer
// (the page components in web/src/views and RepoFrame):
// the "settled slots" rule counts these before it asserts that none is still
// loading or shows an error chip, so a premature zero can never pass.
//
// Pure module (no e2e runtime import): the Deno unit tests import it too.

import type {
	SlotInstanceDto,
	StaticContributionDto,
	ViewResponse,
} from "@tartan/contract/api.ts";

/** A slot a page mounts, optionally only one contribution of it. */
export type Rendered = { readonly slot: string; readonly only?: string };

/** RepoFrame's sidebar: only on pages that are not `wide`. */
const SIDEBAR: Rendered = { slot: "repo.sidebar" };

export const RENDERED = {
	/** `/<repo>`, `/-/tree/…`, `/-/commits/…`. */
	repoCode: [SIDEBAR] as readonly Rendered[],
	/** `/-/blob/<ref>/<path>`. */
	blob: [{ slot: "file.banner" }, SIDEBAR] as readonly Rendered[],
	/** `/-/commit/…`, `/-/compare/…`, `/-/lanes` (wide pages without slots). */
	none: [] as readonly Rendered[],
	/** A group or user page. */
	node: [{ slot: "node.section" }] as readonly Rendered[],
	/** `/-/work/<n>` (wide). */
	work: [{ slot: "work.panel" }, {
		slot: "work.sidebar",
	}] as readonly Rendered[],
	/** `/-/lanes/<id>` (wide; LaneDetail). */
	lane: [{ slot: "lane.badge" }, {
		slot: "lane.sidebar",
	}] as readonly Rendered[],
	/** An extension's `repo.tab` page (`/-/<route>`). */
	repoTab: (id: string): readonly Rendered[] => [
		{ slot: "repo.tab", only: id },
		SIDEBAR,
	],
	/** An extension's `node.tab` page on a group. */
	nodeTab: (
		id: string,
	): readonly Rendered[] => [{ slot: "node.tab", only: id }],
	/** `/-/changes/<id>[/<tab>]` (wide): gate, the active tab, panels, sidebar. */
	change: (activeTab: string | null): readonly Rendered[] => [
		{ slot: "change.gate" },
		...(activeTab === null ? [] : [{ slot: "change.tab", only: activeTab }]),
		{ slot: "change.panel" },
		{ slot: "change.sidebar" },
	],
} as const;

/** How many instances of `slots` a page that mounts `rendered` shows. */
export const instanceCount = (
	slots: readonly Pick<SlotInstanceDto, "slot" | "id">[],
	rendered: readonly Rendered[],
): number =>
	slots.filter((s) =>
		rendered.some((r) =>
			r.slot === s.slot && (r.only === undefined || r.only === s.id)
		)
	).length;

const byOrder = (a: StaticContributionDto, b: StaticContributionDto) =>
	a.order - b.order;

/** ChangeView's active `change.tab`: the one the route names, else the first. */
export const activeChangeTab = (
	view: Pick<ViewResponse, "static">,
	tabParam?: string,
): string | null => {
	const tabs = view.static.tabs.filter((t) => t.slot === "change.tab").slice()
		.sort(byOrder);
	const active = tabs.find((t) =>
		tabParam !== undefined &&
		((t.route ?? t.id) === tabParam || t.id === tabParam)
	) ?? tabs[0];
	return active?.id ?? null;
};

/** The extension `repo.tab` contribution SlotTabView picks for `/-/<tab>`. */
export const tabContribution = (
	view: Pick<ViewResponse, "static">,
	tab: string,
): StaticContributionDto | null =>
	view.static.tabs.find((t) =>
		(t.slot === "repo.tab" || t.slot === "node.tab") &&
		(t.route ?? t.id).split("/")[0] === tab
	) ?? null;

/** The slot ctx hint of a slot render request URL (`?ctx=<base64url JSON>`). */
export const ctxOfSlotRequest = (url: string): Record<string, unknown> => {
	const raw = new URL(url).searchParams.get("ctx") ?? "";
	const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
	const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
	return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
};
