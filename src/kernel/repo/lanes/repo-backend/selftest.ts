// The post-claim lane-repo self-test (WP5b): one
// scratch lane through the REAL seeder and the REAL
// capability route on the forge's canonical origin, `import` only.
//
// 1. A scratch canonical repo `r-<ulid>` (index row first, `create`, the
//    genesis commit) and a scratch RepoDO that is not a node of the tree.
// 2. Its lane mode is set to `import` (an Owner setting of that scratch
//    repo only; the forge's `LANE_MODE` is never touched) and one lane is
//    opened as `sys_kernel`.
// 3. The lane is watched until it opens, or until its first seed attempt
//    fails: then it is closed at once, which fences the seed, so no fallback
//    runs (`import` only, no fallback chain).
// 4. Both repos are deleted (the lane by `purge`, the scratch canonical repo
//    and its index row directly), and the result is stored for display.
//
// A failure is a warning with a fix hint; `importer-unreachable` (the route
// saw no request for the nonce) names zone security features that block
// `/-/cap/*`. It never changes `LANE_MODE`.

import {
	createUlid,
	denied,
	type Envelope,
	FORGE_DO_NAME,
	fromRpcError,
	httpStatus,
	type Lane,
	type LaneSeedFailCode,
	type LaneSelfTestResult,
	repoArtifactsName,
	repoDoName,
	type SetupStateDto,
	SYS_KERNEL,
	toWire,
	unauthenticated,
} from "@tartan/contract";
import {
	type IdentityFacade,
	KERNEL_LANE_ACTOR,
	type KernelGitJobs,
	type LaneSelfTest,
	type RepoCoreFacade,
	type RepoEventsFacade,
	type RepoStore,
	type TreeFacade,
} from "@tartan/contract/kernel.ts";
import type { Env } from "../../../../env.ts";
import type { RouteContext, RouteHandler } from "../../../../router.ts";
import { FORGE_WIDE_HINT, isForgeWide } from "../../../http/owner.ts";
import { createKernelGitJobs } from "../../../land/gitjobs.ts";

/** How long the self-test waits for the lane to leave `opening`. */
export const SELFTEST_WAIT_MS = 60_000;
/** One `awaitLane` call's bound while watching for the first failure. */
export const SELFTEST_POLL_MS = 2_000;

export type SelfTestRepo = {
	core(): Pick<
		RepoCoreFacade,
		| "init"
		| "setLaneSettings"
		| "openLane"
		| "awaitLane"
		| "getLane"
		| "closeLane"
		| "purgeLane"
	>;
	events(): Pick<RepoEventsFacade, "read">;
};

export type SelfTestDeps = {
	readonly artifacts: Pick<RepoStore, "create" | "delete">;
	repo(repoId: string): SelfTestRepo;
	readonly gitJobs: Pick<KernelGitJobs, "genesis">;
	readonly tree: Pick<TreeFacade, "indexArtifacts">;
	setupState(): Promise<SetupStateDto>;
	/** ForgeDO `meta.lane_selftest_json` (display only). */
	store(result: LaneSelfTestResult): Promise<void>;
	now(): number;
	ulid(): string;
	sleep(ms: number): Promise<void>;
	log(message: string, data: Record<string, unknown>): void;
};

const HINTS: Partial<Record<LaneSeedFailCode | "setup", string>> = {
	"importer-unreachable":
		"Artifacts' importer never reached the capability route. Let it through on /-/cap/* on the canonical host (WAF, Bot Fight Mode, Access or other zone security features in front of the forge).",
	"trunk-moved": "Trunk moved during the test import; run the self-test again.",
	"lane-too-large": "The scratch repository was too large to import.",
	"import-timeout":
		"The import did not finish in time; Artifacts may be slow or overloaded.",
	"import-error":
		"Artifacts could not import from the capability route; check the canonical origin is reachable over https.",
	"verify-failed": "The lane repository did not answer at the expected base.",
	"rate-limited":
		"The Artifacts control plane is rate limiting this account; try again later.",
	"lane-repo-ceiling":
		"The forge holds as many lane repositories as it may retain.",
	interrupted: "The test was interrupted; run it again.",
	setup:
		"Run the self-test after the forge is claimed and its canonical origin is set.",
};

