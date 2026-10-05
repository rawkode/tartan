// Mounting helpers for the tartan-ui@1 renderer.

import { h, ref } from "vue";
import { createMemoryHistory } from "vue-router";
import { createAppRouter } from "../../src/router/index.ts";
import {
	UI_ACTIONS,
	UI_DIFF_SOURCE,
	type UiActionRunner,
	type UiDiffSource,
} from "../../src/ui/context.ts";
import type { UiAction, UiJson } from "../../src/ui/nodeTypes.ts";
import UiNode from "../../src/ui/UiNode.vue";
import { flush, mount, type TestElement } from "./renderer.ts";

export type RunnerCall = {
	readonly action: UiAction;
	readonly payload?: UiJson;
};

export const mountNode = async (
	node: unknown,
	options: { readonly runner?: boolean; readonly diff?: UiDiffSource } = {},
): Promise<{ root: TestElement; calls: RunnerCall[]; unmount: () => void }> => {
	const calls: RunnerCall[] = [];
	const runner: UiActionRunner = {
		busy: ref(false),
		run: (action, payload) => {
			calls.push(payload === undefined ? { action } : { action, payload });
			return Promise.resolve();
		},
	};
	const router = createAppRouter({ history: createMemoryHistory() });
	await router.push("/-/ui");
	const provide: [symbol, unknown][] = [];
	if (options.runner !== false) provide.push([UI_ACTIONS, runner]);
	if (options.diff) provide.push([UI_DIFF_SOURCE, options.diff]);
	const mounted = mount({ render: () => h(UiNode, { node }) }, {
		provide,
		plugins: [router],
	});
	await flush();
	return { root: mounted.root, calls, unmount: mounted.unmount };
};
