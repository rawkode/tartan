// A tiny forge for the swarm's Deno tests (TEST-ONLY): one repo in
// `@tartan/testkit`'s FakeArtifacts (real git objects; receive-pack parses and
// stores the agents' packs), and the MCP tools a simulated agent calls
// (work_create, work_claim, repo_tree, repo_read, changes_submit, changes_get)
// answered from it. Pushes go through FakeArtifacts' own smart-HTTP
// receive-pack after the lane-ownership check the gateway makes.

import { createFakeArtifacts, type FileMap } from "@tartan/testkit";
import { pushRefs } from "@tartan/gitproto";
import { type SimPort, SimToolError } from "../agent.ts";

export type FakeForge = {
	readonly repo: string;
	readonly name: string;
	readonly trunk: string;
	portFor(agent: string): SimPort;
	refs(): Record<string, string>;
	/** Changes submitted, by change id. */
	readonly changes: Map<string, { lane: string; head: string; by: string }>;
	/** Every tool call, in order (`<agent> <tool>`). */
	readonly calls: string[];
	readTreeAt(commit: string, path: string): Promise<string[] | null>;
	readFileAt(commit: string, path: string): Promise<string | null>;
	/** Breaks `work_claim` for the next `n` calls (error-path tests). */
	failClaims(n: number): void;
};

let counter = 0;
const ulidish = (): string => {
	counter++;
	return `01k6${String(counter).padStart(22, "0")}`;
};

export const createFakeForge = async (
	files: FileMap,
	repo = "acme/sim/router-01",
): Promise<FakeForge> => {
	const fake = createFakeArtifacts({ namespace: "tartan-test" });
	const name = `r-${ulidish()}`;
	const seeded = await fake.seed(name, { files });
	const trunk = seeded.head!;
	const handle = await fake.get(name);
	const token = await handle.createToken("write", 3600);
	const remote = fake.remote(name);
	const laneOwner = new Map<string, string>();
	const items = new Map<string, string>();
	const claimedItems = new Set<string>();
	const changes = new Map<
		string,
		{ lane: string; head: string; by: string }
	>();
	const calls: string[] = [];
	let n = 0;
	let brokenClaims = 0;

	const refs = (): Record<string, string> => fake.inspect.refs(name);

	const walk = async (
		commit: string,
		path: string,
	): Promise<{ hash: string; type: string } | null> => {
		const meta = await handle.readCommit(commit);
		if (!meta) return null;
		let current = { hash: meta.treeHash, type: "tree" };
		for (const part of path.split("/").filter((p) => p !== "")) {
			if (current.type !== "tree") return null;
			const entries = await handle.readTree(current.hash);
			const next = entries?.find((e) => e.name === part);
			if (!next) return null;
			current = { hash: next.hash, type: next.type };
		}
		return current;
	};

	const treeAt = async (commit: string, path: string) => {
		const at = await walk(commit, path);
		if (!at || at.type !== "tree") return null;
		return await handle.readTree(at.hash);
	};

	const fileAt = async (commit: string, path: string) => {
		const at = await walk(commit, path);
		if (!at || at.type !== "blob") return null;
		const blob = await handle.readBlob(at.hash);
		return blob ? await blob.text() : null;
	};

	const tools = (agent: string) => ({
		work_create: (args: Record<string, unknown>) => {
			n++;
			const ref = `${repo}#${n}`;
			items.set(ref, String(args["title"]));
			return { ref, number: n, title: args["title"], state: "open" };
		},
		work_list: () => ({
			items: [...items.entries()].filter(([ref]) => !claimedItems.has(ref)).map(
				(
					[ref, title],
				) => ({ ref, title, state: "open" }),
			),
		}),
		work_claim: (args: Record<string, unknown>) => {
			if (brokenClaims > 0) {
				brokenClaims--;
				throw new SimToolError("work_claim", "unavailable: try again");
			}
			if (!items.has(String(args["ref"]))) {
				throw new SimToolError("work_claim", "not_found: no such item");
			}
			const id = `ln_${ulidish()}`;
			laneOwner.set(`refs/heads/lanes/${id}`, agent);
			claimedItems.add(String(args["ref"]));
			return {
				lane: {
					id,
					mode: "branch",
					state: "open",
					remote,
					ref: `refs/heads/lanes/${id}`,
					branch: `lanes/${id}`,
					base: refs()["refs/heads/main"],
				},
				overlaps: [],
			};
		},
		repo_tree: async (args: Record<string, unknown>) => {
			const entries = await treeAt(String(args["ref"]), String(args["path"]));
			if (entries === null) {
				throw new SimToolError("repo_tree", "not_found: no such path");
			}
			return {
				entries: entries.map((e) => ({ ...e, path: e.name })),
			};
		},
		repo_read: async (args: Record<string, unknown>) => {
			const text = await fileAt(String(args["ref"]), String(args["path"]));
			if (text === null) {
				throw new SimToolError("repo_read", "not_found: no such file");
			}
			return { text };
		},
		changes_submit: (args: Record<string, unknown>) => {
			const lane = String(args["laneId"]);
			const ref = `refs/heads/lanes/${lane}`;
			const head = refs()[ref];
			if (!head) throw new SimToolError("changes_submit", "empty-lane");
			if (laneOwner.get(ref) !== agent) {
				throw new SimToolError("changes_submit", "denied: not your lane");
			}
			const changeId = `${lane.slice(-26)}`.padEnd(32, "z");
			changes.set(changeId, { lane, head, by: agent });
			return { changeId, revision: 1 };
		},
		changes_get: (args: Record<string, unknown>) => {
			const change = changes.get(String(args["changeId"]));
			if (!change) throw new SimToolError("changes_get", "not_found");
			return { revisions: [{ n: 1, head: change.head }] };
		},
	});

	const portFor = (agent: string): SimPort => {
		const t = tools(agent) as Record<
			string,
			(a: Record<string, unknown>) => unknown
		>;
		return {
			tool: async (tool, args) => {
				calls.push(`${agent} ${tool}`);
				const fn = t[tool];
				if (!fn) throw new SimToolError(tool, "unknown tool");
				return await fn(args) as Record<string, unknown>;
			},
			push: async (url, commands, pack) => {
				calls.push(`${agent} push`);
				for (const c of commands) {
					if (laneOwner.get(c.ref) !== agent) {
						return commands.map((cmd) => ({
							ref: cmd.ref,
							ok: false,
							reason: "not-your-lane",
						}));
					}
				}
				return await pushRefs(
					{
						url,
						authorization: `Bearer ${token.plaintext}`,
						fetch:
							((input: RequestInfo | URL, init?: RequestInit) =>
								fake.fetch(new Request(input, init))) as typeof fetch,
					},
					commands,
					{ pack },
				);
			},
		};
	};

	return {
		repo,
		name,
		trunk,
		portFor,
		refs,
		changes,
		calls,
		readTreeAt: async (commit, path) =>
			(await treeAt(commit, path))?.map((e) => e.name) ?? null,
		readFileAt: fileAt,
		failClaims: (count) => {
			brokenClaims = count;
		},
	};
};
