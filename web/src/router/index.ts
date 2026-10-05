import {
	createRouter,
	createWebHistory,
	type Router,
	type RouterHistory,
} from "vue-router";
import type { Api } from "../api/client.ts";
import { createSetupGuard } from "./guards.ts";
import { pageTitle, routes } from "./routes.ts";

export type AppRouterOptions = {
	readonly history?: RouterHistory;
	/** Enables the first-run guard when given. */
	readonly api?: Pick<Api, "health">;
};

export const createAppRouter = (options: AppRouterOptions = {}): Router => {
	const router = createRouter({
		history: options.history ?? createWebHistory(),
		routes,
		scrollBehavior: (_to, _from, saved) => saved ?? { top: 0 },
	});
	if (options.api) {
		const api = options.api;
		router.beforeEach(
			createSetupGuard(async () => (await api.health()).setupState),
		);
	}
	router.afterEach((to) => {
		if (typeof document !== "undefined") document.title = pageTitle(to.meta);
	});
	return router;
};
