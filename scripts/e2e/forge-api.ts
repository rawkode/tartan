// The launcher's client for the dev-e2e forge's HTTP API (provisioning,
// janitor, teardown). A caller is a browser session (cookie, from the
// headless sign-in) or a token (Bearer). Mutations carry
// `Origin: <canonical>` (the same-origin rule, src/kernel/http/auth.ts).
//
// Errors carry the method, the path, the status and the API's error code and
// reason only: never a request header, a response body, or a minted token,
// so a failed `POST /-/api/tokens` cannot print the PAT it may have made.

import { COOKIE } from "@tartan/contract";
import type {
	AgentCreatedResponse,
	AgentsResponse,
	HealthResponse,
	InstallationsResponse,
	InviteCreated,
	MeResponse,
	NodeDto,
	NodeResolveResponse,
	NodesResponse,
	TokenDto,
} from "@tartan/contract/api.ts";
import { assertForgeOrigin } from "./guards.ts";
import type { FetchLike } from "./oidc-client.ts";

export type Caller =
	| { readonly kind: "session"; readonly cookie: string }
	| { readonly kind: "bearer"; readonly token: string };

export class ApiError extends Error {
	override name = "ApiError";
	constructor(
		readonly method: string,
		readonly path: string,
		readonly status: number,
		readonly code: string,
		readonly reason: string,
	) {
		super(
			`${method} ${path}: HTTP ${status}${code ? ` ${code}` : ""}${
				reason ? ` (${reason})` : ""
			}`,
		);
	}
}

const safe = (value: unknown): string =>
	typeof value === "string" && /^[A-Za-z0-9 ._:/-]{1,80}$/.test(value)
		? value
		: "";

export type CreatedPat = {
	readonly tokenId: string;
	readonly token: string;
	readonly expiresAt: number;
};

/** Pages of a node's children read before giving up (a page is 50 or more). */
export const CHILDREN_PAGES_MAX = 100;

