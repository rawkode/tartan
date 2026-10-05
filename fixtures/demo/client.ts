// A small client for the forge's public API, MCP and smart HTTP, as the
// demo seed and reset use it (WP20). The caller's token (`TARTAN_TOKEN`: an
// Owner's PAT with the `api`, `admin` and `mcp` scopes) is sent as a bearer
// header only; it is never printed, logged or written anywhere. Errors carry
// the status and the API's error code, never a header.

export type ClientDeps = {
	readonly origin: string;
	readonly token: string;
	readonly fetch?: typeof fetch;
};

export class ForgeError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ForgeError";
	}
}

export type NodeRef = {
	readonly id: string;
	readonly path: string;
	readonly kind: "user" | "group" | "repo";
	readonly archived?: boolean;
};

const record = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null
		? value as Record<string, unknown>
		: {};

export const createForgeClient = (deps: ClientDeps) => {
	const origin = deps.origin.replace(/\/+$/, "");
	const doFetch = deps.fetch ?? fetch;

	const request = async <T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> => {
		const res = await doFetch(`${origin}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${deps.token}`,
				accept: "application/json",
				...(body !== undefined ? { "content-type": "application/json" } : {}),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			redirect: "manual",
		});
		const text = await res.text();
		let parsed: unknown = null;
		try {
			parsed = text === "" ? null : JSON.parse(text);
		} catch {
			parsed = text;
		}
		if (res.status >= 300) {
			const err = record(parsed);
			throw new ForgeError(
				res.status,
				typeof err["error"] === "string" ? err["error"] : `http_${res.status}`,
				`${method} ${path}: ${res.status} ${
					typeof err["message"] === "string" ? err["message"] : ""
				}`.trim(),
			);
		}
		return parsed as T;
	};

	const q = (value: string) => encodeURIComponent(value);

	return {
		origin,
		token: deps.token,
		fetch: doFetch,
		health: async () => {
			const res = await doFetch(`${origin}/-/health`);
			return await res.json() as { stage: string; setupState: string };
		},
		me: () =>
			request<{ principal?: { id: string; handle: string } }>(
				"GET",
				"/-/api/me",
			),
		resolve: async (path: string): Promise<NodeRef | null> => {
			try {
				const out = await request<{ node: NodeRef }>(
					"GET",
					`/-/api/nodes/resolve?path=${q(path)}`,
				);
				return out.node.path === path ? out.node : null;
			} catch (error) {
				if (error instanceof ForgeError && error.status === 404) return null;
				throw error;
			}
		},
		children: (parent: string) =>
			request<{ nodes: NodeRef[]; cursor?: string }>(
				"GET",
				`/-/api/nodes?parent=${q(parent)}`,
			),
		createGroup: (
			parent: string | undefined,
			slug: string,
			description: string,
		) =>
			request<NodeRef>("POST", "/-/api/nodes", {
				kind: "group",
				slug,
				description,
				...(parent ? { parent } : {}),
			}),
		createRepo: (
			parent: string,
			slug: string,
			description: string,
			source?: { url: string } | { mode: "push" },
		) =>
			request<NodeRef>("POST", "/-/api/nodes/repos", {
				parent,
				slug,
				description,
				...(source ? { import: source } : {}),
			}),
		importComplete: (repoId: string) =>
			request<unknown>("POST", `/-/api/repos/${q(repoId)}/import-complete`, {}),
		move: (node: string, parent: string, slug: string) =>
			request<NodeRef>("POST", "/-/api/nodes/move", { node, parent, slug }),
		archive: (node: string) =>
			request<unknown>("POST", "/-/api/nodes/archive", { node }),
		installed: async (node: string): Promise<string[]> => {
			const out = await request<{
				installations: { installation: { extId: string } }[];
			}>("GET", `/-/api/installations?node=${q(node)}`);
			return out.installations.map((i) => i.installation.extId);
		},
		install: (extId: string, node: string) =>
			request<unknown>("POST", "/-/api/installations", {
				extId,
				version: "0.1.0",
				node,
				mode: "enforce",
			}),
		agents: () =>
			request<{ agents: { id: string; handle: string; disabled: boolean }[] }>(
				"GET",
				"/-/api/agents",
			),
		createAgent: (input: {
			name: string;
			tool: string;
			model?: string;
			node: string;
			ttlDays?: number;
		}) =>
			request<{ agent: { id: string; handle: string }; token: string }>(
				"POST",
				"/-/api/agents",
				{ maxRole: 30, ttlDays: 1, ...input },
			),
		disableAgent: (id: string) =>
			request<unknown>("DELETE", `/-/api/agents/${q(id)}`),
		lanes: (repo: string) =>
			request<{ lanes: { id: string; state: string; owner: string }[] }>(
				"GET",
				`/-/api/lanes?repo=${q(repo)}&state=${
					q("opening,open,submitted")
				}&limit=200`,
			),
		closeLane: (repo: string, laneId: string) =>
			request<unknown>(
				"DELETE",
				`/-/api/lanes/${q(laneId)}?repo=${q(repo)}&reason=${q("demo reset")}`,
			),
		/** WP10's dev-only seeding: labelled Advances for the gate replay. */
		seedHistory: (repo: string, count: number) =>
			request<{
				repo: string;
				advances: number;
				head: string;
				withFakeKeys: number[];
			}>("POST", `/-/api/seed-history?repo=${q(repo)}`, { count }),
		startSwarm: (body: unknown, max?: number) =>
			request<{ id: string; agents: number; capped: boolean }>(
				"POST",
				`/-/api/swarm${max ? `?max=${max}` : ""}`,
				body,
			),
		swarms: () =>
			request<{ swarms: { id: string; state: string }[] }>(
				"GET",
				"/-/api/swarm",
			),
		stopSwarms: () => request<{ stopped: string[] }>("DELETE", "/-/api/swarm"),
	};
};

export type ForgeClient = ReturnType<typeof createForgeClient>;

/** Dev tools for scripts: refuse anything but a dev stage. */
export const assertDevStage = (stage: string): void => {
	if (!/^dev/.test(stage)) {
		throw new Error(
			`refusing to touch stage "${stage}": seed and reset run on dev stages only`,
		);
	}
};
