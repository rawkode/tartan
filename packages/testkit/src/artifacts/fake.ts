// FakeArtifacts: an in-process stand-in for the Artifacts namespace binding
// (reads by SHA, K15), backed by real git objects.
//
// - Names fold case (`create` of an existing name in any case is
//   `ALREADY_EXISTS` 10201; `get` of a missing one `NOT_FOUND` 10200).
// - Reads resolve only short branch names and SHAs (`reads.ts`).
// - `info().lastPushAt` is not tracked (null).
// - Tokens are scoped to their repo: a token minted for one repo never
//   authenticates against another (`http.ts`).
// - `import()` pulls through a caller-supplied fetch (`importer.ts`), keeps
//   the source branch's name, never emits a push event, and returns a 24 h
//   write token that the product must never store (`issuedTokens()`).
// - Fault injection (`faults`) covers `MEMORY_LIMIT`, `INTERNAL_ERROR`, 429,
//   timeouts, latency and held calls; an import can outlive its caller.
// - Repo handles implement the `RepoStoreRepo` methods, the ones Tartan
//   calls.
//
// Use `fake` wherever `env.ARTIFACTS` or a `RepoStore` is expected, and
// `fake.fetch` wherever a repo remote is fetched.

import type { RepoStore, RepoStoreRepo } from "@tartan/contract/kernel.ts";
import { type GitObject, ZERO_OID } from "../git/objects.ts";
import {
	commitChanges,
	type CommitSpec,
	createObjectStore,
	type FileChanges,
	type FileMap,
	type ObjectStore,
	writeCommit,
	writeTree,
} from "../git/store.ts";
import { artifactsError, FakeTimeoutError } from "./errors.ts";
import { type FakePushEvent, pushEvent } from "./events.ts";
import { createFaultPlan, type FaultPlan } from "./faults.ts";
import { createGitServer } from "./http.ts";
import {
	DEFAULT_IMPORT_MAX_BYTES,
	type ImportRequestLog,
	pullForImport,
} from "./importer.ts";
import * as reads from "./reads.ts";
import {
	checkName,
	type FakeCall,
	type FakeState,
	findRepo,
	iso,
	mintToken,
	nameKey,
	randomId,
	record,
	remoteUrl,
	type RepoState,
	requireRepo,
	tokenPlaintext,
	tokenSecret,
	tokenStateName,
} from "./state.ts";

export type FakeArtifactsOptions = {
	/** Artifacts namespace (default `tartan-test`). */
	readonly namespace?: string;
	/** Host of the repo remotes (default `fake-account.artifacts.fake.test`). */
	readonly host?: string;
	/**
	 * Origin of the repo remotes (default `https://<host>`); e.g.
	 * `http://127.0.0.1:<port>` when stock git talks to `fake.fetch` served
	 * locally. Overrides `host`.
	 */
	readonly origin?: string;
	/** Clock in epoch ms (token expiry, timestamps). */
	readonly now?: () => number;
	/**
	 * The fetch `import()` pulls through for URLs that are not this fake's own
	 * remotes (e.g. the gateway's capability route under test).
	 */
	readonly fetch?: (request: Request) => Promise<Response>;
	/** A pulled pack larger than this fails with `MEMORY_LIMIT`. */
	readonly importMaxBytes?: number;
	/**
	 * Accept `http://` import sources (loopback smoke runs only; the binding
	 * requires https, `INVALID_INPUT` otherwise).
	 */
	readonly allowHttpImports?: boolean;
};

export type IssuedToken = {
	readonly repo: string;
	readonly id: string;
	readonly plaintext: string;
	readonly origin: "create" | "import" | "createToken";
};

export type SeedOptions = {
	readonly files?: FileMap;
	readonly defaultBranch?: string;
	readonly message?: string;
	readonly description?: string;
	/** Extra refs to point at the seeded commit (e.g. `refs/heads/feature`). */
	readonly alsoRefs?: readonly string[];
};

