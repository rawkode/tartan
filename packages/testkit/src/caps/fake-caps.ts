// FakeKernelCaps: a KernelCaps for extension tests that enforces the same
// table the real host does (`CAPS_METHOD_POLICY` through `capsDenial`: grant,
// then shadow, then read-only), K12 confinement of every node, repo, source
// and stream argument to the installation subtree, the "repo required"
// rule for id-keyed calls of node-scoped installations, and the per-call
// checks on `land` refs, `events.read` patterns and `interfaces.call` ids.
// It records every call (allowed or denied) and answers from scripted
// responses; a method with no script and no default throws
// `not_implemented`, so a test states what it relies on.

import {
	CAPS_METHOD_POLICY,
	capsDenial,
	type CapsMethod,
	createUlid,
	denied,
	type DeniedReason,
	type GitSource,
	type InstallMode,
	invalid,
	isWithinPath,
	type KernelCaps,
	type ManifestPermissions,
	type NodeRef,
	notFound,
	notImplemented,
} from "@tartan/contract";

export type FakeCapsProps = {
	readonly inst: string;
	/** The installation's node; its subtree is the confinement boundary. */
	readonly node: { readonly id: string; readonly path: string };
	/** Repo id of a repo-scoped installation (default target of id-keyed calls). */
	readonly repo?: string;
	readonly grants: ManifestPermissions;
	readonly mode: InstallMode;
	readonly readOnly: boolean;
	/** Event types this installation may emit (K10); default: any. */
	readonly mayEmit?: (type: string) => boolean;
};

export type CapsResponder = (args: readonly unknown[]) => unknown;

export type CapsCall = {
	readonly method: CapsMethod;
	readonly args: readonly unknown[];
	/** Whether the policy table counts this call as an effect. */
	readonly effect: boolean;
	readonly denied?: DeniedReason | "invalid";
	readonly error?: string;
	readonly result?: unknown;
};

export type FakeKernelCapsOptions = {
	readonly props?: Partial<FakeCapsProps>;
	/** Known nodes, id → path (K12 for refs by id, GitSource and streams). */
	readonly nodes?: Readonly<Record<string, string>>;
	/** Scripted answers: a value, or a function of the call's arguments. */
	readonly responses?: Partial<Record<CapsMethod, unknown>>;
	/** Whether an interface tool mutates; unknown tools count as mutating. */
	readonly isMutatingTool?: (iface: string, tool: string) => boolean;
	readonly now?: () => number;
};

export type FakeKernelCaps = KernelCaps & {
	readonly calls: readonly CapsCall[];
	/** Allowed calls the policy counts as effects. */
	effects(): CapsCall[];
	denials(): CapsCall[];
	/** Calls of one method. */
	callsOf(method: CapsMethod): CapsCall[];
	/** Scripts (or re-scripts) a method's answer. */
	respond(method: CapsMethod, value: unknown): void;
	/** Timers set and not cleared, key → atMs. */
	readonly timersSet: ReadonlyMap<string, number>;
	/** A copy with other props (e.g. read-only for render, the viewer's bounds). */
	with(props: Partial<FakeCapsProps>): FakeKernelCaps;
};

const ROOT_ULID = "00000000000000000000000000";

export const DEFAULT_CAPS_PROPS: FakeCapsProps = {
	inst: `i_${ROOT_ULID}`,
	node: { id: ROOT_ULID, path: "/acme" },
	grants: { repo: "read" },
	mode: "enforce",
	readOnly: false,
};

/** `x.*` covers `x.y` and `x.*`; `*` covers everything; otherwise exact. */
export const eventPatternCovers = (granted: string, wanted: string): boolean =>
	granted === "*" || granted === wanted ||
	(granted.endsWith(".*") && wanted.startsWith(granted.slice(0, -1)));

/** Glob over a `land` grant: `*` matches any run of characters. */
export const refGlobMatches = (glob: string, ref: string): boolean =>
	new RegExp(
		`^${
			glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(
				".*",
			)
		}$`,
	).test(ref);

type Shared = {
	readonly calls: CapsCall[];
	readonly responses: Map<CapsMethod, unknown>;
	readonly timers: Map<string, number>;
	readonly ulid: () => string;
};

