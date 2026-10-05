// The canonical repo as LandWorkflow and the kernel git jobs reach it from
// the Worker (K11): short-lived tokens scoped
// to that one repo, minted per use and revoked after it (never cached, never
// in params, step outputs, storage, events or logs), protocol v2 `ls-refs`
// for remote reads and a ref-only receive-pack client (`refpush.ts`, built
// on `packages/gitproto`'s codecs) for ref-only writes (commands plus an
// empty pack).

import { repoArtifactsName } from "@tartan/contract";
import {
	type PushCommand,
	type RepoStore,
	SANDBOX_READ_TOKEN_TTL_S,
	SANDBOX_WRITE_TOKEN_TTL_S,
} from "@tartan/contract/kernel.ts";
import { type LsRef, lsRefs, type RefStatus } from "@tartan/gitproto";
import { authorizationFor } from "../repo/gitremote.ts";
import { pushRefsCompat } from "./refpush.ts";

export type MintedToken = {
	readonly remote: string;
	readonly token: string;
	revoke(): Promise<void>;
};

export type CanonicalAccess = {
	readonly name: string;
	remote(): Promise<string>;
	/** A token for the canonical repo only; the caller revokes it. */
	token(scope: "read" | "write"): Promise<MintedToken>;
	/** `ls-refs` with `ref-prefix` arguments (a fresh read token per call). */
	lsRefs(prefixes: readonly string[]): Promise<readonly LsRef[]>;
	/** The exact value of `ref`, or null. */
	refValue(ref: string): Promise<string | null>;
	/** Ref-only receive-pack (a fresh write token per call). */
	pushRefs(
		commands: readonly PushCommand[],
		options?: { readonly pack?: Uint8Array; readonly atomic?: boolean },
	): Promise<readonly RefStatus[]>;
};

export type CanonicalAccessDeps = {
	readonly artifacts: RepoStore;
	readonly repoId: string;
	/** The fetch gitproto uses (tests route it to a fake). */
	readonly fetch?: typeof fetch;
};

export const createCanonicalAccess = (
	deps: CanonicalAccessDeps,
): CanonicalAccess => {
	const name = repoArtifactsName(deps.repoId);
	let remoteUrl: string | null = null;

	const remote = async (): Promise<string> => {
		if (remoteUrl !== null) return remoteUrl;
		const repo = await deps.artifacts.get(name);
		remoteUrl = (await repo.info()).remote;
		return remoteUrl;
	};

	const token = async (scope: "read" | "write"): Promise<MintedToken> => {
		const url = await remote();
		const repo = await deps.artifacts.get(name);
		const minted = await repo.createToken(
			scope,
			scope === "write" ? SANDBOX_WRITE_TOKEN_TTL_S : SANDBOX_READ_TOKEN_TTL_S,
		);
		return {
			remote: url,
			token: minted.plaintext,
			revoke: async () => {
				try {
					const again = await deps.artifacts.get(name);
					await again.revokeToken(minted.id);
				} catch {
					// Expiry (5–10 min) ends it anyway.
				}
			},
		};
	};

	const withToken = async <T>(
		scope: "read" | "write",
		use: (t: MintedToken) => Promise<T>,
	): Promise<T> => {
		const t = await token(scope);
		try {
			return await use(t);
		} finally {
			await t.revoke();
		}
	};

	const gitRemote = (t: MintedToken) => ({
		url: t.remote,
		authorization: authorizationFor(t.token),
		...(deps.fetch ? { fetch: deps.fetch } : {}),
	});

	const list = (prefixes: readonly string[]) =>
		withToken("read", (t) => lsRefs(gitRemote(t), { refPrefixes: prefixes }));

	const refValue = async (ref: string): Promise<string | null> =>
		(await list([ref])).find((r) => r.ref === ref)?.sha ?? null;

	const push: CanonicalAccess["pushRefs"] = (commands, options = {}) =>
		withToken("write", (t) => pushRefsCompat(gitRemote(t), commands, options));

	return {
		name,
		remote,
		token,
		lsRefs: list,
		refValue,
		pushRefs: push,
	};
};