export type FakeRepoHandle = ArtifactsRepo & {
	/** The repo id this handle is bound to. */
	readonly boundId: string;
};

/** Introspection and direct-write helpers for tests (no transport). */
export type FakeArtifactsInspect = {
	repo(name: string): RepoState | undefined;
	refs(name: string): Record<string, string>;
	store(name: string): ObjectStore;
	names(): string[];
	/** Every token plaintext the fake has issued, with its origin. */
	issuedTokens(): IssuedToken[];
	/** Requests the importer made, newest last. */
	importRequests(): readonly ImportRequestLog[];
	/** Imports that finished after their caller timed out. */
	lateImports(): readonly { name: string; ok: boolean }[];
};

export type FakeArtifacts =
	& Artifacts
	& RepoStore
	& {
		readonly namespace: string;
		readonly host: string;
		readonly origin: string;
		/** Smart-HTTP for the repo remotes. */
		fetch(request: Request): Promise<Response>;
		readonly faults: FaultPlan;
		/** Every binding call and smart-HTTP request, redacted. */
		readonly calls: readonly FakeCall[];
		readonly pushEvents: readonly FakePushEvent[];
		onPush(listener: (event: FakePushEvent) => void): () => void;
		remote(name: string): string;
		inspect: FakeArtifactsInspect;
		/** Creates a repo holding `files` as one commit on its default branch. */
		seed(
			name: string,
			options?: SeedOptions,
		): Promise<{ name: string; head: string | null; token: string }>;
		/** Commits `changes` onto `ref` directly (no transport); emits a push event unless `quiet`. */
		commit(
			name: string,
			ref: string,
			changes: FileChanges,
			spec: Omit<CommitSpec, "parents"> & {
				readonly parents?: readonly string[];
				readonly quiet?: boolean;
			},
		): string;
		/** Moves or deletes (`null`) a ref directly; emits a push event unless `quiet`. */
		setRef(
			name: string,
			ref: string,
			oid: string | null,
			options?: { readonly quiet?: boolean },
		): void;
		/** Adds objects to a repo's store directly. */
		putObjects(name: string, objects: readonly GitObject[]): string[];
		reset(): void;
	};

const DAY_S = 86_400;

