// Server-side `ctx` re-derivation for `/-/api/slot/*` (K12). The client sends
// hints only (`ctx` query parameter or action body); the kernel resolves every
// target itself:
//
// - `node` / `repo` (a path or a node id) through the tree; `ctx.node` is
//   the repo when one is named, else the named node, else the installation's
//   own node;
// - **confinement and read first**: a node or repo that does not exist,
//   lies outside the installation's subtree (K12) or that the viewer cannot
//   read answers one and the same `not_found("ctx")`, before any entity, ref
//   or lane hint is resolved, so the anonymous render route reveals nothing
//   about private nodes, branches or lanes;
// - `ref` to a SHA through RepoDO's ref index (K15), never passed through;
// - a lane entity must be a lane of that repo (RepoDO); other entities are
//   extension-owned ids and pass after schema validation;
// - the slot's catalogue context (`SLOTS[slot].context`) decides which
//   fields the slot may receive and which it needs (a repo for `repo.*`,
//   `file.banner`, `lane.*` …), and `extra.route` is accepted only for
//   routed tabs: the hint shape (`SlotCtxHintSchema`) and the per-slot rule
//   (`slotCtxRefusal`) come from `@tartan/contract`, the same rule the SPA
//   narrows its hints with (`narrowSlotCtx`), and both stay strict;
// - the viewer's role at the derived node comes from WP3's `authorize`
//   (credential-bounded); it must reach Reporter and the slot's declared
//   `role`.