const resultOf = (
	at: number,
	code: LaneSeedFailCode,
	hint?: string,
): LaneSelfTestResult => ({
	ok: false,
	code,
	hint: hint ?? HINTS[code] ?? "The lane repository could not be seeded.",
	at,
});

const firstFailure = async (
	repo: SelfTestRepo,
	laneId: string,
): Promise<LaneSeedFailCode | null> => {
	const events: Envelope[] = await repo.events().read({
		since: 0,
		limit: 200,
		patterns: ["lane.seed_failed"],
	});
	const failure = events.find((e) =>
		(e.data as { laneId?: string }).laneId === laneId
	);
	return failure === undefined
		? null
		: (failure.data as { code: LaneSeedFailCode }).code;
};

export const runLaneSelfTestWith = async (
	deps: SelfTestDeps,
	by: string,
): Promise<LaneSelfTestResult> => {
	const started = deps.now();
	const state = await deps.setupState();
	if (state.state !== "done" || state.canonicalOrigin === undefined) {
		return resultOf(started, "interrupted", HINTS.setup);
	}
	const repoId = deps.ulid();
	const name = repoArtifactsName(repoId);
	const repo = deps.repo(repoId);
	let lane: Lane | null = null;
	let result: LaneSelfTestResult;
	let created = false;
	try {
		const indexed = await deps.tree.indexArtifacts({
			name,
			kind: "repo",
			repoId,
			state: "pending",
		});
		if (!indexed.ok) return resultOf(started, "lane-repo-ceiling");
		await deps.artifacts.create(name, { setDefaultBranch: "main" });
		created = true;
		await repo.core().init({
			repoId,
			nodeId: repoId,
			path: `tartan-selftest/${repoId}`,
			defaultBranch: "main",
		});
		await deps.gitJobs.genesis(repoId, {
			defaultBranch: "main",
			message: "Tartan lane self-test",
			author: { name: "Tartan", email: "tartan@kernel.invalid" },
		});
		await deps.tree.indexArtifacts({
			name,
			kind: "repo",
			repoId,
			state: "live",
		});
		await repo.core().setLaneSettings(
			{ laneMode: "import" },
			KERNEL_LANE_ACTOR,
		);
		lane = await repo.core().openLane({
			owner: SYS_KERNEL,
			actor: KERNEL_LANE_ACTOR,
		});
		const deadline = started + SELFTEST_WAIT_MS;
		let current: Lane = lane;
		let failed: LaneSeedFailCode | null = null;
		while (current.state === "opening" && deps.now() < deadline) {
			current = await repo.core().awaitLane(lane.id, SELFTEST_POLL_MS);
			if (current.state !== "opening") break;
			failed = await firstFailure(repo, lane.id);
			if (failed !== null) break;
		}
		if (current.state === "opening") {
			// Fence the seed before any fallback runs.
			await repo.core().closeLane(lane.id, "self-test", KERNEL_LANE_ACTOR)
				.catch(() => {});
			failed ??= (await firstFailure(repo, lane.id)) ?? "import-timeout";
			result = resultOf(deps.now(), failed);
		} else if (
			current.mode === "repo" && current.seed === "import" &&
			current.state === "open"
		) {
			result = {
				ok: true,
				seed: "import",
				...(current.seedMs !== undefined ? { seedMs: current.seedMs } : {}),
				at: deps.now(),
			};
		} else {
			result = resultOf(
				deps.now(),
				(await firstFailure(repo, lane.id)) ?? "import-error",
			);
		}
	} catch (error) {
		const e = fromRpcError(error);
		deps.log("lane self-test failed", { error: e.message.slice(0, 300) });
		result = resultOf(
			deps.now(),
			"interrupted",
			`${HINTS.interrupted} (${e.code})`,
		);
	} finally {
		await cleanup(deps, repo, lane, created ? name : null, repoId);
	}
	await deps.store(result).catch((error) =>
		deps.log("lane self-test result not stored", {
			error: fromRpcError(error).message.slice(0, 200),
		})
	);
	void by;
	return result;
};

