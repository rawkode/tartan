import { createApp } from "vue";
import App from "./App.vue";
import { createApi } from "./api/client.ts";
import { createHttp, type FetchLike } from "./api/http.ts";
import { API, LIVE, SESSION } from "./app/context.ts";
import { syncRoleToDocument } from "./auth/role.ts";
import { createSession } from "./auth/session.ts";
import {
	browserConnect,
	createLiveStore,
	type SocketLike,
} from "./live/store.ts";
import { createForgeStore, FORGE } from "./forge/data/index.ts";
import { createAppRouter } from "./router/index.ts";
import { SETUP_TOKEN, takeSetupToken } from "./setup/fragment.ts";
import { createToasts, TOASTS } from "./shell/toasts.ts";
import { applyThemePreference, readThemePreference } from "./theme.ts";
// Order matters: base.css declares the lowest cascade layer, before Panda's.
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/panda.css";

// Take the setup token out of the URL before the router reads the location
// and before the first render. This runs first,
// synchronously, before any await.
const setupToken = takeSetupToken(globalThis.location, globalThis.history);

// The asset layer redirects a path with ":" in it to its `%3A` spelling. An
// address reads with the colon, so put it back before the router reads it.
if (globalThis.location.pathname.includes("%3A")) {
	globalThis.history.replaceState(
		globalThis.history.state,
		"",
		`${
			globalThis.location.pathname.replaceAll("%3A", ":")
		}${globalThis.location.search}${globalThis.location.hash}`,
	);
}

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
	syncRoleToDocument(session);
	const signedIn = session.load();
	createApp(App)
		.provide(SETUP_TOKEN, setupToken)
		.provide(API, api)
		.provide(SESSION, session)
		.provide(FORGE, createForgeStore(api, session, signedIn))
		.provide(LIVE, createLiveStore({ connect }))
		.provide(TOASTS, createToasts())
		.use(router)
		.mount("#app");
};

void boot();
