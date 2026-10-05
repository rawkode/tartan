// The lane-repo seeder (WP5b; fallback rules, bounds).
//
// A `repo` lane is `opening` until one seed attempt verifies. Every attempt
// is FENCED by `lanes.seed_attempt`: starting attempt n+1 is the CAS
// `seed_attempt = n → n+1 WHERE state = 'opening'`, and every later
// transition of an attempt (phase, open, failure, the `branch` fallback) is
// conditioned on `(state = 'opening', seed_attempt = n)`. A stale
// continuation (a late import result, a retried RPC, a second driver, the
// watchdog racing the runner) therefore never reopens a closed lane,
// overwrites a fallback or opens the lane on a superseded repo. Each attempt
// uses a fresh repo name (`laneArtifactsName(repo, lane, n)`), so an import
// that completes after its JS-side timeout lands in a repo no lane owns
// (the orphan sweep's).
//
// - `planOpening` runs inside WP5a's open transaction (no I/O) and writes
//   attempt 1's history row.
// - `startAttempt` runs attempt 1 detached; at most `LANE_SEED_CONCURRENCY`
//   attempts run per repo at once, more queue.
// - An attempt: the index upsert first (the forge ceiling ⇒ `branch`), then
//   `import()` from a freshly minted capability URL (its 24 h token is
//   dropped unread), then verification by SHA (K15) and `readTip` = base,
//   then the open CAS.
// - The `seed:<laneId>` watchdog (and the cron's re-drive) never awaits an
//   import and never throws: past the deadline it probes the
//   current attempt's repo (verified ⇒ open, so an eviction between import
//   and verify needs no second import) or fails the attempt and starts the
//   next one detached.

import {
	capPath,
	conflict,
	invalid,
	isIdOf,
	isLanePlatformFault,
	LANE_LEASE_MS,
	LANE_REPO_HEAD_REF,
	laneArtifactsName,
	laneBranchRef,
	type LaneMode,
	type LaneSeed,
	type LaneSeedFailCode,
	SYS_KERNEL,
	ZERO_SHA,
} from "@tartan/contract";
import {
	type KernelWriteRow,
	type LaneOpeningPlan,
	type LaneRow,
	SEED_TIMER_PREFIX,
	seedTimerKey,
} from "@tartan/contract/kernel.ts";
import {
	IMPORT_TOO_LARGE_TTL_MS,
	LANE_CAP_TTL_S,
	LANE_SEED_CONCURRENCY,
} from "../../../../constants.ts";
import { first, getMeta, getMetaNumber, rows, setMeta } from "../../core.ts";
import { laneEventData } from "../rows.ts";
import {
	attemptBase,
	attemptRow,
	attemptsOf,
	configuredMode,
	type Ctx,
	emit,
	endAttempt,
	errorText,
	identity,
	insertAttempt,
	isCurrent,
	lane as laneOf,
	laneRepoRefs,
	notifyOwner,
	setAttemptRemote,
	trunkTip,
} from "./context.ts";
import {
	attemptDeadline,
	type AttemptOutcome,
	classifyImportFailure,
	firstSeed,
	importTimeoutMs,
	nextAfterFailure,
	nextOf,
	type NextStep,
	parseBreaker,
	recordStrike,
	REDRIVE_AFTER_MS,
	START_PHASE,
	strikeOf,
	VERIFY_BUDGET_MS,
	WATCHDOG_BUDGET_MS,
} from "./plan.ts";

/** A promise that rejects with `TimedOut` after `ms`. */
class TimedOut extends Error {
	constructor(readonly ms: number) {
		super(`timed out after ${ms} ms`);
	}
}

const within = async <T>(work: Promise<T>, ms: number): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new TimedOut(ms)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};

/** A tiny per-RepoDO semaphore (`LANE_SEED_CONCURRENCY`). */
const createLimiter = (limit: number) => {
	let running = 0;
	const queue: (() => void)[] = [];
	const release = () => {
		running--;
		queue.shift()?.();
	};
	return async <T>(work: () => Promise<T>): Promise<T> => {
		if (running >= limit) {
			await new Promise<void>((resolve) => queue.push(resolve));
		}
		running++;
		try {
			return await work();
		} finally {
			release();
		}
	};
};