const cleanup = async (
	deps: SelfTestDeps,
	repo: SelfTestRepo,
	lane: Lane | null,
	name: string | null,
	repoId: string,
): Promise<void> => {
	if (lane !== null) {
		try {
			const now = await repo.core().getLane(lane.id);
			if (
				now !== null && !["closed", "archived", "deleted"].includes(now.state)
			) {
				await repo.core().closeLane(lane.id, "self-test", KERNEL_LANE_ACTOR);
			}
			await repo.core().purgeLane(lane.id, KERNEL_LANE_ACTOR);
		} catch (error) {
			deps.log("lane self-test: lane cleanup failed (the sweep removes it)", {
				error: fromRpcError(error).message.slice(0, 200),
			});
		}
	}
	if (name !== null) {
		try {
			await deps.artifacts.delete(name);
			await deps.tree.indexArtifacts({
				name,
				kind: "repo",
				repoId,
				state: "deleted",
			});
		} catch (error) {
			deps.log("lane self-test: scratch repo cleanup failed", {
				error: fromRpcError(error).message.slice(0, 200),
			});
		}
	}
};

/**
 * ForgeDO's identity facade: setup state, the Owner check and the store of
 * the last result (`IdentityFacade.recordLaneSelfTest`,
 * `meta.lane_selftest_json`).
 */
const forgeIdentity = (env: Env) =>
	env.FORGE.getByName(FORGE_DO_NAME).identity() as unknown as Pick<
		IdentityFacade,
		"setupState" | "isOwner" | "recordLaneSelfTest" | "lastLaneSelfTest"
	>;

/** The production deps, from the Worker's `env`. */
export const envSelfTestDeps = (env: Env): SelfTestDeps => {
	const ulid = createUlid();
	return {
		artifacts: env.ARTIFACTS,
		repo: (repoId) =>
			env.REPO.getByName(repoDoName(repoId)) as unknown as SelfTestRepo,
		gitJobs: createKernelGitJobs(env),
		tree: env.FORGE.getByName(FORGE_DO_NAME).tree() as unknown as Pick<
			TreeFacade,
			"indexArtifacts"
		>,
		setupState: () => forgeIdentity(env).setupState(),
		store: (result) => forgeIdentity(env).recordLaneSelfTest(result),
		now: () => Date.now(),
		ulid,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		log: (message, data) =>
			console.error(
				`[tartan] lanes.selftest: ${message}`,
				JSON.stringify(data),
			),
	};
};

export const runLaneSelfTest: LaneSelfTest<Env> = (env, by) =>
	runLaneSelfTestWith(envSelfTestDeps(env), by);

const json = (body: unknown, status = 200): Response =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });

export type SelfTestRouteDeps = {
	isOwner(principal: string): Promise<boolean>;
	run(by: string): Promise<LaneSelfTestResult>;
	last(): Promise<LaneSelfTestResult | null>;
};

/** The route body, with its ports (tests inject them). */
export const laneSelfTestRoute = (
	deps: (env: Env) => SelfTestRouteDeps,
): RouteHandler =>
async (c: RouteContext) => {
	try {
		if (c.auth === null) throw unauthenticated();
		const ports = deps(c.env);
		if (!isForgeWide(c.auth) || !(await ports.isOwner(c.auth.principal))) {
			throw denied(
				"role",
				`only the forge Owner runs the lane self-test (${FORGE_WIDE_HINT})`,
			);
		}
		if (c.req.method === "GET") {
			return json({ last: await ports.last().catch(() => null) });
		}
		return json(await ports.run(c.auth.principal));
	} catch (error) {
		const wire = toWire(error);
		return json(wire, httpStatus(wire.error));
	}
};

/** `POST /-/api/admin/selftest/lanes` (Owner) runs it; `GET` shows the last result. */
export const handleLaneSelfTest: RouteHandler = laneSelfTestRoute((env) => ({
	isOwner: (principal) => forgeIdentity(env).isOwner(principal),
	run: (by) => runLaneSelfTest(env, by),
	last: () => forgeIdentity(env).lastLaneSelfTest(),
}));