import {
	type Actor,
	denied,
	type EffectiveRole,
	type ExtScope,
	fromRpcError,
	type InstallationDto,
	invalid,
	isWithinPath,
	type NodeDto,
	notFound,
	ROLE,
	type SlotContext,
	type SlotContribution,
	SlotCtxHintSchema,
	slotCtxRefusal,
	type SlotId,
	SLOTS,
	ULID_RE,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import type { ApiDeps } from "./deps.ts";

export type DerivedSlot = {
	readonly ctx: SlotContext;
	readonly node: NodeDto;
	readonly scope: ExtScope;
	readonly role: EffectiveRole;
};

const resolveNode = async (
	deps: ApiDeps,
	hint: string,
): Promise<NodeDto> => {
	if (ULID_RE.test(hint)) {
		const node = await deps.tree().node(hint);
		if (node === null) throw notFound("node");
		return node;
	}
	const resolved = await deps.tree().resolvePath(hint);
	if (resolved === null || resolved.rest !== "" || resolved.redirectTo) {
		throw notFound("node");
	}
	return resolved.node;
};

export const actorOf = (auth: AuthContext): Actor => ({
	kind: auth.kind,
	id: auth.principal,
	...(auth.onBehalfOf ? { onBehalfOf: auth.onBehalfOf } : {}),
});

export const deriveSlotContext = async (
	deps: ApiDeps,
	input: {
		readonly installation: InstallationDto;
		readonly contribution: SlotContribution;
		readonly hints: unknown;
		readonly auth: AuthContext | null;
	},
): Promise<DerivedSlot> => {
	const { installation, contribution, auth } = input;
	// Client hints; unknown keys are refused (strict), every value re-derived.
	const parsed = SlotCtxHintSchema.safeParse(input.hints ?? {});
	if (!parsed.success) {
		throw invalid("invalid ctx", {
			issues: parsed.error.issues.map((i) =>
				`${i.path.join(".") || "(root)"}: ${i.message}`
			),
		});
	}
	const hints = parsed.data;
	const slot = contribution.slot as SlotId;
	const def = SLOTS[slot];
	const wants = (field: string): boolean =>
		(def.context as readonly string[]).includes(field);

	const home = await deps.tree().node(installation.nodeId);
	if (home === null) throw notFound("installation node");
	/** Every hidden case looks the same: missing, outside the subtree, unreadable. */
	const hidden = () => notFound("ctx");
	const visible = async (hint: string | undefined) => {
		if (hint === undefined) return undefined;
		const target = await resolveNode(deps, hint).catch((error) => {
			throw fromRpcError(error).code === "not_found" ? hidden() : error;
		});
		// K12 first: nothing outside the installation's subtree is touched further.
		if (!isWithinPath(home.path, target.path)) throw hidden();
		return target;
	};
	const repoNode = await visible(hints.repo);
	const namedNode = await visible(hints.node);
	// Before any hint is resolved further: the viewer must read every
	// named node (an unauthorized one is indistinguishable from a missing one).
	const named = [repoNode, namedNode].filter((n) => n !== undefined);
	for (const target of named.length > 0 ? named : [home]) {
		await deps.authorize(auth, { node: target }, "read").catch((error) => {
			const code = fromRpcError(error).code;
			throw code === "denied" || code === "unauthenticated" ? hidden() : error;
		});
	}
	if (repoNode !== undefined && repoNode.kind !== "repo") {
		throw invalid("ctx.repo is not a repo");
	}
	if (
		repoNode !== undefined && namedNode !== undefined &&
		namedNode.id !== repoNode.id
	) {
		throw invalid("ctx.node and ctx.repo disagree");
	}
	const node = repoNode ?? namedNode ?? home;
	const repo = node.kind === "repo" ? node : undefined;
	const needsRepo = wants("repo") || wants("lane") || wants("change") ||
		installation.storageScope === "repo";
	if (needsRepo && repo === undefined) {
		throw invalid(`slot ${slot} needs a repo`);
	}

	// The per-slot rule: an entity of a kind the slot names (and one when
	// it needs one); ref, path, route, lines, revision and gate only when the
	// slot's catalogue context or kind takes them.
	const refusal = slotCtxRefusal(slot, hints);
	if (refusal !== null) throw invalid(refusal);
	let laneId: string | undefined;
	if (hints.entity?.kind === "lane") {
		const lane = await deps.repo(repo!.id).getLane(hints.entity.id);
		if (lane === null || lane.repoId !== repo!.id) throw notFound("lane");
		laneId = lane.id;
	}

	let ref: string | undefined;
	if (hints.ref !== undefined) {
		if (repo === undefined) throw invalid(`slot ${slot} takes no ref`);
		const sha = await deps.repo(repo.id).resolveRef(hints.ref);
		if (sha === null) throw notFound("ref");
		ref = sha;
	}

	// The viewer must read the node (≥ Reporter) and meet the slot's role.
	const role = await deps.authorize(
		auth,
		{ node, ...(laneId ? { laneId } : {}) },
		"read",
	);
	const needed = Math.max(ROLE.reporter, contribution.role ?? 0);
	if (role < needed) throw denied("role", "the slot needs a higher role");

	const extra: Record<string, unknown> = {
		...(hints.route !== undefined ? { route: hints.route } : {}),
		...(hints.revision !== undefined ? { revision: hints.revision } : {}),
		...(hints.lines !== undefined ? { lines: hints.lines } : {}),
		...(hints.gate !== undefined ? { gate: hints.gate } : {}),
		...(hints.ref !== undefined ? { refName: hints.ref } : {}),
	};
	const ctx: SlotContext = {
		slot,
		node: node.id,
		...(repo ? { repo: repo.id } : {}),
		...(ref ? { ref } : {}),
		...(hints.path !== undefined ? { path: hints.path } : {}),
		...(hints.entity ? { entity: hints.entity } : {}),
		...(auth ? { viewer: actorOf(auth) } : {}),
		mode: installation.mode === "shadow" ? "shadow" : "enforce",
		...(Object.keys(extra).length > 0 ? { extra } : {}),
	};
	const scope: ExtScope = installation.storageScope === "repo"
		? { kind: "repo", repoId: repo!.id }
		: { kind: "node" };
	return { ctx, node, scope, role };
};
