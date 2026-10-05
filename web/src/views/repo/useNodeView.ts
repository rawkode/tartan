// Loads `GET /-/api/view?path=<node>&view=<view>` for the current route: the
// node, viewer role, static contributions and dynamic slot instances.
// Every node and repo page starts here.

import { computed, type ComputedRef } from "vue";
import { useRoute } from "vue-router";
import type { ViewResponse } from "@tartan/contract/api.ts";
import { useApi } from "../../app/context.ts";
import { type Resource, useResource } from "../../composables/resource.ts";
import { nodePathParam } from "../../router/params.ts";
import { nodeCtx, type SlotCtxHint } from "../../slots/ctx.ts";

export type NodeView = Resource<ViewResponse, readonly [string, string]> & {
	readonly nodePath: ComputedRef<string>;
	readonly view: ComputedRef<string>;
	/**
	 * The page's slot ctx hint (one per page, built with `slots/ctx.ts`);
	 * each slot host narrows it to what its slot takes. The kernel re-derives
	 * every value. It always describes the view on screen: while another
	 * node's view loads (in-view navigation across repos), the hint of the
	 * shown view is held, so its slots never render or act with one node's
	 * instances and another page's entity, ref or path.
	 */
	readonly ctx: ComputedRef<SlotCtxHint>;
	readonly repoId: ComputedRef<string | undefined>;
};

export const useNodeView = (
	view: () => string,
	/** Builds the page's hint from the node path (default: the node only). */
	ctx: (node: string) => SlotCtxHint = nodeCtx,
): NodeView => {
	const api = useApi();
	const route = useRoute();
	const nodePath = computed(() => nodePathParam(route.params));
	const viewName = computed(view);
	const resource = useResource(
		() => [nodePath.value, viewName.value] as const,
		([path, v]) => api.view(path, v),
	);
	// The shown view belongs to another node than the route's: a cross-node
	// navigation is loading. Within one node the instances stay valid, so the
	// hint follows the route at once.
	const otherNode = computed(() => {
		const loaded = resource.loadedKey.value;
		return loaded !== undefined && loaded[0] !== nodePath.value;
	});
	return {
		...resource,
		nodePath,
		view: viewName,
		ctx: computed((held?: SlotCtxHint) =>
			otherNode.value && held !== undefined
				? held
				: ctx(resource.data.value?.node.path ?? nodePath.value)
		),
		repoId: computed(() => resource.data.value?.repo?.id),
	};
};
