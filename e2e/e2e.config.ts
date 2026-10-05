// The one e2e config (docs/testing/e2e.md). Deterministic tests only: no
// `agents` key, so no model is configured and nothing can call one; the
// replay cache is off; telemetry is off before anything else loads.
//
// Run it through `deno task e2e`, which deploys and provisions the dev-e2e
// stage and passes the run's values as `TARTAN_E2E_*` variables. Without
// them the config does not load (support/stage.ts).

import "./support/no-telemetry.ts";
import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";
import { SIGNED_IN, stage, usernameOf } from "./support/stage.ts";

const s = stage();

export default {
	projectId: "tartan-e2e",
	tests: "tests/**/*.e2e.ts",
	targets: [{
		name: "chromium",
		engine: web({
			browser: "chromium",
			viewport: { width: 1280, height: 800 },
		}),
		app: {
			url: s.origin,
			// Stable session keys if the workers.dev subdomain changes; `test`
			// because a workers.dev host would otherwise be labelled production.
			identity: "tartan-dev-e2e",
			environment: "test",
		},
	}],
	timeout: 120_000,
	launchTimeout: 60_000,
	actionTimeout: 15_000,
	assertionTimeout: 10_000,
	cleanupTimeout: 30_000,
	// Flakes stay visible; a flaky test is quarantined, never retried away.
	retries: 0,
	// One dev Worker and a handful of Durable Objects: two at a time.
	workers: 2,
	cache: "off",
	// Traces hold request headers; only failed attempts keep one, and the
	// launcher ends every session cookie found in them after the run.
	trace: "retain-on-failure",
	video: "off",
	output: ".e2e",
	reporters: ["list", "junit", "markdown"],
	// Static strings: registered for redaction before the first test.
	credentials: {
		...Object.fromEntries(
			SIGNED_IN.map((p) => [p, {
				username: usernameOf(p),
				password: s.passwords[p],
			}]),
		),
		outsider: {
			username: usernameOf("outsider"),
			password: s.passwords.outsider,
		},
	},
	secrets: {
		...(s.tokens === undefined ? {} : {
			"owner-pat": s.tokens.ownerPat,
			"reporter-pat": s.tokens.reporterPat,
			"read-pat": s.tokens.readPat,
			"developer-agent": s.tokens.developerAgent,
			"developer-agent-b": s.tokens.developerAgentB,
		}),
		...(s.setupToken === undefined ? {} : { "setup-token": s.setupToken }),
	},
} satisfies E2EConfig;
