// Test-only: the ForgeDO `tree` module on the `node:sqlite` storage fake,
// with recording fakes of its siblings (WP2 identity internals, WP6 forge
// events), `@tartan/testkit`'s FakeArtifacts (real git objects, live limits)
// behind the Artifacts port and a public mirror for imports, a RepoDO `core`
// fake that mints real fake-Artifacts tokens and records the K1 ledger, and
// WP3's real in-Worker genesis writer pushing through `fake.fetch`.

import {
	createUlid,
	type ImportCompleteResponse,
	isSha,
	repoArtifactsName,
	SYS_KERNEL,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	ForgeInternals,
	IdentityInternal,
	KernelWriteIntent,
	KernelWriteRow,
	ModuleDeps,
	PrincipalRow,
} from "@tartan/contract/kernel.ts";
import { createFakeArtifacts, type FakeArtifacts } from "@tartan/testkit";
import {
	COMMON_MIGRATIONS,
	migrationSources,
	runMigrations,
} from "../../../do/migrations.ts";
import type { Env } from "../../../env.ts";
import type { RepoSetupPort, TreePorts } from "../context.ts";
import { createGenesis, type GenesisCore } from "../genesis.ts";
import { createTreeModule, type TreeKernelFacade } from "../module.ts";
import { createTestStorage } from "./sqlite.ts";

/** 2026-10-02T12:00:00Z. */
export const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);

export type Clock = { now(): number; advance(ms: number): void };

export const createClock = (start = T0): Clock => {
	let at = start;
	return {
		now: () => at,
		advance: (ms) => {
			at += ms;
		},
	};
};

/** Imports read `https://public.example.test/<name>.git` (a credential-free mirror of a fake repo). */
export const PUBLIC_HOST = "public.example.test";
export const publicUrl = (name: string): string =>
	`https://${PUBLIC_HOST}/${name}.git`;

const publicMirror = (fake: () => FakeArtifacts) =>
async (
	request: Request,
): Promise<Response> => {
	const url = new URL(request.url);
	const m = /^\/([^/]+)\.git\/(info\/refs|git-upload-pack)$/.exec(
		url.pathname,
	);
	if (url.host !== PUBLIC_HOST || !m) {
		return new Response("not found\n", { status: 404 });
	}
	const repo = await fake().get(m[1]).catch(() => null);
	if (!repo) return new Response("not found\n", { status: 404 });
	const token = await repo.createToken("read", 60);
	const body = request.method === "POST"
		? new Uint8Array(await request.arrayBuffer())
		: null;
	const headers: Record<string, string> = {
		authorization: `Bearer ${token.plaintext}`,
	};
	for (const name of ["content-type", "git-protocol"]) {
		const value = request.headers.get(name);
		if (value) headers[name] = value;
	}
	const upstream = await fake().fetch(
		new Request(`${fake().remote(m[1])}/${m[2]}${url.search}`, {
			method: request.method,
			headers,
			body,
		}),
	);
	return new Response(await upstream.arrayBuffer(), {
		status: upstream.status,
		headers: upstream.headers,
	});
};

// ---------------------------------------------------------------------------
// Siblings
// ---------------------------------------------------------------------------

export type FakeIdentity = {
	readonly internal: IdentityInternal;
	readonly principals: Map<string, PrincipalRow>;
	user(handle: string, options?: { admin?: boolean }): string;
	agent(owner: string, handle: string): string;
	disable(id: string): void;
	setOwner(id: string | null): void;
};

export const createFakeIdentity = (ulid: () => string): FakeIdentity => {
	const principals = new Map<string, PrincipalRow>();
	let owner: string | null = null;
	const add = (row: PrincipalRow): string => {
		principals.set(row.id, row);
		return row.id;
	};
	const base = (id: string, handle: string): PrincipalRow => ({
		id,
		kind: "user",
		handle,
		display: handle,
		email: null,
		email_verified: 0,
		owner_user_id: null,
		agent_tool: null,
		agent_model: null,
		is_admin: 0,
		created_at: T0,
		disabled_at: null,
	});
	return {
		principals,
		internal: {
			principalSync: (id) => principals.get(id) ?? null,
			isOwner: (id) => owner !== null && id === owner,
		},
		user: (handle, options) =>
			add({
				...base(`u_${ulid()}`, handle),
				is_admin: options?.admin ? 1 : 0,
			}),
		agent: (ownerId, handle) =>
			add({
				...base(`a_${ulid()}`, handle),
				kind: "agent",
				owner_user_id: ownerId,
			}),
		disable: (id) => {
			const row = principals.get(id);
			if (row) principals.set(id, { ...row, disabled_at: T0 });
		},
		setOwner: (id) => {
			owner = id;
		},
	};
};

