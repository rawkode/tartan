// Extension fan-out logic (WP7b): `createExtDispatchWith(deps)` is the one
// implementation of installation lookup, per-call timeouts, defaults and
// aggregation behind `createExtDispatch(env)` (dispatch.ts, the production
// wiring). Pure over its deps, so the Deno tests run it on real hosts over
// in-memory storage.
//
// - `gates`: every gate in force at the node for the point, enforce and
//   shadow, in parallel, each with its manifest timeout; timeouts and errors
//   become outcomes and the manifest `default` (stricter with `onTruncated`
//   on truncated input); any enforce veto blocks, shadow never does (K8,
//   K9). The caller records `gate.decided`.
// - `echo`: the `push.accepted` echo hooks in force, with their declared
//   inputs prefetched from the lane range (awaiting phase 2, K17) inside the
//   total budget; an input that could not be prefetched is absent and the
//   input says `truncated: true`; lines come back sanitized and prefixed.
// - `context`: the `context_get` assembler: the protocol cards and the
//   lane's position first (kernel), then at most 8 `context@1` contributors
//   (300 ms each, `maxBytes` each, 16 KB together), ranked protocol >
//   negative > conflicts > ownership > hints, fenced as untrusted, cut to the
//   token budget.
// - `tools` / `resolveTool`: kernel tools, interface tools of providers in
//   force and extension-private tools (`<extshort>_<tool>`) at an MCP scope;
//   the listing is filtered by the caller's role there.

import {
	type Actor,
	type ActorBounds,
	type AddedLine,
	aggregateGates,
	byteLength,
	CONTEXT_LIMITS,
	type ContextPriority,
	type ContextRequest,
	type ContextSection,
	type DefinedInterfaceId,
	defuseFences,
	ECHO_LIMITS,
	effectiveGateDecision,
	type EffectiveRole,
	type Envelope,
	extensionToolName,
	type ExtScope,
	fromRpcError,
	type GateCall,
	type GateDecision,
	gateOnTruncated,
	type GitSource,
	INTERFACE_TOOLS,
	INTERFACES,
	KERNEL_TOOLS,
	type KernelToolName,
	type Lane,
	type LaneRange,
	type PathDiff,
	type PrefetchedInputs,
	type SlotContext,
	stripControl,
	truncateBytes,
} from "@tartan/contract";
import {
	actorBoundsOf,
	type AuthContext,
	type Clock,
	type ContextAssemblyRequest,
	type DispatchAt,
	type ExtDispatch,
	type ExtensionHostApi,
	type InstallationInForce,
	type ResolvedTool,
} from "@tartan/contract/kernel.ts";
import type { ContextPack } from "@tartan/contract/mcp.ts";
import { z } from "zod";
import type { PortNode } from "../../caps/ports.ts";
import { createActorRoles } from "../../caps/roles.ts";

/** Extra wall-clock a caller allows on top of a host budget for the RPC itself. */
export const DISPATCH_SLACK_MS = 200;

export type DispatchHost = Pick<ExtensionHostApi, "gate" | "echo" | "context">;

/** What the dispatcher reads (ForgeDO registry and tree, RepoDO, RepoProbe, ExtensionDOs). */
export type DispatchDeps = {
	readonly clock: Clock;
	inForce(nodeId: string): Promise<InstallationInForce[]>;
	provider(iface: string, nodeId: string): Promise<InstallationInForce | null>;
	protocolCards(
		nodeId: string,
	): Promise<{ installation: string; ext: string; md: string }[]>;
	host(installationId: string, scope: ExtScope): DispatchHost;
	lane(repoId: string, laneId: string): Promise<Lane | null>;
	laneRange(repoId: string, laneId: string): Promise<LaneRange>;
	addedLines(
		source: GitSource,
		base: string,
		head: string,
	): Promise<{ lines: AddedLine[]; truncated: boolean }>;
	diffPaths(source: GitSource, base: string, head: string): Promise<PathDiff>;
	node(id: string): Promise<PortNode | null>;
	effectiveRole(
		principals: readonly string[],
		nodeId: string,
	): Promise<EffectiveRole>;
};