/**
 * How long the watchdog defers an attempt still queued in this isolate: past
 * this the limiter is taken to be wedged and the attempt fails as before.
 */
const QUEUED_MAX_MS = 150_000;

/** What the lane is: an `opening` lane's attempt result, after a transition committed. */
type Settled =
	| { readonly kind: "open"; readonly row: LaneRow }
	| { readonly kind: "branch"; readonly row: LaneRow; readonly code: string }
	| {
		readonly kind: "next";
		readonly attempt: number;
		readonly delayMs: number;
	}
	| { readonly kind: "stale" };

const MESSAGES: Readonly<Record<string, string>> = {
	"lane-too-large":
		"The repository is too large to give this lane its own repository with import(); it opened as a branch lane (refs/heads/lanes/<id>) in the canonical repository.",
	"lane-repo-ceiling":
		"The forge holds as many lane repositories as it may retain; this lane opened as a branch lane (refs/heads/lanes/<id>) in the canonical repository.",
	"degraded":
		"Recent lane seeds in this repository failed, so new lanes skip the failing seed for an hour.",
};

const noticeText = (code: string): string =>
	MESSAGES[code] ??
		`This lane could not get its own repository (${code}) and opened as a branch lane (refs/heads/lanes/<id>) in the canonical repository.`;

