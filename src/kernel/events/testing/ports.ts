// Test-only fakes of the WP6 HTTP ports (`../http.ts` `KernelPorts`) and a
// RouteContext builder, for `deno test` of the route handlers. Runtime code
// never imports this file.

import {
	denied,
	type EffectiveRole,
	type Envelope,
	type NodeDto,
	type Notice,
	type Permission,
	PERMISSION_MIN_ROLE,
	unauthenticated,
} from "@tartan/contract";
import type {
	AuthContext,
	ForgeEventsFacade,
	RepoEventsFacade,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../../env.ts";
import type { RouteContext } from "../../../router.ts";
import type { InboxApi } from "../../inbox/module.ts";
import type { KernelPorts } from "../http.ts";

export const CANONICAL = "https://forge.test";

export const repoNodeDto = (id: string): NodeDto => ({
	id,
	parentId: null,
	kind: "repo",
	slug: "shop",
	path: "acme/shop",
	depth: 1,
	visibility: "private",
	archived: false,
	createdAt: 0,
});

export const authOf = (
	principal: string,
	extra: Partial<AuthContext> = {},
): AuthContext => ({
	principal,
	kind: principal.startsWith("a_") ? "agent" : "user",
	via: "session",
	scopes: [],
	nodeId: null,
	laneId: null,
	maxRole: 50,
	isAdmin: false,
	...extra,
});

export type FakePortsState = {
	/** principal → role on every known repo. */
	roles: Map<string, EffectiveRole>;
	repos: Set<string>;
	handles: Map<string, string>;
	fetched: Request[];
	delivered: { principal: string; notice: unknown }[];
	events: Envelope[];
};

export const createFakePorts = (
	overrides: Partial<KernelPorts> = {},
): { ports: KernelPorts; state: FakePortsState } => {
	const state: FakePortsState = {
		roles: new Map(),
		repos: new Set(),
		handles: new Map(),
		fetched: [],
		delivered: [],
		events: [],
	};
	const repoEvents = (): RepoEventsFacade => ({
		append: () => Promise.reject(new Error("not used")),
		get: () => Promise.resolve([]),
		read: (q) =>
			Promise.resolve(
				state.events.filter((e) =>
					e.seq > q.since && (q.includeShadow || !e.shadow)
				).slice(0, q.limit ?? 100),
			),
		head: () => Promise.resolve(state.events.at(-1)?.seq ?? 0),
		verifyChain: () => Promise.resolve({ ok: true }),
		prune: () => Promise.resolve({ deleted: 0 }),
		refreshSubscribers: () => Promise.resolve(),
	});
	const forgeEvents = (): ForgeEventsFacade => ({
		read: () => Promise.resolve([]),
		readPage: () => Promise.resolve({ events: [], scannedTo: 0 }),
		head: () => Promise.resolve(0),
		appendKernel: () => Promise.reject(new Error("not used")),
		audit: () => Promise.resolve(),
		auditLog: (since) =>
			Promise.resolve([{
				seq: since + 1,
				at: 1,
				principal_id: "u_x",
				via_installation: null,
				action: "login",
				target: null,
				data_json: null,
			}]),
	});
	const inbox = (principal: string): InboxApi => {
		const notices: Notice[] = [];
		return {
			deliver: (notice) => {
				state.delivered.push({ principal, notice });
				return Promise.resolve({ id: "n1", created: true });
			},
			peek: () => Promise.resolve(notices),
			read: () => Promise.resolve(notices),
			ack: (ids) => Promise.resolve({ acked: ids.length }),
			wait: () => Promise.resolve(notices),
			unreadCount: () => Promise.resolve(0),
			touch: () => Promise.resolve(),
			presence: () => Promise.resolve(null),
		};
	};
	const ports: KernelPorts = {
		authorize: (auth, _node, perm: Permission) => {
			if (auth === null) return Promise.reject(unauthenticated());
			const role = state.roles.get(auth.principal) ?? 0;
			return role >= PERMISSION_MIN_ROLE[perm]
				? Promise.resolve(role)
				: Promise.reject(denied("role"));
		},
		node: (id) => Promise.resolve(state.repos.has(id) ? repoNodeDto(id) : null),
		canonicalOrigin: () => Promise.resolve(CANONICAL),
		roleOn: (principal) => Promise.resolve(state.roles.get(principal) ?? 0),
		principalByHandle: (handle) =>
			Promise.resolve(state.handles.get(handle) ?? null),
		repoEvents,
		repoFetch: (_repoId, req) => {
			state.fetched.push(req);
			return Promise.resolve(new Response("forwarded", { status: 200 }));
		},
		forgeEvents,
		inbox,
		...overrides,
	};
	return { ports, state };
};

export const routeContext = (
	method: string,
	path: string,
	options: {
		auth?: AuthContext | null;
		headers?: Record<string, string>;
		body?: unknown;
		rest?: string;
	} = {},
): RouteContext => {
	const url = new URL(path, CANONICAL);
	const req = new Request(url, {
		method,
		headers: {
			...(options.body !== undefined
				? { "content-type": "application/json" }
				: {}),
			...options.headers,
		},
		...(options.body !== undefined
			? { body: JSON.stringify(options.body) }
			: {}),
	});
	return {
		req,
		env: {} as Env,
		ctx: {} as ExecutionContext,
		url,
		params: options.rest !== undefined ? { rest: options.rest } : {},
		route: {
			id: "test",
			owner: "WP6",
			policy: {
				auth: "any",
				anonymous: false,
				csrf: true,
				setupExempt: false,
				host: "redirect",
			},
		},
		auth: options.auth ?? null,
	};
};

/** `code[:reason]` of a JSON error response. */
export const errorOf = async (res: Response): Promise<string> => {
	const body = await res.json() as { error: string; reason?: string };
	return `${res.status} ${body.error}${body.reason ? `:${body.reason}` : ""}`;
};
