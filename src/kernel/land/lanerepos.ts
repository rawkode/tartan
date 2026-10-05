// Lane repos as the Advance and the kernel git jobs reach them (WP10; K11): a
// token scoped to exactly one lane repo of THIS repo family, minted per use and
// revoked after it, never cached, never in params, step outputs, storage,
// events or logs. A name outside the family is refused, so a sandbox exec can
// never be handed a token for another repo's lanes.

import { invalid, parseArtifactsName } from "@tartan/contract";
import {
	type RepoStore,
	SANDBOX_READ_TOKEN_TTL_S,
	SANDBOX_WRITE_TOKEN_TTL_S,
} from "@tartan/contract/kernel.ts";
import type { MintedToken } from "./upstream.ts";

export type LaneRepoAccess = {
	/** A token for exactly `name` (a lane repo of this repo); the caller revokes it. */
	token(name: string, scope: "read" | "write"): Promise<MintedToken>;
};

export const requireLaneRepoOf = (repoId: string, name: string): string => {
	const lower = String(name).toLowerCase();
	const parsed = parseArtifactsName(lower);
	if (parsed === null || parsed.kind !== "lane" || parsed.repoUlid !== repoId) {
		throw invalid(`not a lane repo of repo ${repoId}: ${name}`);
	}
	return lower;
};

export const createLaneRepoAccess = (deps: {
	readonly artifacts: RepoStore;
	readonly repoId: string;
}): LaneRepoAccess => ({
	token: async (name, scope) => {
		const lane = requireLaneRepoOf(deps.repoId, name);
		const repo = await deps.artifacts.get(lane);
		const remote = (await repo.info()).remote;
		const minted = await repo.createToken(
			scope,
			scope === "write" ? SANDBOX_WRITE_TOKEN_TTL_S : SANDBOX_READ_TOKEN_TTL_S,
		);
		return {
			remote,
			token: minted.plaintext,
			revoke: async () => {
				try {
					const again = await deps.artifacts.get(lane);
					await again.revokeToken(minted.id);
				} catch {
					// Expiry (5–10 min) ends it anyway.
				}
			},
		};
	},
});

/** Runs `use` with a lane-repo token, revoking it after. */
export const withLaneRepoCred = async <T>(
	access: LaneRepoAccess,
	name: string,
	scope: "read" | "write",
	use: (cred: { remote: string; token: string }) => Promise<T>,
): Promise<T> => {
	const t = await access.token(name, scope);
	try {
		return await use({ remote: t.remote, token: t.token });
	} finally {
		await t.revoke();
	}
};