export type AppendEntry = Parameters<ForgeInternals["events"]["appendSync"]>[0];
export type AuditEntry = Parameters<ForgeInternals["events"]["auditSync"]>[0];

export const createFakeEvents = () => {
	const appends: AppendEntry[] = [];
	const audits: AuditEntry[] = [];
	return {
		appends,
		audits,
		internal: {
			appendSync: (entry: AppendEntry) => {
				appends.push(entry);
				return { id: `evt-${appends.length}`, seq: appends.length };
			},
			auditSync: (entry: AuditEntry) => {
				audits.push(entry);
			},
		},
		types: () => appends.map((e) => e.type),
	};
};

// ---------------------------------------------------------------------------
// RepoDO core fake (init, importComplete, upstream, K1 ledger)
// ---------------------------------------------------------------------------

export type FakeRepoCore = RepoSetupPort & GenesisCore;

export type FakeRepos = {
	core(repoId: string): FakeRepoCore;
	readonly inits: Parameters<RepoSetupPort["init"]>[0][];
	readonly completes: {
		repoId: string;
		by: string;
		defaultBranch?: string;
		source?: string;
	}[];
	readonly writes: (KernelWriteRow & { marks: string[] })[];
	/** The next call of `method` rejects with `error`. */
	failNext(method: "init" | "importComplete" | "upstream", error: Error): void;
};

export const createFakeRepos = (
	fake: () => FakeArtifacts,
	clock: Clock,
): FakeRepos => {
	const inits: FakeRepos["inits"] = [];
	const completes: FakeRepos["completes"] = [];
	const writes: FakeRepos["writes"] = [];
	const failures = new Map<string, Error>();
	const take = (method: string): void => {
		const error = failures.get(method);
		if (error) {
			failures.delete(method);
			throw error;
		}
	};
	const core = (repoId: string): FakeRepoCore => {
		const name = repoArtifactsName(repoId);
		return {
			init: (input) => {
				take("init");
				inits.push(input);
				return Promise.resolve();
			},
			importComplete: (by, input, source) =>
				Promise.resolve().then(() => {
					take("importComplete");
					completes.push({
						repoId,
						by,
						...(input.defaultBranch
							? { defaultBranch: input.defaultBranch }
							: {}),
						...(source !== undefined ? { source } : {}),
					});
					const refs = fake().inspect.refs(name);
					const branch = input.defaultBranch ?? "main";
					const tip = refs[`refs/heads/${branch}`];
					if (!tip) throw new Error(`the default branch ${branch} is missing`);
					return {
						repoId,
						defaultBranch: branch,
						trunkSha: tip,
						refs: Object.keys(refs).length,
						trunkCommits: 1,
					} satisfies ImportCompleteResponse;
				}),
			upstream: async (_target, scope) => {
				take("upstream");
				const repo = await fake().get(name);
				const token = await repo.createToken(scope, 600);
				return {
					artifactsName: name,
					remote: fake().remote(name),
					token: token.plaintext,
					expiresAt: clock.now() + 600_000,
					kind: "canonical",
					ref: "refs/heads/main",
				};
			},
			registerKernelWrite: (intent: KernelWriteIntent) => {
				const row: KernelWriteRow & { marks: string[] } = {
					id: `kw_${writes.length + 1}`,
					target: intent.target,
					ref: intent.ref,
					expect_old: intent.expectOld,
					new_sha: intent.newSha,
					purpose: intent.purpose,
					owner_kind: intent.ownerKind,
					owner_id: intent.ownerId,
					state: "intent",
					supersedes: null,
					created_at: clock.now(),
					updated_at: clock.now(),
					marks: [],
				};
				if (!isSha(intent.newSha) || intent.expectOld !== ZERO_SHA) {
					throw new Error("genesis writes zeros → sha");
				}
				writes.push(row);
				return Promise.resolve(row);
			},
			markKernelWrite: (id, state) => {
				writes.find((w) => w.id === id)?.marks.push(state);
				return Promise.resolve();
			},
		} as FakeRepoCore;
	};
	return {
		core,
		inits,
		completes,
		writes,
		failNext: (method, error) => {
			failures.set(method, error);
		},
	};
};

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

