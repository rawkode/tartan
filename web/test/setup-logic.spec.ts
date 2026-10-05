// Setup wizard logic: step order per phase, the
// container check retry (≤ 2 minutes), and the issuer field rules.

import { describe, expect, it } from "vitest";
import type { EnvironmentCheck } from "@tartan/contract/api.ts";
import {
	CONTAINER_RETRY_MS,
	requiredChecksPass,
	runChecksWithRetry,
} from "../src/setup/checks.ts";
import { checkIssuer, jwksUri, redirectUri } from "../src/setup/issuer.ts";
import {
	entryStep,
	nextStep,
	postClaimSteps,
	PRE_CLAIM,
	stepAllowed,
} from "../src/setup/wizard.ts";
import { fakeClock } from "./support/fakes.ts";

const check = (
	id: EnvironmentCheck["id"],
	ok: boolean,
	optional = false,
): EnvironmentCheck => ({ id, phase: "setup", ok, optional, message: id });

describe("wizard steps", () => {
	it("lands on the step of the kernel's setup state", () => {
		expect(entryStep("fresh", false)).toBe("unlock");
		expect(entryStep("unlocked", false)).toBe("checks");
		expect(entryStep("idp", false)).toBe("claim");
		expect(entryStep("done", true)).toBe("selftest");
		expect(entryStep("done", false)).toBe("already-set-up");
	});

	it("walks the pre-claim steps in order", () => {
		expect(PRE_CLAIM).toEqual(["unlock", "checks", "name", "idp", "claim"]);
		expect(nextStep("unlock", false)).toBe("checks");
		expect(nextStep("checks", false)).toBe("name");
		expect(nextStep("name", false)).toBe("idp");
		expect(nextStep("idp", false)).toBe("claim");
	});

	it("runs the lane self-test after the claim, never before", () => {
		expect(PRE_CLAIM).not.toContain("selftest");
		expect(postClaimSteps(false)[0]).toBe("selftest");
		expect(stepAllowed("selftest", "unlocked")).toBe(false);
		expect(stepAllowed("selftest", "idp")).toBe(false);
		expect(stepAllowed("selftest", "done")).toBe(true);
	});

	it("offers the root-key step only on the button path", () => {
		expect(postClaimSteps(false)).toEqual([
			"selftest",
			"pack",
			"content",
			"people",
			"finished",
		]);
		expect(postClaimSteps(true)).toEqual([
			"selftest",
			"pack",
			"content",
			"people",
			"secret",
			"finished",
		]);
		expect(nextStep("people", true)).toBe("secret");
		expect(nextStep("people", false)).toBe("finished");
	});

	it("allows re-unlocking while not done (expired setup session)", () => {
		expect(stepAllowed("unlock", "unlocked")).toBe(true);
		expect(stepAllowed("unlock", "done")).toBe(false);
		expect(stepAllowed("claim", "unlocked")).toBe(false);
	});
});

describe("environment checks", () => {
	it("requires every non-optional check", () => {
		expect(requiredChecksPass([])).toBe(false);
		expect(
			requiredChecksPass([check("artifacts", true), check("ai", false, true)]),
		).toBe(true);
		expect(requiredChecksPass([check("artifacts", false)])).toBe(false);
	});

	it("retries while the container check fails, then stops when it passes", async () => {
		const clock = fakeClock();
		let attempt = 0;
		const progress: { attempt: number; retrying: boolean }[] = [];
		const done = runChecksWithRetry({
			scheduler: clock,
			fetchChecks: () => {
				attempt += 1;
				return Promise.resolve([
					check("artifacts", true),
					check("containers", attempt >= 3, true),
				]);
			},
			onProgress: (p) =>
				progress.push({ attempt: p.attempt, retrying: p.retrying }),
		});
		await clock.advance(10_000);
		await clock.advance(10_000);
		const checks = await done;
		expect(attempt).toBe(3);
		expect(checks.find((c) => c.id === "containers")?.ok).toBe(true);
		expect(progress).toEqual([
			{ attempt: 1, retrying: true },
			{ attempt: 2, retrying: true },
			{ attempt: 3, retrying: false },
		]);
	});

	it("gives up after 2 minutes with the container check still failing", async () => {
		const clock = fakeClock();
		let attempts = 0;
		const done = runChecksWithRetry({
			scheduler: clock,
			fetchChecks: () => {
				attempts += 1;
				return Promise.resolve([check("containers", false, true)]);
			},
			onProgress: () => {},
		});
		await clock.advance(CONTAINER_RETRY_MS + 30_000);
		const checks = await done;
		expect(checks[0]?.ok).toBe(false);
		expect(attempts).toBe(CONTAINER_RETRY_MS / 10_000 + 1);
	});

	it("does not retry for other failing checks", async () => {
		const clock = fakeClock();
		let attempts = 0;
		await runChecksWithRetry({
			scheduler: clock,
			fetchChecks: () => {
				attempts += 1;
				return Promise.resolve([
					check("artifacts", false),
					check("containers", true, true),
				]);
			},
			onProgress: () => {},
		});
		expect(attempts).toBe(1);
	});

	it("stops when cancelled", async () => {
		const clock = fakeClock();
		let cancelled = false;
		let attempts = 0;
		const done = runChecksWithRetry({
			scheduler: clock,
			cancelled: () => cancelled,
			fetchChecks: () => {
				attempts += 1;
				return Promise.resolve([check("containers", false, true)]);
			},
			onProgress: () => {},
		});
		cancelled = true;
		await clock.advance(10_000);
		await done;
		expect(attempts).toBe(1);
	});
});

describe("issuer field", () => {
	it("accepts an https issuer exactly as typed (trimmed)", () => {
		expect(checkIssuer("  https://id.rawkode.academy ")).toEqual({
			ok: true,
			issuer: "https://id.rawkode.academy",
		});
	});

	it("warns about (but keeps) a trailing slash: issuers match exactly", () => {
		const result = checkIssuer("https://id.rawkode.academy/");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.issuer).toBe("https://id.rawkode.academy/");
			expect(result.warning).toMatch(/trailing slash/);
		}
	});

	it("refuses what cannot be an issuer", () => {
		for (
			const bad of [
				"",
				"id.rawkode.academy",
				"http://id.rawkode.academy",
				"https://user:pw@id.example",
				"https://id.example/?a=1",
				"https://id.example/#x",
				"https://id.example/.well-known/openid-configuration",
				"javascript:alert(1)",
			]
		) {
			expect(checkIssuer(bad).ok).toBe(false);
		}
	});

	it("derives the redirect and JWKS URLs from the canonical origin", () => {
		expect(redirectUri("https://code.rawkode.academy")).toBe(
			"https://code.rawkode.academy/-/auth/callback",
		);
		expect(jwksUri("https://code.rawkode.academy/")).toBe(
			"https://code.rawkode.academy/-/auth/jwks.json",
		);
	});
});
