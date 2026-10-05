import { createApp } from "vue";
import App from "./App.vue";
import { createApi } from "./api/client.ts";
import { createHttp, type FetchLike } from "./api/http.ts";
import { API, LIVE, SESSION } from "./app/context.ts";
import { createSession } from "./auth/session.ts";
import {
	browserConnect,
	createLiveStore,
	type SocketLike,
} from "./live/store.ts";
import { createAppRouter } from "./router/index.ts";
import { SETUP_TOKEN, takeSetupToken } from "./setup/fragment.ts";
import { createToasts, TOASTS } from "./shell/toasts.ts";
import { createProjectsClient, PROJECTS } from "./views/project/client.ts";
import { applyThemePreference, readThemePreference } from "./theme.ts";
import "./styles/tokens.css";
import "./styles/base.css";

// Take the setup token out of the URL before the router reads the location
// and before the first render. This runs first,
// synchronously, before any await.
const setupToken = takeSetupToken(globalThis.location, globalThis.history);

applyThemePreference(readThemePreference());

type Services = {
	readonly fetch: FetchLike;
	readonly connect: (path: string) => SocketLike;
};

const services = async (): Promise<Services> => {
	if (import.meta.env.VITE_TARTAN_MOCK === "1") {
		const { mockServices } = await import("./api/mock/index.ts");
		return mockServices(globalThis.location, globalThis.history);
	}
	return {
		fetch: (input, init) => globalThis.fetch(input, init),
		connect: browserConnect,
	};
};

const boot = async (): Promise<void> => {
	const { fetch, connect } = await services();
	const http = createHttp(fetch);
	const api = createApi(http);
	const session = createSession(api);
	const router = createAppRouter({ api });
	void session.load();
	createApp(App)
		.provide(SETUP_TOKEN, setupToken)
		.provide(API, api)
		.provide(PROJECTS, createProjectsClient(http))
		.provide(SESSION, session)
		.provide(LIVE, createLiveStore({ connect }))
		.provide(TOASTS, createToasts())
		.use(router)
		.mount("#app");
};

void boot();
