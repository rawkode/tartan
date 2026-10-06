// Lifecycle of the dev-e2e forge (`tartan-dev-e2e`), driven through the
// repository's own deploy tooling with the stage fixed to `dev-e2e`:
//
// - `deployForge`: `deno task deploy -- --stage dev-e2e --dev-tools
//   --no-print-url --account <CLOUDFLARE_ACCOUNT_ID>`, plus, by default,
//   containers with the runner image built here (`--image dockerfile`,
//   `DEFAULT_IMAGE`; `--image registry` renders the recorded ttl.sh digest
//   instead) and repository config (`--repo-config`, which needs
//   containers); `--no-containers` drops both. Once the forge is claimed,
//   `--delete-setup-token` too. A fresh forge is then claimed (phase A, the
//   claim suite) with the setup token read from deploy's 0600 URL file,
//   which is deleted afterwards.
// - `destroyForge`: `deno task destroy -- --stage dev-e2e --yes
//   --delete-namespace --account <id>` (it also deregisters the forge's DCR
//   client at the IdP).

import * as path from "node:path";
import {
	assessImageRecord,
	buildsImageHere,
	type ImageRecordState,
	type Run,
} from "../preflight.ts";
import { RUNNER_IMAGE_RECORD } from "../render-config.ts";
import {
	assertAccount,
	assertForgeOrigin,
	forgeOriginFor,
	GuardError,
	STAGE,
} from "./guards.ts";
import type { MaskedRun } from "./proc.ts";
import {
	readForgeRecord,
	readSetupToken,
	type StateFs,
	type StatePaths,
	writeStageState,
} from "./state.ts";

export type ForgeDeps = {
	readonly run: Run;
	readonly masked: MaskedRun;
	/** Bounded (`timedFetch`): a hung request fails instead of stalling the launcher. */
	readonly fetch: typeof fetch;
	readonly fs: StateFs;
	readonly paths: StatePaths;
	readonly root: string;
	readonly deno: string;
	readonly now: () => number;
	readonly log: (line: string) => void;
	/** From `CLOUDFLARE_ACCOUNT_ID`, already checked (`accountIdFrom`). */
	readonly accountId: string;
};

/**
 * The M2 switches a stage may be deployed with, passed through to `deno
 * task deploy` (each flag is deploy's own; the compiled defaults stay off):
 * the global log with its consume token (`--k2 --k2-token-store <id>
 * --k2-token-secret <name>`: the stream `tartan_dev_e2e_log` is found or
 * created), the lane mode and workload transport overrides, monorepo
 * projects and the Rust → WASM extension packages.
 */
export type StageSwitches = {
	/** The K2 Consume token's Secrets Store names (ids and names only, never the value). */
	readonly k2?: { readonly storeId: string; readonly secretName: string };
	readonly laneMode?: "import" | "branch";
	readonly workloadTransport?: "local" | "k2";
	readonly projects?: boolean;
	readonly buildExt?: boolean;
	/** `TARTAN_ECHO`: band-2 guidance on this stage. */
	readonly echo?: "on" | "off";
};

/** How a stage is deployed. */
export type StagePlan = {
	/** Containers (CI, Advances, repository config) on; the default. */
	readonly containers: boolean;
	/** The runner image source for `deploy --image` (containers only). */
	readonly image: "registry" | "dockerfile";
	/** The M2 switches (none by default). */
	readonly switches?: StageSwitches;
};

const STORE_ID_RE = /^[0-9a-f]{32}$/;
const SECRET_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LANE_MODES: readonly string[] = ["import", "branch"];
const TRANSPORTS: readonly string[] = ["local", "k2"];

