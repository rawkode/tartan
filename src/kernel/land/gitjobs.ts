// Kernel git jobs (WP10; contract `KernelGitJobs`). Every job registers its
// `kernel_writes` intent through `RepoCoreFacade` before it writes and marks it
// after, and is idempotent: a job that finds the remote already at its target
// returns success.
//
// - `genesis`: the first commit of a created repo, written in the Worker
//   with the pack writer of `packages/gitproto` (no container), purpose
//   `genesis` (WP5a's ledger records it as `trunk_commits` seq 0).
// - `refWrite`: ref-only writes in the Worker through gitproto's
//   receive-pack client (commands plus an empty pack; the old SHA is the
//   compare-and-swap): `change-ref` for `branch` lanes, `attic`, `lane-gc`,
//   `purge` of a ref, candidate deletion.
// - `archive`: advisory `ref.advance` gates first, then the attic ref
//   (`branch` backend); a veto keeps the summary only.
// - `repair`: the K5 sweeper's job for an advance whose trunk push landed
//   but whose notes or change refs did not (fresh intents for each push); a
//   `repo` lane's change ref is pushed with its objects, re-fetched by SHA
//   from the lane repo into a cold mirror first.
// - `sync` and `restack`: server-side rebases (`rebase.ts`) of a lane onto
//   trunk or onto another lane's head, objects fetched by SHA from where each
//   lives, pushed with a lease into the lane's own storage only (its lane
//   repo, or its branch ref), purpose `lane-sync` with target = the lane.

import {
	type AddedLine,
	changeRef,
	conflict,
	type EffectiveGateDecision,
	fromRpcError,
	gitSandboxName,
	invalid,
	isIdOf,
	isSha,
	isUlid,
	isValidRefName,
	KERNEL_WRITE_PURPOSES,
	type KernelWritePurpose,
	NOTES_REF,
	notFound,
	parseAdvanceId,
	repoDoName,
	type SyncResult,
	trunkRef,
	ulidTime,
	unavailable,
	ZERO_SHA,
} from "@tartan/contract";
import type {
	CreateKernelGitJobs,
	ExtDispatch,
	GenesisInput,
	KernelGitJobs,
	KernelWriteIntent,
	RepoCoreFacade,
	RepoProbeApi,
	RepoStore,
} from "@tartan/contract/kernel.ts";
import {
	encodeCommit,
	encodeTree,
	hashObject,
	writePack,
} from "@tartan/gitproto";
import type { Env } from "../../env.ts";
import { loopback } from "../../exports.ts";
import { createExtDispatch } from "../exthost/host/dispatch.ts";
import { createLandGit, type GitRunner } from "./git.ts";
import { createLaneRepoAccess, withLaneRepoCred } from "./lanerepos.ts";
import { rebaseOnto } from "./rebase.ts";
import { encodeNote } from "./notes.ts";
import { pushNotes } from "./notesflow.ts";
import type { LandFacade } from "./types.ts";
import { createCanonicalAccess } from "./upstream.ts";

/** Purposes `refWrite` performs (ref-only writes). */
export const REF_ONLY_PURPOSES: readonly KernelWritePurpose[] = [
	"change-ref",
	"attic",
	"lane-gc",
	"purge",
	"candidate",
];

/** Kernel identity of commits the kernel writes. */
export const KERNEL_GIT_IDENTITY = {
	name: "Tartan",
	email: "tartan@kernel.invalid",
} as const;

export type GitJobsDeps = {
	readonly artifacts: RepoStore;
	/** RepoDO core of a repo (the intent ledger, lanes, the index). */
	core(repoId: string): Pick<
		RepoCoreFacade,
		| "registerKernelWrite"
		| "markKernelWrite"
		| "getLane"
		| "refs"
		| "laneFetchSpecs"
		| "info"
	>;
	/** RepoDO land of a repo (status, batch, why notes). */
	land(repoId: string): Pick<LandFacade, "status" | "batch" | "whyNote">;
	/** `git:<repoId>` (TartanSandbox.gitExec). */
	exec(repoId: string): GitRunner;
	/** The fetch gitproto uses (tests route it to a fake). */
	readonly fetch?: typeof fetch;
	/** WP7b's dispatcher (archive's advisory gates). */
	readonly gates: Pick<ExtDispatch, "gates">;
	/** WP8's RepoProbe (archive's gate inputs). */
	probe(): Pick<RepoProbeApi, "addedLines" | "diffPaths">;
	readonly mirrorRoot?: string;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly log?: (message: string, data: Record<string, unknown>) => void;
};

