// A fake land kernel for the queue tests: the behaviour of WP10's
// `RepoLandFacade.submit` that a queue@1 provider depends on (K4), the land
// events it appends, and the other caps the train calls (events.read,
// lanes.get, interfaces.call, notify, timers). It drives one extension module
// through `@tartan/ext-api/testing.ts` the way the builtin host does: kernel
// events in log order, the `tick` timer when due, a fresh ExtCtx per call.
// Shared verbatim with `extensions/fifo/test/kernel.ts` (drift-checked).
//
// What the fake checks on every `land.submit` (refusals are thrown and
// recorded in `refusals`; provider bugs are recorded in `violations`):
// - idempotency on `batchId`: the same content returns the existing batch,
//   other content is `conflict`;
// - K4: every reason event exists in the log; per change, a non-shadow
//   `changes.submitted` of that change and a `review.decided{approve}` whose
//   `head` is the landed head; queue events never count;
// - each change's `head` equals the lane head (`conflict(head-moved)`),
//   the lane is `submitted` and not quarantined; the batch freezes its lanes
//   (`landing`) until it ends;
// - K1: `landing_paused` refuses with `denied(landing-paused)`;
// - the ref: caps' `permissions.land` grant, then WP10's "only the default
//   branch lands" (`defaultBranch`, `main` unless set);
// - the batch was stored by the provider before the call (`beforeSubmit`).
//
// Who provides queue@1 at the repo (`state.provider`: this installation,
// another one, or none) answers `interfaces.provider("queue@1")` and
// `interfaces.call("queue@1", …)` as caps does (a call to the caller itself
// is a call cycle); with
// `state.kernelChecksProvider`, `land.submit` while another installation
// provides queue@1 is refused `denied("grant", "… not the queue@1 provider
// in force …")` (the requested caps check).

import {
	type Actor,
	conflict,
	createUlid,
	denied,
	type Envelope,
	type ExtensionModule,
	type ExtMigration,
	invalid,
	type LandBatchState,
	type LandRequest,
	LandRequestSchema,
	type LandStatus,
	type ManifestPermissions,
	notFound,
	tartanError,
	unavailable,
} from "@tartan/contract";
import {
	createTestHarness,
	type Harness,
	rows,
} from "@tartan/ext-api/testing.ts";

export const REPO = "01k6rrrrrrrrrrrrrrrrrrrrrr";
export const INSTALL = "i_01k6wwwwwwwwwwwwwwwwwwwwww";
export const OWNER = "u_01k6vvvvvvvvvvvvvvvvvvvvv0";
export const MAINTAINER = "u_01k6vvvvvvvvvvvvvvvvvvvvv1";
export const STRANGER = "a_01k6aaaaaaaaaaaaaaaaaaaaz9";

const HEX_TO_CHANGE = "klmnopqrstuvwxyz";
const pad = (n: number, width: number): string =>
	n.toString(16).padStart(width, "0");

/** A 40-hex sha for a label number. */
export const shaOf = (n: number): string => pad(n, 40);
/** A change id (`[k-z]{32}`). */
export const changeIdOf = (n: number): string =>
	[...pad(n, 32)].map((c) => HEX_TO_CHANGE[parseInt(c, 16)]).join("");
export const agentOf = (n: number): string =>
	`a_01k6aaaaaaaaaaaaaaaaaaaa${pad(n, 2)}`;
export const laneOf = (n: number): string =>
	`ln_01k6ssssssssssssssssssss${pad(n, 2)}`;

export type LaneModel = {
	id: string;
	owner: string;
	head: string;
	state: "open" | "submitted" | "landing" | "landed";
	quarantined: boolean;
};

export type ChangeModel = {
	n: number;
	changeId: string;
	laneId: string;
	author: string;
	title: string;
	summary: string;
	workRef: string;
	revision: number;
	head: string;
	base: string;
	affected: string[];
	paths: string[];
};

export type BatchModel = {
	request: LandRequest;
	state: LandBatchState;
	attempt: number;
	outcomes: Map<string, "landed" | "conflicted" | "vetoed" | "pending">;
	commits: Map<string, string>;
	result?: unknown;
};