/** Checks a plan's switches the way deploy will, before anything is deployed. */
export const checkSwitches = (switches: StageSwitches): StageSwitches => {
	if (switches.k2 !== undefined) {
		if (!STORE_ID_RE.test(switches.k2.storeId)) {
			throw new GuardError("--k2-token-store is a 32-hex Secrets Store id");
		}
		if (!SECRET_NAME_RE.test(switches.k2.secretName)) {
			throw new GuardError("--k2-token-secret is a Secrets Store secret name");
		}
	}
	if (
		switches.laneMode !== undefined && !LANE_MODES.includes(switches.laneMode)
	) {
		throw new GuardError("--lane-mode is import or branch");
	}
	if (
		switches.workloadTransport !== undefined &&
		!TRANSPORTS.includes(switches.workloadTransport)
	) {
		throw new GuardError("--workload-transport is local or k2");
	}
	if (switches.echo !== undefined && !["on", "off"].includes(switches.echo)) {
		throw new GuardError("--echo is on or off");
	}
	if (switches.workloadTransport === "k2" && switches.k2 === undefined) {
		throw new GuardError(
			"--workload-transport k2 needs --k2 with --k2-token-store and --k2-token-secret",
		);
	}
	return switches;
};

/** deploy's flags for `switches`. */
export const switchArgs = (switches: StageSwitches | undefined): string[] => [
	...(switches?.k2 === undefined ? [] : [
		"--k2",
		"--k2-token-store",
		switches.k2.storeId,
		"--k2-token-secret",
		switches.k2.secretName,
	]),
	...(switches?.laneMode === undefined
		? []
		: ["--lane-mode", switches.laneMode]),
	...(switches?.workloadTransport === undefined
		? []
		: ["--workload-transport", switches.workloadTransport]),
	...(switches?.projects === true ? ["--projects"] : []),
	...(switches?.buildExt === true ? ["--build-ext"] : []),
	...(switches?.echo === undefined ? [] : ["--echo", switches.echo]),
];

/**
 * The runner image source of `stage up` without `--image`: `dockerfile`
 * (wrangler builds the image with Docker and pushes it to the account's own
 * registry.cloudflare.com). `registry` renders the ttl.sh digest that
 * containers/runner/publish.ts records, which Containers pull only on an
 * account where that registry is configured; elsewhere the deploy fails
 * after the Worker upload with IMAGE_REGISTRY_NOT_CONFIGURED. Both need
 * Docker here.
 */
export const DEFAULT_IMAGE: StagePlan["image"] = "dockerfile";

/** `--image`'s value, or the default; anything else is refused. */
export const imageOf = (value: string | undefined): StagePlan["image"] => {
	const image = value ?? DEFAULT_IMAGE;
	if (image !== "registry" && image !== "dockerfile") {
		throw new GuardError("--image is dockerfile or registry");
	}
	return image;
};

/** The recorded runner image as deploy would judge it. */
export const recordedImage = async (
	deps: Pick<ForgeDeps, "run" | "fs" | "root" | "now">,
): Promise<ImageRecordState> => {
	const head = await deps.run("git", ["rev-parse", "HEAD"], { cwd: deps.root })
		.catch(() => null);
	return await assessImageRecord(
		await deps.fs.readText(path.join(deps.root, RUNNER_IMAGE_RECORD)),
		{
			now: deps.now(),
			head: head?.code === 0 ? head.stdout.trim() : null,
			runnerChangedSince: async (commit) => {
				const diff = await deps.run("git", [
					"diff",
					"--quiet",
					commit,
					"HEAD",
					"--",
					"containers/runner",
				], { cwd: deps.root }).catch(() => null);
				return diff?.code !== 0;
			},
		},
	);
};

/** One line saying where deploy will take the runner image from. */
export const imageNote = (
	plan: StagePlan,
	record: ImageRecordState | null,
): string => {
	if (!plan.containers) {
		return "containers off (--no-containers): CI, Advances and repository config are unavailable, so the suites that need them skip";
	}
	if (!buildsImageHere({ containers: true, image: plan.image }, record)) {
		return "containers on: deploy reuses the recorded runner image";
	}
	return plan.image === "dockerfile"
		? "containers on: deploy builds the runner image here (Docker)"
		: `containers on: deploy publishes a new runner image (${
			record?.valid === false ? record.reason : "no record"
		})`;
};

type Health = {
	product?: unknown;
	stage?: unknown;
	setupState?: unknown;
};

export const forgeHealth = async (
	fetchFn: typeof fetch,
	origin: string,
): Promise<Health | null> => {
	try {
		const r = await fetchFn(`${assertForgeOrigin(origin)}/-/health`, {
			headers: { "cache-control": "no-store" },
		});
		return await r.json().catch(() => null) as Health | null;
	} catch {
		return null;
	}
};

