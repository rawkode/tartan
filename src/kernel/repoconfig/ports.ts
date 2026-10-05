// The seams the RepoDO `repoconfig` module calls (WP23): SHA reads of the
// canonical repo or a lane's repo (K15), ForgeDO's registry (schema, dry-run
// check, fenced apply, state), the `cue:*` sandboxes (`cueSubmit`, which
// returns at once) and the InboxDO of a preview's requester. Tests pass
// fakes of the same shape; `envRepoConfigPorts` binds them to the Worker.

import {
	type CueJobInput,
	type CueSubmitResult,
	FORGE_DO_NAME,
	inboxDoName,
	type NoticeInput,
	type RepoConfigApplyAnswer,
	type RepoConfigApplyInput,
	type RepoConfigCheckAnswer,
	type RepoConfigForgeState,
	type RepoConfigSchemaDto,
	ROLE,
} from "@tartan/contract";
import type { RegistryFacade, TreeFacade } from "@tartan/contract/kernel.ts";
import type { Env } from "../../env.ts";
import { withRpc } from "../../do/dispose.ts";
import { artifactsReads, type ConfigReads } from "./reader.ts";

export type RepoConfigReads = ConfigReads & {
	/** Releases the binding stub. */
	close(): void;
};

export type RepoConfigModulePorts = {
	/** SHA reads bound to one Artifacts repo by its name (the caller picks it, K15). */
	reads(artifactsName: string): Promise<RepoConfigReads>;
	/** `watch`: a trunk evaluation (ForgeDO pokes this repo after registry changes). */
	schema(
		repoId: string,
		options?: { readonly watch?: boolean },
	): Promise<RepoConfigSchemaDto>;
	check(repoId: string, resolved: unknown): Promise<RepoConfigCheckAnswer>;
	apply(
		repoId: string,
		input: RepoConfigApplyInput,
	): Promise<RepoConfigApplyAnswer>;
	forgeState(repoId: string): Promise<RepoConfigForgeState | null>;
	submit(sandbox: string, job: CueJobInput): Promise<CueSubmitResult>;
	notify(
		principal: string,
		notice: NoticeInput & { source: string; sourceLabel?: string },
	): Promise<void>;
	/** The people who are Owners at the repo (granted there or at an ancestor). */
	owners(repoId: string): Promise<string[]>;
	log(message: string, data: Record<string, unknown>): void;
};

/** Ancestor walks stop here (the hierarchy has no deeper repos in practice). */
const OWNER_WALK_MAX = 64;

const registry = (env: Env): RegistryFacade =>
	// Typed through the contract facade (the RPC stub types are too deep).
	env.FORGE.getByName(FORGE_DO_NAME).registry() as unknown as RegistryFacade;

export const envRepoConfigPorts = (env: Env): RepoConfigModulePorts => ({
	reads: async (name) => {
		const repo = await env.ARTIFACTS.get(name);
		const reads = artifactsReads(repo);
		return {
			...reads,
			close: () => {
				try {
					(repo as unknown as Partial<Disposable>)[Symbol.dispose]?.();
				} catch {
					// already released
				}
			},
		};
	},
	// Each call disposes its registry stub when it settles.
	schema: (repoId, options) =>
		withRpc(() => registry(env), (r) => r.repoConfigSchema(repoId, options)),
	check: (repoId, resolved) =>
		withRpc(() => registry(env), (r) => r.checkRepoConfig(repoId, resolved)),
	apply: (repoId, input) =>
		withRpc(() => registry(env), (r) => r.applyRepoConfig(repoId, input)),
	forgeState: (repoId) =>
		withRpc(() => registry(env), (r) => r.repoConfigState(repoId)),
	submit: async (sandbox, job) =>
		await env.SANDBOX.getByName(sandbox).cueSubmit(job),
	notify: async (principal, notice) => {
		await env.INBOX.getByName(inboxDoName(principal)).deliver(notice);
	},
	owners: async (repoId) => {
		const tree = () =>
			env.FORGE.getByName(FORGE_DO_NAME).tree() as unknown as Pick<
				TreeFacade,
				"node" | "grants"
			>;
		const at = Date.now();
		const out = new Set<string>();
		let id: string | null = repoId;
		for (let i = 0; i < OWNER_WALK_MAX && id !== null; i++) {
			const nodeId: string = id;
			const [node, grants] = await withRpc(
				tree,
				(t) => Promise.all([t.node(nodeId), t.grants(nodeId)]),
			);
			for (const g of grants) {
				if (
					g.role >= ROLE.owner && g.principal_id.startsWith("u_") &&
					(g.expires_at === null || g.expires_at > at)
				) {
					out.add(g.principal_id);
				}
			}
			id = node?.parentId ?? null;
		}
		return [...out].slice(0, 50);
	},
	log: (message, data) =>
		console.error(`[tartan] repoconfig: ${message}`, JSON.stringify(data)),
});
