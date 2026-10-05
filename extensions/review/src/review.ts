// tartan.review behaviour (K4, K13):
//
// - `changes.submitted`/`changes.revised` record the change's latest
//   revision and head; a new revision clears the attention set (its
//   approval would name an older head, K4).
// - `checks.completed` for the latest head assesses the risk with policy at
//   the change's base on trunk (owners rules, project graph) and the lane's
//   diff, then either approves (`review.decided{route:'auto'}`) or asks a
//   human (`review.requested{route:'human'}` + attention set + notices).
//   Failing checks get `request_changes` from the reviewer and a notice.
// - `review_decide` (a user, Maintainer+) records a human decision bound to
//   the latest head; agents and extensions are refused.
// - In `human-required` mode nothing is approved automatically and the
//   `ref.advance` gate vetoes every change without a user's approval of
//   exactly the landed head.
// - `conflicts.*`, `queue.ejected`, `land.vetoed`, `ref.advanced` feed the
//   radar factor and the track record.

import {
	type Actor,
	CHANGES_EVENTS,
	CHECKS_EVENTS,
	conflict,
	CONFLICTS_EVENTS,
	denied,
	type Envelope,
	type ExtCtx,
	type GateDecision,
	type GateInput,
	invalid,
	notFound,
	type RepoRef,
	type Review,
} from "@tartan/contract";
import { requireInteractiveActor } from "@tartan/ext-api";
import {
	type OwnerRule,
	OWNERS_LOCATION,
	OWNERS_POLICY_KEY,
	principalOwners,
	validateOwners,
} from "./owners.ts";
import {
	assessRisk,
	type ChangedFile,
	DEFAULT_THRESHOLD,
	DEFAULT_WEIGHTS,
	type ReviewMode,
	RISK_FACTORS,
	type RiskResult,
	type RiskWeights,
	routeOf,
	testScriptsChanged,
} from "./risk.ts";
import { type ChangeRow, createStore, type ReviewRow } from "./store.ts";

const decoder = new TextDecoder();
const MANIFEST_MAX_BYTES = 256 * 1024;
/** Manifests compared for test-script changes per review; beyond: counted as changed. */
const MANIFESTS_MAX = 20;
const MANIFEST_NAMES = new Set(["package.json"]);
const RULES_SHA_KEY = "rules-sha";

export type ReviewConfig = {
	readonly mode: ReviewMode;
	readonly autoThreshold: number;
	readonly weights: RiskWeights;
};

export const reviewConfigOf = (raw: unknown): ReviewConfig => {
	const c = (raw ?? {}) as {
		mode?: unknown;
		autoThreshold?: unknown;
		weights?: unknown;
	};
	const weights = { ...DEFAULT_WEIGHTS };
	if (c.weights !== null && typeof c.weights === "object") {
		for (const f of RISK_FACTORS) {
			const w = (c.weights as Record<string, unknown>)[f];
			if (typeof w === "number" && Number.isFinite(w) && w >= 0 && w <= 100) {
				weights[f] = w;
			}
		}
	}
	return {
		mode: c.mode === "human-required" ? "human-required" : "by-exception",
		autoThreshold: typeof c.autoThreshold === "number" &&
				c.autoThreshold >= 0 && c.autoThreshold <= 1
			? c.autoThreshold
			: DEFAULT_THRESHOLD,
		weights,
	};
};

const LIST_MAX = 20;
const cap = (v: unknown): unknown =>
	Array.isArray(v) ? v.slice(0, LIST_MAX) : v;

/**
 * The evidence carried by `review.decided` (≤ 16 KB events): factors,
 * reasons and bounded lists; the full bundle stays in `reviews.evidence_json`.
 */
export const eventEvidence = (
	e: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
	const weakened = e.weakened as
		| { deletedTests?: unknown; netTestLines?: unknown }
		| undefined;
	const out: Record<string, unknown> = {
		factors: e.factors,
		forced: e.forced,
		reasons: cap(e.reasons),
		ci: e.ci,
		lines: e.lines,
		policyFiles: cap(e.policyFiles),
		failing: cap(e.failing),
		note: typeof e.note === "string" ? e.note.slice(0, 1000) : undefined,
		affected: Array.isArray(e.affected) ? e.affected.length : undefined,
		global: e.global,
		...(weakened
			? {
				weakened: {
					deletedTests: cap(weakened.deletedTests),
					netTestLines: weakened.netTestLines,
				},
			}
			: {}),
	};
	return Object.fromEntries(
		Object.entries(out).filter(([, v]) => v !== undefined),
	);
};

