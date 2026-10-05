// The project pages' routes (WP25 slice A′). `web/src/router/routes.ts`
// spreads `PROJECT_ROUTES` before the
// extension-tab catch-all (`/-/:tab/:rest*`), so `p` is never an extension
// tab; static segments outrank params either way.

import type { RouteRecordRaw } from "vue-router";

/**
 * One node-path segment: `NODE_SEGMENT` of `router/routes.ts`, repeated here
 * because that table imports this one (a spec checks they are equal).
 */
export const PROJECT_NODE_SEGMENT = "[^/-][^/]*";

const node = (suffix: string): string =>
	`/:nodePath(${PROJECT_NODE_SEGMENT})+${suffix}`;

/** A project slug in a URL (`PROJECT_SLUG_RE`). */
export const PROJECT_SLUG_SEGMENT = "[a-z0-9][a-z0-9.-]*";

export const PROJECT_ROUTES: readonly RouteRecordRaw[] = [
	{
		path: node("/-/p"),
		name: "projects",
		component: () => import("./ProjectsView.vue"),
		meta: { title: "Projects", owner: "WP25" },
	},
	{
		path: node(`/-/p/:project(${PROJECT_SLUG_SEGMENT})/:tab(issues|changes)?`),
		name: "project",
		component: () => import("./ProjectView.vue"),
		meta: { title: "Project", owner: "WP25" },
	},
];
