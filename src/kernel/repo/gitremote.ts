// The upstream `Authorization` header for an Artifacts git remote
// (`UPSTREAM_AUTH` [E A1]): `Bearer <full token>`, or Basic with the secret
// stripped of its `?expires=…` suffix.

import { UPSTREAM_AUTH } from "../../constants.ts";

export const authorizationFor = (
	token: string,
	mode: "bearer" | "basic" = UPSTREAM_AUTH,
): string => {
	if (mode === "bearer") return `Bearer ${token}`;
	const secret = token.replace(/\?expires=\d+$/, "");
	return `Basic ${btoa(`x:${secret}`)}`;
};
