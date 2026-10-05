// Shared steps of WP2's tests: a forge taken from `fresh` to `done` through
// the module's own facade, the way the wizard does it.

import { setupSecretHash } from "../setup.ts";
import type { IdentityHarness } from "./harness.ts";
import type { MockIdp } from "./mock-idp.ts";

export const SETUP_TOKEN = "setup-token-0123456789abcdefghijklmnopqrstuv";
export const IP_A = "a1a1a1a1a1a1a1a1";
export const IP_B = "b2b2b2b2b2b2b2b2";
export const ORIGIN = "https://code.example.com";
export const OWNER = {
	issuer: "https://idp.test",
	sub: "owner-sub",
	handle: "rawkode",
	display: "David Flanagan",
	email: "david@example.com",
};

/** unlock → name → manual IdP (a public client registered at the mock) → setup session. */
export const unlockAndConfigure = async (
	h: IdentityHarness,
	idp: MockIdp,
	options: { token?: string; ip?: string } = {},
): Promise<string> => {
	const { sessionCookie } = await h.facade.unlock({
		token: options.token ?? SETUP_TOKEN,
		purpose: "bootstrap",
		ipHash: options.ip ?? IP_A,
	});
	await h.facade.setName(
		{ forgeName: "Rawkode", canonicalOrigin: ORIGIN },
		sessionCookie,
	);
	idp.addClient("manual-client", { method: "none" });
	await h.facade.configureIdp(
		{ issuer: idp.issuer, clientId: "manual-client", clientAuth: "none" },
		sessionCookie,
	);
	return sessionCookie;
};

/** The whole bootstrap: the owner claims the forge. */
export const claimForge = async (h: IdentityHarness, idp: MockIdp) => {
	await unlockAndConfigure(h, idp);
	return await h.facade.claimOwner(OWNER, await setupSecretHash(SETUP_TOKEN));
};