/** A ref-only write's transient failures are retried this many times. */
export const REF_WRITE_RETRIES = 3;
export const REF_WRITE_BACKOFF_MS = 500;

const validateIntent = (intent: KernelWriteIntent): void => {
	if (!KERNEL_WRITE_PURPOSES.includes(intent.purpose)) {
		throw invalid(`unknown purpose: ${intent.purpose}`);
	}
	if (!REF_ONLY_PURPOSES.includes(intent.purpose)) {
		throw invalid(`${intent.purpose} is not a ref-only write`);
	}
	if (intent.target !== "repo" && !isIdOf("lane", intent.target)) {
		throw invalid(`invalid target: ${intent.target}`);
	}
	if (!isValidRefName(intent.ref)) throw invalid(`invalid ref: ${intent.ref}`);
	if (!isSha(intent.expectOld) || !isSha(intent.newSha)) {
		throw invalid("expectOld and newSha must be shas");
	}
	if (intent.expectOld === ZERO_SHA && intent.newSha === ZERO_SHA) {
		throw invalid(`${intent.ref}: both ids are zero`);
	}
};

const EMPTY_TREE = encodeTree([]);

export const createKernelGitJobsWith = (deps: GitJobsDeps): KernelGitJobs => {
	const log = deps.log ??
		((message: string, data: Record<string, unknown>) =>
			console.error(`[tartan] land.gitjobs: ${message}`, JSON.stringify(data)));
	const accesses = new Map<string, ReturnType<typeof createCanonicalAccess>>();
	const access = (repoId: string) => {
		const known = accesses.get(repoId);
		if (known !== undefined) return known;
		const created = createCanonicalAccess({
			artifacts: deps.artifacts,
			repoId,
			...(deps.fetch ? { fetch: deps.fetch } : {}),
		});
		accesses.set(repoId, created);
		return created;
	};
	const sleep = deps.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	// -----------------------------------------------------------------------
	// refWrite
	// -----------------------------------------------------------------------

	const refWrite: KernelGitJobs["refWrite"] = async (repoId, intents) => {
		if (intents.length === 0) return [];
		if (intents.length > 32) throw invalid("at most 32 ref writes per call");
		for (const intent of intents) validateIntent(intent);
		if (new Set(intents.map((i) => i.ref)).size !== intents.length) {
			throw invalid("a ref is written twice in one call");
		}
		const core = deps.core(repoId);
		// Every intent exists before the write.
		const rows = [];
		for (const intent of intents) {
			rows.push(await core.registerKernelWrite(intent));
		}
		const upstream = access(repoId);
		const commands = intents.map((i) => ({
			ref: i.ref,
			old: i.expectOld,
			new: i.newSha,
		}));
		// A transient failure (a refused or failed request, a 5xx, no report)
		// is retried; the compare-and-swap keeps a retry from writing twice.
		let statuses: Awaited<ReturnType<typeof upstream.pushRefs>> | null = null;
		for (let attempt = 0; statuses === null; attempt++) {
			try {
				statuses = await upstream.pushRefs(commands);
			} catch (error) {
				log("refWrite: push failed", {
					repoId,
					attempt,
					error: fromRpcError(error).message,
				});
				if (attempt >= REF_WRITE_RETRIES) throw error;
				await sleep(REF_WRITE_BACKOFF_MS * 2 ** attempt);
			}
		}
		const results = [];
		for (const [index, intent] of intents.entries()) {
			const status = statuses[index];
			const reason = status === undefined
				? "no status"
				: status.ok
				? ""
				: status.reason;
			let ok = status?.ok === true;
			if (!ok) {
				// A lost response or a non-CAS refusal: the write may still have
				// landed (a retry then reads as stale). The remote decides.
				const current = await upstream.refValue(intent.ref).catch(() => null);
				ok = (current ?? ZERO_SHA) === intent.newSha;
				if (!ok) {
					log("refWrite: refused", {
						repoId,
						ref: intent.ref,
						purpose: intent.purpose,
						reason,
					});
				}
			}
			await core.markKernelWrite(rows[index].id, ok ? "pushed" : "abandoned");
			results.push({ ref: intent.ref, ok, ...(ok ? {} : { reason }) });
		}
		return results;
	};

	// -----------------------------------------------------------------------
	// genesis
	// -----------------------------------------------------------------------

	const genesisObjects = async (repoId: string, input: GenesisInput) => {
		const at = Math.floor(ulidTime(repoId) / 1000);
		const message = `${input.message.replace(/\r/g, "").trim()}\n`;
		const commit = encodeCommit({
			tree: await hashObject("tree", EMPTY_TREE),
			author: { name: input.author.name, email: input.author.email, at },
			committer: {
				name: KERNEL_GIT_IDENTITY.name,
				email: KERNEL_GIT_IDENTITY.email,
				at,
			},
			message,
		});
		const { pack, ids } = await writePack([
			{ type: "tree", data: EMPTY_TREE },
			{ type: "commit", data: commit },
		]);
		return { pack, commit: ids[1] };
	};

	const genesis: KernelGitJobs["genesis"] = async (repoId, input) => {
		if (!isValidRefName(trunkRef(input.defaultBranch))) {
			throw invalid(`invalid default branch: ${input.defaultBranch}`);
		}
		if (input.message.trim().length === 0) throw invalid("message is empty");
		const ref = trunkRef(input.defaultBranch);
		const { pack, commit } = await genesisObjects(repoId, input);
		const core = deps.core(repoId);
		const indexed = (await core.refs()).find((r) => r.ref === ref);
		if (indexed !== undefined) {
			if (indexed.sha === commit) return { commit };
			throw conflict(`${ref} already exists in the index`);
		}
		const upstream = access(repoId);
		const remote = await upstream.refValue(ref);
		if (remote !== null && remote !== commit) {
			throw conflict(`${ref} already exists upstream`);
		}
		const row = await core.registerKernelWrite({
			target: "repo",
			ref,
			expectOld: ZERO_SHA,
			newSha: commit,
			purpose: "genesis",
			ownerKind: "kernel",
			ownerId: `genesis:${repoId}`,
		});
		if (remote === null) {
			const [status] = await upstream.pushRefs(
				[{ ref, old: ZERO_SHA, new: commit }],
				{ pack },
			);
			if (status?.ok !== true) {
				const after = await upstream.refValue(ref);
				if (after !== commit) {
					await core.markKernelWrite(row.id, "abandoned");
					throw conflict(
						`genesis push refused: ${status?.reason ?? "no status"}`,
					);
				}
			}
		}
		await core.markKernelWrite(row.id, "pushed");
		return { commit };
	};

	// -----------------------------------------------------------------------
	// archive (advisory gates first)
	// -----------------------------------------------------------------------

	const advisoryVeto = async (
		repoId: string,
		nodeId: string,
		lane: { id: string; ref: string; base: string; head?: string },
	): Promise<boolean> => {
		if (lane.head === undefined || lane.head === lane.base) return false;
		const source = { repoId, laneId: lane.id };
		let lines: { lines: AddedLine[]; truncated: boolean };
		let paths: string[];
		try {
			const [added, diff] = await Promise.all([
				deps.probe().addedLines(source, lane.base, lane.head),
				deps.probe().diffPaths(source, lane.base, lane.head),
			]);
			lines = {
				lines: added.lines,
				truncated: added.truncated || diff.truncated,
			};
			paths = diff.paths.map((p) => p.path);
		} catch (error) {
			log("archive: gate inputs unavailable", { error: String(error) });
			lines = { lines: [], truncated: true };
			paths = [];
		}
		try {
			const result = await deps.gates.gates("ref.advance", {
				point: "ref.advance",
				repo: repoId,
				ref: lane.ref,
				base: lane.base,
				head: lane.head,
				changeId: "",
				changedPaths: paths,
				addedLines: lines.lines,
				truncated: lines.truncated,
				workRefs: [],
				actor: { kind: "system", id: "sys_kernel" },
				advisory: true,
			}, { nodeId, repoId });
			return result.effective.some((e: EffectiveGateDecision) =>
				e.mode === "enforce" && e.decision === "veto"
			);
		} catch (error) {
			if (fromRpcError(error).code === "not_implemented") return false;
			throw unavailable("archive: the ref.advance gates did not answer");
		}
	};

	const archive: KernelGitJobs["archive"] = async (repoId, laneId, options) => {
		const core = deps.core(repoId);
		const lane = await core.getLane(laneId);
		if (lane === null) throw notFound(`unknown lane: ${laneId}`);
		const vetoed = options.gateFirst
			? await advisoryVeto(repoId, repoId, lane)
			: false;
		if (lane.mode === "repo") return { kind: "summary", vetoed };
		if (vetoed || options.atticRef === undefined || lane.head === undefined) {
			return { kind: "summary", vetoed };
		}
		const head = lane.head;
		const upstream = access(repoId);
		const current = await upstream.refValue(options.atticRef);
		if (current === head) {
			return { kind: "ref", ref: options.atticRef, head, vetoed: false };
		}
		const [result] = await refWrite(repoId, [{
			target: laneId,
			ref: options.atticRef,
			expectOld: current ?? ZERO_SHA,
			newSha: head,
			purpose: "attic",
			ownerKind: "kernel",
			ownerId: `archive:${laneId}`,
		}]);
		if (result?.ok !== true) {
			throw conflict(`attic write refused: ${result?.reason ?? "no status"}`);
		}
		return { kind: "ref", ref: options.atticRef, head, vetoed: false };
	};

	// -----------------------------------------------------------------------
	// Lane repos (`repo` backend)
	// -----------------------------------------------------------------------

	const laneRepos = (repoId: string) =>
		createLaneRepoAccess({ artifacts: deps.artifacts, repoId });

	/** The lane repo of each `repo`-backend lane among `laneIds`. */
	const laneRepoNames = async (
		repoId: string,
		laneIds: readonly string[],
	): Promise<Map<string, string>> => {
		const unique = [...new Set(laneIds)];
		const found = new Map<string, string>();
		const canonical = access(repoId).name;
		for (const laneId of unique) {
			const [spec] = await deps.core(repoId).laneFetchSpecs([laneId]);
			if (spec !== undefined && spec.token.artifactsName !== canonical) {
				found.set(laneId, spec.token.artifactsName);
			}
		}
		return found;
	};

	/**
	 * Change refs of `repo` lanes: the intent first, then the head
	 * fetched by SHA from its lane repo into the mirror when missing (a cold
	 * mirror after a container restart), then one push WITH objects
	 * to the canonical repo, compare-and-swap on the old value.
	 */
	const pushChangeRefsWithObjects = async (
		repoId: string,
		git: ReturnType<typeof createLandGit>,
		items: readonly {
			readonly intent: KernelWriteIntent;
			readonly laneRepo: string;
		}[],
		workPrefix: string,
	): Promise<void> => {
		const core = deps.core(repoId);
		const rows = [];
		for (const item of items) {
			rows.push(await core.registerKernelWrite(item.intent));
		}
		for (const [i, item] of items.entries()) {
			if (await git.has(item.intent.newSha)) continue;
			await withLaneRepoCred(
				laneRepos(repoId),
				item.laneRepo,
				"read",
				(cred) =>
					git.fetch(cred, [{
						sha: item.intent.newSha,
						ref: `${workPrefix}-${i}`,
					}]),
			);
		}
		const upstream = access(repoId);
		const write = await upstream.token("write");
		let refs;
		try {
			refs = (await git.push(
				write,
				items.map((item) => ({
					src: item.intent.newSha,
					dst: item.intent.ref,
					expect: item.intent.expectOld,
				})),
			)).refs;
		} finally {
			await write.revoke();
		}
		const refused: string[] = [];
		for (const [i, item] of items.entries()) {
			const status = refs.find((r) => r.ref === item.intent.ref);
			let ok = status?.kind === "ok" || status?.kind === "uptodate";
			if (!ok) {
				const current = await upstream.refValue(item.intent.ref).catch(() =>
					null
				);
				ok = current === item.intent.newSha;
			}
			await core.markKernelWrite(rows[i].id, ok ? "pushed" : "abandoned");
			if (!ok) {
				refused.push(`${item.intent.ref} (${status?.reason ?? "no status"})`);
			}
		}
		await git.cleanup(`${workPrefix}`);
		if (refused.length > 0) {
			throw conflict(`change refs refused: ${refused.join(", ")}`);
		}
	};

	// -----------------------------------------------------------------------
	// sync and restack (server-side rebases)
	// -----------------------------------------------------------------------

	/** Where a lane's head lives, and the objects fetched from there by SHA. */
	const laneSource = async (
		repoId: string,
		laneId: string,
	): Promise<{ readonly laneRepo: string | null }> => {
		const [spec] = await deps.core(repoId).laneFetchSpecs([laneId]);
		if (spec === undefined) throw notFound(`unknown lane: ${laneId}`);
		return {
			laneRepo: spec.token.artifactsName === access(repoId).name
				? null
				: spec.token.artifactsName,
		};
	};

	const fetchInto = async (
		repoId: string,
		git: ReturnType<typeof createLandGit>,
		laneRepo: string | null,
		specs: readonly { sha: string; ref: string }[],
	): Promise<void> => {
		const missing: { sha: string; ref: string }[] = [];
		for (const s of specs) if (!(await git.has(s.sha))) missing.push(s);
		if (missing.length === 0) return;
		if (laneRepo === null) {
			const read = await access(repoId).token("read");
			try {
				await git.fetch(read, missing);
			} finally {
				await read.revoke();
			}
			return;
		}
		await withLaneRepoCred(
			laneRepos(repoId),
			laneRepo,
			"read",
			(cred) => git.fetch(cred, missing),
		);
	};

	/**
	 * Rebases a lane onto trunk (`sync`) or onto another lane's head
	 * (`restack`): objects fetched by SHA from where each lives (the canonical
	 * repo, or each lane's own repo with a token scoped to it), the lane's own
	 * commits replayed in the mirror, then one push with a lease on the old
	 * head, into the lane's own storage only (its lane repo, or its branch ref
	 * in the canonical repo), registered first as a `lane-sync` intent with
	 * target = the lane (refused while the lane is `landing`).
	 */
	const rebaseLane = async (
		repoId: string,
		laneId: string,
		onto: { readonly laneId: string } | null,
	): Promise<SyncResult> => {
		if (!isUlid(repoId)) throw invalid(`not a repo id: ${repoId}`);
		if (!isIdOf("lane", laneId)) throw invalid(`not a lane id: ${laneId}`);
		const core = deps.core(repoId);
		const lane = await core.getLane(laneId);
		if (lane === null) throw notFound(`unknown lane: ${laneId}`);
		if (lane.head === undefined) {
			throw conflict(`lane ${laneId} has no commits`, { code: "empty-lane" });
		}
		const head = lane.head;
		const owner = `${onto === null ? "sync" : "restack"}:${laneId}`;
		const work = `refs/tartan-work/${owner.replace(":", "-")}`;
		const git = createLandGit({
			exec: deps.exec(repoId),
			repoId,
			...(deps.mirrorRoot ? { mirrorRoot: deps.mirrorRoot } : {}),
		});
		await git.ensureMirror();
		const upstream = access(repoId);
		const info = await core.info();
		const trunk = await upstream.refValue(trunkRef(info.defaultBranch));
		if (trunk === null) throw conflict("the repo has no trunk yet");
		const own = await laneSource(repoId, laneId);
		await fetchInto(repoId, git, null, [{ sha: trunk, ref: `${work}/trunk` }]);
		await fetchInto(repoId, git, own.laneRepo, [{
			sha: head,
			ref: `${work}/head`,
		}]);
		let base = trunk;
		const exclude: string[] = [];
		if (onto !== null) {
			const other = await core.getLane(onto.laneId);
			if (other === null) throw notFound(`unknown lane: ${onto.laneId}`);
			if (other.head === undefined) {
				throw conflict(`lane ${onto.laneId} has no commits`, {
					code: "empty-lane",
				});
			}
			const theirs = await laneSource(repoId, onto.laneId);
			await fetchInto(repoId, git, theirs.laneRepo, [{
				sha: other.head,
				ref: `${work}/onto`,
			}]);
			base = other.head;
			exclude.push(trunk);
		}
		const rebased = await rebaseOnto({
			exec: deps.exec(repoId),
			mirror: git.mirror,
			committer: KERNEL_GIT_IDENTITY,
			date: Math.floor((deps.now?.() ?? Date.now()) / 1000),
		}, { head, onto: base, exclude });
		if (!rebased.ok) {
			await git.cleanup(`${work}/`);
			return { ok: false, conflicts: rebased.conflicts };
		}
		if (rebased.head === head) {
			await git.cleanup(`${work}/`);
			return { ok: true, head };
		}
		const row = await core.registerKernelWrite({
			target: laneId,
			ref: lane.ref,
			expectOld: head,
			newSha: rebased.head,
			purpose: "lane-sync",
			ownerKind: "job",
			ownerId: owner,
		});
		const pushTo = (cred: { remote: string; token: string }) =>
			git.push(cred, [{ src: rebased.head, dst: lane.ref, expect: head }]);
		let pushed;
		try {
			if (own.laneRepo === null) {
				const write = await upstream.token("write");
				try {
					pushed = await pushTo(write);
				} finally {
					await write.revoke();
				}
			} else {
				pushed = await withLaneRepoCred(
					laneRepos(repoId),
					own.laneRepo,
					"write",
					pushTo,
				);
			}
		} catch (error) {
			await core.markKernelWrite(row.id, "abandoned");
			throw error;
		} finally {
			await git.cleanup(`${work}/`);
		}
		const status = pushed.refs.find((r) => r.ref === lane.ref);
		if (status?.kind !== "ok" && status?.kind !== "uptodate") {
			await core.markKernelWrite(row.id, "abandoned");
			throw conflict(
				`lane ${laneId} moved during the rebase: ${
					status?.reason ?? "no status"
				}`,
				{ code: "head-moved" },
			);
		}
		await core.markKernelWrite(row.id, "pushed");
		return { ok: true, head: rebased.head };
	};

	// -----------------------------------------------------------------------
	// repair (K5 sweeper)
	// -----------------------------------------------------------------------

	const repair: KernelGitJobs["repair"] = async (repoId, advanceId) => {
		const parsed = parseAdvanceId(advanceId);
		if (parsed === null) throw invalid(`not an advance id: ${advanceId}`);
		const batchId = `lb_${parsed.batchUlid}`;
		const land = deps.land(repoId);
		const detail = await land.batch(batchId);
		if (detail === null) throw notFound(`unknown batch: ${batchId}`);
		const landed = detail.status.changes.filter((c) =>
			c.outcome === "landed" && c.commit !== undefined
		);
		if (landed.length === 0) return;
		const heads = new Map(detail.changes.map((c) => [c.changeId, c.head]));
		const upstream = access(repoId);
		const owner = `repair-${advanceId}`;
		const git = createLandGit({
			exec: deps.exec(repoId),
			repoId,
			...(deps.mirrorRoot ? { mirrorRoot: deps.mirrorRoot } : {}),
		});
		await git.ensureMirror();

		// Change refs, one fresh intent each: ref-only for `branch`
		// lanes; pushed with objects for `repo` lanes, whose heads live only
		// in their lane repos (re-fetched by SHA first).
		const existing = new Map(
			(await upstream.lsRefs(landed.map((c) => changeRef(c.changeId)))).map((
				r,
			) => [r.ref, r.sha]),
		);
		const laneRepoOf = await laneRepoNames(
			repoId,
			landed.map((c) => c.laneId),
		);
		const writes: (KernelWriteIntent & { laneRepo?: string })[] = landed
			.flatMap((c) => {
				const head = heads.get(c.changeId);
				const ref = changeRef(c.changeId);
				if (head === undefined || existing.get(ref) === head) return [];
				const laneRepo = laneRepoOf.get(c.laneId);
				return [{
					target: "repo",
					ref,
					expectOld: existing.get(ref) ?? ZERO_SHA,
					newSha: head,
					purpose: "change-ref" as const,
					ownerKind: "job" as const,
					ownerId: owner,
					...(laneRepo !== undefined ? { laneRepo } : {}),
				}];
			});
		const refOnly = writes.filter((w) => w.laneRepo === undefined).map((
			{ laneRepo: _, ...intent },
		) => intent);
		if (refOnly.length > 0) {
			const results = await refWrite(repoId, refOnly);
			const failed = results.filter((r) => !r.ok);
			if (failed.length > 0) {
				throw conflict(
					`repair: change refs refused: ${
						failed.map((f) => `${f.ref} (${f.reason})`).join(", ")
					}`,
				);
			}
		}
		const withObjects = writes.filter((w) => w.laneRepo !== undefined);
		if (withObjects.length > 0) {
			await pushChangeRefsWithObjects(
				repoId,
				git,
				withObjects.map((w) => ({
					intent: {
						target: w.target,
						ref: w.ref,
						expectOld: w.expectOld,
						newSha: w.newSha,
						purpose: w.purpose,
						ownerKind: w.ownerKind,
						ownerId: w.ownerId,
					},
					laneRepo: w.laneRepo as string,
				})),
				`refs/tartan-work/${owner}/change`,
			);
		}

		// Notes: re-add the landed commits' notes that the remote lacks.
		const tip = await upstream.refValue(NOTES_REF);
		const read = await upstream.token("read");
		try {
			await git.fetch(read, [
				...(tip !== null
					? [{ sha: tip, ref: `refs/tartan-work/${owner}/notes` }]
					: []),
				...landed.map((c, i) => ({
					sha: c.commit as string,
					ref: `refs/tartan-work/${owner}/landed-${i}`,
				})),
			]);
		} finally {
			await read.revoke();
		}
		const workRef = `refs/notes/tartan-work/${owner}`;
		const missing: { commit: string; text: string }[] = [];
		if (tip !== null) {
			await git.buildNotes({
				notesRef: workRef,
				base: tip,
				notes: [],
				identity: KERNEL_GIT_IDENTITY,
				date: 0,
			});
		}
		for (const change of landed) {
			const commit = change.commit as string;
			if (tip !== null && await git.hasNote(workRef, commit)) continue;
			const note = await land.whyNote(advanceId, change.changeId);
			missing.push({ commit, text: encodeNote(note) });
		}
		if (missing.length > 0) {
			const core = deps.core(repoId);
			let previous: string | undefined;
			await pushNotes({
				git,
				remoteTip: () => upstream.refValue(NOTES_REF),
				readCred: () => upstream.token("read"),
				writeCred: () => upstream.token("write"),
				register: async (base, newTip) => {
					const row = await core.registerKernelWrite({
						target: "repo",
						ref: NOTES_REF,
						expectOld: base,
						newSha: newTip,
						purpose: "notes",
						ownerKind: "job",
						ownerId: owner,
						...(previous !== undefined ? { supersedes: previous } : {}),
					});
					previous = row.id;
				},
			}, {
				workRef,
				notes: missing,
				identity: KERNEL_GIT_IDENTITY,
				date: Math.floor((deps.now?.() ?? Date.now()) / 1000),
			}, null);
			if (previous !== undefined) {
				await deps.core(repoId).markKernelWrite(previous, "pushed");
			}
		}
		await git.cleanup(`refs/tartan-work/${owner}/`);
	};

	return {
		genesis,
		refWrite,
		archive,
		sync: (repoId, laneId) => rebaseLane(repoId, laneId, null),
		restack: (repoId, laneId, onto) => {
			if (!isIdOf("lane", onto)) {
				return Promise.reject(invalid(`not a lane id: ${onto}`));
			}
			return rebaseLane(repoId, laneId, { laneId: onto });
		},
		repair,
	};
};

