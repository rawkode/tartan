// SPA route table (WP18, WP19).
//
// URL grammar: a node (user, group or repo) lives at
// `/<path>`, and its views at `/<path>/-/<view>` (GitLab-style separator).
// Forge-level pages live under `/-/`. The Worker claims `/-/api`, `/-/auth`,
// `/-/live`, `/-/mcp`, `/-/oauth`, `/-/health`, `/-/raw`, `/.well-known`, git
// paths (`*.git/…`, `/-/lanes/<id>.git/…`) and unsafe `/-/setup/*` methods
// before assets; everything else reaches this table through the SPA fallback.
// The kernel re-derives node, repo, ref and path server-side; route params are
// hints only.
//
// Ownership: coordination views live in
// `views/coord/` (WP19); repository config in `views/repoconfig/` (WP23);
// everything else belongs to WP18.

import type { RouteRecordRaw } from "vue-router";
import { PROJECT_ROUTES } from "../views/project/routes.ts";

/**
 * One node-path segment. Slugs match `[a-z0-9][a-z0-9-]*` (`nodes.slug`), so
 * a segment never starts with `-`, and the first `/-/` in a
 * URL always separates the node path from its view. The pattern is looser than
 * the slug grammar on purpose: the kernel answers 404 for unknown nodes.
 */
export const NODE_SEGMENT = "[^/-][^/]*";

/** `/<nodePath>` (one or more segments) followed by `suffix`. */
const node = (suffix = ""): string => `/:nodePath(${NODE_SEGMENT})+${suffix}`;

export type RouteOwner = "WP18" | "WP19" | "WP23" | "WP25";

export type ViewMeta = {
	readonly title: string;
	readonly owner: RouteOwner;
};

const meta = (title: string, owner: RouteOwner = "WP18"): ViewMeta => ({
	title,
	owner,
});