export type TreeHarnessOptions = {
	/** Replace the genesis writer (default: WP3's, through `fake.fetch`). */
	readonly genesis?: TreePorts["genesis"];
};

export const createTreeHarness = (options: TreeHarnessOptions = {}) => {
	const clock = createClock();
	const ulid = createUlid({ now: () => clock.now() });
	const storage = createTestStorage();
	const identity = createFakeIdentity(ulid);
	const events = createFakeEvents();
	const timers = new Map<string, number>();
	const logs: string[] = [];
	const waits: Promise<unknown>[] = [];
	let fakeRef: FakeArtifacts | null = null;
	const fake = createFakeArtifacts({
		now: () => clock.now(),
		fetch: publicMirror(() => fakeRef as FakeArtifacts),
	});
	fakeRef = fake;
	const repos = createFakeRepos(() => fake, clock);
	const genesis = options.genesis ?? createGenesis({
		core: (repoId) => repos.core(repoId),
		clock,
		fetch: (input, init) => fake.fetch(new Request(input, init)),
	});
	const ports: TreePorts = {
		artifacts: fake,
		repo: (repoId) => repos.core(repoId),
		genesis,
	};
	const module = createTreeModule({
		ports: () => ports,
		log: (message, data) => logs.push(`${message} ${JSON.stringify(data)}`),
	});
	runMigrations(
		storage,
		migrationSources([COMMON_MIGRATIONS.base], [module]),
		clock,
	);
	/** `registry.revalidateRepoConfigSync` calls (repository config, WP3 move/archive). */
	const revalidations: { by: string; scope: string }[] = [];
	const siblings = {
		identity: identity.internal,
		events: events.internal,
		registry: {
			revalidateRepoConfigSync: (by: string, scope: string) => {
				revalidations.push({ by, scope });
				return 0;
			},
		},
		slots: {},
	} as unknown as ForgeInternals;
	const deps: ModuleDeps<Env, ForgeInternals> = {
		sql: storage.sql,
		storage,
		ctx: {
			waitUntil: (p: Promise<unknown>) => waits.push(p),
		} as unknown as DurableObjectState,
		env: {} as Env,
		modules: siblings,
		timers: {
			schedule: (key, at) => {
				timers.set(key, at);
			},
			cancel: (key) => {
				timers.delete(key);
			},
			get: (key) => timers.get(key) ?? null,
		},
		clock,
		ids: { ulid },
	};
	const instance = module.create(deps);
	(siblings as unknown as Record<string, unknown>).tree = instance.internal;
	const facade = instance.facade as TreeKernelFacade;

	/** The forge Owner, signed up and set as `owner_principal`, with a user root. */
	const owner = async (handle = "owner") => {
		const id = identity.user(handle, { admin: true });
		identity.setOwner(id);
		const root = await facade.createRoot({
			kind: "user",
			slug: handle,
			owner: id,
		});
		return { id, root };
	};

	/** A group path below an existing node (each segment created as `by`). */
	const groups = async (by: string, root: string, path: string) => {
		let parent = (await facade.resolvePath(root))?.node;
		if (!parent) throw new Error(`no root ${root}`);
		for (const slug of path.split("/").filter(Boolean)) {
			parent = await facade.createNode(by, {
				parentId: parent.id,
				kind: "group",
				slug,
			});
		}
		return parent;
	};

	return {
		clock,
		ulid,
		storage,
		identity,
		events,
		timers,
		logs,
		waits,
		revalidations,
		fake,
		repos,
		ports,
		module,
		instance,
		facade,
		internal: instance.internal,
		onTimer: instance.onTimer as (key: string) => Promise<void>,
		owner,
		groups,
		kernel: SYS_KERNEL,
	};
};

export type TreeHarness = ReturnType<typeof createTreeHarness>;