type Raced<T> = { readonly ok: true; readonly value: T } | {
	readonly ok: false;
	readonly timedOut: boolean;
	readonly error?: unknown;
};

const within = async <T>(work: Promise<T>, ms: number): Promise<Raced<T>> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timed = new Promise<Raced<T>>((resolve) => {
		timer = setTimeout(
			() => resolve({ ok: false, timedOut: true }),
			Math.max(0, ms),
		);
	});
	return await Promise.race([
		work.then(
			(value): Raced<T> => ({ ok: true, value }),
			(error): Raced<T> => ({ ok: false, timedOut: false, error }),
		),
		timed,
	]).finally(() => clearTimeout(timer));
};

const active = (i: InstallationInForce): boolean =>
	i.installation.mode === "enforce" || i.installation.mode === "shadow";

/** The ExtensionDO scope serving an installation at a repo. */
export const scopeFor = (
	i: InstallationInForce,
	repoId: string | undefined,
): ExtScope | null =>
	i.installation.storageScope === "repo"
		? repoId === undefined ? null : { kind: "repo", repoId }
		: { kind: "node" };

const PRIORITY_RANK: Readonly<Record<ContextPriority | "kernel", number>> = {
	kernel: 0,
	protocol: 1,
	negative: 2,
	conflicts: 3,
	ownership: 4,
	hints: 5,
};

const isTimeout = (error: unknown): boolean =>
	fromRpcError(error).code === "timeout";

type PackSection = {
	readonly source: string;
	readonly id: string;
	readonly title: string;
	readonly priority: ContextPriority | "kernel";
	readonly md: string;
	readonly untrusted: boolean;
	readonly order: number;
};

/** Renders one section; untrusted text is fenced and cannot close its fence. */
const renderSection = (s: PackSection, md: string): string => {
	const title = stripControl(s.title).replace(/\n/g, " ").slice(0, 120);
	const body = s.untrusted
		? `\`\`\`untrusted (${stripControl(s.source).slice(0, 64)})\n${
			defuseFences(md)
		}\n\`\`\``
		: md;
	return `## ${title}\n\n${body}\n`;
};

/**
 * Assembles a context pack in budget order: each
 * section whole while it fits, else cut to the space left (marked
 * truncated), and nothing after the budget is spent.
 */
export const assembleContextPack = (
	sections: readonly PackSection[],
	budgetTokens: number,
): ContextPack => {
	const budget = budgetTokens * CONTEXT_LIMITS.bytesPerToken;
	const ordered = [...sections].sort((a, b) =>
		PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.order - b.order
	);
	let md = "";
	let used = 0;
	let truncated = false;
	const out: ContextPack["sections"][number][] = [];
	for (const s of ordered) {
		const full = renderSection(s, s.md);
		const size = byteLength(full);
		if (used + size <= budget) {
			md += full;
			used += size;
			out.push({
				source: s.source,
				id: s.id,
				priority: s.priority,
				bytes: byteLength(s.md),
				truncated: false,
			});
			continue;
		}
		truncated = true;
		const overhead = byteLength(renderSection(s, ""));
		const room = budget - used - overhead;
		if (room < 64) continue;
		const cut = truncateBytes(s.md, room);
		const text = renderSection(s, cut);
		md += text;
		used += byteLength(text);
		out.push({
			source: s.source,
			id: s.id,
			priority: s.priority,
			bytes: byteLength(cut),
			truncated: true,
		});
	}
	return { md, sections: out, budgetTokens, truncated };
};

