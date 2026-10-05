/// <reference types="@cloudflare/vitest-pool-workers/types" />
// `createCapMac(env)` in workerd: the isolate keyring builds
// `LANE_CAP_KEY` once, from `TARTAN_SECRET` or (button path, as in the pool)
// from the root key ForgeDO generated; a RepoDO in the same isolate (WP5b's
// seeder) and the Worker (WP4's route) agree on every MAC.

import { runInDurableObject } from "cloudflare:test";
import type { CapFields } from "@tartan/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { testEnv as env, uniqueName } from "../../../test/env.ts";
import { createKeyring } from "../identity/keyring.ts";
import { capMacOf, createCapMac } from "./capmac.ts";
import { forgeIdentity, resetIsolateState } from "./isolate.ts";

const FIELDS: CapFields = {
	exp: 1_800_000_120,
	laneId: "ln_01k6aaaaaaaaaaaaaaaaaaaaaa",
	nonce: "0123456789abcdef0123456789abcdef",
	repoId: "01k6bbbbbbbbbbbbbbbbbbbbbb",
};

describe("createCapMac in workerd", () => {
	beforeEach(() => resetIsolateState());

	it("signs in the Worker and verifies in a RepoDO (same root, same key)", async () => {
		const mac = await createCapMac(env).sign(FIELDS);
		expect(mac).toMatch(/^[0-9a-f]{64}$/);
		const verified = await runInDurableObject(
			env.REPO.getByName(uniqueName("wp02-capmac")),
			() => createCapMac(env).verify(FIELDS, mac),
		);
		expect(verified).toBe(true);
		expect(
			await createCapMac(env).verify({ ...FIELDS, exp: FIELDS.exp + 1 }, mac),
		).toBe(false);
	});

	it("is HMAC-SHA256 under the root's lane-cap key, which never leaves WebCrypto", async () => {
		const root = await forgeIdentity(env).rootKey();
		expect(root).toBeTruthy();
		const independent = await createKeyring(root as string);
		const expected = await capMacOf(() => Promise.resolve(independent.laneCap))
			.sign(FIELDS);
		expect(await createCapMac(env).sign(FIELDS)).toBe(expected);
		await expect(crypto.subtle.exportKey("raw", independent.laneCap)).rejects
			.toThrow();
	});

	it("with TARTAN_SECRET set, ForgeDO is never asked for the root", async () => {
		const withSecret = {
			...env,
			TARTAN_SECRET: "a-secret-root-0123456789abcdef",
			FORGE: undefined,
		} as unknown as typeof env;
		const mac = createCapMac(withSecret);
		const sig = await mac.sign(FIELDS);
		expect(await mac.verify(FIELDS, sig)).toBe(true);
	});
});