const build = (
	options: FakeKernelCapsOptions,
	props: FakeCapsProps,
	shared: Shared,
): FakeKernelCaps => {
	const nodes = options.nodes ?? {};
	const now = options.now ?? Date.now;
	const mutating = options.isMutatingTool ?? (() => true);

	const pathOfId = (id: string): string | undefined =>
		id === props.node.id ? props.node.path : nodes[id];

	const confineNode = (ref: NodeRef | undefined): void => {
		if (ref === undefined) return;
		const path = "path" in ref ? ref.path : pathOfId(ref.id);
		if (path === undefined || !isWithinPath(props.node.path, path)) {
			throw denied("scope", "target outside the installation subtree");
		}
	};
	const confineRepoId = (repoId: string): void => confineNode({ id: repoId });
	const confineSource = (s: GitSource | undefined): void => {
		if (s) confineRepoId(s.repoId);
	};
	/** Repo routing: id-keyed calls name their repo unless the installation is repo-scoped. */
	const repoTarget = (o: unknown): void => {
		const repo = (o as { repo?: NodeRef } | undefined)?.repo;
		if (repo) return confineNode(repo);
		if (props.repo === undefined) throw invalid("repo required");
	};

	/** Per-method argument checks after the policy gate. */
	const checks: Partial<Record<CapsMethod, (args: unknown[]) => void>> = {
		"repo.info": ([r]) => confineNode(r as NodeRef),
		"repo.resolveRef": ([r]) => confineNode(r as NodeRef),
		"repo.readFile": ([r]) => confineNode(r as NodeRef),
		"repo.readTree": ([r, , , s]) => {
			confineNode(r as NodeRef);
			confineSource(s as GitSource | undefined);
		},
		"repo.log": ([r]) => confineNode(r as NodeRef),
		"repo.diffPaths": ([s]) => confineSource(s as GitSource),
		"repo.hunks": ([s]) => confineSource(s as GitSource),
		"repo.merge3": ([inputs]) =>
			(inputs as { repoId: string }[]).forEach((i) => confineRepoId(i.repoId)),
		"repo.laneRange": ([, o]) => repoTarget(o),
		"repo.diff": ([a, b]) => {
			confineSource(a as GitSource);
			confineSource(b as GitSource);
		},
		"repo.projectGraph": ([r]) => confineNode(r as NodeRef),
		"repo.affected": ([r, , , s]) => {
			confineNode(r as NodeRef);
			confineSource(s as GitSource | undefined);
		},
		"repo.treeHash": ([r, , , s]) => {
			confineNode(r as NodeRef);
			confineSource(s as GitSource | undefined);
		},
		"repo.blame": ([r]) => confineNode(r as NodeRef),
		"repo.policy": ([r]) => confineNode(r as NodeRef),
		"lanes.open": ([o]) => confineNode((o as { repo: NodeRef }).repo),
		"lanes.adopt": ([o]) => confineNode((o as { repo: NodeRef }).repo),
		"lanes.list": ([f]) => confineNode((f as { repo: NodeRef }).repo),
		"lanes.get": ([, o]) => repoTarget(o),
		"lanes.close": ([, , o]) => repoTarget(o),
		"lanes.archive": ([, o]) => repoTarget(o),
		"lanes.delegate": ([, , o]) => repoTarget(o),
		"lanes.sync": ([, o]) => repoTarget(o),
		"lanes.restack": ([, , o]) => repoTarget(o),
		"land.submit": ([r]) => {
			const req = r as { repo: NodeRef; ref: string };
			confineNode(req.repo);
			if (!(props.grants.land ?? []).some((g) => refGlobMatches(g, req.ref))) {
				throw denied("grant", `land grant does not cover ${req.ref}`);
			}
		},
		"land.status": ([, o]) => repoTarget(o),
		"land.report": ([, , o]) => repoTarget(o),
		"runs.start": ([g]) => {
			const graph = g as { repo: NodeRef; source: GitSource };
			confineNode(graph.repo);
			confineSource(graph.source);
		},
		"runs.get": ([, o]) => repoTarget(o),
		"runs.cancel": ([, o]) => repoTarget(o),
		"runs.logs": ([, , o]) => repoTarget(o),
		"notes.contribute": ([r]) => confineNode(r as NodeRef),
		"events.emit": ([type, , o]) => {
			if (props.mayEmit && !props.mayEmit(type as string)) {
				throw denied("namespace", `may not emit ${type}`);
			}
			confineNode((o as { repo?: NodeRef } | undefined)?.repo);
		},
		"events.read": ([stream, , patterns]) => {
			if (typeof stream === "string" && stream.startsWith("repo:")) {
				confineRepoId(stream.slice(5));
			}
			const granted = props.grants["events.read"] ?? [];
			const uncovered = (patterns as string[]).filter((p) =>
				!granted.some((g) => eventPatternCovers(g, p))
			);
			if (uncovered.length > 0) {
				throw denied(
					"grant",
					`events.read does not cover ${uncovered.join(", ")}`,
				);
			}
		},
		"notify.send": ([, n]) => confineNode((n as { repo?: NodeRef }).repo),
		"authz.check": ([, node]) => confineNode(node as NodeRef),
		"principals.presence": ([r]) => confineNode(r as NodeRef),
		"interfaces.call": ([iface, , , at]) => {
			if (!(props.grants["interfaces.call"] ?? []).includes(iface as string)) {
				throw denied("grant", `interfaces.call does not cover ${iface}`);
			}
			confineNode(at as NodeRef | undefined);
		},
	};

	/** Answers used when a method is not scripted. */
	const defaults: Partial<Record<CapsMethod, CapsResponder>> = {
		"clock.now": () => now(),
		"ids.ulid": () => shared.ulid(),
		"events.emit": () => shared.ulid(),
		"timers.set": ([key, at]) => {
			shared.timers.set(key as string, at as number);
		},
		"timers.clear": ([key]) => {
			shared.timers.delete(key as string);
		},
		"notify.send": () => undefined,
		"notes.contribute": () => undefined,
		"principals.get": ([id]) => {
			throw notFound(`principal ${id}`);
		},
	};

	const invoke = async (
		method: CapsMethod,
		args: unknown[],
	): Promise<unknown> => {
		const isTool = method === "interfaces.call";
		const policy = CAPS_METHOD_POLICY[method];
		const effect = policy.effect === "tool"
			? mutating(String(args[0]), String(args[1]))
			: policy.effect;
		const denial = capsDenial(method, {
			grants: props.grants,
			mode: props.mode,
			readOnly: props.readOnly,
			mutatingTool: isTool ? effect : undefined,
		});
		const fail = (reason: DeniedReason | "invalid", error: Error) => {
			shared.calls.push({
				method,
				args,
				effect,
				denied: reason,
				error: error.message,
			});
			throw error;
		};
		if (denial) fail(denial, denied(denial, `${method}: ${denial}`));
		try {
			checks[method]?.(args);
		} catch (e) {
			const reason = (e as { reason?: string }).reason as
				| DeniedReason
				| undefined;
			fail(reason ?? "invalid", e as Error);
		}
		const scripted = shared.responses.has(method);
		const responder = scripted
			? shared.responses.get(method)
			: defaults[method];
		if (!scripted && responder === undefined) {
			const error = notImplemented(`FakeKernelCaps ${method} (script it)`);
			shared.calls.push({ method, args, effect, error: error.message });
			throw error;
		}
		try {
			const result = typeof responder === "function"
				? await (responder as CapsResponder)(args)
				: responder;
			shared.calls.push({ method, args, effect, result });
			return result;
		} catch (e) {
			shared.calls.push({ method, args, effect, error: (e as Error).message });
			throw e;
		}
	};

	const namespaces: Record<string, Record<string, unknown>> = {};
	for (const method of Object.keys(CAPS_METHOD_POLICY) as CapsMethod[]) {
		const [ns, name] = method.split(".");
		namespaces[ns] ??= {};
		namespaces[ns][name] = (...args: unknown[]) => invoke(method, args);
	}
	// `clock.now` and `ids.ulid` are synchronous in the contract.
	namespaces.clock.now = () => {
		shared.calls.push({ method: "clock.now", args: [], effect: false });
		return shared.responses.has("clock.now")
			? shared.responses.get("clock.now") as number
			: now();
	};
	namespaces.ids.ulid = () => {
		shared.calls.push({ method: "ids.ulid", args: [], effect: false });
		return shared.ulid();
	};

	return {
		...(namespaces as unknown as KernelCaps),
		calls: shared.calls,
		effects: () =>
			shared.calls.filter((c) => c.effect && !c.denied && !c.error),
		denials: () => shared.calls.filter((c) => c.denied !== undefined),
		callsOf: (method) => shared.calls.filter((c) => c.method === method),
		respond: (method, value) => {
			shared.responses.set(method, value);
		},
		timersSet: shared.timers,
		with: (next) => build(options, { ...props, ...next }, shared),
	};
};

export const createFakeKernelCaps = (
	options: FakeKernelCapsOptions = {},
): FakeKernelCaps => {
	const now = options.now ?? Date.now;
	return build(
		options,
		{ ...DEFAULT_CAPS_PROPS, ...options.props },
		{
			calls: [],
			responses: new Map(Object.entries(options.responses ?? {})) as Map<
				CapsMethod,
				unknown
			>,
			timers: new Map(),
			ulid: createUlid({ now }),
		},
	);
};