export type SubmitFault =
	| "lost" // the batch is created, the answer is lost (internal)
	| "lost-silent" // as `lost`, and `land.submitted` is not delivered either
	| "unavailable" // nothing is created
	| "lane-git-job" // conflict(lane-git-job): a lane sync holds a lane
	| "not-provider" // caps: the caller is not the queue@1 provider in force
	| null;

export type Emitted = {
	readonly id: string;
	readonly type: string;
	readonly data: Record<string, unknown>;
	readonly idemKey?: string;
};

export type Notice = {
	readonly principal: string;
	readonly notice: Record<string, unknown>;
};

export type KernelOptions = {
	readonly module: ExtensionModule;
	readonly migrations: readonly ExtMigration[];
	readonly grants: ManifestPermissions;
	readonly extId: string;
	readonly config?: unknown;
	readonly mode?: "enforce" | "shadow";
	/** The provider's batch table, checked before each submit. */
	readonly batchTable?: string;
	/** The repo's default branch (`caps.repo.info`); `main` by default. */
	readonly defaultBranch?: string;
	/**
	 * The installation's own node: the repo by default; a group for an
	 * installation inherited by the repo (its instance's scope stays
	 * `repo:<REPO>`). Repo-keyed caps refuse any id but REPO, as caps does
	 * for a node that is not a repo.
	 */
	readonly installNode?: { readonly id: string; readonly path: string };
};

/** caps' `refGranted` (WP7b): `*` matches one ref segment. */
const refGranted = (patterns: readonly string[], ref: string): boolean =>
	patterns.some((p) =>
		new RegExp(
			`^${
				p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, "\\$&"))
					.join("[^/]*")
			}$`,
		).test(ref)
	);

export type Kernel = ReturnType<typeof createKernel>;

