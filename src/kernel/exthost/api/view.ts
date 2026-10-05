// `GET /-/api/view?path=<node path>&view=<sub-route>`: node, viewer role, the
// **static** contributions in force (tabs, nav items, header actions, with
// `when` evaluated server-side against `{viewer.role, node.kind, entity.kind}`
// and each contribution's declared `role` applied), and the dynamic slot
// instances the SPA fills with `/-/api/slot/*`. No extension runs here.
//
// The view grammar (sub-route after `/-/`): `""` (overview), `changes/<id>`,
// `lanes/<id>`, `work/<ref>`, `blob/…`, `blame/…`, `hud`, `home`, or a
// routed tab's own page (`<route>[/…]`, e.g. `weave`), which adds that tab's
// contribution as a dynamic slot (the tab page is dynamic). An entity
// view is never a tab page; a change view also lists its `change.tab` pages
// (the SPA renders the selected one).

import {
	type EntityRef,
	invalid,
	type NodeDto,
	notFound,
	type SlotContribution,
	type SlotId,
	type SlotInstanceDto,
	type StaticContributionDto,
	stripControl,
	type ViewerDto,
	type ViewResponse,
	type WhenContext,
} from "@tartan/contract";
import type {
	AuthContext,
	InstallationInForce,
} from "@tartan/contract/kernel.ts";
import { resolve } from "../registry/resolve.ts";
import type { ApiDeps } from "./deps.ts";
import { guard, json } from "./http.ts";
import { evalWhen } from "./when.ts";

const MAX_VIEW = 2048;

const ENTITY_ROUTES: Readonly<Record<string, string>> = {
	changes: "change",
	lanes: "lane",
	work: "work",
};

/** The entity a view names, if any (`changes/<id>` → change). */
export const viewEntity = (view: string): EntityRef | undefined => {
	const [route, id] = view.split("/");
	const kind = ENTITY_ROUTES[route ?? ""];
	return kind !== undefined && id !== undefined && id !== ""
		? { kind, id }
		: undefined;
};

/** Which catalogue slots a view shows, by kind. */
export const viewSlots = (
	kind: NodeDto["kind"],
	view: string,
): {
	tabs: readonly SlotId[];
	nav: readonly SlotId[];
	actions: readonly SlotId[];
	dynamic: readonly SlotId[];
} => {
	const entity = viewEntity(view);
	const first = view.split("/")[0] ?? "";
	const isRepo = kind === "repo";
	const dynamic: SlotId[] = [];
	if (entity?.kind === "change") {
		dynamic.push("change.panel", "change.sidebar", "change.gate");
	} else if (entity?.kind === "lane") {
		dynamic.push("lane.badge", "lane.sidebar");
	} else if (entity?.kind === "work") {
		dynamic.push("work.panel", "work.sidebar");
	} else if (first === "hud") {
		dynamic.push("hud.metric");
	} else if (first === "home") {
		dynamic.push("home.section");
	} else if (isRepo && first === "blob") {
		dynamic.push("file.banner", "repo.sidebar");
	} else if (isRepo && first === "blame") {
		dynamic.push("blame.annotation");
	} else if (isRepo && first === "") {
		dynamic.push("repo.sidebar");
	} else if (!isRepo && first === "") {
		dynamic.push("node.section");
	}
	return {
		tabs: isRepo
			? (entity?.kind === "change" ? ["repo.tab", "change.tab"] : ["repo.tab"])
			: ["node.tab"],
		nav: ["nav.global"],
		actions: isRepo ? ["repo.header.action"] : [],
		dynamic,
	};
};

type Item = {
	readonly installation: InstallationInForce;
	readonly slot: SlotContribution;
};

const byOrder = (a: StaticContributionDto, b: StaticContributionDto) =>
	a.order - b.order || (a.label ?? a.id).localeCompare(b.label ?? b.id);

/** Longest label an installation's config may give a slot. */
export const LABEL_MAX = 40;

/**
 * An installation's `labels` config renames its own static slots' labels, by
 * contribution id (`{"labels": {"work": "Issues"}}`; the Classic pack names
 * `tartan.work`'s tab "Issues" and `tartan.changes`' "Pull requests"). Only
 * labels the manifest declares are renamed; a value that is not a 1–40
 * character string after stripping control characters is ignored.
 */
export const configLabel = (
	config: unknown,
	slotId: string,
): string | undefined => {
	if (config === null || typeof config !== "object") return undefined;
	const labels = (config as Record<string, unknown>).labels;
	if (labels === null || typeof labels !== "object" || Array.isArray(labels)) {
		return undefined;
	}
	if (!Object.hasOwn(labels, slotId)) return undefined;
	const value = (labels as Record<string, unknown>)[slotId];
	if (typeof value !== "string") return undefined;
	const clean = stripControl(value).trim();
	return clean.length > 0 && clean.length <= LABEL_MAX ? clean : undefined;
};

const labelOf = (i: Item): string | undefined =>
	i.slot.label === undefined
		? undefined
		: configLabel(i.installation.installation.config, i.slot.id) ??
			i.slot.label;

const staticDto = (i: Item): StaticContributionDto => ({
	installationId: i.installation.installation.id,
	ext: i.installation.installation.extId,
	slot: i.slot.slot as SlotId,
	id: i.slot.id,
	...(i.slot.label !== undefined ? { label: labelOf(i) } : {}),
	...(i.slot.title !== undefined ? { title: i.slot.title } : {}),
	...(i.slot.icon !== undefined ? { icon: i.slot.icon } : {}),
	...(i.slot.route !== undefined ? { route: i.slot.route } : {}),
	order: i.slot.order,
});

