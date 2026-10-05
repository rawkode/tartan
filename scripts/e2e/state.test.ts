// Checkout-local stage state: file modes, exact paths, origin checks.

import { equal, ok, rejects, throws } from "node:assert/strict";
import { GuardError } from "./guards.ts";
import {
	DEPLOY_SETTLE_MS,
	expiryWarning,
	parseForgeRecord,
	parseIdpState,
	readIdpState,
	readPrivate,
	readSetupToken,
	settleWait,
	STAGE_TTL_MS,
	type StateFs,
	statePaths,
} from "./state.ts";

const ORIGIN = "https://tartan-dev-e2e.acme.workers.dev";
const ISSUER = "https://tartan-e2e--idp.acme.workers.dev";
const SEED = "A".repeat(43);

const memoryFs = (files: Record<string, { text: string; mode: number }>) => {
	const store = new Map(Object.entries(files));
	const fs: StateFs = {
		readText: (f) => Promise.resolve(store.get(f)?.text ?? null),
		mode: (f) => Promise.resolve(store.get(f)?.mode ?? null),
		writePrivate: (f, text) => {
			store.set(f, { text, mode: 0o600 });
			return Promise.resolve();
		},
		remove: (f) => {
			store.delete(f);
			return Promise.resolve();
		},
	};
	return { fs, store };
};

const paths = statePaths("/repo");

const idpJson = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({
		version: 1,
		seed: SEED,
		issuer: ISSUER,
		redirectUris: [`${ORIGIN}/-/auth/callback`],
		kid: "e2e-0123456789abcdef",
		createdAt: "2026-10-03T00:00:00.000Z",
		...extra,
	});

Deno.test("secret files are refused when the group or others can read them", async () => {
	const { fs } = memoryFs({
		[paths.idp]: { text: idpJson(), mode: 0o644 },
	});
	await rejects(readPrivate(fs, paths.idp), GuardError);
	const strict = memoryFs({ [paths.idp]: { text: idpJson(), mode: 0o600 } });
	equal((await readIdpState(strict.fs, paths))?.issuer, ISSUER);
});

Deno.test("idp.json never holds the private key and names only dev-e2e callbacks", () => {
	throws(() => parseIdpState(idpJson({ jwk: { d: "x" } })), GuardError);
	throws(
		() =>
			parseIdpState(
				idpJson({
					redirectUris: ["https://code.rawkode.academy/-/auth/callback"],
				}),
			),
		GuardError,
	);
	throws(() => parseIdpState(idpJson({ seed: "short" })), GuardError);
	throws(
		() => parseIdpState(idpJson({ issuer: "https://id.rawkode.academy" })),
		GuardError,
	);
});

Deno.test("the setup token comes from the exact 0600 file on the forge origin", async () => {
	const url = `${ORIGIN}/-/setup#t=${"t".repeat(43)}`;
	const good = memoryFs({
		[paths.setupUrl]: { text: `${url}\n`, mode: 0o600 },
	});
	equal(await readSetupToken(good.fs, paths, ORIGIN), "t".repeat(43));
	ok(paths.setupUrl.endsWith("/.wrangler/deploy/setup-url.dev-e2e.txt"));

	const loose = memoryFs({ [paths.setupUrl]: { text: url, mode: 0o644 } });
	await rejects(readSetupToken(loose.fs, paths, ORIGIN), GuardError);

	const other = memoryFs({
		[paths.setupUrl]: {
			text: `https://code.rawkode.academy/-/setup#t=${"t".repeat(43)}`,
			mode: 0o600,
		},
	});
	await rejects(readSetupToken(other.fs, paths, ORIGIN), GuardError);

	const none = memoryFs({});
	equal(await readSetupToken(none.fs, paths, ORIGIN), null);
	// Another stage's file next to it is never read.
	const demo = memoryFs({
		["/repo/.wrangler/deploy/setup-url.dev-demo.txt"]: {
			text: url,
			mode: 0o600,
		},
	});
	equal(await readSetupToken(demo.fs, paths, ORIGIN), null);
});

Deno.test("the deploy record must be dev-e2e on workers.dev without a domain", () => {
	const record = (extra: Record<string, unknown>) =>
		JSON.stringify({
			stage: "dev-e2e",
			workersDev: ORIGIN,
			domain: null,
			image: { variant: "registry" },
			setupState: "done",
			accountId: "0123456789abcdef0123456789abcdef",
			commit: "b".repeat(40),
			...extra,
		});
	const parsed = parseForgeRecord(record({}));
	equal(parsed.origin, ORIGIN);
	equal(parsed.containers, true);
	equal(parsed.accountId, "0123456789abcdef0123456789abcdef");
	equal(parsed.commit, "b".repeat(40));
	equal(parseForgeRecord(record({ commit: null })).commit, null);
	equal(parseForgeRecord(record({ commit: "HEAD" })).commit, null);
	equal(
		parseForgeRecord(record({ image: { variant: "none" } })).containers,
		false,
	);
	throws(() => parseForgeRecord(record({ stage: "dev-demo" })), GuardError);
	throws(
		() => parseForgeRecord(record({ domain: "code.rawkode.academy" })),
		GuardError,
	);
	throws(
		() =>
			parseForgeRecord(
				record({ workersDev: "https://tartan-dev-demo.acme.workers.dev" }),
			),
		GuardError,
	);
});

Deno.test("an expired stage prints a stage-down reminder", () => {
	const now = Date.UTC(2026, 9, 3, 12);
	const state = {
		upAt: new Date(now - STAGE_TTL_MS - 1).toISOString(),
		expiresAt: new Date(now - 1).toISOString(),
	};
	ok(expiryWarning(state, now)?.includes("stage down"));
	equal(
		expiryWarning(
			{ ...state, expiresAt: new Date(now + 1).toISOString() },
			now,
		),
		null,
	);
	equal(expiryWarning(null, now), null);
});

Deno.test("a run waits until a fresh deploy has settled (Durable Object resets after a code update)", () => {
	const at = "2026-01-01T00:00:00.000Z";
	const record = parseForgeRecord(JSON.stringify({
		stage: "dev-e2e",
		workersDev: ORIGIN,
		domain: null,
		image: { variant: "dockerfile" },
		setupState: "done",
		accountId: "0123456789abcdef0123456789abcdef",
		commit: "b".repeat(40),
		deployedAt: at,
	}));
	const deployed = Date.parse(at);
	equal(record.deployedAt, deployed);
	equal(settleWait(record, deployed + 30_000), DEPLOY_SETTLE_MS - 30_000);
	equal(settleWait(record, deployed + DEPLOY_SETTLE_MS), 0);
	equal(settleWait(record, deployed + 3_600_000), 0);
	equal(settleWait({ ...record, deployedAt: null }, deployed), 0);
	ok(DEPLOY_SETTLE_MS >= 60_000);
});
