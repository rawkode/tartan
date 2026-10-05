// The identity module under test (WP2), on any DO-shaped storage: node:sqlite
// in Deno, a real Durable Object's storage in workerd. Siblings are fakes
// that record what identity asks of them: WP6's `auditSync`/`appendSync`,
// WP3's tree internals and the `TreePort` writes (WP1's testkit fakes can
// replace these once they exist).

import { createUlid, type Role } from "@tartan/contract";
import type {
	ForgeInternals,
	NodeRow,
	TreeInternal,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../../env.ts";
import {
	COMMON_MIGRATIONS,
	migrationSources,
	runMigrations,
} from "../../../do/migrations.ts";
import type { TreePort } from "../context.ts";
import { createIdentityModule } from "../module.ts";
import type { FetchLike } from "../ssrf.ts";
import type { IdentityKernelFacade } from "../types.ts";

/** 2027-01-15T08:00:00Z: a fixed start for every test clock. */
export const T0 = 1_800_000_000_000;
export const TEST_SECRET = "test-root-secret-0123456789abcdef-wp02";

export type TestClock = {
	now(): number;
	advance(ms: number): void;
	set(ms: number): void;
};

export const createTestClock = (start = T0): TestClock => {
	let t = start;
	return {
		now: () => t,
		advance: (ms) => {
			t += ms;
		},
		set: (ms) => {
			t = ms;
		},
	};
};

/** Vars a deployment always has, plus a root secret (overridable, `undefined` removes one). */
export const testIdentityEnv = (over: Partial<Env> = {}): Env =>
	({
		TARTAN_STAGE: "test",
		TARTAN_FEATURES: "",
		TARTAN_DEV_TOOLS: "0",
		TARTAN_MAX_PUSH_MB: "95",
		TARTAN_JUDGE_MODEL: "",
		OIDC_ISSUER: "",
		OIDC_CLIENT_ID: "",
		TARTAN_SECRET: TEST_SECRET,
		...over,
	}) as Env;

export type AuditEntry = Parameters<ForgeInternals["events"]["auditSync"]>[0];
export type AppendEntry = Parameters<ForgeInternals["events"]["appendSync"]>[0];

export const createFakeEvents = () => {
	const audits: AuditEntry[] = [];
	const appends: AppendEntry[] = [];
	return {
		audits,
		appends,
		internal: {
			auditSync: (entry: AuditEntry) => {
				audits.push(entry);
			},
			appendSync: (entry: AppendEntry) => {
				appends.push(entry);
				return { id: `evt-${appends.length}`, seq: appends.length };
			},
		},
	};
};

export const createFakeTree = (ulid: () => string) => {
	const nodes = new Map<string, NodeRow>();
	const roles = new Map<string, Role>();
	const roots: { kind: "user"; slug: string; owner: string }[] = [];
	const grants: {
		by: string;
		nodeId: string;
		principal: string;
		role: Role;
	}[] = [];
	let failRoot: Error | null = null;

	const addNode = (path: string, kind: NodeRow["kind"] = "group"): NodeRow => {
		const parts = path.split("/");
		const parent = parts.length > 1
			? nodeByPath(parts.slice(0, -1).join("/"))
			: null;
		const row: NodeRow = {
			id: ulid(),
			parent_id: parent?.id ?? null,
			kind,
			slug: parts[parts.length - 1],
			path,
			depth: parts.length - 1,
			visibility: "private",
			artifacts_name: null,
			default_branch: null,
			description: null,
			created_by: "sys_kernel",
			created_at: T0,
			archived_at: null,
		};
		nodes.set(row.id, row);
		return row;
	};
	const nodeByPath = (path: string): NodeRow | null =>
		[...nodes.values()].find((n) => n.path === path) ?? null;
	const setRole = (principal: string, nodeId: string, role: Role) => {
		roles.set(`${principal}@${nodeId}`, role);
	};

	const internal: TreeInternal = {
		nodeSync: (id) => nodes.get(id) ?? null,
		nodeByPathSync: nodeByPath,
		ancestorPathsSync: (id) => {
			const n = nodes.get(id);
			if (!n) return [];
			const parts = n.path.split("/");
			return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
		},
		effectiveRoleSync: (principals, nodeId) => {
			const n = nodes.get(nodeId);
			if (!n) return 0;
			const prefixes = internal.ancestorPathsSync(nodeId);
			let best = 0;
			for (const prefix of prefixes) {
				const at = nodeByPath(prefix);
				for (const p of principals) {
					best = Math.max(best, at ? roles.get(`${p}@${at.id}`) ?? 0 : 0);
				}
			}
			return best as Role | 0;
		},
		isWithinSync: (rootId, nodeId) => {
			const root = nodes.get(rootId);
			const node = nodes.get(nodeId);
			return !!root && !!node &&
				(node.path === root.path || node.path.startsWith(`${root.path}/`));
		},
		// Contract additions of the wave-1 integration; the identity module
		// does not call them yet.
		holdsRoleWithinSync: (principal, rootId) =>
			[...nodes.values()].some((n) =>
				internal.isWithinSync(rootId, n.id) &&
				(roles.get(`${principal}@${n.id}`) ?? 0) > 0
			),
		createRootSync: (input) => {
			roots.push(input);
			return addNode(input.slug, "user");
		},
		grantSync: (by, nodeId, principal, role) => {
			grants.push({ by, nodeId, principal, role });
			setRole(principal, nodeId, role);
		},
	};

	const port: TreePort = {
		createRoot: (input) => {
			if (failRoot) return Promise.reject(failRoot);
			roots.push(input);
			return Promise.resolve({ id: addNode(input.slug, "user").id });
		},
		grant: (by, nodeId, principal, role) => {
			grants.push({ by, nodeId, principal, role });
			setRole(principal, nodeId, role);
			return Promise.resolve();
		},
	};

	return {
		internal,
		port,
		roots,
		grants,
		addNode,
		setRole,
		failRootWith: (error: Error | null) => {
			failRoot = error;
		},
	};
};

export type HarnessOptions = {
	readonly storage: DurableObjectStorage;
	readonly env?: Partial<Env>;
	readonly fetch?: FetchLike;
	readonly start?: number;
	/** Apply the common and identity migrations (Deno); a real ForgeDO already did. */
	readonly migrate?: boolean;
	readonly ctx?: DurableObjectState;
};

export const createIdentityHarness = (o: HarnessOptions) => {
	const clock = createTestClock(o.start);
	const ulid = createUlid({ now: () => clock.now() });
	const env = testIdentityEnv(o.env);
	const events = createFakeEvents();
	const tree = createFakeTree(ulid);
	const logs: string[] = [];
	const module = createIdentityModule({
		fetch: o.fetch ?? (() => Promise.reject(new Error("no network in tests"))),
		tree: () => tree.port,
		log: {
			warn: (message) => logs.push(message),
			error: (message, data) =>
				logs.push(`${message} ${JSON.stringify(data ?? {})}`),
		},
	});
	if (o.migrate) {
		runMigrations(
			o.storage,
			migrationSources([COMMON_MIGRATIONS.base, COMMON_MIGRATIONS.rateLimits], [
				module,
			]),
			clock,
		);
	}
	const siblings = {
		events: events.internal,
		tree: tree.internal,
		registry: {},
		slots: {},
	} as unknown as ForgeInternals;
	const instance = module.create({
		sql: o.storage.sql,
		storage: o.storage,
		ctx: o.ctx ?? ({} as DurableObjectState),
		env,
		modules: siblings,
		timers: { schedule: () => {}, cancel: () => {}, get: () => null },
		clock,
		ids: { ulid },
	});
	return {
		facade: instance.facade as IdentityKernelFacade,
		internal: instance.internal,
		clock,
		env,
		events,
		tree,
		logs,
		ulid,
		storage: o.storage,
	};
};

export type IdentityHarness = ReturnType<typeof createIdentityHarness>;

/** The claim code a harness logged (`[tartan] setup code: …`). */
export const loggedCode = (logs: readonly string[]): string => {
	const line = [...logs].reverse().find((l) =>
		l.startsWith("[tartan] setup code: ")
	);
	if (!line) throw new Error("no setup code was logged");
	return line.slice("[tartan] setup code: ".length).split(" ")[0];
};
