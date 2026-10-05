// The global-log slice of Env is read from the typed Env, never from an
// untyped value: a renamed Env field fails to compile
// instead of silently reading undefined (relay off, every run local).

import { deepEqual } from "node:assert/strict";
import type { Env } from "../../env.ts";
import { projectsMode } from "../projects/mode.ts";
import { k2Env } from "./k2.ts";

Deno.test("k2Env and projectsMode take the typed Env and read only their fields", () => {
	const producer = { send: () => Promise.resolve({ success: true as const }) };
	const env = {
		TARTAN_STAGE: "dev-e2e",
		EVENT_LOG: producer,
		TARTAN_K2_STREAM: "0123456789abcdef0123456789abcdef",
		TARTAN_PROJECTS: "scan",
		FORGE: {},
	} as unknown as Env;
	deepEqual(k2Env(env), {
		TARTAN_STAGE: "dev-e2e",
		EVENT_LOG: producer,
		TARTAN_K2_STREAM: "0123456789abcdef0123456789abcdef",
	});
	deepEqual(projectsMode(env), "scan");
	// @ts-expect-error: an untyped value is not a Worker Env.
	k2Env({ TARTAN_STAGE: 1 });
	// @ts-expect-error: TARTAN_PROJECTS is read from the typed Env.
	projectsMode({ TARTAN_PROJECTS: 2 });
});
