// Auth state for the SPA: who is signed in (`GET /-/api/me`, WP2's
// `MeResponse`), plus the login and logout helpers. Sessions are the
// kernel's `__Host-tartan-session` cookie; the SPA never sees or stores a
// credential.

import { reactive } from "vue";
import type { MeResponse } from "@tartan/contract/api.ts";
import { type Api, loginHref } from "../api/client.ts";
import { errorMessage, isApiError } from "../api/http.ts";

/** A signed-in caller: `MeResponse` with a principal. */
export type SignedInMe = Extract<MeResponse, { readonly auth: unknown }>;
export type MePrincipal = SignedInMe["principal"];

export type SessionState = {
	status: "unknown" | "loading" | "anonymous" | "signed-in" | "error";
	/** The last `/-/api/me` answer for a signed-in caller, else null. */
	me: SignedInMe | null;
	error: string | null;
};

export type Session = {
	readonly state: Readonly<SessionState>;
	readonly load: () => Promise<void>;
	readonly logout: () => Promise<void>;
	/** `/-/auth/login?return_to=<path>`; `return_to` is forced same-origin. */
	readonly loginUrl: (returnTo: string) => string;
	/** The signed-in principal, or null. */
	readonly principal: () => MePrincipal | null;
	/** `auth.isAdmin`: scope-aware admin power (a session of an admin, or an `admin`-scoped token). */
	readonly isAdmin: () => boolean;
};

const isSignedIn = (me: MeResponse): me is SignedInMe => me.principal !== null;

export const createSession = (api: Api): Session => {
	const state = reactive<SessionState>({
		status: "unknown",
		me: null,
		error: null,
	});

	const load = async (): Promise<void> => {
		state.status = "loading";
		state.error = null;
		try {
			const me = await api.me();
			state.me = isSignedIn(me) ? me : null;
			state.status = state.me ? "signed-in" : "anonymous";
		} catch (e) {
			state.me = null;
			// 401/403: no usable session; 503 `setup_required`: nobody can be
			// signed in before the claim.
			if (
				isApiError(e) &&
				(e.status === 401 || e.status === 403 ||
					e.code === "setup_required")
			) {
				state.status = "anonymous";
			} else {
				state.status = "error";
				state.error = errorMessage(e);
			}
		}
	};

	const logout = async (): Promise<void> => {
		try {
			await api.logout();
		} finally {
			state.me = null;
			state.status = "anonymous";
		}
	};

	return {
		state,
		load,
		logout,
		loginUrl: (returnTo) => loginHref(returnTo),
		principal: () => state.me?.principal ?? null,
		isAdmin: () => state.me?.auth.isAdmin === true,
	};
};
