// Mock services for `VITE_TARTAN_MOCK=1` builds (local demos, screenshots,
// Lighthouse). The mock forge's state survives page loads in sessionStorage,
// so the setup wizard can be walked end to end:
// - `?setup=fresh|unlocked|idp|done` (re)starts the mock forge in that state;
// - a full-page visit to `/-/auth/login` (the claim, "Sign in") signs in as
//   the owner — the mock has no IdP — and returns to `return_to`.

import { sameOriginPath } from "../../ui/links.ts";
import type { FetchLike } from "../http.ts";
import { MOCK_NOW, OWNER_VIEWER } from "./fixtures.ts";
import { createMockConnect } from "./live.ts";
import { withMockProjects } from "./projects.ts";
import {
	createMockFetch,
	createMockState,
	type MockOptions,
} from "./server.ts";

const STORAGE_KEY = "tartan.mock.state.v2";

type MockLocation = Pick<Location, "pathname" | "search">;
type MockHistory = Pick<History, "replaceState">;

export const mockServices = (location: MockLocation, history: MockHistory) => {
	const params = new URLSearchParams(location.search);
	const setup = params.get("setup");
	const options: MockOptions = {
		setupState: setup === "fresh" || setup === "unlocked" || setup === "idp"
			? setup
			: "done",
		latencyMs: 120,
		timeShiftMs: Date.now() - MOCK_NOW,
	};
	let stored: string | null = null;
	try {
		stored = setup === null
			? globalThis.sessionStorage?.getItem(STORAGE_KEY) ?? null
			: null;
	} catch {
		stored = null;
	}
	const state = stored
		? JSON.parse(stored) as ReturnType<typeof createMockState>
		: createMockState(options);
	const save = (): void => {
		try {
			globalThis.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
		} catch {
			// Storage blocked: the mock forge resets on the next page load.
		}
	};

	if (location.pathname === "/-/auth/login") {
		if (state.setup.state === "idp") {
			state.setup = { ...state.setup, state: "done" };
			state.setupSession = false;
		}
		state.viewer = OWNER_VIEWER;
		const returnTo = sameOriginPath(params.get("return_to")) ?? "/";
		history.replaceState(null, "", returnTo);
	}
	save();

	const inner = withMockProjects(createMockFetch(options, state));
	const fetch: FetchLike = async (input, init) => {
		const response = await inner(input, init);
		save();
		return response;
	};
	return { fetch, connect: createMockConnect() };
};