export const createFakeArtifacts = (
	options: FakeArtifactsOptions = {},
): FakeArtifacts => {
	const origin = options.origin ??
		`https://${options.host ?? "fake-account.artifacts.fake.test"}`;
	const state: FakeState = {
		namespace: options.namespace ?? "tartan-test",
		host: new URL(origin).host,
		origin: new URL(origin).origin,
		now: options.now ?? Date.now,
		repos: new Map(),
		importing: new Set(),
		calls: [],
	};
	const faults = createFaultPlan();
	const pushEvents: FakePushEvent[] = [];
	const listeners = new Set<(event: FakePushEvent) => void>();
	const importLog: ImportRequestLog[] = [];
	const late: { name: string; ok: boolean }[] = [];
	const emit = (event: FakePushEvent) => {
		pushEvents.push(event);
		listeners.forEach((l) => l(event));
	};
	const server = createGitServer({
		state,
		faults,
		onPush: emit,
	});
	const ownRemote = (url: string) => {
		try {
			return new URL(url).origin === state.origin;
		} catch {
			return false;
		}
	};
	const importFetch = (request: Request): Promise<Response> =>
		ownRemote(request.url)
			? server(request)
			: options.fetch
			? options.fetch(request)
			: Promise.reject(new Error("no fetch configured for import()"));

	/** Runs a binding call under the fault plan and records it. */
	const call = async <T>(
		op: Parameters<FaultPlan["run"]>[0],
		detail: string,
		args: readonly unknown[],
		work: () => T | Promise<T>,
	): Promise<T> => {
		try {
			const value = await faults.run(op, args, async () => await work());
			record(state, op, detail);
			return value;
		} catch (error) {
			record(state, op, detail, error);
			throw error;
		}
	};

	const newRepo = (
		name: string,
		init: {
			description?: string | null;
			defaultBranch?: string;
			infoDefaultBranch?: string;
			readOnly?: boolean;
			source?: string | null;
			store?: ObjectStore;
		},
	): RepoState => {
		checkName(name);
		if (findRepo(state, name) || state.importing.has(nameKey(name))) {
			throw artifactsError("ALREADY_EXISTS", `repo already exists: ${name}`);
		}
		const repo: RepoState = {
			id: randomId(),
			name,
			description: init.description ?? null,
			defaultBranch: init.defaultBranch ?? "main",
			...(init.infoDefaultBranch === undefined
				? {}
				: { infoDefaultBranch: init.infoDefaultBranch }),
			createdAtMs: state.now(),
			source: init.source ?? null,
			readOnly: init.readOnly ?? false,
			store: init.store ?? createObjectStore(),
			refs: new Map(),
			tokens: [],
			deleted: false,
		};
		state.repos.set(nameKey(name), repo);
		return repo;
	};

	const createResult = (
		repo: RepoState,
		origin: "create" | "import",
	): ArtifactsCreateRepoResult => {
		const token = mintToken(state, repo, "write", DAY_S, origin);
		return {
			id: repo.id,
			name: repo.name,
			description: repo.description,
			defaultBranch: repo.defaultBranch,
			remote: remoteUrl(state, repo.name),
			token: tokenPlaintext(token),
		};
	};

	const info = (repo: RepoState): ArtifactsRepoInfo => ({
		id: repo.id,
		name: repo.name,
		description: repo.description,
		defaultBranch: repo.infoDefaultBranch ?? repo.defaultBranch,
		createdAt: iso(repo.createdAtMs),
		updatedAt: iso(repo.createdAtMs),
		lastPushAt: null,
		source: repo.source,
		readOnly: repo.readOnly,
		remote: remoteUrl(state, repo.name),
	});

	const handle = (bound: RepoState): FakeRepoHandle => {
		let disposed = false;
		const live = (): RepoState => {
			if (disposed) throw new Error("repo handle disposed");
			const current = findRepo(state, bound.name);
			if (!current || current.id !== bound.id) {
				throw artifactsError(
					"NOT_FOUND",
					`Repository not found: ${bound.name}.`,
				);
			}
			return current;
		};
		const on = <T>(
			op: Parameters<FaultPlan["run"]>[0],
			detail: string,
			work: (repo: RepoState) => T,
		) => call(op, `${bound.name} ${detail}`, [bound.name], () => work(live()));
		const repoHandle: RepoStoreRepo & { readonly boundId: string } = {
			boundId: bound.id,
			createToken: (scope = "write", ttl = DAY_S) =>
				on("repo.createToken", `${scope} ${ttl}`, (repo) => {
					if (scope !== "read" && scope !== "write") {
						throw artifactsError(
							"INVALID_INPUT",
							"scope must be read or write",
						);
					}
					const t = mintToken(state, repo, scope, ttl, "createToken");
					return {
						id: t.id,
						plaintext: tokenPlaintext(t),
						scope: t.scope,
						expiresAt: iso(t.expiresAtMs),
					};
				}),
			listTokens: () =>
				on("repo.listTokens", "", (repo) => {
					// A revoked token is not listed; active and expired ones are.
					const tokens = [...repo.tokens].reverse().filter((t) => !t.revoked)
						.map((t) => ({
							id: t.id,
							scope: t.scope,
							state: tokenStateName(state, t),
							createdAt: iso(t.createdAtMs),
							expiresAt: iso(t.expiresAtMs),
						}));
					return { tokens, total: tokens.length };
				}),
			revokeToken: (tokenOrId) =>
				on("repo.revokeToken", "<token>", (repo) => {
					if (typeof tokenOrId !== "string" || tokenOrId === "") {
						throw artifactsError("INVALID_INPUT", "tokenOrId is required");
					}
					const secret = tokenSecret(tokenOrId);
					const t = repo.tokens.find((x) =>
						x.id === tokenOrId || x.secret === secret
					);
					if (!t || t.revoked) return false;
					t.revoked = true;
					return true;
				}),
			info: () => on("repo.info", "", info),
			readBlob: (hash) =>
				on("repo.readBlob", String(hash), (repo) => reads.readBlob(repo, hash)),
			readTree: (hash) =>
				on("repo.readTree", String(hash), (repo) => reads.readTree(repo, hash)),
			readCommit: (hash) =>
				on(
					"repo.readCommit",
					String(hash),
					(repo) => reads.readCommit(repo, hash),
				),
			readFile: (args) =>
				on(
					"repo.readFile",
					JSON.stringify(args),
					(repo) => reads.readFile(repo, args),
				),
			log: (opts) =>
				on(
					"repo.log",
					JSON.stringify(opts ?? {}),
					(repo) => reads.log(repo, opts),
				),
			[Symbol.dispose]: () => {
				disposed = true;
			},
		};
		// Typed as the binding's handle so the fake stands in for
		// `env.ARTIFACTS`.
		return repoHandle as FakeRepoHandle;
	};

	const seedFiles = (
		repo: RepoState,
		files: FileMap,
		message: string,
	): string => {
		const tree = writeTree(repo.store, files);
		return writeCommit(repo.store, tree, { message });
	};

	const fake: FakeArtifacts = {
		namespace: state.namespace,
		host: state.host,
		origin: state.origin,
		fetch: (request) => server(request),
		faults,
		calls: state.calls,
		pushEvents,
		onPush: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		remote: (name) => remoteUrl(state, name),

		create: (name, opts) =>
			call("create", String(name), [name], () =>
				createResult(
					newRepo(name, {
						description: opts?.description,
						defaultBranch: opts?.setDefaultBranch,
						readOnly: opts?.readOnly,
					}),
					"create",
				)),

		get: (name) =>
			call("get", String(name), [name], () => {
				checkName(name);
				return handle(requireRepo(state, name));
			}),

		import: async (params) => {
			const name = params?.target?.name;
			const url = params?.source?.url;
			const detail = `${String(name)} ← ${String(url)}`;
			const run = async (): Promise<ArtifactsCreateRepoResult> => {
				if (params?.source?.depth !== undefined) {
					throw new Error("FakeArtifacts does not model depth imports");
				}
				const pulled = await pullForImport(
					importFetch,
					url,
					params.source.branch,
					options.importMaxBytes ?? DEFAULT_IMPORT_MAX_BYTES,
					(entry) => importLog.push(entry),
				);
				state.importing.delete(nameKey(name));
				const repo = newRepo(name, {
					description: params.target.opts?.description,
					readOnly: params.target.opts?.readOnly,
					defaultBranch: pulled.branch,
					// Without `branch`, the fake's `info()` says `main` whatever
					// the source's branch is; `HEAD` keeps it.
					...(params.source.branch === undefined
						? { infoDefaultBranch: "main" }
						: {}),
					source: url,
					store: pulled.store,
				});
				repo.refs.set(`refs/heads/${pulled.branch}`, pulled.head);
				return createResult(repo, "import");
			};
			try {
				checkName(name);
				const httpOk = options.allowHttpImports === true &&
					typeof url === "string" && url.startsWith("http://");
				if (
					typeof url !== "string" || (!url.startsWith("https://") && !httpOk)
				) {
					throw artifactsError("INVALID_INPUT", "source url must be https");
				}
				if (findRepo(state, name) || state.importing.has(nameKey(name))) {
					throw artifactsError(
						"ALREADY_EXISTS",
						`repo already exists: ${name}`,
					);
				}
			} catch (error) {
				record(state, "import", detail, error);
				throw error;
			}
			// The name is taken while the import runs (`get` → IMPORT_IN_PROGRESS).
			state.importing.add(nameKey(name));
			try {
				const result = await faults.run("import", [name, url], run, (end) => {
					late.push({ name, ok: end.ok });
					if (!end.ok) state.importing.delete(nameKey(name));
				});
				record(state, "import", detail);
				return result;
			} catch (error) {
				// An import that outlives its caller keeps the name until it ends.
				if (!(error instanceof FakeTimeoutError && error.outlives)) {
					state.importing.delete(nameKey(name));
				}
				record(state, "import", detail, error);
				throw error;
			}
		},

		list: (opts) =>
			call("list", JSON.stringify(opts ?? {}), [], () => {
				const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
				const all = [...state.repos.values()].sort((a, b) =>
					a.createdAtMs - b.createdAtMs || (a.name < b.name ? -1 : 1)
				);
				const start = opts?.cursor
					? all.findIndex((r) => r.id === opts.cursor) + 1
					: 0;
				const page = all.slice(start, start + limit);
				const more = start + limit < all.length;
				return {
					repos: page.map((r) => {
						const { remote: _remote, ...rest } = info(r);
						return rest;
					}),
					total: all.length,
					...(more ? { cursor: page[page.length - 1].id } : {}),
				};
			}),

		delete: (name) =>
			call("delete", String(name), [name], () => {
				checkName(name);
				const repo = findRepo(state, name);
				if (!repo) return false;
				repo.deleted = true;
				state.repos.delete(nameKey(name));
				return true;
			}),

		inspect: {
			repo: (name) => findRepo(state, name),
			refs: (name) => Object.fromEntries(requireRepo(state, name).refs),
			store: (name) => requireRepo(state, name).store,
			names: () => [...state.repos.values()].map((r) => r.name),
			issuedTokens: () =>
				[...state.repos.values()].flatMap((r) =>
					r.tokens.map((t) => ({
						repo: r.name,
						id: t.id,
						plaintext: tokenPlaintext(t),
						origin: t.origin,
					}))
				),
			importRequests: () => importLog,
			lateImports: () => late,
		},

		seed: async (name, seed = {}) => {
			const result = await fake.create(name, {
				description: seed.description,
				setDefaultBranch: seed.defaultBranch,
			});
			const repo = requireRepo(state, name);
			if (!seed.files) return { name, head: null, token: result.token };
			const head = seedFiles(repo, seed.files, seed.message ?? "seed");
			repo.refs.set(`refs/heads/${repo.defaultBranch}`, head);
			for (const ref of seed.alsoRefs ?? []) repo.refs.set(ref, head);
			return { name, head, token: result.token };
		},

		commit: (name, ref, changes, spec) => {
			const repo = requireRepo(state, name);
			const before = repo.refs.get(ref) ?? null;
			const oid = commitChanges(repo.store, before, changes, spec);
			repo.refs.set(ref, oid);
			if (!spec.quiet) {
				emit(pushEvent(state.namespace, repo, ref, before ?? ZERO_OID, oid));
			}
			return oid;
		},

		setRef: (name, ref, oid, opts) => {
			const repo = requireRepo(state, name);
			const before = repo.refs.get(ref) ?? ZERO_OID;
			if (oid === null) repo.refs.delete(ref);
			else {
				if (!repo.store.has(oid)) throw new Error(`unknown object ${oid}`);
				repo.refs.set(ref, oid);
			}
			const after = oid ?? ZERO_OID;
			if (!opts?.quiet && before !== after) {
				emit(pushEvent(state.namespace, repo, ref, before, after));
			}
		},

		putObjects: (name, objects) => {
			const repo = requireRepo(state, name);
			return objects.map((o) => repo.store.put(o));
		},

		reset: () => {
			state.repos.clear();
			state.importing.clear();
			state.calls.length = 0;
			pushEvents.length = 0;
			importLog.length = 0;
			late.length = 0;
			faults.clear();
		},
	};
	return fake;
};