const slotDto = (i: Item): SlotInstanceDto => ({
	installationId: i.installation.installation.id,
	ext: i.installation.installation.extId,
	slot: i.slot.slot as SlotId,
	id: i.slot.id,
	...(i.slot.title !== undefined ? { title: i.slot.title } : {}),
	refreshOn: i.slot.refreshOn ?? [],
	cache: i.slot.cache,
	order: i.slot.order,
});

/** The static and dynamic contributions of a view (pure; `inForce` from the registry). */
export const viewContributions = (
	inForce: readonly InstallationInForce[],
	node: Pick<NodeDto, "kind">,
	view: string,
	role: number,
): Pick<ViewResponse, "static" | "slots"> => {
	const entity = viewEntity(view);
	const when: WhenContext = {
		viewer: { role },
		node: { kind: node.kind },
		...(entity ? { entity: { kind: entity.kind } } : {}),
	};
	const wanted = viewSlots(node.kind, view);
	const items: Item[] = resolve(inForce).effective.flatMap((installation) =>
		(installation.manifest.contributes?.slots ?? [])
			.filter((slot) => (slot.role ?? 0) <= role && evalWhen(slot.when, when))
			.map((slot) => ({ installation, slot }))
	);
	const of = (slots: readonly SlotId[], dynamic: boolean) =>
		items.filter((i) =>
			(slots as readonly string[]).includes(i.slot.slot) &&
			i.slot.dynamic === dynamic
		);
	const first = view.split("/")[0] ?? "";
	// A tab page is `<route>[/…]` of the node kind's tab slot (`repo.tab` or
	// `node.tab`); `changes/<id>` is the change entity, never the Changes tab.
	const routedTabs: readonly SlotId[] = wanted.tabs;
	const tabPage = entity !== undefined || first === ""
		? []
		: items.filter((i) =>
			(routedTabs as readonly string[]).includes(i.slot.slot) &&
			i.slot.route !== undefined &&
			(i.slot.route === first || i.slot.route.split("/")[0] === first)
		);
	// Every change.tab page of a repo's change view (static+route: renderable).
	const changeTabs = entity?.kind === "change" && node.kind === "repo"
		? items.filter((i) => i.slot.slot === "change.tab")
		: [];
	return {
		static: {
			tabs: of(wanted.tabs, false).map(staticDto).sort(byOrder),
			nav: of(wanted.nav, false).map(staticDto).sort(byOrder),
			actions: of(wanted.actions, false).map(staticDto).sort(byOrder),
		},
		slots: [...of(wanted.dynamic, true), ...tabPage, ...changeTabs]
			.map(slotDto)
			.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
	};
};

const viewerDto = async (
	deps: ApiDeps,
	auth: AuthContext | null,
	role: ViewerDto["role"],
): Promise<ViewerDto> => {
	if (auth === null) return { role, isAdmin: false };
	let handle = auth.principal;
	let display = auth.principal;
	try {
		const p = await deps.identity().principal(auth.principal);
		if (p !== null) {
			handle = p.handle;
			display = p.display;
		}
	} catch {
		// Identity is optional for the view; the principal id is enough.
	}
	return {
		principal: { id: auth.principal, handle, display, kind: auth.kind },
		role,
		isAdmin: auth.isAdmin,
	};
};

export const handleViewRequest = (
	deps: ApiDeps,
	req: Request,
	auth: AuthContext | null,
): Promise<Response> =>
	guard(async () => {
		const url = new URL(req.url);
		const path = url.searchParams.get("path") ?? "";
		const view = (url.searchParams.get("view") ?? "").replace(/^\/+|\/+$/g, "");
		if (path === "" || path.length > 16384) throw invalid("path is required");
		if (view.length > MAX_VIEW) throw invalid("view is too long");
		const resolved = await deps.tree().resolvePath(path);
		if (resolved === null || resolved.rest !== "") throw notFound("node");
		if (resolved.redirectTo !== undefined) {
			const to = new URL("/-/api/view", url);
			to.searchParams.set("path", resolved.redirectTo);
			if (view !== "") to.searchParams.set("view", view);
			return json({ redirectTo: resolved.redirectTo }, 301, {
				location: `${to.pathname}${to.search}`,
			});
		}
		const node = resolved.node;
		const role = await deps.authorize(auth, { node }, "read-metadata");
		const banners: ViewResponse["banners"][number][] = [];
		let repo: ViewResponse["repo"];
		if (node.kind === "repo") {
			try {
				const info = await deps.repo(node.id).info();
				repo = {
					id: node.id,
					defaultBranch: info.defaultBranch,
					trunkSha: info.trunkSha,
					landingPaused: info.landingPaused,
				};
				if (info.landingPaused) {
					banners.push({
						tone: "danger",
						text:
							"Landing is paused until an Owner acknowledges an unexplained ref change",
					});
				}
			} catch {
				repo = {
					id: node.id,
					defaultBranch: node.defaultBranch ?? "main",
					trunkSha: null,
					landingPaused: false,
				};
				banners.push({
					tone: "warning",
					text: "Repository status is unavailable",
				});
			}
		}
		if (node.archived) {
			banners.push({ tone: "info", text: "This node is archived" });
		}
		const inForce = await deps.registry().inForce(node.id);
		const body: ViewResponse = {
			node,
			...(repo ? { repo } : {}),
			viewer: await viewerDto(deps, auth, role),
			view,
			...viewContributions(inForce, node, view, role),
			banners,
		};
		return json(body);
	});