const laneSection = (lane: Lane): string =>
	[
		`- lane: \`${lane.id}\` (${lane.mode}, ${lane.state}${
			lane.quarantined ? ", quarantined" : ""
		})`,
		`- branch: \`${lane.branch}\`; remote: \`${lane.remote}\``,
		`- base: \`${lane.base}\`${lane.head ? `; head: \`${lane.head}\`` : ""}`,
	].join("\n");

const inputSchemaOf = (input: string | Record<string, unknown>): unknown =>
	typeof input === "object" ? input : { type: "object" };

const JSON_SCHEMA_OPTIONS = {
	target: "draft-2020-12",
	io: "input",
	unrepresentable: "any",
} as const;

/** Tool input schemas are static: converted once per isolate. */
const jsonSchemas = new WeakMap<z.ZodType, unknown>();

const toJsonSchema = (schema: z.ZodType): unknown => {
	const cached = jsonSchemas.get(schema);
	if (cached !== undefined) return cached;
	const out = z.toJSONSchema(schema, JSON_SCHEMA_OPTIONS) as Record<
		string,
		unknown
	>;
	delete out.$schema;
	jsonSchemas.set(schema, out);
	return out;
};

/** The dispatcher over explicit deps (see the header). */
export const createExtDispatchWith = (deps: DispatchDeps): ExtDispatch => {
	const roleAt = async (auth: AuthContext, nodeId: string) => {
		const node = await deps.node(nodeId);
		if (node === null) return { node: null, role: 0 as EffectiveRole };
		const actor: Actor = {
			kind: auth.kind,
			id: auth.principal,
			...(auth.onBehalfOf ? { onBehalfOf: auth.onBehalfOf } : {}),
		};
		const role = await createActorRoles(
			deps,
			(ref) => "id" in ref ? deps.node(ref.id) : Promise.resolve(null),
			{ self: "", backgroundRole: 0, actor, bounds: actorBoundsOf(auth) },
		).roleAt(node);
		return { node, role };
	};

	const extensionTools = (inForce: readonly InstallationInForce[]) =>
		inForce.filter((i) => i.installation.mode === "enforce").flatMap((i) =>
			(i.manifest.contributes?.tools ?? []).map((contribution) => ({
				name: extensionToolName(i.manifest.id, contribution.name),
				contribution,
				installation: i,
			}))
		);

	const prefetch = async (
		event: Envelope,
		at: DispatchAt,
		specs: ReadonlySet<string>,
		deadline: number,
	): Promise<PrefetchedInputs> => {
		const data = (event.data ?? {}) as { target?: unknown; after?: unknown };
		const target = typeof data.target === "string" ? data.target : "repo";
		const after = typeof data.after === "string" ? data.after : "";
		const wantsDiff = specs.has("diff") || specs.has("changed-paths");
		const wantsLines = specs.has("added-lines");
		const wantsFiles = [...specs].some((s) => s.startsWith("file:"));
		if (!wantsDiff && !wantsLines && !wantsFiles) return { truncated: false };
		// Only lane pushes have a K17 range here; anything else is reported missing.
		if (target === "repo" || after === "") return { truncated: true };
		const source: GitSource = { repoId: at.repoId, laneId: target };
		const range = await within(
			deps.laneRange(at.repoId, target),
			deadline - deps.clock.now(),
		);
		if (!range.ok) return { truncated: true };
		let truncated = range.value.rangeTruncated || wantsFiles;
		const [paths, lines] = await Promise.all([
			wantsDiff
				? within(
					deps.diffPaths(source, range.value.rangeBase, after),
					deadline - deps.clock.now(),
				)
				: Promise.resolve(null),
			wantsLines
				? within(
					deps.addedLines(source, range.value.rangeBase, after),
					deadline - deps.clock.now(),
				)
				: Promise.resolve(null),
		]);
		const inputs: {
			-readonly [K in keyof PrefetchedInputs]: PrefetchedInputs[K];
		} = {
			truncated,
		};
		if (paths !== null) {
			if (paths.ok) {
				inputs.diff = paths.value;
				inputs.changedPaths = paths.value.paths.map((p) => p.path);
				truncated ||= paths.value.truncated;
			} else truncated = true;
		}
		if (lines !== null) {
			if (lines.ok) {
				inputs.addedLines = lines.value.lines;
				truncated ||= lines.value.truncated;
			} else truncated = true;
		}
		inputs.truncated = truncated;
		return inputs;
	};

	return {
		gates: async (point, input, at) => {
			const inForce = (await deps.inForce(at.nodeId)).filter(active);
			const targets = inForce.flatMap((i) =>
				(i.manifest.gates ?? []).filter((g) => g.point === point).map((g) => ({
					i,
					g,
				}))
			);
			const calls: GateCall[] = await Promise.all(
				targets.map(async ({ i, g }): Promise<GateCall> => {
					const mode = i.installation.mode === "shadow" ? "shadow" : "enforce";
					const base = {
						installation: i.installation.id,
						ext: i.manifest.id,
						mode,
						onTruncated: gateOnTruncated(g),
						default: g.default,
					} as const;
					const scope = scopeFor(i, at.repoId);
					if (scope === null) {
						return {
							...base,
							outcome: {
								kind: "error",
								message: "no repo for a repo-scoped gate",
							},
						};
					}
					const ctx: SlotContext = { node: at.nodeId, repo: at.repoId, mode };
					const raced = await within<GateDecision>(
						deps.host(i.installation.id, scope).gate(point, input, ctx),
						g.timeoutMs + DISPATCH_SLACK_MS,
					);
					if (raced.ok) {
						return {
							...base,
							outcome: { kind: "decision", decision: raced.value },
						};
					}
					if (raced.timedOut || isTimeout(raced.error)) {
						return { ...base, outcome: { kind: "timeout" } };
					}
					return {
						...base,
						outcome: {
							kind: "error",
							message: truncateBytes(fromRpcError(raced.error).text, 500),
						},
					};
				}),
			);
			const effective = calls.map((c) =>
				effectiveGateDecision(c, input.truncated)
			);
			return { calls, effective, blocked: aggregateGates(effective).blocked };
		},

		echo: async (event, at, budgetMs = ECHO_LIMITS.totalBudgetMs) => {
			const budget = Math.min(budgetMs, ECHO_LIMITS.totalBudgetMs);
			const deadline = deps.clock.now() + budget;
			const hooks = (await deps.inForce(at.nodeId))
				.filter((i) => i.installation.mode === "enforce")
				.filter((i) =>
					(i.manifest.echo ?? []).some((e) => e.event === event.type)
				);
			if (hooks.length === 0) return [];
			const specs = new Set(
				hooks.flatMap((i) => [
					...(i.manifest.echo?.[0]?.inputs ?? []),
					...(i.manifest.inputs ?? []),
				]),
			);
			const inputs = await prefetch(event, at, specs, deadline);
			const results = await Promise.all(hooks.map(async (i) => {
				const scope = scopeFor(i, at.repoId);
				if (scope === null) return [];
				const raced = await within(
					deps.host(i.installation.id, scope).echo(event, inputs),
					deadline - deps.clock.now(),
				);
				return raced.ok ? [...raced.value.lines] : [];
			}));
			return results.flat();
		},

		context: async (req: ContextAssemblyRequest, bounds: ActorBounds) => {
			const budgetTokens = req.budgetTokens ??
				CONTEXT_LIMITS.defaultBudgetTokens;
			const sections: PackSection[] = [];
			let order = 0;
			const [cards, inForce, lane] = await Promise.all([
				deps.protocolCards(req.repo.nodeId).catch(() => []),
				deps.inForce(req.repo.nodeId).catch(() => []),
				req.laneId === undefined
					? Promise.resolve(null)
					: deps.lane(req.repo.id, req.laneId).catch(() => null),
			]);
			if (cards.length > 0) {
				sections.push({
					source: "kernel",
					id: "protocol",
					title: "Protocol",
					priority: "kernel",
					md: truncateBytes(
						cards.map((c) => `### ${c.ext}\n\n${c.md.trim()}`).join("\n\n"),
						8 * 1024,
					),
					untrusted: false,
					order: order++,
				});
			}
			if (lane !== null) {
				sections.push({
					source: "kernel",
					id: "lane",
					title: "Where you are",
					priority: "kernel",
					md: laneSection(lane),
					untrusted: false,
					order: order++,
				});
			}
			const contributors = inForce
				.filter((i) => i.installation.mode === "enforce")
				.filter((i) => (i.manifest.contributes?.context ?? []).length > 0)
				.sort((a, b) => b.depth - a.depth)
				.slice(0, CONTEXT_LIMITS.maxContributors);
			const answers = await Promise.all(contributors.map(async (i) => {
				const scope = scopeFor(i, req.repo.id);
				if (scope === null) return [];
				const maxBytes = Math.max(
					...(i.manifest.contributes?.context ?? []).map((c) => c.maxBytes),
				);
				const request: ContextRequest = {
					repo: req.repo.path,
					repoId: req.repo.id,
					...(req.work !== undefined ? { work: req.work } : {}),
					...(req.laneId !== undefined ? { laneId: req.laneId } : {}),
					...(req.paths !== undefined ? { paths: [...req.paths] } : {}),
					maxBytes,
					actor: req.actor,
				} as ContextRequest;
				const raced = await within<ContextSection[]>(
					deps.host(i.installation.id, scope).context(request, bounds),
					CONTEXT_LIMITS.timeoutMs + DISPATCH_SLACK_MS,
				);
				return raced.ok
					? raced.value.map((s) => ({ installation: i, section: s }))
					: [];
			}));
			let extensionBytes = 0;
			for (const { installation, section } of answers.flat()) {
				const room = CONTEXT_LIMITS.totalBytes - extensionBytes;
				if (room <= 0) break;
				const md = truncateBytes(section.md, room);
				extensionBytes += byteLength(md);
				sections.push({
					source: installation.installation.id,
					id: section.id,
					title: section.title ?? `${installation.manifest.id}: ${section.id}`,
					priority: section.priority,
					md,
					untrusted: true,
					order: order++,
				});
			}
			return assembleContextPack(sections, budgetTokens);
		},

		tools: async (scopeNodeId, auth) => {
			const { node, role } = await roleAt(auth, scopeNodeId);
			if (node === null) return [];
			const listed: {
				name: string;
				description: string;
				inputSchema: unknown;
			}[] = [];
			for (const name of Object.keys(KERNEL_TOOLS) as KernelToolName[]) {
				const def = KERNEL_TOOLS[name];
				if (def.milestone !== "M1" || def.role > role) continue;
				listed.push({
					name,
					description: def.description,
					inputSchema: toJsonSchema(def.input),
				});
			}
			const providers = await Promise.all(
				(Object.keys(INTERFACES) as DefinedInterfaceId[])
					.filter((id) => Object.keys(INTERFACES[id].tools).length > 0)
					.map(async (id) => ({
						id,
						provider: await deps.provider(id, scopeNodeId),
					})),
			);
			for (const { id, provider } of providers) {
				if (provider === null) continue;
				for (const [name, def] of Object.entries(INTERFACES[id].tools)) {
					if (def.role > role) continue;
					listed.push({
						name,
						description: def.description,
						inputSchema: toJsonSchema(def.input),
					});
				}
			}
			for (const tool of extensionTools(await deps.inForce(scopeNodeId))) {
				if (tool.contribution.role > role) continue;
				listed.push({
					name: tool.name,
					description: tool.contribution.description,
					inputSchema: inputSchemaOf(tool.contribution.input),
				});
			}
			return listed;
		},

		resolveTool: async (
			scopeNodeId,
			name,
			_auth,
		): Promise<ResolvedTool | null> => {
			if (Object.hasOwn(KERNEL_TOOLS, name)) {
				return { kind: "kernel", name: name as KernelToolName };
			}
			const iface = INTERFACE_TOOLS[name];
			if (iface !== undefined) {
				const provider = await deps.provider(iface.iface, scopeNodeId);
				return provider === null
					? null
					: { kind: "interface", iface: iface.iface, def: iface.def, provider };
			}
			const found = extensionTools(await deps.inForce(scopeNodeId)).find((t) =>
				t.name === name
			);
			return found === undefined ? null : {
				kind: "extension",
				contribution: found.contribution,
				installation: found.installation,
			};
		},
	};
};