/** Pauses between health attempts: a busy forge gets about 14 s in all. */
export const HEALTH_BACKOFF_MS = [1_000, 3_000, 10_000] as const;

/**
 * `/-/health` until it answers as the claimed `dev-e2e` forge, retried with
 * backoff: one slow answer (an isolate's first ForgeDO read, crons loading
 * ForgeDO) must not fail a guard. Returns the last answer either way.
 */
export const claimedForgeHealth = async (
	fetchFn: typeof fetch,
	origin: string,
	options: {
		readonly backoffMs?: readonly number[];
		readonly sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<Health | null> => {
	const backoff = options.backoffMs ?? HEALTH_BACKOFF_MS;
	const sleep = options.sleep ??
		((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	let health: Health | null = null;
	for (let attempt = 0;; attempt++) {
		health = await forgeHealth(fetchFn, origin);
		const claimed = health?.product === "Tartan" &&
			health.stage === STAGE && health.setupState === "done";
		if (claimed || attempt >= backoff.length) return health;
		await sleep(backoff[attempt]);
	}
};

export const deployArgs = (
	input: StagePlan & {
		readonly claimed: boolean;
		readonly accountId: string;
	},
): string[] => [
	"run",
	"-A",
	"scripts/deploy.ts",
	"--stage",
	STAGE,
	"--dev-tools",
	"--no-print-url",
	"--account",
	input.accountId,
	...(input.containers
		? ["--image", input.image, "--repo-config"]
		: ["--no-containers"]),
	...switchArgs(input.switches),
	...(input.claimed ? ["--delete-setup-token"] : []),
];

export const destroyArgs = (accountId: string): string[] => [
	"run",
	"-A",
	"scripts/destroy.ts",
	"--stage",
	STAGE,
	"--yes",
	"--delete-namespace",
	"--account",
	accountId,
];

export type ForgeUp = {
	readonly origin: string;
	readonly setupState: string;
	/** Present when the forge is unclaimed: phase A runs with it, then the file goes. */
	readonly setupToken: string | null;
};

export const deployForge = async (
	deps: ForgeDeps,
	input: StagePlan & { readonly subdomain: string },
): Promise<ForgeUp> => {
	const origin = forgeOriginFor(input.subdomain);
	deps.log(
		imageNote(input, input.containers ? await recordedImage(deps) : null),
	);
	const before = await forgeHealth(deps.fetch, origin);
	if (before?.product === "Tartan" && before.stage !== STAGE) {
		throw new GuardError(
			`${origin} answers as stage ${JSON.stringify(before.stage)}; refusing`,
		);
	}
	const claimed = before?.product === "Tartan" && before.setupState === "done";
	const code = await deps.masked(
		deps.deno,
		deployArgs({
			containers: input.containers,
			image: input.image,
			...(input.switches === undefined ? {} : { switches: input.switches }),
			claimed,
			accountId: deps.accountId,
		}),
		{ cwd: deps.root },
	);
	if (code !== 0) throw new GuardError(`deploy failed (exit ${code})`);
	const record = await readForgeRecord(deps.fs, deps.paths);
	if (record === null || record.origin !== origin) {
		throw new GuardError(
			"deploy wrote no dev-e2e record for the expected origin",
		);
	}
	assertAccount(record.accountId, deps.accountId);
	if (record.containers !== input.containers) {
		throw new GuardError(
			`deploy recorded containers ${
				record.containers ? "on" : "off"
			}, not what stage up asked for`,
		);
	}
	await writeStageState(deps.fs, deps.paths, deps.now());
	const setupToken = record.setupState === "done"
		? null
		: await readSetupToken(deps.fs, deps.paths, origin);
	return { origin, setupState: record.setupState, setupToken };
};

export const destroyForge = async (deps: ForgeDeps): Promise<void> => {
	const record = await readForgeRecord(deps.fs, deps.paths);
	if (record !== null) assertAccount(record.accountId, deps.accountId);
	const code = await deps.masked(deps.deno, destroyArgs(deps.accountId), {
		cwd: deps.root,
	});
	if (code !== 0) throw new GuardError(`destroy failed (exit ${code})`);
	await deps.fs.remove(deps.paths.stage);
};
