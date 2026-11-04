// The viewer's role in the forge shell, from the session. `<html data-role>`
// shows and hides controls (`.owner-only` and friends, panda.config.ts); it is
// presentation only, because the kernel authorises every action itself.

import { watchEffect } from "vue";
import type { Session } from "./session.ts";

export type ForgeRole = "owner" | "contributor" | "anon";

/** Anyone not yet known to be signed in is anonymous, so controls fail closed. */
export const forgeRole = (
	session: Pick<Session, "state" | "isAdmin">,
): ForgeRole => {
	if (session.state.status !== "signed-in") return "anon";
	return session.isAdmin() ? "owner" : "contributor";
};

export const syncRoleToDocument = (session: Session): void => {
	watchEffect(() => {
		document.documentElement.dataset["role"] = forgeRole(session);
	});
};