export const createForgeApi = (fetchFn: FetchLike, origin: string) => {
	const forge = assertForgeOrigin(origin);

	const request = async <T>(
		method: string,
		path: string,
		options: {
			readonly caller?: Caller;
			readonly body?: unknown;
			readonly ok?: readonly number[];
		} = {},
	): Promise<{ status: number; body: T }> => {
		const headers = new Headers({ accept: "application/json" });
		if (options.caller?.kind === "session") {
			headers.set("cookie", `${COOKIE.session}=${options.caller.cookie}`);
		} else if (options.caller?.kind === "bearer") {
			headers.set("authorization", `Bearer ${options.caller.token}`);
		}
		if (method !== "GET" && method !== "HEAD") headers.set("origin", forge);
		if (options.body !== undefined) {
			headers.set("content-type", "application/json");
		}
		const response = await fetchFn(`${forge}${path}`, {
			method,
			headers,
			redirect: "manual",
			body: options.body === undefined
				? undefined
				: JSON.stringify(options.body),
		});
		const text = await response.text();
		let body: unknown = null;
		try {
			body = text === "" ? null : JSON.parse(text);
		} catch {
			body = null;
		}
		const ok = options.ok ?? [200, 201, 204];
		if (!ok.includes(response.status)) {
			const e = body as { error?: unknown; reason?: unknown } | null;
			throw new ApiError(
				method,
				path.split("?")[0],
				response.status,
				safe(e?.error),
				safe(e?.reason),
			);
		}
		return { status: response.status, body: body as T };
	};

	const q = (params: Record<string, string>) =>
		new URLSearchParams(params).toString();

	return {
		origin: forge,
		request,
		health: async () =>
			(await request<HealthResponse>("GET", "/-/health")).body,
		me: async (caller: Caller) =>
			(await request<MeResponse>("GET", "/-/api/me", { caller })).body,
		/** The node at `path`, or null when it does not exist (or is hidden). */
		resolve: async (caller: Caller, path: string): Promise<NodeDto | null> => {
			const r = await request<NodeResolveResponse>(
				"GET",
				`/-/api/nodes/resolve?${q({ path })}`,
				{ caller, ok: [200, 404] },
			);
			return r.status === 200 ? r.body.node : null;
		},
		/**
		 * Every child of `parent`, all pages: the API pages children, so the
		 * teardown and the janitor read every page.
		 */
		children: async (caller: Caller, parent: string) => {
			const out: NodesResponse["nodes"][number][] = [];
			let cursor: string | undefined;
			for (let page = 0; page < CHILDREN_PAGES_MAX; page++) {
				const body = (await request<NodesResponse>(
					"GET",
					`/-/api/nodes?${q({ parent, ...(cursor ? { cursor } : {}) })}`,
					{ caller },
				)).body;
				out.push(...body.nodes);
				cursor = body.cursor;
				if (cursor === undefined) return out;
			}
			throw new Error(
				`${parent} has more than ${CHILDREN_PAGES_MAX} pages of children`,
			);
		},
		createGroup: async (
			caller: Caller,
			input: { parent?: string; slug: string; visibility: string },
		) =>
			(await request<NodeDto>("POST", "/-/api/nodes", {
				caller,
				body: { ...input, kind: "group" },
			})).body,
		createRepo: async (
			caller: Caller,
			input: Record<string, unknown>,
		) =>
			(await request<NodeDto>("POST", "/-/api/nodes/repos", {
				caller,
				body: input,
			})).body,
		archive: async (caller: Caller, node: string) =>
			void await request("POST", "/-/api/nodes/archive", {
				caller,
				body: { node },
			}),
		installations: async (caller: Caller, node: string) =>
			(await request<InstallationsResponse>(
				"GET",
				`/-/api/installations?${q({ node })}`,
				{ caller },
			)).body,
		install: async (caller: Caller, input: Record<string, unknown>) =>
			void await request("POST", "/-/api/installations", {
				caller,
				body: input,
			}),
		/** The Owner's repo-overrides opt-in of one installation (WP23). */
		repoOverrides: async (caller: Caller, installation: string, on: boolean) =>
			void await request(
				"PUT",
				`/-/api/installations/${
					encodeURIComponent(installation)
				}/repo-overrides`,
				{ caller, body: { on } },
			),
		createInvite: async (
			caller: Caller,
			input: { node: string; role: 10 | 20 | 30 | 40; note?: string },
		) =>
			(await request<InviteCreated>("POST", "/-/api/invites", {
				caller,
				body: input,
			})).body,
		createPat: async (
			caller: Caller,
			input: {
				name: string;
				scopes: readonly string[];
				node: string;
				maxRole?: number;
				expiresInDays: number;
			},
		) =>
			(await request<CreatedPat>("POST", "/-/api/tokens", {
				caller,
				body: input,
			})).body,
		tokens: async (caller: Caller) =>
			(await request<{ tokens: TokenDto[] }>("GET", "/-/api/tokens", {
				caller,
			})).body.tokens,
		revokeToken: async (caller: Caller, id: string) =>
			void await request(
				"DELETE",
				`/-/api/tokens/${encodeURIComponent(id)}`,
				{ caller, ok: [204, 404] },
			),
		createAgent: async (caller: Caller, input: Record<string, unknown>) =>
			(await request<AgentCreatedResponse>("POST", "/-/api/agents", {
				caller,
				body: input,
			})).body,
		agents: async (caller: Caller) =>
			(await request<AgentsResponse>("GET", "/-/api/agents", { caller }))
				.body.agents,
		disableAgent: async (caller: Caller, id: string) =>
			void await request(
				"DELETE",
				`/-/api/agents/${encodeURIComponent(id)}`,
				{ caller, ok: [204, 404] },
			),
	};
};

export type ForgeApi = ReturnType<typeof createForgeApi>;
