// Fallback switches and kernel constants:
// pure Deno tests.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { LANE_FALLBACK_ORDER, LANE_MODES } from "@tartan/contract";
import {
	DEFAULT_MAX_PUSH_MB,
	ECHO_ENABLED,
	echoEnabledOf,
	FALLBACK_SWITCHES,
	LANE_CAP_TTL_S,
	LANE_FALLBACK,
	LANE_IMPORT_MAX_BYTES,
	LANE_MODE,
	laneFallback,
	laneModeOf,
	maxPushBytes,
	WORKLOAD_TRANSPORT,
	workloadTransportOf,
} from "./constants.ts";

Deno.test("the switches are at their defaults", () => {
	deepStrictEqual(FALLBACK_SWITCHES, {
		UPSTREAM_AUTH: "bearer",
		ECHO_ENABLED: false,
		LANE_MODE: "branch",
		LANE_FALLBACK: "import>branch",
		LANE_IMPORT_MAX_BYTES: 36 * 1024 * 1024,
		LANE_CAP_TTL_S: 120,
		LANE_CAP_PIN_BASE: false,
		LANE_CAP_CLIENT_CHECK: false,
		EXT_DYNAMIC_ENABLED: true,
		IMAGE_VARIANT: "dockerfile",
		TRIGGER_ENABLED: true,
		WAIT_MODE: "event",
		PUSH_LEASE_ENABLED: false,
		MCP_TRANSPORT: "sdk",
		WORKLOAD_TRANSPORT: "local",
	});
	ok((LANE_MODES as readonly string[]).includes(LANE_MODE));
	equal(LANE_FALLBACK, LANE_FALLBACK_ORDER.join(">"));
	// The capability outlives the 60 s token minimum.
	ok(LANE_CAP_TTL_S >= 60);
	ok(LANE_IMPORT_MAX_BYTES > 0);
});

Deno.test("laneFallback accepts only the fixed order or branch alone", () => {
	deepStrictEqual(laneFallback(undefined), ["import", "branch"]);
	deepStrictEqual(laneFallback(""), ["import", "branch"]);
	deepStrictEqual(laneFallback(" import > branch "), ["import", "branch"]);
	deepStrictEqual(laneFallback("branch"), ["branch"]);
	for (
		const bad of [
			"branch>import",
			"import>import>branch",
			"import",
			"import>bogus",
			"bogus>branch",
			"import>>branch",
			">",
		]
	) {
		deepStrictEqual(laneFallback(bad), ["import", "branch"], bad);
	}
});

Deno.test("maxPushBytes reads TARTAN_MAX_PUSH_MB in decimal MB, defaulting to 95", () => {
	equal(DEFAULT_MAX_PUSH_MB, 95);
	equal(maxPushBytes(undefined), 95_000_000);
	equal(maxPushBytes("95"), 95_000_000);
	equal(maxPushBytes("190"), 190_000_000);
	for (const bad of ["", " ", "0", "-5", "1.5", "95MB", "Infinity"]) {
		equal(maxPushBytes(bad), 95_000_000, bad);
	}
	// The default stays under the smallest zone plan body limit (100 MB).
	ok(maxPushBytes(undefined) < 100_000_000);
});

Deno.test("laneModeOf and workloadTransportOf take a stage's rendered override, else the compiled switch", () => {
	equal(laneModeOf(undefined), LANE_MODE);
	equal(laneModeOf({}), LANE_MODE);
	equal(laneModeOf({ TARTAN_LANE_MODE: "import" }), "import");
	equal(laneModeOf({ TARTAN_LANE_MODE: "branch" }), "branch");
	equal(laneModeOf({ TARTAN_LANE_MODE: "bogus" }), LANE_MODE);
	equal(laneModeOf({ TARTAN_LANE_MODE: "" }), LANE_MODE);
	equal(workloadTransportOf(undefined), WORKLOAD_TRANSPORT);
	equal(workloadTransportOf({ TARTAN_WORKLOAD_TRANSPORT: "k2" }), "k2");
	equal(workloadTransportOf({ TARTAN_WORKLOAD_TRANSPORT: "local" }), "local");
	equal(
		workloadTransportOf({ TARTAN_WORKLOAD_TRANSPORT: "queue" }),
		WORKLOAD_TRANSPORT,
	);
});

Deno.test("echoEnabledOf takes a stage's rendered TARTAN_ECHO, else ECHO_ENABLED", () => {
	equal(echoEnabledOf(undefined), ECHO_ENABLED);
	equal(echoEnabledOf({}), ECHO_ENABLED);
	equal(echoEnabledOf({ TARTAN_ECHO: "on" }), true);
	equal(echoEnabledOf({ TARTAN_ECHO: "off" }), false);
	equal(echoEnabledOf({ TARTAN_ECHO: "1" }), ECHO_ENABLED);
	equal(echoEnabledOf({ TARTAN_ECHO: "" }), ECHO_ENABLED);
});