export const createKernel = (options: KernelOptions) => {
	const defaultBranch = options.defaultBranch ?? "main";
	const trunk = `refs/heads/${defaultBranch}`;
	const clock = { now: 1_760_000_000_000 };
	const ulid = createUlid({ now: () => clock.now });
	const log: Envelope[] = [];
	const outbox: Envelope[] = [];
	const lanes = new Map<string, LaneModel>();
	const changes = new Map<string, ChangeModel>();
	const batches = new Map<string, BatchModel>();
	const submits: LandRequest[] = [];
	const violations: string[] = [];
	const refusals: string[] = [];
	const emitted: Emitted[] = [];
	const emitKeys = new Map<string, string>();
	const notices: Notice[] = [];
	const work = new Map<string, Record<string, unknown>>();
	const maintainers = new Set<string>([MAINTAINER]);
	const faults: SubmitFault[] = [];
	const state = {
		landingPaused: false,
		trunk: shaOf(0xfff0),
		commits: 0,
		provider: "self" as "self" | "other" | "none" | "unknown",
		kernelChecksProvider: false,
		/**
		 * K13.3 at `land.submit`: the changes that touch a root `*.cue` file,
		 * each with whether a Maintainer signed its head off.
		 */
		policy: new Map<string, boolean>(),
		/**
		 * K13.3: changes whose diff the kernel cannot read yet (no
		 * `push.diffed`), so `land.submit` answers `policy-unknown`.
		 */
		policyUnknown: new Set<string>(),
	};
	let seq = 0;

	const append = (
		type: string,
		data: Record<string, unknown>,
		o: { actor?: Actor; shadow?: boolean; deliver?: boolean } = {},
	): Envelope => {
		seq += 1;
		clock.now += 1;
		const ev: Envelope = {
			id: ulid(),
			seq,
			stream: `repo:${REPO}`,
			type,
			v: 1,
			source: { kind: "kernel" },
			actor: o.actor ?? { kind: "system", id: "sys_kernel" },
			node: REPO,
			repo: REPO,
			depth: 0,
			shadow: o.shadow ?? false,
			at: clock.now,
			data,
		};
		log.push(ev);
		if (o.deliver ?? true) outbox.push(ev);
		return ev;
	};

	const violation = (text: string): void => {
		violations.push(text);
	};

	/** caps' `confineRepo`: a repo-keyed call names the repo, never a group. */
	const requireRepo = (ref: { readonly id?: string } | undefined): string => {
		if (ref?.id !== REPO) throw invalid("repo is not a repo");
		return REPO;
	};

	const patternMatches = (p: string, type: string): boolean =>
		p === "*" || p === type ||
		(p.endsWith(".*") && type.startsWith(p.slice(0, -1)));

	// -- land.submit (WP10 semantics, see the header) ---------------------------

	const checkSubmit = (r: LandRequest): void => {
		const byId = new Map(log.map((e) => [e.id, e]));
		for (const id of r.reason.events) {
			if (!byId.has(id)) {
				throw invalid(`reason event ${id} is not in this repo's log (K4)`);
			}
		}
		const chain = r.reason.events.map((id) => byId.get(id)!);
		for (const c of r.batch) {
			const submitted = chain.some((e) =>
				e.type === "changes.submitted" && !e.shadow &&
				(e.data as Record<string, unknown>).changeId === c.changeId
			);
			const approval = chain.some((e) => {
				const d = e.data as Record<string, unknown>;
				return e.type === "review.decided" && !e.shadow &&
					d.changeId === c.changeId && d.decision === "approve" &&
					d.head === c.head;
			});
			if (!submitted || !approval) {
				throw invalid(
					`reason chain lacks ${
						!submitted ? "changes.submitted" : "an approval of the head"
					} for ${c.changeId} (K4)`,
				);
			}
			const lane = lanes.get(c.laneId);
			if (!lane) throw notFound(`lane ${c.laneId}`);
			if (lane.quarantined) {
				throw tartanError("conflict", `lane ${c.laneId} is quarantined`, {
					reason: "quarantined",
				});
			}
			if (lane.head !== c.head) {
				throw tartanError("conflict", `lane ${c.laneId} moved`, {
					reason: "head-moved",
				});
			}
			if (lane.state !== "submitted") {
				throw tartanError("conflict", `lane ${c.laneId} is ${lane.state}`, {
					reason: "lane-state",
				});
			}
		}
	};

	const landSubmit = (r: LandRequest): { batchId: string } => {
		submits.push(structuredClone(r));
		// What caps checks before RepoDO (WP7b): the request schema.
		const parsed = LandRequestSchema.safeParse(r);
		if (!parsed.success) {
			violation(`invalid LandRequest: ${parsed.error.message}`);
			throw invalid("land.submit: invalid request");
		}
		if (options.batchTable) {
			const stored = rows<{ request_json: string | null }>(
				harness.storage,
				`SELECT request_json FROM ${options.batchTable} WHERE batch_id = ?`,
				r.batchId,
			)[0];
			if (!stored || stored.request_json !== JSON.stringify(r)) {
				violation(`batch ${r.batchId} was not stored before land.submit`);
			}
		}
		if (state.kernelChecksProvider && state.provider === "other") {
			refusals.push("land.submit: not the queue@1 provider in force");
			throw denied(
				"grant",
				"land.submit: not the queue@1 provider in force at acme/platform/router",
			);
		}
		// caps (WP7b) before RepoDO: the repo is a repo, the ref is granted.
		requireRepo(r.repo as { id?: string });
		if (!refGranted(options.grants.land ?? [], r.ref)) {
			refusals.push(`land.submit: ${r.ref} is not granted`);
			throw denied("grant", `land.submit: ${r.ref} is not granted`);
		}
		const fault = faults.shift() ?? null;
		if (fault === "unavailable") throw unavailable("injected: land.submit");
		if (fault === "lane-git-job") {
			throw tartanError("conflict", "a lane-sync job holds the lane", {
				reason: "lane-git-job",
			});
		}
		if (fault === "not-provider") {
			refusals.push("land.submit: not the queue@1 provider in force");
			throw denied(
				"grant",
				"land.submit: not the queue@1 provider in force at acme/platform/router",
			);
		}
		const existing = batches.get(r.batchId);
		if (existing) {
			if (JSON.stringify(existing.request) !== JSON.stringify(r)) {
				throw tartanError("conflict", "batch id reused with other content");
			}
			if (fault?.startsWith("lost")) throw new Error("injected: response lost");
			return { batchId: r.batchId };
		}
		if (state.landingPaused) throw denied("landing-paused", "landing paused");
		const unknown = r.batch.find((c) =>
			state.policyUnknown.has(c.changeId) && !state.policy.get(c.changeId)
		);
		if (unknown !== undefined) {
			const text =
				`policy-unknown: the diff of ${unknown.changeId} is not known yet, so whether it changes a root .cue file is unknown; retry once it is (K13)`;
			refusals.push(text);
			throw denied("policy-unknown", text);
		}
		const touching = r.batch.filter((c) => state.policy.has(c.changeId));
		if (touching.length > 1) {
			const text =
				`policy-batch: a batch holds at most one change that touches a root .cue file (${
					touching.map((c) => c.changeId).join(", ")
				}); land them one at a time`;
			refusals.push(text);
			throw denied("policy-batch", text);
		}
		if (touching.length === 1 && !state.policy.get(touching[0].changeId)) {
			const text = `policy-signoff: ${
				touching[0].changeId
			} changes a root .cue file; a Maintainer must approve the policy change first (K13)`;
			refusals.push(text);
			throw denied("policy-signoff", text);
		}
		try {
			// WP10: only the repo's default branch lands.
			if (r.ref !== trunk) throw invalid(`only ${trunk} lands`);
			checkSubmit(r);
		} catch (e) {
			refusals.push(e instanceof Error ? e.message : String(e));
			throw e;
		}
		batches.set(r.batchId, {
			request: structuredClone(r),
			state: "composing",
			attempt: 1,
			outcomes: new Map(r.batch.map((c) => [c.changeId, "pending"])),
			commits: new Map(),
		});
		for (const c of r.batch) lanes.get(c.laneId)!.state = "landing";
		append("land.submitted", {
			batchId: r.batchId,
			attempt: 1,
			ref: r.ref,
			changes: r.batch.map((c) => ({
				changeId: c.changeId,
				laneId: c.laneId,
				head: c.head,
			})),
			reasonEvents: r.reason.events,
			requestedBy: `x_${INSTALL}`,
			testPolicy: r.testPolicy,
			...(r.partitionKey ? { partitionKey: r.partitionKey } : {}),
		}, { deliver: fault !== "lost-silent" });
		if (fault?.startsWith("lost")) throw new Error("injected: response lost");
		return { batchId: r.batchId };
	};

	const landStatus = (batchId: string): LandStatus => {
		const b = batches.get(batchId);
		if (!b) throw notFound(`batch ${batchId} not found`);
		return {
			batchId,
			repoId: REPO,
			ref: b.request.ref,
			state: b.state,
			attempt: b.attempt,
			baseSha: state.trunk,
			changes: b.request.batch.map((c) => ({
				changeId: c.changeId,
				laneId: c.laneId,
				outcome: b.outcomes.get(c.changeId),
				...(b.commits.has(c.changeId)
					? { commit: b.commits.get(c.changeId) }
					: {}),
			})),
			...(b.result !== undefined ? { result: b.result } : {}),
			createdAt: clock.now,
		};
	};

	// -- the harness -------------------------------------------------------------

	const harness: Harness = createTestHarness({
		module: options.module,
		migrations: options.migrations,
		grants: options.grants,
		config: options.config,
		now: () => clock.now,
		install: {
			id: INSTALL,
			extId: options.extId,
			version: "0.1.0",
			node: options.installNode ?? { id: REPO, path: "acme/platform/router" },
			scopeKey: `repo:${REPO}`,
			mode: options.mode ?? "enforce",
		},
		handlers: {
			"events.emit": ((type: string, data: unknown, o?: {
				idemKey?: string;
			}) => {
				const key = o?.idemKey;
				if (key && emitKeys.has(key)) return emitKeys.get(key);
				const id = ulid();
				if (key) emitKeys.set(key, id);
				emitted.push({
					id,
					type,
					data: data as Record<string, unknown>,
					idemKey: key,
				});
				return id;
			}) as never,
			"events.read": ((
				stream: string,
				since: number,
				patterns: string[],
				limit = 100,
			) => {
				if (stream !== `repo:${REPO}`) throw notFound(`stream ${stream}`);
				return log.filter((e) =>
					e.seq > since && patterns.some((p) => patternMatches(p, e.type))
				).slice(0, Math.min(limit, 100)); // the caps page cap
			}) as never,
			"land.submit": ((r: LandRequest) => landSubmit(r)) as never,
			"repo.info": ((ref: { readonly id?: string }) => ({
				id: requireRepo(ref),
				nodeId: REPO,
				path: "acme/platform/router",
				defaultBranch,
				visibility: "private",
				trunkSha: state.trunk,
				landingPaused: state.landingPaused,
			})) as never,
			"land.status": ((id: string) => landStatus(id)) as never,
			"lanes.get": ((id: string) => {
				const lane = lanes.get(id);
				if (!lane) throw notFound(`lane ${id}`);
				return { ...lane, repoId: REPO, delegates: [], pushes: 1 };
			}) as never,
			"interfaces.provider": ((iface: string) => {
				if (iface !== "queue@1") throw notFound(`${iface} provider`);
				if (state.provider === "unknown") {
					throw unavailable("injected: the registry cannot answer");
				}
				if (state.provider === "none") return null;
				return {
					installation: state.provider === "self"
						? INSTALL
						: "i_01k6oooooooooooooooooooooo",
					extension: state.provider === "self"
						? options.extId
						: "tartan.other-queue",
					self: state.provider === "self",
				};
			}) as never,
			"interfaces.call": ((iface: string, tool: string, args: {
				changeId?: string;
				ref?: string;
			}) => {
				if (iface === "changes@1" && tool === "changes_get") {
					const c = changes.get(args.changeId ?? "");
					if (!c) throw notFound(`change ${args.changeId}`);
					return {
						changeId: c.changeId,
						laneId: c.laneId,
						title: c.title,
						summary: c.summary,
						author: c.author,
						workRef: c.workRef,
						state: "submitted",
					};
				}
				if (iface === "work@1" && tool === "work_get") {
					const item = work.get(args.ref ?? "");
					if (!item) throw notFound(`work ${args.ref}`);
					return item;
				}
				if (iface === "queue@1") {
					if (!(options.grants["interfaces.call"] ?? []).includes("queue@1")) {
						throw denied("grant", "interfaces.call: queue@1 is not granted");
					}
					if (state.provider === "self") throw conflict("call cycle");
					if (state.provider === "unknown") {
						throw unavailable("injected: the registry cannot answer");
					}
					if (state.provider === "none") {
						throw notFound(
							"no queue@1 provider in force at acme/platform/router",
						);
					}
					return { partitions: [] };
				}
				throw notFound(`${iface} ${tool}`);
			}) as never,
			"repo.diffPaths": ((src: { laneId?: string }) => {
				const c = [...changes.values()].find((x) => x.laneId === src.laneId);
				return {
					paths: (c?.paths ?? []).map((path) => ({
						path,
						change: "modified",
					})),
					truncated: false,
				};
			}) as never,
			"notify.send": ((principal: string, notice: Record<string, unknown>) => {
				requireRepo(notice.repo as { id?: string } | undefined);
				notices.push({ principal, notice });
			}) as never,
			"principals.get": ((id: string) => ({
				id,
				kind: id.startsWith("u_") ? "user" : "agent",
				handle: id === MAINTAINER ? "maint" : "rawkode",
				display: "Someone",
			})) as never,
			"authz.check": ((principal: string, node: { id?: string }) => {
				requireRepo(node);
				return maintainers.has(principal);
			}) as never,
		},
	});

	// -- scenario helpers ----------------------------------------------------------

	/** Opens a lane, pushes `head` and submits the change (`changes.submitted`). */
	const submitChange = (
		n: number,
		o: {
			affected?: string[];
			paths?: string[];
			author?: string;
			deliver?: boolean;
		} = {},
	): ChangeModel => {
		const laneId = laneOf(n);
		const author = o.author ?? agentOf(n);
		const head = shaOf(0x1000 + n * 16);
		lanes.set(laneId, {
			id: laneId,
			owner: author,
			head,
			state: "submitted",
			quarantined: false,
		});
		const workRef = `acme/platform/router#${n}`;
		work.set(workRef, {
			ref: workRef,
			kind: "intent",
			title: `intent ${n}`,
			why: `because ${n}`,
			acceptance: [`criterion ${n}`],
		});
		const change: ChangeModel = {
			n,
			changeId: changeIdOf(n),
			laneId,
			author,
			title: `Change ${n}`,
			summary: `Summary of change ${n}`,
			workRef,
			revision: 1,
			head,
			base: state.trunk,
			affected: o.affected ?? ["api"],
			paths: o.paths ?? [`services/api/src/f${n}.ts`],
		};
		changes.set(change.changeId, change);
		append("changes.submitted", {
			changeId: change.changeId,
			laneId,
			revision: 1,
			head,
			base: change.base,
			affected: change.affected,
			workRef,
		}, { actor: { kind: "agent", id: author }, deliver: o.deliver });
		return change;
	};

	/** The owner pushes a new head: a new revision (`changes.revised`). */
	const pushRevision = (
		c: ChangeModel,
		o: { deliver?: boolean } = {},
	): ChangeModel => {
		const lane = lanes.get(c.laneId)!;
		if (lane.state === "landing") {
			throw new Error(`push rejected: lane-landing (${c.laneId})`);
		}
		c.revision += 1;
		c.head = shaOf(0x1000 + c.n * 16 + c.revision);
		lane.head = c.head;
		lane.state = "submitted";
		append("changes.revised", {
			changeId: c.changeId,
			laneId: c.laneId,
			revision: c.revision,
			head: c.head,
			base: c.base,
			affected: c.affected,
			workRef: c.workRef,
		}, { actor: { kind: "agent", id: c.author }, deliver: o.deliver });
		return c;
	};

	const approve = (
		c: ChangeModel,
		o: {
			by?: Actor;
			route?: "auto" | "human";
			shadow?: boolean;
			head?: string;
			deliver?: boolean;
		} = {},
	): Envelope =>
		append("review.decided", {
			changeId: c.changeId,
			revision: c.revision,
			head: o.head ?? c.head,
			decision: "approve",
			route: o.route ?? "auto",
			risk: 0.12,
			decidedBy: o.by ?? { kind: "ext", id: "x_i_01k6vvvvvvvvvvvvvvvvvvvvvv" },
		}, { shadow: o.shadow, deliver: o.deliver });

	type Outcome = {
		readonly conflicted?: readonly {
			readonly changeId: string;
			readonly paths: string[];
			readonly conflictsWith: string[];
		}[];
		readonly vetoed?: readonly {
			readonly changeId: string;
			readonly message: string;
		}[];
		readonly failed?: { readonly reason: string; readonly failing?: string[] };
		/** Append the terminal event without delivering it (a lost delivery). */
		readonly silent?: boolean;
	};

	/** Ends a batch the way LandWorkflow does, appending its events. */
	const finish = (batchId: string, o: Outcome = {}): void => {
		const b = batches.get(batchId);
		if (!b) throw new Error(`no batch ${batchId}`);
		const deliver = !(o.silent ?? false);
		const release = (changeId: string) => {
			const c = b.request.batch.find((x) => x.changeId === changeId)!;
			lanes.get(c.laneId)!.state = "submitted";
		};
		for (const c of o.conflicted ?? []) {
			b.outcomes.set(c.changeId, "conflicted");
			release(c.changeId);
			append("land.conflicted", {
				batchId,
				attempt: 1,
				changeId: c.changeId,
				paths: c.paths,
				regions: c.paths.map((path) => ({
					path,
					regions: [{
						baseStart: 40,
						baseLines: 3,
						oursStart: 40,
						oursLines: 4,
						theirsStart: 40,
						theirsLines: 5,
					}],
				})),
				conflictsWith: c.conflictsWith,
			});
		}
		for (const v of o.vetoed ?? []) {
			b.outcomes.set(v.changeId, "vetoed");
			release(v.changeId);
			append("land.vetoed", {
				batchId,
				attempt: 1,
				changeId: v.changeId,
				inst: "i_01k6gggggggggggggggggggggg",
				message: v.message,
			});
		}
		const survivors = b.request.batch.filter((c) =>
			b.outcomes.get(c.changeId) === "pending"
		);
		if (o.failed) {
			for (const c of survivors) release(c.changeId);
			b.state = "failed";
			b.result = { reason: o.failed.reason, failing: o.failed.failing ?? [] };
			append("land.failed", {
				batchId,
				attempt: 1,
				reason: o.failed.reason,
				...(o.failed.failing ? { failing: o.failed.failing } : {}),
			}, { deliver });
			return;
		}
		const old = state.trunk;
		const landed = survivors.map((c) => {
			state.commits += 1;
			const commit = shaOf(0xc0000 + state.commits);
			state.trunk = commit;
			b.outcomes.set(c.changeId, "landed");
			b.commits.set(c.changeId, commit);
			lanes.get(c.laneId)!.state = "landed";
			return { changeId: c.changeId, laneId: c.laneId, commit };
		});
		b.state = landed.length > 0
			? "landed"
			: (o.conflicted?.length ? "conflicted" : "vetoed");
		if (landed.length > 0) {
			append("ref.advanced", {
				ref: trunk,
				old,
				new: state.trunk,
				advanceId: `adv_${batchId.slice(3)}_1`,
				changes: landed,
				reasonEvents: b.request.reason.events,
				evidenceReused: false,
			}, { deliver });
		}
		append("land.completed", {
			batchId,
			attempt: 1,
			landed: landed.map((l) => ({ changeId: l.changeId, commit: l.commit })),
			conflicted: (o.conflicted ?? []).map((c) => c.changeId),
			vetoed: (o.vetoed ?? []).map((v) => v.changeId),
		}, { deliver });
	};

	/** Delivers pending kernel events in log order. */
	const deliver = async (): Promise<void> => {
		while (outbox.length > 0) {
			const ev = outbox.shift()!;
			await harness.event(ev);
		}
	};

	/** The pending train timer, if any. */
	const tickAt = (): number | undefined => harness.recorder.timers.get("tick");

	/**
	 * Delivers events and runs every tick due within `horizonMs` (advancing the
	 * clock), until nothing is due. The watchdog tick (minutes away) stays.
	 */
	const settle = async (horizonMs = 30_000): Promise<void> => {
		for (let i = 0; i < 200; i += 1) {
			await deliver();
			const at = tickAt();
			if (at === undefined || at > clock.now + horizonMs) return;
			clock.now = Math.max(clock.now, at);
			harness.recorder.timers.delete("tick");
			await harness.timer("tick");
		}
		throw new Error("settle: the train did not come to rest");
	};

	/** Runs the pending tick now, whatever its time (a fired watchdog). */
	const fireTick = async (): Promise<void> => {
		const at = tickAt();
		if (at === undefined) throw new Error("no tick pending");
		clock.now = Math.max(clock.now, at);
		harness.recorder.timers.delete("tick");
		await harness.timer("tick");
		await deliver();
	};

	const inFlight = (): string[] =>
		[...batches].filter(([, b]) =>
			!["landed", "conflicted", "vetoed", "failed", "cancelled"].includes(
				b.state,
			)
		).map(([id]) => id);

	const emittedOf = (type: string): Emitted[] =>
		emitted.filter((e) => e.type === type);

	return {
		clock,
		log,
		lanes,
		changes,
		batches,
		submits,
		violations,
		refusals,
		emitted,
		notices,
		work,
		maintainers,
		faults,
		state,
		harness,
		append,
		submitChange,
		pushRevision,
		approve,
		finish,
		deliver,
		/** Queues a held-back event for delivery (a late delivery). */
		release: (ev: Envelope) => {
			outbox.push(ev);
		},
		/** Drops undelivered events (the provider was not subscribed then). */
		discard: (): number => outbox.splice(0).length,
		/** Runs the adoption timer now, then delivers what it caused. */
		adopt: async (): Promise<void> => {
			const at = harness.recorder.timers.get("adopt");
			if (at !== undefined) clock.now = Math.max(clock.now, at);
			harness.recorder.timers.delete("adopt");
			await harness.timer("adopt");
			await deliver();
		},
		/** The pending adoption timer, if any. */
		adoptAt: (): number | undefined => harness.recorder.timers.get("adopt"),
		settle,
		fireTick,
		tickAt,
		inFlight,
		emittedOf,
		/** Entries of the provider's table, for assertions. */
		entries: () =>
			rows<{
				change_id: string;
				state: string;
				batch_id: string | null;
				reason: string | null;
			}>(
				harness.storage,
				"SELECT change_id, state, batch_id, reason FROM entries ORDER BY enqueued_at, change_id",
			),
		close: () => harness.close(),
	};
};