export const createReviewer = (x: ExtCtx) => {
	const store = createStore(x.sql);
	const config = reviewConfigOf(x.config);
	const shadow = x.install.mode === "shadow";
	const now = () => x.caps.clock.now();

	const text = async (
		repo: RepoRef,
		sha: string,
		path: string,
		max: number,
	): Promise<string | null> => {
		const bytes = await x.caps.repo.readFile(repo, sha, path, max + 1);
		if (bytes === null) return null;
		if (bytes.length > max) return null;
		return decoder.decode(bytes);
	};

	/**
	 * Owner rules at a trunk commit (K13; ADR repo config): `tartan.review`'s repo
	 * policy from the repository's package `tartan`. `rules` is null when they
	 * cannot be read (the config at that commit does not evaluate, or the
	 * value is invalid): every change then goes to a person. `pending`: the
	 * config at that commit is still evaluating.
	 */
	const rulesAt = async (
		repo: RepoRef,
		base: string,
	): Promise<{ rules: OwnerRule[] | null; pending: boolean }> => {
		const answer = await x.caps.repo.policy(repo, base);
		let rules: OwnerRule[] | null;
		let pending = false;
		switch (answer.state) {
			case "none":
				rules = [];
				break;
			case "pending":
				rules = store.rules().rules;
				pending = true;
				break;
			case "expired":
				rules = null;
				break;
			case "ok": {
				if (!answer.exact) {
					rules = null;
					break;
				}
				const value = answer.values[OWNERS_POLICY_KEY];
				if (value === undefined) {
					rules = [];
					break;
				}
				const checked = validateOwners(value);
				if (!checked.ok) {
					x.log.warn("review: invalid owners rules on trunk", {
						where: OWNERS_LOCATION,
						errors: checked.errors.slice(0, 5),
					});
				}
				rules = checked.ok ? [...checked.rules] : null;
			}
		}
		if (!x.readOnly && !pending) {
			store.writeRules(base, rules ?? []);
			x.kv.put(RULES_SHA_KEY, new TextEncoder().encode(base));
		}
		return { rules, pending };
	};

	/** Manifests whose test scripts the change edits (K13: those are policy). */
	const scriptChanges = async (
		repo: RepoRef,
		change: ChangeRow,
		files: readonly ChangedFile[],
	): Promise<string[]> => {
		const manifests = files.filter((f) =>
			MANIFEST_NAMES.has(f.path.slice(f.path.lastIndexOf("/") + 1)) ||
			(f.oldPath !== undefined &&
				MANIFEST_NAMES.has(f.oldPath.slice(f.oldPath.lastIndexOf("/") + 1)))
		);
		const out: string[] = [];
		for (const [i, f] of manifests.entries()) {
			if (i >= MANIFESTS_MAX) {
				out.push(f.path);
				continue;
			}
			const basePath = f.oldPath ?? f.path;
			const base = f.change === "added"
				? null
				: await text(repo, change.base, basePath, MANIFEST_MAX_BYTES);
			const deleted = f.change === "deleted";
			const head = deleted
				? null
				: await text(repo, change.head, f.path, MANIFEST_MAX_BYTES);
			if (testScriptsChanged(base, head, deleted)) out.push(f.path);
		}
		return out;
	};

	/**
	 * Where policy is read for an assessment: the current trunk tip. The
	 * change's base is the lane's merge base, which its owner controls (a
	 * force push can root the lane on an old trunk commit), so owners and
	 * sensitivity rules added to trunk since still apply.
	 * The tip is never older than the base (the base is on trunk); the base
	 * stands in only while trunk has no commit.
	 */
	const policySha = async (repo: RepoRef, base: string): Promise<string> =>
		(await x.caps.repo.info(repo)).trunkSha ?? base;

	/** Risk of the change's latest revision (policy and graph from trunk, K13). */
	const assess = async (change: ChangeRow): Promise<RiskResult> => {
		const repo: RepoRef = { id: repoId() };
		const source = { repoId: repoId(), laneId: change.laneId };
		const policy = await policySha(repo, change.base);
		const [graph, owners, paths, diff] = await Promise.all([
			x.caps.repo.projectGraph(repo, policy),
			rulesAt(repo, policy),
			x.caps.repo.diffPaths(source, change.base, change.head),
			x.caps.repo.diff(
				{ repoId: repoId(), sha: change.base },
				{ ...source, sha: change.head },
			),
		]);
		const lines = new Map(diff.map((f) => [f.path, f]));
		const files: ChangedFile[] = paths.paths.map((p) => ({
			path: p.path,
			...(p.oldPath ? { oldPath: p.oldPath } : {}),
			change: p.change,
			additions: lines.get(p.path)?.additions ?? 0,
			deletions: lines.get(p.path)?.deletions ?? 0,
		}));
		return assessRisk({
			files,
			truncated: paths.truncated,
			graph,
			rules: owners.rules,
			configPending: owners.pending,
			testScriptChanges: await scriptChanges(repo, change, files),
			conflicts: store.openConflictSeverities(change.laneId),
			track: store.track(change.authorId),
		}, config.weights);
	};

	// A repo-scoped installation's repo (`repo:<ulid>` scope); events and
	// slot contexts name it too.
	const scopeRepo = x.install.scopeKey.startsWith("repo:")
		? x.install.scopeKey.slice("repo:".length)
		: undefined;
	let hinted: string | undefined;
	const repoId = (): string => {
		const id = scopeRepo ?? hinted;
		if (id === undefined) throw invalid("review: no repo in context");
		return id;
	};
	const useRepo = (id: string | undefined): void => {
		if (id !== undefined) hinted = id;
	};

	const evidenceOf = (
		r: RiskResult,
		ci: string,
		reasons: readonly string[],
	) => ({
		factors: r.factors,
		forced: r.forced,
		reasons,
		policyFiles: r.policyFiles,
		weakened: r.weakened,
		affected: r.affected.projects,
		global: r.affected.global,
		sensitivePaths: r.sensitivePaths.slice(0, 50),
		owners: r.owners,
		lines: r.lines,
		ci,
		mode: config.mode,
		threshold: config.autoThreshold,
	});

	const attentionOf = (r: RiskResult, change: ChangeRow): string[] => {
		const named = principalOwners(r.owners);
		if (named.length > 0) return named.sort();
		return change.onBehalfOf ? [change.onBehalfOf] : [];
	};

	// -- events ------------------------------------------------------------------

	const onChange = (ev: Envelope): void => {
		const schema = CHANGES_EVENTS[ev.type as "changes.submitted"];
		const parsed = schema.safeParse(ev.data);
		if (!parsed.success) return;
		const d = parsed.data;
		const prev = store.change(d.changeId);
		if (prev !== null && prev.revision > d.revision) return;
		store.tx(() => {
			store.writeChange({
				changeId: d.changeId,
				laneId: d.laneId,
				authorId: ev.actor.id,
				onBehalfOf: ev.actor.onBehalfOf ?? null,
				workRef: d.workRef ?? null,
				revision: d.revision,
				head: d.head,
				base: d.base,
				state: "submitted",
				updatedAt: now(),
			});
			if (prev !== null && prev.revision < d.revision) {
				store.setAttention(d.changeId, [], "revised", now());
			}
		});
	};

	const onChecksCompleted = async (ev: Envelope): Promise<void> => {
		const parsed = CHECKS_EVENTS["checks.completed"].safeParse(ev.data);
		if (!parsed.success || parsed.data.subject.kind !== "change") return;
		const d = parsed.data;
		const change = store.change(d.subject.id);
		if (change === null || change.head !== d.sha) return;
		if (d.state === "cancelled") return;
		const ci = d.state === "failure"
			? "failure"
			: d.cached
			? "cached"
			: "success";
		const existing = store.review(change.changeId, change.revision, shadow);
		// Same head: keep a user's decision, and the reviewer's own while CI
		// says the same; a re-run that turns red or green is judged again.
		if (
			existing !== null && existing.head === change.head &&
			(existing.decidedKind === "user" ||
				(existing.ci === "failure") === (ci === "failure"))
		) {
			if (!existing.notified) await announce(change, existing);
			return;
		}
		if (d.state === "failure") {
			const row: ReviewRow = {
				changeId: change.changeId,
				n: change.revision,
				head: change.head,
				risk: 1,
				factors: {},
				route: "auto",
				decision: "request_changes",
				decidedBy: x.actor.id,
				decidedKind: x.actor.kind,
				evidence: {
					ci: "failure",
					reasons: ["checks failed"],
					failing: d.contexts.filter((c) => c.state === "failure").map((c) =>
						c.context
					),
				},
				shadow,
				ci: "failure",
				notified: false,
				at: now(),
			};
			store.writeReview(row);
			return await announce(change, row);
		}
		await judge(change, ci);
	};

	/** Assesses the risk of a change's head and records the route (after CI). */
	const judge = async (
		change: ChangeRow,
		ci: "success" | "cached" | "failure",
	): Promise<void> => {
		const risk = await assess(change);
		const route = routeOf(risk, config.mode, config.autoThreshold);
		const reasons = [
			...risk.forced,
			...(config.mode === "human-required" ? ["human-required"] : []),
			...(route === "human" && risk.forced.length === 0 &&
					config.mode === "by-exception"
				? [`risk ${risk.risk} ≥ ${config.autoThreshold}`]
				: []),
		];
		const row: ReviewRow = {
			changeId: change.changeId,
			n: change.revision,
			head: change.head,
			risk: risk.risk,
			factors: risk.factors,
			route,
			decision: route === "auto" ? "approve" : null,
			decidedBy: route === "auto" ? x.actor.id : null,
			decidedKind: route === "auto" ? x.actor.kind : null,
			evidence: {
				...evidenceOf(risk, ci, reasons),
				attention: route === "human" ? attentionOf(risk, change) : [],
			},
			shadow,
			ci,
			notified: false,
			at: now(),
		};
		store.tx(() => {
			store.writeReview(row);
			if (route === "human" && !shadow) {
				store.setAttention(
					change.changeId,
					attentionOf(risk, change),
					reasons.join(", ") || "review",
					now(),
				);
			}
		});
		await announce(change, row);
	};

	/**
	 * `repo.config.resolved`: trunk's Tartan config left `pending`, so changes
	 * routed to a person only because it was still evaluating are judged
	 * again (a person's own decision is never replaced).
	 */
	const onConfigResolved = async (ev: Envelope): Promise<void> => {
		if (ev.source.kind !== "kernel") return;
		for (const row of store.waiting(shadow)) {
			const reasons = (row.evidence as { reasons?: unknown }).reasons;
			if (!Array.isArray(reasons) || !reasons.includes("config-pending")) {
				continue;
			}
			const change = store.change(row.changeId);
			if (change === null || change.head !== row.head) continue;
			if (row.ci !== "success" && row.ci !== "cached") continue;
			await judge(change, row.ci);
		}
	};

	/** Emits the review's event, notices and note section (idempotent until `notified`). */
	const announce = async (change: ChangeRow, row: ReviewRow): Promise<void> => {
		const repoRef: RepoRef = { id: repoId() };
		const subject = { kind: "change", id: change.changeId };
		const key = `${change.changeId}:${row.n}:${row.head}`;
		if (row.decision !== null) {
			const decidedBy: Actor = row.decidedKind === "user" ||
					row.decidedKind === "agent" || row.decidedKind === "system"
				? { kind: row.decidedKind, id: row.decidedBy! }
				: x.actor;
			await x.caps.events.emit("review.decided", {
				changeId: change.changeId,
				revision: row.n,
				head: row.head,
				decision: row.decision,
				route: row.route,
				risk: row.risk,
				decidedBy,
				evidence: eventEvidence(row.evidence),
			}, {
				subject,
				idemKey:
					`review.decided:${key}:${row.decision}:${row.decidedBy}:${row.at}`,
			});
			if (!shadow && row.decision === "approve") {
				await x.caps.notes.contribute(repoRef, change.changeId, {
					route: row.route,
					risk: row.risk,
					factors: row.factors,
					...(row.route === "human" ? { decidedBy: row.decidedBy } : {}),
				});
			}
			if (!shadow && row.decision === "request_changes") {
				await notify(
					[change.authorId, ...(change.onBehalfOf ? [change.onBehalfOf] : [])],
					change,
					"warn",
					`Changes requested on ${change.changeId} r${row.n}: ${
						(row.evidence.reasons as string[] | undefined)?.join(", ") ??
							"see the review"
					}`,
					`review:${key}:rc`,
				);
			}
		} else {
			const attention = (row.evidence.attention as string[] | undefined) ?? [];
			await x.caps.events.emit("review.requested", {
				changeId: change.changeId,
				revision: row.n,
				head: row.head,
				route: "human",
				attentionSet: attention,
				risk: row.risk,
				factors: row.factors,
			}, { subject, idemKey: `review.requested:${key}:${row.at}` });
			if (!shadow) {
				await notify(
					attention,
					change,
					"info",
					`Review needed: change ${change.changeId} r${row.n} (risk ${row.risk}; ${
						(row.evidence.reasons as string[] | undefined)?.join(", ") ||
						"review"
					})`,
					`review:${key}:req`,
				);
			}
		}
		store.writeReview({ ...row, notified: true });
	};

	const notify = async (
		principals: readonly string[],
		change: ChangeRow,
		severity: "info" | "warn",
		message: string,
		dedupeKey: string,
	): Promise<void> => {
		for (const p of new Set(principals)) {
			try {
				await x.caps.notify.send(p, {
					repo: { id: repoId() },
					laneId: change.laneId,
					kind: "review",
					severity,
					text: message,
					data: { changeId: change.changeId },
					dedupeKey,
				});
			} catch (e) {
				x.log.warn("review: notify failed", { principal: p, error: String(e) });
			}
		}
	};

	const onConflict = (ev: Envelope): void => {
		const at = now();
		if (ev.type === "conflicts.detected") {
			const p = CONFLICTS_EVENTS["conflicts.detected"].safeParse(ev.data);
			if (!p.success) return;
			store.upsertConflict(
				p.data.conflictId,
				p.data.a,
				p.data.b,
				p.data.severity,
				"open",
				at,
			);
		} else if (ev.type === "conflicts.escalated") {
			const p = CONFLICTS_EVENTS["conflicts.escalated"].safeParse(ev.data);
			if (p.success) {
				store.updateConflict(p.data.conflictId, { severity: p.data.to }, at);
			}
		} else if (ev.type === "conflicts.acked") {
			const p = CONFLICTS_EVENTS["conflicts.acked"].safeParse(ev.data);
			if (p.success) {
				store.updateConflict(p.data.conflictId, { state: "acked" }, at);
			}
		} else if (ev.type === "conflicts.cleared") {
			const p = CONFLICTS_EVENTS["conflicts.cleared"].safeParse(ev.data);
			if (p.success) {
				store.updateConflict(p.data.conflictId, { state: "cleared" }, at);
			}
		}
	};

	const authorOf = (changeId: unknown): string | null =>
		typeof changeId === "string"
			? store.change(changeId)?.authorId ?? null
			: null;

	const onTrack = (ev: Envelope): void => {
		const d = ev.data as {
			changeId?: unknown;
			changes?: { changeId?: unknown }[];
		};
		if (ev.type === "queue.ejected" || ev.type === "land.vetoed") {
			if (ev.type === "land.vetoed" && ev.source.kind !== "kernel") return;
			const author = authorOf(d.changeId);
			if (author) {
				store.bump(
					ev.id,
					author,
					ev.type === "queue.ejected" ? "ejected" : "vetoed",
				);
			}
			return;
		}
		if (ev.type === "ref.advanced" && ev.source.kind === "kernel") {
			for (const c of d.changes ?? []) {
				const author = authorOf(c.changeId);
				if (author === null) continue;
				store.bump(ev.id, author, "landed");
				store.setChangeState(String(c.changeId), "landed", now());
				store.setAttention(String(c.changeId), [], "landed", now());
			}
		}
	};

	// -- tools -------------------------------------------------------------------

	const reviewDto = (change: ChangeRow, row: ReviewRow | null): Review => ({
		changeId: change.changeId,
		revision: change.revision,
		head: change.head,
		risk: row?.risk ?? 0,
		factors: row?.factors ?? {},
		route: row?.route ?? "human",
		attentionSet: store.attention(change.changeId),
		...(row?.decision ? { decision: row.decision } : {}),
		...(row?.decision && row.decidedBy && row.decidedKind
			? {
				decidedBy: {
					kind: row.decidedKind as Actor["kind"],
					id: row.decidedBy,
				},
			}
			: {}),
		evidence: row?.evidence ?? { pending: "waiting for checks" },
	});

	const get = (changeId: string): Review => {
		const change = store.change(changeId);
		if (change === null) {
			throw notFound(`change ${changeId} is not under review`);
		}
		return reviewDto(change, store.review(changeId, change.revision, shadow));
	};

	const queue = (mine: boolean): Review[] => {
		const ids = mine ? new Set(store.attentionFor(x.actor.id)) : null;
		return store.waiting(shadow)
			.filter((r) => ids === null || ids.has(r.changeId))
			.flatMap((r) => {
				const change = store.change(r.changeId);
				return change ? [reviewDto(change, r)] : [];
			});
	};

	/**
	 * A human decision: only a user actor with `approve` (Maintainer+)
	 * at the repo counts, bound to the latest revision's head (K4).
	 */
	const decide = async (args: {
		changeId: string;
		decision: "approve" | "request_changes";
		revision?: number;
		note?: string;
	}): Promise<Review> => {
		requireInteractiveActor(x, "review_decide");
		if (x.actor.kind !== "user") {
			throw denied(
				"actor",
				"review_decide: only a user's decision counts; agents and extensions cannot approve",
			);
		}
		const change = store.change(args.changeId);
		if (change === null) {
			throw notFound(`change ${args.changeId} is not under review`);
		}
		if (change.state !== "submitted") {
			throw conflict(`change ${args.changeId} is ${change.state}`);
		}
		if (args.revision !== undefined && args.revision !== change.revision) {
			throw conflict(
				`revision ${args.revision} is not the latest (r${change.revision}); review the latest head`,
			);
		}
		const allowed = await x.caps.authz.check(
			x.actor.id,
			{ id: repoId() },
			"approve",
		);
		if (!allowed) {
			throw denied("role", "review_decide: needs Maintainer or above");
		}
		const prev = store.review(change.changeId, change.revision, shadow);
		const row: ReviewRow = {
			changeId: change.changeId,
			n: change.revision,
			head: change.head,
			risk: prev?.risk ?? 0,
			factors: prev?.factors ?? {},
			route: "human",
			decision: args.decision,
			decidedBy: x.actor.id,
			decidedKind: "user",
			evidence: {
				...(prev?.evidence ?? {}),
				...(args.note ? { note: args.note } : {}),
				...(prev && prev.route === "auto" ? { overrides: "auto" } : {}),
			},
			shadow,
			ci: prev?.ci ?? null,
			notified: false,
			at: now(),
		};
		store.tx(() => {
			store.writeReview(row);
			store.setAttention(change.changeId, [], "decided", now());
		});
		await announce(change, row);
		return reviewDto(
			change,
			store.review(change.changeId, change.revision, shadow),
		);
	};

	/** `ref.advance` (human-required mode only; by-exception always allows). */
	const gate = (input: GateInput): GateDecision => {
		if (input.point !== "ref.advance") {
			return { decision: "allow", message: "not a review gate point" };
		}
		if (config.mode !== "human-required") {
			return {
				decision: "allow",
				message: "review by exception: approvals travel as review.decided",
			};
		}
		// Approvals bind to the lane head (K4); LandWorkflow's `head` is the
		// composed squash commit, so the lane head comes in `laneHead`.
		const approved = input.laneHead ?? input.head;
		const approval = store.userApproval(input.changeId, approved);
		if (approval === null) {
			return {
				decision: "veto",
				message:
					`human-required review: change ${input.changeId} has no user approval of ${
						approved.slice(0, 7)
					}`,
			};
		}
		return {
			decision: "allow",
			message: `approved by ${approval.decidedBy} (r${approval.n})`,
		};
	};

	/** The cached rules (read at the latest base), for context@1. */
	const cachedRules = (): { sha: string | null; rules: OwnerRule[] } => {
		const sha = x.kv.get(RULES_SHA_KEY);
		return {
			sha: sha === null ? null : decoder.decode(sha),
			rules: store.rules().rules,
		};
	};

	return {
		store,
		config,
		useRepo,
		onChange,
		onChecksCompleted,
		onConfigResolved,
		onConflict,
		onTrack,
		get,
		queue,
		decide,
		gate,
		assess,
		cachedRules,
	};
};
export type Reviewer = ReturnType<typeof createReviewer>;
