// FakeArtifacts state: repos, refs, tokens and the call recorder, shared by
// the binding facade (`fake.ts`), the smart-HTTP server (`http.ts`) and the
// importer (`importer.ts`).

import { redactSecrets } from "@tartan/contract";
import { toHex } from "../bytes.ts";
import { type ObjectStore } from "../git/store.ts";
import { artifactsError } from "./errors.ts";

export type TokenState = {
	readonly id: string;
	/** `art_v2_x_<40 hex>`, the part before `?expires=`. */
	readonly secret: string;
	readonly scope: "read" | "write";
	readonly createdAtMs: number;
	readonly expiresAtMs: number;
	revoked: boolean;
	/** Where the token came from (tests assert on import tokens). */
	readonly origin: "create" | "import" | "createToken";
};

export type RepoState = {
	readonly id: string;
	/** The name as created (lookups fold case). */
	readonly name: string;
	readonly description: string | null;
	readonly defaultBranch: string;
	/**
	 * What `info().defaultBranch` reports when it differs from the branch
	 * `HEAD` names: `main` for a repo imported without `branch`, whatever the
	 * source's branch is. Callers take the default branch from the repo node
	 * or the advertised `HEAD`.
	 */
	readonly infoDefaultBranch?: string;
	readonly createdAtMs: number;
	readonly source: string | null;
	readonly readOnly: boolean;
	readonly store: ObjectStore;
	readonly refs: Map<string, string>;
	readonly tokens: TokenState[];
	deleted: boolean;
};

export type FakeCall = {
	readonly op: string;
	/** Redacted, printable arguments. */
	readonly detail: string;
	readonly at: number;
	readonly outcome: "ok" | "error";
	readonly error?: string;
};

export type FakeState = {
	readonly namespace: string;
	readonly host: string;
	/** `https://<host>` unless set (e.g. `http://127.0.0.1:<port>` for stock git). */
	readonly origin: string;
	readonly now: () => number;
	readonly repos: Map<string, RepoState>;
	/** Lowercased names with an `import()` in flight. */
	readonly importing: Set<string>;
	readonly calls: FakeCall[];
};

/** Names: `[A-Za-z0-9._-]`; `/` is `INVALID_REPO_NAME`. */
const NAME_RE = /^[A-Za-z0-9._-]+$/;
/** The fake refuses longer names with `INTERNAL_ERROR`. */
export const MAX_NAME_LENGTH = 512;

export const checkName = (name: unknown): string => {
	if (typeof name !== "string" || !NAME_RE.test(name)) {
		throw artifactsError("INVALID_REPO_NAME");
	}
	if (name.length > MAX_NAME_LENGTH) throw artifactsError("INTERNAL_ERROR");
	return name;
};

export const nameKey = (name: string): string => name.toLowerCase();

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A 16-char lowercase id, like the binding's repo and token ids. */
export const randomId = (): string =>
	Array.from(
		crypto.getRandomValues(new Uint8Array(16)),
		(b) => ID_ALPHABET[b % ID_ALPHABET.length],
	).join("");

export const randomSecret = (): string =>
	`art_v2_x_${toHex(crypto.getRandomValues(new Uint8Array(20)))}`;

/** `art_v2_x_<hex>?expires=<unix s>` as the binding returns it. */
export const tokenPlaintext = (t: TokenState): string =>
	`${t.secret}?expires=${Math.floor(t.expiresAtMs / 1000)}`;

/** The secret part of a presented token (with or without `?expires=`). */
export const tokenSecret = (presented: string): string =>
	presented.split("?")[0];

export const MIN_TTL_S = 60;
export const MAX_TTL_S = 31_536_000;

export const mintToken = (
	state: FakeState,
	repo: RepoState,
	scope: "read" | "write",
	ttlS: number,
	origin: TokenState["origin"],
): TokenState => {
	if (!Number.isInteger(ttlS) || ttlS < MIN_TTL_S || ttlS > MAX_TTL_S) {
		throw artifactsError(
			"INVALID_TTL",
			`Invalid TTL ${ttlS}: must be between ${MIN_TTL_S} and ${MAX_TTL_S} seconds.`,
		);
	}
	const at = state.now();
	const token: TokenState = {
		id: randomId(),
		secret: randomSecret(),
		scope,
		createdAtMs: at,
		expiresAtMs: at + ttlS * 1000,
		revoked: false,
		origin,
	};
	repo.tokens.push(token);
	return token;
};

export const tokenStateName = (
	state: FakeState,
	t: TokenState,
): "active" | "expired" | "revoked" =>
	t.revoked ? "revoked" : state.now() >= t.expiresAtMs ? "expired" : "active";

export const findRepo = (
	state: FakeState,
	name: string,
): RepoState | undefined => state.repos.get(nameKey(name));

export const requireRepo = (state: FakeState, name: string): RepoState => {
	const repo = findRepo(state, name);
	if (!repo) {
		if (state.importing.has(nameKey(name))) {
			throw artifactsError(
				"IMPORT_IN_PROGRESS",
				`Import in progress: ${name}.`,
			);
		}
		throw artifactsError("NOT_FOUND", `Repository not found: ${name}.`);
	}
	return repo;
};

export const remoteUrl = (state: FakeState, name: string): string =>
	`${state.origin}/git/${state.namespace}/${name}.git`;

export const iso = (ms: number): string => new Date(ms).toISOString();

export const record = (
	state: FakeState,
	op: string,
	detail: string,
	error?: unknown,
): void => {
	state.calls.push({
		op,
		detail: redactSecrets(detail),
		at: state.now(),
		outcome: error === undefined ? "ok" : "error",
		...(error === undefined ? {} : {
			error: redactSecrets(
				error instanceof Error
					? `${
						(error as { code?: string }).code ?? error.name
					}: ${error.message}`
					: String(error),
			),
		}),
	});
};
