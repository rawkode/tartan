// Mounts the real router + views with the real API client over the mock
// kernel (or a custom fetch), recording every request.

import { type Component, h } from "vue";
import { createMemoryHistory, type Router, RouterView } from "vue-router";
import { type Api, createApi } from "../../src/api/client.ts";
import { createHttp, type FetchLike } from "../../src/api/http.ts";
import { withMockProjects } from "../../src/api/mock/projects.ts";
import {
	createMockFetch,
	type MockOptions,
} from "../../src/api/mock/server.ts";
import { API, LIVE, SESSION } from "../../src/app/context.ts";
import { createSession, type Session } from "../../src/auth/session.ts";
import { SCHEDULER } from "../../src/live/scheduler.ts";
import { createLiveStore, type SocketLike } from "../../src/live/store.ts";
import { createAppRouter } from "../../src/router/index.ts";
import { SETUP_TOKEN } from "../../src/setup/fragment.ts";
import { createToasts, TOASTS, type Toasts } from "../../src/shell/toasts.ts";
import {
	createProjectsClient,
	PROJECTS,
} from "../../src/views/project/client.ts";
import { type FakeClock, fakeClock } from "./fakes.ts";
import { flush, mount, type TestElement } from "./renderer.ts";

export type RecordedCall = {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
	readonly headers: Readonly<Record<string, string>>;
};

export const recordingFetch = (
	inner: FetchLike,
): { fetch: FetchLike; calls: RecordedCall[] } => {
	const calls: RecordedCall[] = [];
	return {
		calls,
		fetch: (input, init) => {
			calls.push({
				method: (init?.method ?? "GET").toUpperCase(),
				path: input,
				body: typeof init?.body === "string"
					? JSON.parse(init.body)
					: undefined,
				headers: { ...(init?.headers as Record<string, string> | undefined) },
			});
			return inner(input, init);
		},
	};
};

/** A socket that never opens (views under test do not need live frames). */
export const silentConnect = (): SocketLike => ({
	onopen: null,
	onmessage: null,
	onclose: null,
	onerror: null,
	close: () => {},
});

export type AppHarness = {
	readonly root: TestElement;
	readonly router: Router;
	readonly api: Api;
	readonly session: Session;
	readonly toasts: Toasts;
	readonly calls: RecordedCall[];
	readonly clock: FakeClock;
	readonly unmount: () => void;
};

export const mountApp = async (
	path: string,
	options: {
		readonly mock?: MockOptions;
		readonly fetch?: FetchLike;
		readonly setupToken?: string | null;
		readonly guard?: boolean;
		readonly clock?: FakeClock;
		/** The `/-/live` connector (default: a socket that never opens). */
		readonly connect?: (path: string) => SocketLike;
		/** Mount the whole shell (`App.vue`) instead of just the routed view. */
		readonly shell?: Component;
	} = {},
): Promise<AppHarness> => {
	const recorder = recordingFetch(
		options.fetch ?? withMockProjects(createMockFetch(options.mock)),
	);
	const http = createHttp(recorder.fetch);
	const api = createApi(http);
	const session = createSession(api);
	await session.load();
	const router = createAppRouter({
		history: createMemoryHistory(),
		...(options.guard ? { api } : {}),
	});
	const toasts = createToasts(() => undefined);
	const clock = options.clock ?? fakeClock();
	const live = createLiveStore({
		connect: options.connect ?? silentConnect,
		scheduler: clock,
	});
	const { root, unmount } = mount(
		options.shell ?? { render: () => h(RouterView) },
		{
			provide: [
				[API, api],
				[PROJECTS, createProjectsClient(http)],
				[SESSION, session],
				[LIVE, live],
				[TOASTS, toasts],
				[SETUP_TOKEN, options.setupToken ?? null],
				[SCHEDULER, clock],
			],
			plugins: [router],
		},
	);
	await router.push(path);
	await router.isReady();
	await flush();
	return {
		root,
		router,
		api,
		session,
		toasts,
		calls: recorder.calls,
		clock,
		unmount,
	};
};