export const createSeeder = (
	ctx: Ctx,
	hooks: {
		/** Set when the index upsert before an attempt finds the ceiling reached. */
		readonly ceilingCache: { reached: boolean; at: number };
	},
) => {
	const limit = createLimiter(LANE_SEED_CONCURRENCY);
	const timers = ctx.deps.timers;
	/**
	 * Attempts this isolate scheduled that have not started yet (the backoff
	 * sleep, the per-repo limiter), with when they were queued: the watchdog
	 * defers them instead of failing an attempt that never ran.
	 */
	const queued = new Map<string, number>();
	const queuedKey = (laneId: string, attempt: number) => `${laneId}:${attempt}`;

	const repoUlid = () => identity(ctx).repoId;
	const laneUlidOf = (laneId: string) => laneId.slice(3);

	// -----------------------------------------------------------------------
	// Lease timer (K7): WP5a's `lease` handler recomputes; we only make sure
	// it fires no later than this lane's expiry.
	// -----------------------------------------------------------------------

	const armLease = (at: number): void => {
		const current = timers.get("lease");
		if (current === null || current > at) timers.schedule("lease", at);
	};

	// -----------------------------------------------------------------------
	// planOpening (inside WP5a's open transaction)
	// -----------------------------------------------------------------------

	const CEILING_CACHE_MS = 60_000;

	const planOpening = (laneId: string, now: number): LaneOpeningPlan => {
		if (!isIdOf("lane", laneId)) throw invalid(`not a lane id: ${laneId}`);
		const configured = configuredMode(ctx);
		const ceiling = hooks.ceilingCache;
		const first = firstSeed({
			configured,
			chain: ctx.ports.chain,
			now,
			breaker: parseBreaker(getMeta(ctx.sql, "lane_breaker")),
			tooLargeUntil: getMetaNumber(ctx.sql, "import_too_large_until"),
			packBytes: getMetaNumber(ctx.sql, "trunk_pack_bytes"),
			ceilingReached: ceiling.reached && now - ceiling.at < CEILING_CACHE_MS,
		});
		if (first.mode === "branch") {
			return first.reason === undefined
				? { mode: "branch" }
				: { mode: "branch", reason: first.reason };
		}
		const base = attemptBase(ctx);
		if (base === ZERO_SHA) throw conflict("the repo has no trunk yet");
		const seed: LaneSeed = first.mode;
		const repoName = laneArtifactsName(repoUlid(), laneUlidOf(laneId), 1);
		insertAttempt(ctx, {
			lane_id: laneId,
			attempt: 1,
			seed,
			repo_name: repoName,
			base_sha: base,
			started_at: now,
		});
		return {
			mode: "repo",
			seed,
			seedPhase: START_PHASE,
			seedDeadline: attemptDeadline(
				now,
				getMetaNumber(ctx.sql, "trunk_pack_bytes"),
			),
			repoName,
			capNonce: ctx.ports.nonce(),
			base,
		};
	};

	// -----------------------------------------------------------------------
	// Transitions (each one transaction, fenced on (opening, n))
	// -----------------------------------------------------------------------

	const latestSeedIntent = (laneId: string): KernelWriteRow | null =>
		first<KernelWriteRow>(
			ctx.sql,
			`SELECT * FROM kernel_writes WHERE target = ? AND purpose = 'lane-seed'
			 ORDER BY created_at DESC, id DESC LIMIT 1`,
			laneId,
		);

	const openSeedIntents = (laneId: string): KernelWriteRow[] =>
		rows<KernelWriteRow>(
			ctx.sql,
			`SELECT * FROM kernel_writes WHERE target = ? AND purpose = 'lane-seed'
			 AND state IN ('intent','pushed')`,
			laneId,
		);

	const setPhase = (
		laneId: string,
		attempt: number,
		from: string,
		to: string,
	): boolean =>
		ctx.tx(() =>
			ctx.sql.exec(
				`UPDATE lanes SET seed_phase = ? WHERE id = ? AND state = 'opening'
				 AND seed_attempt = ? AND seed_phase = ? RETURNING id`,
				to,
				laneId,
				attempt,
				from,
			).toArray().length === 1
		);

	/**
	 * Starts attempt n's watchdog clock now: the deadline planned when the
	 * attempt was scheduled also covered its wait in the limiter and the
	 * control bucket, so a queued attempt could time out before it ran. The
	 * deadline only ever moves later.
	 */
	const rearm = (laneId: string, attempt: number): void => {
		const deadline = attemptDeadline(
			ctx.now(),
			getMetaNumber(ctx.sql, "trunk_pack_bytes"),
		);
		ctx.tx(() => {
			const moved = ctx.sql.exec(
				`UPDATE lanes SET seed_deadline = ? WHERE id = ? AND state = 'opening'
				 AND seed_attempt = ? AND (seed_deadline IS NULL OR seed_deadline < ?)
				 RETURNING id`,
				deadline,
				laneId,
				attempt,
				deadline,
			).toArray();
			if (moved.length === 1) timers.schedule(seedTimerKey(laneId), deadline);
		});
	};

	const history = (laneId: string): AttemptOutcome[] =>
		attemptsOf(ctx, laneId).filter((a) => a.outcome !== null).map((a) => ({
			attempt: a.attempt,
			seed: a.seed,
			code: a.code as LaneSeedFailCode | null,
		}));

	/** Strike accounting when a lane leaves `opening` (inside the transaction). */
	const account = (row: LaneRow, final: LaneMode): void => {
		const attempts = attemptsOf(ctx, row.id);
		if (attempts.length === 0) return;
		const code = strikeOf({
			firstSeed: attempts[0].seed,
			final,
			attempts: attempts.map((a) => ({
				attempt: a.attempt,
				seed: a.seed,
				code: a.code as LaneSeedFailCode | null,
			})),
		});
		if (code === null) return;
		const now = ctx.now();
		const state = parseBreaker(getMeta(ctx.sql, "lane_breaker"));
		// What a lane opened now would try first (the ceiling aside, which is
		// no seed's fault): a strike from a lane that started under another
		// mode is left over from a degradation already applied.
		const effective = firstSeed({
			configured: configuredMode(ctx),
			chain: ctx.ports.chain,
			now,
			breaker: state,
			tooLargeUntil: getMetaNumber(ctx.sql, "import_too_large_until"),
			packBytes: getMetaNumber(ctx.sql, "trunk_pack_bytes"),
			ceilingReached: false,
		}).mode;
		const update = recordStrike({
			state,
			strike: { at: now, laneId: row.id, code },
			firstSeed: attempts[0].seed,
			effective,
			chain: ctx.ports.chain,
		});
		setMeta(ctx.sql, "lane_breaker", JSON.stringify(update.state));
		if (update.degraded !== undefined) {
			emit(ctx, { type: "lane.mode_degraded", data: update.degraded });
			degradedNotice = update.degraded;
		}
	};
	/**
	 * A degradation recorded by the transition running now: reset before each
	 * transition's transaction and read once after it committed, so a
	 * rolled-back transition never sends the Owner notice.
	 */
	let degradedNotice: { from: LaneMode; to: LaneMode; until: number } | null =
		null;

	const openSync = (laneId: string, attempt: number): LaneRow | null => {
		const before = laneOf(ctx, laneId);
		if (!isCurrent(before, attempt) || before.repo_name === null) return null;
		const now = ctx.now();
		const seedMs = Math.max(0, now - before.created_at);
		const opened = ctx.sql.exec(
			`UPDATE lanes SET state = 'open', head_sha = base_sha, cap_nonce = NULL,
			   seed_phase = NULL, seed_deadline = NULL, seed_ms = ?, lease_expires_at = ?
			 WHERE id = ? AND state = 'opening' AND seed_attempt = ? RETURNING id`,
			seedMs,
			now + LANE_LEASE_MS,
			laneId,
			attempt,
		).toArray();
		if (opened.length !== 1) return null;
		const intent = latestSeedIntent(laneId);
		if (
			intent !== null && intent.new_sha === before.base_sha &&
			(intent.state === "intent" || intent.state === "pushed")
		) {
			ctx.deps.core.internal.markKernelWriteSync(intent.id, "pushed");
		}
		endAttempt(ctx, laneId, attempt, "open", null);
		timers.cancel(seedTimerKey(laneId));
		armLease(now + LANE_LEASE_MS);
		const row = laneOf(ctx, laneId) as LaneRow;
		emit(ctx, {
			type: "lane.opened",
			subject: { kind: "lane", id: laneId },
			data: laneEventData(row, { seedMs }),
		});
		account(row, row.seed ?? "import");
		return row;
	};

	const fallbackSync = (
		laneId: string,
		attempt: number,
		code: string,
	): LaneRow | null => {
		const before = laneOf(ctx, laneId);
		if (!isCurrent(before, attempt)) return null;
		const now = ctx.now();
		const base = trunkTip(ctx);
		const moved = ctx.sql.exec(
			`UPDATE lanes SET mode = 'branch', repo_name = NULL, seed = NULL, cap_nonce = NULL,
			   cap_uses = 0, cap_consumed_at = NULL, cap_outcome = NULL, seed_phase = NULL,
			   seed_deadline = NULL, ref = ?, head_sha = NULL, base_sha = ?, state = 'open',
			   lease_expires_at = ?
			 WHERE id = ? AND state = 'opening' AND seed_attempt = ? RETURNING id`,
			laneBranchRef(laneId),
			base === ZERO_SHA ? before.base_sha : base,
			now + LANE_LEASE_MS,
			laneId,
			attempt,
		).toArray();
		if (moved.length !== 1) return null;
		for (const intent of openSeedIntents(laneId)) {
			ctx.deps.core.internal.markKernelWriteSync(intent.id, "abandoned");
		}
		timers.cancel(seedTimerKey(laneId));
		armLease(now + LANE_LEASE_MS);
		const row = laneOf(ctx, laneId) as LaneRow;
		emit(ctx, {
			type: "lane.opened",
			subject: { kind: "lane", id: laneId },
			data: laneEventData(row, { reason: code }),
		});
		account(row, "branch");
		return row;
	};

	/** The CAS n → n+1 with a fresh name, nonce, base, intent and watchdog. */
	const startNextSync = (
		before: LaneRow,
		attempt: number,
		seed: LaneSeed,
		delayMs: number,
	): number | null => {
		const next = attempt + 1;
		const now = ctx.now();
		const startAt = now + delayMs;
		const base = attemptBase(ctx);
		if (base === ZERO_SHA) return null;
		const name = laneArtifactsName(repoUlid(), laneUlidOf(before.id), next);
		const nonce = ctx.ports.nonce();
		const deadline = attemptDeadline(
			startAt,
			getMetaNumber(ctx.sql, "trunk_pack_bytes"),
		);
		const moved = ctx.sql.exec(
			`UPDATE lanes SET seed_attempt = ?, seed = ?, seed_phase = ?, seed_deadline = ?,
			   repo_name = ?, cap_nonce = ?, cap_uses = 0, cap_consumed_at = NULL,
			   cap_outcome = NULL, base_sha = ?
			 WHERE id = ? AND state = 'opening' AND seed_attempt = ? RETURNING id`,
			next,
			seed,
			START_PHASE,
			deadline,
			name,
			nonce,
			base,
			before.id,
			attempt,
		).toArray();
		if (moved.length !== 1) return null;
		const previous = latestSeedIntent(before.id);
		ctx.deps.core.internal.registerKernelWriteSync({
			target: before.id,
			ref: LANE_REPO_HEAD_REF,
			expectOld: ZERO_SHA,
			newSha: base,
			purpose: "lane-seed",
			ownerKind: "kernel",
			ownerId: before.id,
			...(previous !== null ? { supersedes: previous.id } : {}),
		});
		insertAttempt(ctx, {
			lane_id: before.id,
			attempt: next,
			seed,
			repo_name: name,
			base_sha: base,
			started_at: startAt,
		});
		timers.schedule(seedTimerKey(before.id), deadline);
		return next;
	};

	/** Ends attempt `n` with `code` and moves the lane on (one transaction). */
	const failSync = (
		laneId: string,
		attempt: number,
		code: LaneSeedFailCode,
	): Settled => {
		const before = laneOf(ctx, laneId);
		if (!isCurrent(before, attempt) || before.seed === null) {
			return { kind: "stale" };
		}
		const earlier = history(laneId).filter((a) => a.attempt < attempt);
		endAttempt(ctx, laneId, attempt, "failed", code);
		if (code === "lane-too-large") {
			setMeta(
				ctx.sql,
				"import_too_large_until",
				ctx.now() + IMPORT_TOO_LARGE_TTL_MS,
			);
		}
		// A lane the kernel owns is the post-claim self-test's probe: one
		// attempt, no retry and no later seed (it ends on `branch` at once).
		const step: NextStep = before.owner_principal === SYS_KERNEL
			? { kind: "branch" }
			: nextAfterFailure({
				failed: { attempt, seed: before.seed, code },
				history: earlier,
				chain: ctx.ports.chain,
			});
		emit(ctx, {
			type: "lane.seed_failed",
			subject: { kind: "lane", id: laneId },
			data: {
				laneId,
				seed: before.seed,
				code,
				attempt,
				next: nextOf(step),
				platformFault: isLanePlatformFault(code),
			},
		});
		if (step.kind === "branch") {
			const row = fallbackSync(laneId, attempt, code);
			return row === null ? { kind: "stale" } : { kind: "branch", row, code };
		}
		const next = startNextSync(before, attempt, step.seed, step.delayMs);
		if (next === null) {
			const row = fallbackSync(laneId, attempt, code);
			return row === null ? { kind: "stale" } : { kind: "branch", row, code };
		}
		return { kind: "next", attempt: next, delayMs: step.delayMs };
	};

	// -----------------------------------------------------------------------
	// After a transition committed
	// -----------------------------------------------------------------------

	const afterSettled = (settled: Settled, laneId: string): void => {
		const degraded = degradedNotice;
		degradedNotice = null;
		if (degraded !== null) noticeDegraded(degraded);
		switch (settled.kind) {
			case "open": {
				ctx.deps.core.releaseLaneWaiters(laneId);
				const row = settled.row;
				ctx.detach("index upsert (live) failed", async () => {
					if (row.repo_name === null) return;
					await ctx.deps.forgeTree().indexArtifacts({
						name: row.repo_name,
						kind: "lane",
						repoId: repoUlid(),
						laneId,
						state: "live",
					});
				});
				return;
			}
			case "branch": {
				ctx.deps.core.releaseLaneWaiters(laneId);
				notifyOwner(
					ctx,
					settled.row,
					noticeText(settled.code),
					settled.code === "lane-repo-ceiling" ||
						settled.code === "lane-too-large"
						? settled.code
						: "lane-seed-failed",
				);
				return;
			}
			case "next":
				schedule(laneId, settled.attempt, settled.delayMs);
				return;
			case "stale":
				return;
		}
	};

	const noticeDegraded = (
		degraded: { from: LaneMode; to: LaneMode; until: number },
	): void => {
		ctx.detach("degradation notice failed", async () => {
			const id = identity(ctx);
			const grants = await ctx.deps.forgeTree().grants(id.nodeId).catch(
				() => [],
			);
			const owners = [
				...new Set(
					grants.filter((g) => g.role >= 50).map((g) => g.principal_id),
				),
			];
			await Promise.all(owners.map((owner) =>
				ctx.ports.notify(owner, {
					repoId: id.repoId,
					kind: "system",
					severity: "warn",
					text:
						`Lane seeds failed for several lanes of ${id.path}; new lanes use ${degraded.to} instead of ${degraded.from} until ${
							new Date(degraded.until).toISOString()
						}.`,
					data: { code: "lane-mode-degraded", ...degraded },
					dedupeKey: `lane-mode-degraded:${id.repoId}:${degraded.until}`,
					source: "kernel",
					sourceLabel: "lanes",
				}).catch(() => {})
			));
		});
	};

	const fail = (
		laneId: string,
		attempt: number,
		code: LaneSeedFailCode,
	): void => {
		let settled: Settled;
		try {
			degradedNotice = null;
			settled = ctx.tx(() => failSync(laneId, attempt, code));
		} catch (error) {
			ctx.ports.log("seed failure transition failed", {
				laneId,
				attempt,
				code,
				error: errorText(error),
			});
			return;
		}
		afterSettled(settled, laneId);
	};

	const open = (laneId: string, attempt: number): boolean => {
		degradedNotice = null;
		const row = ctx.tx(() => openSync(laneId, attempt));
		if (row === null) return false;
		afterSettled({ kind: "open", row }, laneId);
		return true;
	};

	const toBranch = (laneId: string, attempt: number, code: string): void => {
		// The forge ceiling: no retry, no strike-worthy failure (Tartan-side).
		let settled: Settled;
		try {
			degradedNotice = null;
			settled = ctx.tx((): Settled => {
				const before = laneOf(ctx, laneId);
				if (!isCurrent(before, attempt) || before.seed === null) {
					return { kind: "stale" };
				}
				endAttempt(ctx, laneId, attempt, "failed", code);
				emit(ctx, {
					type: "lane.seed_failed",
					subject: { kind: "lane", id: laneId },
					data: {
						laneId,
						seed: before.seed,
						code,
						attempt,
						next: "branch",
						platformFault: false,
					},
				});
				const row = fallbackSync(laneId, attempt, code);
				return row === null ? { kind: "stale" } : { kind: "branch", row, code };
			});
		} catch (error) {
			ctx.ports.log("branch fallback failed", {
				laneId,
				error: errorText(error),
			});
			return;
		}
		afterSettled(settled, laneId);
	};

	// -----------------------------------------------------------------------
	// Verification by SHA: the base reads in the lane repo and
	// `refs/heads/main` = base
	// -----------------------------------------------------------------------

	const verify = async (name: string, base: string): Promise<boolean> => {
		const repo = await ctx.access.control(() => ctx.deps.artifacts.get(name));
		try {
			const commit = await repo.readCommit(base);
			if (commit === null || commit === undefined) return false;
			const tree = await repo.readTree(commit.treeHash);
			if (tree === null || tree === undefined) return false;
		} finally {
			try {
				repo[Symbol.dispose]?.();
			} catch {
				// Best effort.
			}
		}
		const refs = await laneRepoRefs(ctx, name, [LANE_REPO_HEAD_REF]);
		return refs?.find((r) => r.ref === LANE_REPO_HEAD_REF)?.sha === base;
	};

	// -----------------------------------------------------------------------
	// Running one attempt (detached)
	// -----------------------------------------------------------------------

	const capabilityUrl = async (row: LaneRow): Promise<string> => {
		const origin = (await ctx.deps.canonicalOrigin()).replace(/\/+$/, "");
		const fields = {
			exp: Math.floor(ctx.now() / 1000) + LANE_CAP_TTL_S,
			laneId: row.id,
			nonce: row.cap_nonce as string,
			repoId: repoUlid(),
		};
		const mac = await ctx.deps.capMac.sign(fields);
		return `${origin}${capPath({ ...fields, mac })}`;
	};

	const runImport = async (
		row: LaneRow,
		attempt: number,
	): Promise<"verify" | "done"> => {
		const name = row.repo_name as string;
		let url: string;
		try {
			url = await capabilityUrl(row);
		} catch (error) {
			ctx.ports.log("capability mint failed", {
				laneId: row.id,
				error: errorText(error),
			});
			fail(row.id, attempt, "interrupted");
			return "done";
		}
		if (!setPhase(row.id, attempt, "cap", "importing")) return "done";
		const timeoutMs = importTimeoutMs(
			getMetaNumber(ctx.sql, "trunk_pack_bytes"),
		);
		try {
			await ctx.deps.core.control.take();
			// The bucket may have held this attempt back: its import bound starts
			// now, and so does its watchdog's.
			rearm(row.id, attempt);
			// The 24 h token import() returns is dropped unread (U53): only the
			// remote URL is kept.
			const remote = await within(
				ctx.deps.artifacts.import({
					source: { url, branch: "main" },
					target: { name },
				}).then((created) => created.remote),
				ctx.ports.bound("import", timeoutMs),
			);
			ctx.tx(() => setAttemptRemote(ctx, name, remote));
			return "verify";
		} catch (error) {
			const timedOut = error instanceof TimedOut;
			if (!timedOut && /\b429\b|rate.?limit/i.test(errorText(error))) {
				ctx.deps.core.control.backoff();
			}
			const current = laneOf(ctx, row.id);
			const code = classifyImportFailure(error, {
				uses: current?.cap_uses ?? 0,
				consumedAt: current?.cap_consumed_at ?? null,
				outcome: current?.cap_outcome ?? null,
			}, timedOut);
			ctx.ports.log("import failed", {
				laneId: row.id,
				attempt,
				code,
				error: timedOut ? "timeout" : errorText(error),
			});
			fail(row.id, attempt, code);
			return "done";
		}
	};

	const runAttempt = async (laneId: string, attempt: number): Promise<void> => {
		const row = laneOf(ctx, laneId);
		if (!isCurrent(row, attempt) || row.repo_name === null) return;
		if (row.seed !== null) rearm(laneId, attempt);
		// Index first: nothing is minted or imported before the row.
		try {
			const indexed = await ctx.deps.forgeTree().indexArtifacts({
				name: row.repo_name,
				kind: "lane",
				repoId: repoUlid(),
				laneId,
				state: "pending",
			});
			if (!indexed.ok) {
				hooks.ceilingCache.reached = true;
				hooks.ceilingCache.at = ctx.now();
				toBranch(laneId, attempt, "lane-repo-ceiling");
				return;
			}
			hooks.ceilingCache.reached = false;
		} catch (error) {
			ctx.ports.log("index upsert failed", {
				laneId,
				attempt,
				error: errorText(error),
			});
			fail(laneId, attempt, "interrupted");
			return;
		}
		const current = laneOf(ctx, laneId);
		if (!isCurrent(current, attempt)) return;
		const step = await runImport(current, attempt);
		if (step === "done") return;
		if (!setPhase(laneId, attempt, "importing", "verifying")) return;
		let verified = false;
		try {
			verified = await within(
				verify(current.repo_name as string, current.base_sha),
				ctx.ports.bound("verify", VERIFY_BUDGET_MS),
			);
		} catch (error) {
			ctx.ports.log("verify failed", { laneId, error: errorText(error) });
		}
		if (verified) open(laneId, attempt);
		else fail(laneId, attempt, "verify-failed");
	};

	const schedule = (laneId: string, attempt: number, delayMs = 0): void => {
		const key = queuedKey(laneId, attempt);
		queued.set(key, ctx.now());
		ctx.detach("seed attempt failed", async () => {
			try {
				if (delayMs > 0) await ctx.ports.sleep(delayMs);
				await limit(() => {
					queued.delete(key);
					return runAttempt(laneId, attempt);
				});
			} finally {
				queued.delete(key);
			}
		});
	};

	/** True while attempt n waits in this isolate, for at most `QUEUED_MAX_MS`. */
	const stillQueued = (laneId: string, attempt: number, now: number) => {
		const at = queued.get(queuedKey(laneId, attempt));
		return at !== undefined && now - at < QUEUED_MAX_MS;
	};

	const startAttempt = (laneId: string): void => {
		try {
			const row = laneOf(ctx, laneId);
			if (row === null || row.state !== "opening") return;
			schedule(laneId, row.seed_attempt);
		} catch (error) {
			ctx.ports.log("startAttempt failed", { laneId, error: errorText(error) });
		}
	};

	// -----------------------------------------------------------------------
	// The watchdog and the re-drive
	// -----------------------------------------------------------------------

	const failCodeFor = (phase: string | null): LaneSeedFailCode =>
		phase === "importing"
			? "import-timeout"
			: phase === "verifying"
			? "verify-failed"
			: "interrupted";

	const seedLane = async (laneId: string): Promise<void> => {
		try {
			if (!isIdOf("lane", laneId)) return;
			const row = laneOf(ctx, laneId);
			if (row === null || row.state !== "opening" || row.mode !== "repo") {
				return;
			}
			const now = ctx.now();
			if (row.seed_deadline !== null && row.seed_deadline > now) {
				timers.schedule(seedTimerKey(laneId), row.seed_deadline);
				return;
			}
			const attempt = row.seed_attempt;
			if (row.seed !== null && stillQueued(laneId, attempt, now)) {
				// Not started yet: its clock starts when it does.
				rearm(laneId, attempt);
				return;
			}
			if (row.seed_phase === "cap" || row.repo_name === null) {
				fail(laneId, attempt, "interrupted");
				return;
			}
			let verified = false;
			try {
				verified = await within(
					verify(row.repo_name, row.base_sha),
					ctx.ports.bound("watchdog", WATCHDOG_BUDGET_MS),
				);
			} catch {
				verified = false;
			}
			if (verified && open(laneId, attempt)) return;
			fail(laneId, attempt, failCodeFor(row.seed_phase));
		} catch (error) {
			ctx.ports.log("seed watchdog failed", {
				laneId,
				error: errorText(error),
			});
		}
	};

	const onSeedTimer = async (key: string): Promise<void> => {
		if (!key.startsWith(SEED_TIMER_PREFIX)) return;
		await seedLane(key.slice(SEED_TIMER_PREFIX.length));
	};

	const redriveSeeds = async (now: number): Promise<{ laneIds: string[] }> => {
		identity(ctx);
		const due = rows<{ id: string }>(
			ctx.sql,
			`SELECT id FROM lanes WHERE state = 'opening' AND mode = 'repo'
			 AND seed_deadline IS NOT NULL AND seed_deadline < ? ORDER BY seed_deadline LIMIT 50`,
			now - REDRIVE_AFTER_MS,
		).map((r) => r.id);
		for (const laneId of due) await seedLane(laneId);
		return { laneIds: due };
	};

	return {
		planOpening,
		startAttempt,
		seedLane,
		onSeedTimer,
		redriveSeeds,
		/** Tests: run one attempt to its end, in the caller's turn. */
		runAttempt,
		verify,
	};
};

export type Seeder = ReturnType<typeof createSeeder>;

export { attemptRow };
