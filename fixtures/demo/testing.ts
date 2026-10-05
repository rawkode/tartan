// A fake of the forge's REST API for the seed and reset tests (TEST-ONLY):
// the endpoints `client.ts` calls, over in-memory nodes, installations,
// agents and swarms, with every call recorded (method, path, and whether a
// bearer token was sent — never its value).

export type FakeNode = {
	id: string;
	path: string;
	kind: "user" | "group" | "repo";
	archived: boolean;
	import?: unknown;
	imported?: boolean;
};

/** The request bodies the fake reads (every field the client sends). */
type Body = {
	readonly parent?: string;
	readonly slug: string;
	readonly import?: unknown;
	readonly node: string;
	readonly extId: string;
	readonly name: string;
	readonly model?: string;
	readonly agents?: number;
};

export const createFakeRest = (stage = "dev-demo") => {
	let n = 0;
	const nodes = new Map<string, FakeNode>();
	const installs: { extId: string; node: string }[] = [];
	const agents: {
		id: string;
		handle: string;
		disabled: boolean;
		model?: string;
	}[] = [];
	const swarms: { id: string; state: string; body: unknown; max?: string }[] =
		[];
	const calls: { method: string; path: string; bearer: boolean }[] = [];
	/** `POST /-/api/seed-history` calls; `seedHistory: false` answers 404 (no dev tools). */
	const seeded: { repo: string; count: number }[] = [];
	const options = { seedHistory: true };
	const add = (
		path: string,
		kind: FakeNode["kind"],
		extra: Partial<FakeNode> = {},
	) => {
		n++;
		const node: FakeNode = {
			id: `01k6${String(n).padStart(22, "0")}`,
			path,
			kind,
			archived: false,
			...extra,
		};
		nodes.set(path, node);
		return node;
	};
	add("rawkode", "user");

	const json = (body: unknown, status = 200) =>
		new Response(body === null ? null : JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	const fail = (status: number, error: string) =>
		json({ error, message: error }, status);

	const handle = async (input: RequestInfo | URL, init?: RequestInit) => {
		const req = new Request(input, init);
		const url = new URL(req.url);
		const method = req.method;
		const path = url.pathname;
		calls.push({
			method,
			path: `${path}${url.search}`,
			bearer: (req.headers.get("authorization") ?? "").startsWith("Bearer "),
		});
		const body =
			(method === "GET" || method === "DELETE"
				? {}
				: await req.json().catch(() => ({}))) as Body;
		if (path === "/-/health") return json({ stage, setupState: "done" });
		if (path === "/-/api/nodes/resolve") {
			const node = nodes.get(url.searchParams.get("path") ?? "");
			return node ? json({ node }) : fail(404, "not_found");
		}
		if (path === "/-/api/nodes" && method === "POST") {
			const p = body.parent ? `${body.parent}/${body.slug}` : body.slug;
			if (nodes.has(p)) return fail(409, "conflict");
			return json(add(p, "group"), 201);
		}
		if (path === "/-/api/nodes/repos" && method === "POST") {
			const p = `${body.parent}/${body.slug}`;
			if (nodes.has(p)) return fail(409, "conflict");
			return json(
				add(p, "repo", body.import ? { import: body.import } : {}),
				201,
			);
		}
		const complete = /^\/-\/api\/repos\/([^/]+)\/import-complete$/.exec(path);
		if (complete) {
			const node = [...nodes.values()].find((x) => x.id === complete[1]);
			if (!node) return fail(404, "not_found");
			node.imported = true;
			return json({ repoId: node.id });
		}
		if (path === "/-/api/nodes/move" && method === "POST") {
			const from = body.node as string;
			const to = `${body.parent}/${body.slug}`;
			for (const [p, node] of [...nodes.entries()]) {
				if (p === from || p.startsWith(`${from}/`)) {
					nodes.delete(p);
					node.path = to + p.slice(from.length);
					nodes.set(node.path, node);
				}
			}
			return json(nodes.get(to));
		}
		if (path === "/-/api/nodes/archive" && method === "POST") {
			const node = nodes.get(body.node);
			if (!node) return fail(404, "not_found");
			node.archived = true;
			return json(null, 204);
		}
		if (path === "/-/api/installations") {
			if (method === "POST") {
				installs.push({ extId: body.extId, node: body.node });
				return json({}, 201);
			}
			const at = url.searchParams.get("node") ?? "";
			const inForce = installs.filter((i) =>
				at === i.node || at.startsWith(`${i.node}/`)
			);
			return json({
				installations: inForce.map((i) => ({
					installation: { extId: i.extId },
				})),
			});
		}
		if (path === "/-/api/agents") {
			if (method === "GET") return json({ agents });
			const agent = {
				id: `a_${agents.length + 1}`,
				handle: body.name,
				disabled: false,
				model: body.model,
			};
			agents.push(agent);
			return json({ agent, token: `tagt_secret_${body.name}` }, 201);
		}
		const agentId = /^\/-\/api\/agents\/([^/]+)$/.exec(path);
		if (agentId && method === "DELETE") {
			const agent = agents.find((a) => a.id === agentId[1]);
			if (agent) agent.disabled = true;
			return json(null, 204);
		}
		if (path === "/-/api/seed-history" && method === "POST") {
			if (!options.seedHistory) return fail(404, "not found");
			const repo = url.searchParams.get("repo") ?? "";
			const count = (body as unknown as { count: number }).count;
			seeded.push({ repo, count });
			return json({
				repo,
				advances: count,
				head: "b".repeat(40),
				withFakeKeys: [Math.round(count * 0.3), Math.round(count * 0.75)],
			}, 201);
		}
		if (path === "/-/api/swarm") {
			if (method === "POST") {
				const id = `swarm-${String(swarms.length + 1).padStart(26, "0")}`;
				swarms.push({
					id,
					state: "planning",
					body,
					...(url.searchParams.get("max")
						? { max: url.searchParams.get("max")! }
						: {}),
				});
				return json({ id, agents: body.agents, capped: false }, 202);
			}
			if (method === "DELETE") {
				for (const s of swarms) s.state = "stopping";
				return json({ stopped: swarms.map((s) => s.id) }, 202);
			}
			return json({ swarms });
		}
		return fail(404, "no fake for this endpoint");
	};

	return {
		fetch: handle as typeof fetch,
		nodes,
		installs,
		agents,
		swarms,
		calls,
		seeded,
		options,
	};
};
