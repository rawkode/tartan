// Name, origin, account and disk guards of the e2e launcher.

import { equal, rejects, throws } from "node:assert/strict";
import type { Run } from "../preflight.ts";
import {
	ACCOUNT_ENV,
	accountIdFrom,
	assertAccount,
	assertForgeOrigin,
	assertIdpOrigin,
	assertStage,
	assertWorkerName,
	callbackOf,
	checkDisk,
	forgeOriginFor,
	GuardError,
	idpOriginFor,
} from "./guards.ts";
import { hardenEnv, shouldStrip, TELEMETRY_OFF } from "./env.ts";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

Deno.test("the account comes from CLOUDFLARE_ACCOUNT_ID, checked, and nothing else passes", () => {
	equal(ACCOUNT_ENV, "CLOUDFLARE_ACCOUNT_ID");
	equal(accountIdFrom((n) => n === ACCOUNT_ENV ? ACCOUNT : undefined), ACCOUNT);
	equal(accountIdFrom(() => ` ${ACCOUNT}\n`), ACCOUNT);
	for (
		const value of [undefined, "", "acme", ACCOUNT.toUpperCase(), `${ACCOUNT}0`]
	) {
		throws(() => accountIdFrom(() => value), GuardError, String(value));
	}
	equal(assertAccount(ACCOUNT, ACCOUNT), ACCOUNT);
	throws(() => assertAccount("f".repeat(32), ACCOUNT), GuardError);
	throws(() => assertAccount("", ACCOUNT), GuardError);
});

Deno.test("no tracked launcher or IdP file names an account id", async () => {
	const root = new URL("../../", import.meta.url);
	const files = [
		"scripts/e2e/guards.ts",
		"scripts/e2e/cloudflare.ts",
		"scripts/e2e/forge-stage.ts",
		"scripts/e2e/idp-stage.ts",
		"scripts/e2e/main.ts",
		"tools/mock-idp/wrangler.jsonc",
	];
	for (const file of files) {
		const text = await Deno.readTextFile(new URL(file, root));
		equal(/\b[0-9a-f]{32}\b/.test(text), false, `${file} holds a 32-hex id`);
		equal(/"account_id"/.test(text), false, `${file} pins account_id`);
	}
});

Deno.test("only the two e2e Workers and the dev-e2e stage pass", () => {
	assertWorkerName("tartan-dev-e2e");
	assertWorkerName("tartan-e2e--idp");
	for (
		const name of [
			"tartan-dev-demo",
			"tartan",
			"tartan-e2e-idp",
			"tartan-dev-e2e-x",
			"code-rawkode-academy",
		]
	) {
		throws(() => assertWorkerName(name), GuardError, name);
	}
	assertStage("dev-e2e");
	throws(() => assertStage("dev-demo"), GuardError);
});

Deno.test("origins are the workers.dev names of the two Workers, nothing else", () => {
	equal(forgeOriginFor("acme"), "https://tartan-dev-e2e.acme.workers.dev");
	equal(idpOriginFor("acme"), "https://tartan-e2e--idp.acme.workers.dev");
	equal(
		callbackOf("https://tartan-dev-e2e.acme.workers.dev"),
		"https://tartan-dev-e2e.acme.workers.dev/-/auth/callback",
	);
	for (
		const origin of [
			"https://code.rawkode.academy",
			"https://tartan-dev-demo.acme.workers.dev",
			"http://tartan-dev-e2e.acme.workers.dev",
			"https://tartan-dev-e2e.acme.workers.dev/",
			"https://tartan-dev-e2e.acme.workers.dev.evil.test",
		]
	) {
		throws(() => assertForgeOrigin(origin), GuardError, origin);
		throws(() => callbackOf(origin), GuardError, origin);
	}
	throws(() => assertIdpOrigin("https://id.rawkode.academy"), GuardError);
	throws(() => forgeOriginFor("Acme"), GuardError);
	throws(() => forgeOriginFor("a.b"), GuardError);
});

const df = (availableKib: number): Run => () =>
	Promise.resolve({
		code: 0,
		stdout:
			`Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 970000000 840000000 ${availableKib} 93% /System/Volumes/Data\n`,
		stderr: "",
	});

Deno.test("the disk guard stops below 1.5 GB free", async () => {
	equal(await checkDisk(df(2 * 1024 * 1024), "."), 2 * 1024 ** 3);
	await rejects(checkDisk(df(1024 * 1024), "."), GuardError);
	await rejects(
		checkDisk(() => Promise.resolve({ code: 1, stdout: "", stderr: "" }), "."),
		GuardError,
	);
});

Deno.test("hardenEnv removes model keys and run overrides and turns telemetry off", () => {
	const vars = new Map<string, string>([
		["PATH", "/usr/bin"],
		["HOME", "/Users/x"],
		["OPENAI_API_KEY", "sk-x"],
		["AI_GATEWAY_API_KEY", "x"],
		["ANTHROPIC_API_KEY", "x"],
		["E2E_OAUTH_CREDENTIALS", "{}"],
		["E2E_USER_OWNER_PASSWORD", "hunter2hunter2"],
		["E2E_SECRET_OWNER_PAT", "tpat_x"],
		["TARTAN_E2E_ORIGIN", "https://evil.test"],
		["DO_NOT_TRACK", "0"],
		["E2E_TELEMETRY_DEBUG", "1"],
	]);
	const removed = hardenEnv({
		toObject: () => Object.fromEntries(vars),
		set: (k, v) => void vars.set(k, v),
		delete: (k) => void vars.delete(k),
	});
	equal(removed.includes("OPENAI_API_KEY"), true);
	equal(removed.includes("E2E_USER_OWNER_PASSWORD"), true);
	equal(removed.includes("E2E_SECRET_OWNER_PAT"), true);
	equal(removed.includes("TARTAN_E2E_ORIGIN"), true);
	equal(removed.includes("PATH"), false);
	equal(vars.get("PATH"), "/usr/bin");
	for (const [k, v] of Object.entries(TELEMETRY_OFF)) equal(vars.get(k), v);
	equal(vars.has("OPENAI_API_KEY"), false);
	equal(vars.has("E2E_TELEMETRY_DEBUG"), false);
	equal(shouldStrip("HOME"), false);
});