/**
 * RepoProbe through the module-level `exports` of `cloudflare:workers`,
 * imported on first use so Deno tests can import this file (as WP7b's
 * dispatcher does).
 */
const moduleProbe = (): Pick<RepoProbeApi, "addedLines" | "diffPaths"> => {
	const probe = async () =>
		loopback({ exports: (await import("cloudflare:workers")).exports })
			.RepoProbe as unknown as RepoProbeApi;
	return {
		addedLines: async (...args) => (await probe()).addedLines(...args),
		diffPaths: async (...args) => (await probe()).diffPaths(...args),
	};
};

/** The production deps, from the Worker's (or a DO's) `env`. */
export const envGitJobsDeps = (env: Env): GitJobsDeps => ({
	artifacts: env.ARTIFACTS,
	core: (repoId) =>
		env.REPO.getByName(repoDoName(repoId)).core() as unknown as ReturnType<
			GitJobsDeps["core"]
		>,
	land: (repoId) =>
		env.REPO.getByName(repoDoName(repoId)).land() as unknown as ReturnType<
			GitJobsDeps["land"]
		>,
	exec: (repoId) => (argv, options) =>
		env.SANDBOX.getByName(gitSandboxName(repoId)).gitExec(argv, options),
	gates: createExtDispatch(env),
	probe: moduleProbe,
});

export const createKernelGitJobs: CreateKernelGitJobs<Env> = (env) =>
	createKernelGitJobsWith(envGitJobsDeps(env));

/** With RepoProbe reachable through the caller's `ctx.exports` (archive gates). */
export const createKernelGitJobsFor = (
	env: Env,
	host: { readonly exports: unknown },
): KernelGitJobs =>
	createKernelGitJobsWith({
		...envGitJobsDeps(env),
		gates: createExtDispatch(env, host),
		probe: () =>
			loopback(host).RepoProbe as unknown as Pick<
				RepoProbeApi,
				"addedLines" | "diffPaths"
			>,
	});