export const routes: readonly RouteRecordRaw[] = [
	// Forge home and HUD (WP19): every judge question is ≤ 2 clicks away.
	{
		path: "/",
		alias: "/-/hud",
		name: "home",
		component: () => import("../views/coord/HudView.vue"),
		meta: meta("Home", "WP19"),
	},

	// First run and sign-in.
	{
		path: "/-/setup",
		name: "setup",
		component: () => import("../views/setup/SetupWizardView.vue"),
		meta: meta("Set up your forge"),
	},
	{
		path: "/-/login",
		name: "login",
		component: () => import("../views/auth/LoginView.vue"),
		meta: meta("Sign in"),
	},
	{
		path: "/-/invite/:code",
		name: "invite",
		component: () => import("../views/auth/InviteView.vue"),
		meta: meta("Invite"),
	},

	// Namespace browser and forge administration (WP18).
	{
		path: "/-/explore",
		name: "explore",
		component: () => import("../views/explore/ExploreView.vue"),
		meta: meta("Explore"),
	},
	{
		path: "/-/agents",
		name: "agents",
		component: () => import("../views/admin/AgentsView.vue"),
		meta: meta("Agents"),
	},
	{
		path: "/-/extensions",
		name: "extensions",
		component: () => import("../views/admin/ExtensionsView.vue"),
		meta: meta("Extensions"),
	},
	{
		path: "/-/extensions/:installationId",
		name: "extension",
		component: () => import("../views/admin/ExtensionInstallationView.vue"),
		meta: meta("Extension installation"),
	},
	{
		path: "/-/extensions/:installationId/compare",
		name: "extension-compare",
		component: () => import("../views/admin/ExtensionCompareView.vue"),
		meta: meta("Policy compare"),
	},
	{
		path: "/-/settings",
		name: "settings",
		component: () => import("../views/admin/SettingsView.vue"),
		meta: meta("Settings"),
	},

	// Shell utilities.
	{
		path: "/-/leaving",
		name: "leaving",
		component: () => import("../views/shell/LeavingView.vue"),
		meta: meta("Leaving Tartan"),
	},
	{
		path: "/-/ui",
		name: "ui-gallery",
		component: () => import("../views/shell/UiGalleryView.vue"),
		meta: meta("UI nodes"),
	},
	{
		path: "/-/:rest(.*)*",
		name: "forge-not-found",
		component: () => import("../views/shell/NotFoundView.vue"),
		meta: meta("Not found"),
	},

	// Reserved root slugs that people type by hand.
	{ path: "/explore", redirect: { name: "explore" } },
	{ path: "/settings", redirect: { name: "settings" } },
	{ path: "/setup", redirect: { name: "setup" } },
	{ path: "/login", redirect: { name: "login" } },

	// Nodes: users, groups and repos.
	{
		path: node(),
		name: "node",
		component: () => import("../views/node/NodeView.vue"),
		meta: meta("Namespace"),
	},
	{
		path: node("/-/settings"),
		name: "node-settings",
		component: () => import("../views/node/NodeSettingsView.vue"),
		meta: meta("Node settings"),
	},
	// Repository settings → Extensions: the root CUE package `tartan` (WP23;
	// ADR repo config). Members read it.
	{
		path: node("/-/settings/extensions"),
		name: "repo-config",
		component: () => import("../views/repoconfig/RepoConfigView.vue"),
		meta: meta("Extensions config", "WP23"),
	},

	// Repo code views (WP18; kernel browse API, WP3).
	{
		path: node("/-/tree/:refPath*"),
		name: "repo-tree",
		component: () => import("../views/repo/RepoTreeView.vue"),
		meta: meta("Files"),
	},
	{
		path: node("/-/blob/:refPath+"),
		name: "repo-file",
		component: () => import("../views/repo/RepoFileView.vue"),
		meta: meta("File"),
	},
	{
		path: node("/-/commits/:refPath*"),
		name: "repo-log",
		component: () => import("../views/repo/RepoLogView.vue"),
		meta: meta("History"),
	},
	{
		path: node("/-/commit/:sha"),
		name: "repo-commit",
		component: () => import("../views/repo/RepoCommitView.vue"),
		meta: meta("Commit"),
	},
	{
		path: node("/-/compare/:range+"),
		name: "repo-compare",
		component: () => import("../views/repo/RepoCompareView.vue"),
		meta: meta("Compare revisions"),
	},

	// Change and work item pages: slot hosts.
	{
		path: node("/-/changes/:changeId/:tab?"),
		name: "change",
		component: () => import("../views/repo/ChangeView.vue"),
		meta: meta("Change"),
	},
	{
		path: node("/-/work/:workId"),
		name: "work-item",
		component: () => import("../views/repo/WorkItemView.vue"),
		meta: meta("Work item"),
	},

	// Coordination views (WP19).
	{
		path: node("/-/lanes"),
		name: "lanes",
		component: () => import("../views/coord/LanesView.vue"),
		meta: meta("Lanes", "WP19"),
	},
	{
		path: node("/-/lanes/:laneId"),
		name: "lane",
		component: () => import("../views/coord/LanesView.vue"),
		meta: meta("Lane", "WP19"),
	},
	{
		path: node("/-/blame/:refPath+"),
		name: "why-blame",
		component: () => import("../views/coord/WhyBlameView.vue"),
		meta: meta("Why-blame", "WP19"),
	},
	{
		path: node("/-/runs"),
		name: "runs",
		component: () => import("../views/coord/RunsView.vue"),
		meta: meta("Runs", "WP19"),
	},
	{
		path: node("/-/runs/:runId"),
		name: "run",
		component: () => import("../views/coord/RunView.vue"),
		meta: meta("Run", "WP19"),
	},
	{
		path: node("/-/runs/:runId/jobs/:jobId"),
		name: "run-job",
		component: () => import("../views/coord/RunView.vue"),
		meta: meta("Job log", "WP19"),
	},
	{
		path: node("/-/advances"),
		name: "advances",
		component: () => import("../views/coord/AdvancesView.vue"),
		meta: meta("Advances", "WP19"),
	},
	// One land batch: the kernel serves batches by id (`/-/api/advances/<batchId>`).
	{
		path: node("/-/advances/:batchId"),
		name: "advance",
		component: () => import("../views/coord/AdvanceView.vue"),
		meta: meta("Advance", "WP19"),
	},

	// Monorepo projects (WP25): `/-/p` and `/-/p/<slug>[/<tab>]`, before the
	// extension tabs so `p` is never one.
	...PROJECT_ROUTES,

	// Extension-contributed node.tab / repo.tab pages. Manifest routes match
	// `^[a-z0-9-/*]{1,64}$`; kernel views above win because
	// static segments outrank params.
	{
		path: node("/-/:tab([a-z0-9-]+)/:rest*"),
		name: "slot-tab",
		component: () => import("../views/node/SlotTabView.vue"),
		meta: meta("Extension tab"),
	},

	{
		path: "/:pathMatch(.*)*",
		name: "not-found",
		component: () => import("../views/shell/NotFoundView.vue"),
		meta: meta("Not found"),
	},
];

/** Document title for a route's meta (meta values are `unknown` to vue-router). */
export const pageTitle = (routeMeta: Record<PropertyKey, unknown>): string => {
	const title = routeMeta["title"];
	return typeof title === "string" && title !== ""
		? `${title} · Tartan`
		: "Tartan";
};
