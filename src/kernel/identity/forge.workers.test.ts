/// <reference types="@cloudflare/vitest-pool-workers/types" />
// The identity module inside the real ForgeDO (WP2): its migrations are
// applied by the DO host, the facade answers over Workers RPC (errors keep
// their code), the first-boot root key works on the button path, and the
// `TreePort` reaches WP3's tree facade on the same DO. WebCrypto in workerd:
// `timingSafeEqual`, Ed25519 ID tokens.

import { runInDurableObject } from "cloudflare:test";
import { fromRpcError } from "@tartan/contract";
import { describe, expect, it } from "vitest";
import { testEnv as env, uniqueName } from "../../../test/env.ts";
import { constantTimeEqual, sha256Hex, utf8 } from "./crypto.ts";
import { createKeyring } from "./keyring.ts";
import { forgeTreePort } from "./module.ts";
import { authorizationUrl, discover, exchangeCode, pkcePair } from "./oidc.ts";
import { createGuardedFetch } from "./ssrf.ts";
import { createMockIdp } from "./testing/mock-idp.ts";

const forge = () => env.FORGE.getByName(uniqueName("wp02-forge"));

describe("identity in the real ForgeDO", () => {
	it("applies migrations 100–101 and lists them in _migrations", async () => {
		const stub = forge();
		await stub.identity().setupState();
		const rows = await runInDurableObject(
			stub,
			(_i, state) =>
				state.storage.sql.exec<{ n: number; name: string }>(
					"SELECT n, name FROM _migrations WHERE n BETWEEN 100 AND 199 ORDER BY n",
				).toArray(),
		);
		expect(rows).toEqual([
			{ n: 100, name: "identity: identity tables" },
			{ n: 101, name: "identity: consumed destroy tokens" },
		]);
	});

	it("answers over RPC: setup state, unknown tokens and sessions, login transactions", async () => {
		const identity = forge().identity();
		expect(await identity.setupState()).toEqual({
			state: "fresh",
			rootKeyFallback: true,
		});
		expect(await identity.token("0".repeat(64))).toBeNull();
		expect(await identity.session("0".repeat(64))).toBeNull();
		expect(await identity.consumeLoginTxn("0".repeat(64), "1".repeat(64)))
			.toBeNull();
		const error = await identity.putLoginTxn({
			state_hash: "x",
			binding_hash: "y",
			purpose: "login",
			verifier_sealed: "v1.x",
			nonce: "n",
			return_to: "/",
			expires_at: 0,
			invite_hash: null,
		}).catch((e: unknown) => e);
		expect(fromRpcError(error).code).toBe("invalid");
	});

	it("button path: without TARTAN_SECRET the forge generates one root key and keeps it", async () => {
		const stub = forge();
		const first = await stub.identity().rootKey();
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(await stub.identity().rootKey()).toBe(first);
		const sealed = await runInDurableObject(
			stub,
			(_i, state) =>
				state.storage.sql.exec<{ v: string }>(
					"SELECT v FROM meta WHERE k = 'root_key_fallback_sealed'",
				).one().v,
		);
		expect(sealed).toMatch(/^v1\./);
		expect(sealed).not.toContain(first);
		// Another forge has another key.
		expect(await forge().identity().rootKey()).not.toBe(first);
	});

	it("logs a single-use claim code when TARTAN_SETUP_TOKEN is absent", async () => {
		const identity = forge().identity();
		expect(await identity.ensureBootstrapCode()).toEqual({ created: true });
		expect(await identity.ensureBootstrapCode()).toEqual({ created: false });
	});

	it("the TreePort reaches WP3's tree facade on the same Durable Object", async () => {
		const stub = forge();
		await stub.identity().setupState();
		const outcome = await runInDurableObject(stub, async (_i, state) => {
			try {
				return {
					ok: await forgeTreePort({ env, ctx: state }).createRoot({
						kind: "user",
						slug: "probe",
						owner: "u_01k6aaaaaaaaaaaaaaaaaaaaaa",
					}),
				};
			} catch (error) {
				return { error: fromRpcError(error) };
			}
		});
		// WP3's stub answers `not_implemented` naming its own method; once WP3 merges it creates the node.
		if ("error" in outcome) {
			expect(outcome.error?.code).toBe("not_implemented");
			expect(outcome.error?.text).toContain("tree.createRoot");
		} else {
			expect(outcome.ok.id).toBeTruthy();
		}
	});
});

describe("WebCrypto in workerd", () => {
	it("uses crypto.subtle.timingSafeEqual", async () => {
		expect(
			typeof (crypto.subtle as { timingSafeEqual?: unknown }).timingSafeEqual,
		).toBe("function");
		const a = utf8(await sha256Hex("a"));
		expect(constantTimeEqual(a, a.slice())).toBe(true);
		expect(constantTimeEqual(a, utf8(await sha256Hex("b")))).toBe(false);
	});

	it("verifies RS256 and EdDSA ID tokens", async () => {
		for (const alg of ["RS256", "EdDSA"] as const) {
			const idp = await createMockIdp({ idTokenAlg: alg });
			idp.addClient("pub", { method: "none" });
			const fetchFn = createGuardedFetch(idp.fetch);
			const as = await discover(idp.issuer, fetchFn);
			const pkce = await pkcePair();
			const redirectUri = "https://code.example.com/-/auth/callback";
			const url = authorizationUrl(as, {
				clientId: "pub",
				redirectUri,
				scope: "openid",
				state: "st",
				nonce: "nonce-0123456789abcdef",
				codeChallenge: pkce.challenge,
			});
			const claims = await exchangeCode({
				as,
				rp: { clientId: "pub", clientAuth: "none", idTokenAlg: alg },
				callback: idp.authorize(url, { sub: `user-${alg}` }),
				redirectUri,
				state: "st",
				codeVerifier: pkce.verifier,
				nonce: "nonce-0123456789abcdef",
				verifySignature: true,
				fetch: fetchFn,
			});
			expect(claims.sub).toBe(`user-${alg}`);
		}
	});

	it("seals with non-extractable AES-GCM keys", async () => {
		const keyring = await createKeyring("workerd-root-0123456789abcdef");
		const sealed = await keyring.seal("k", "1", "v");
		expect(await keyring.open("k", "1", sealed)).toBe("v");
		expect(keyring.laneCap.extractable).toBe(false);
	});
});
