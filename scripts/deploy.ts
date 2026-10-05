// One-command deploy.
//
//   deno task deploy -- --stage <stage> [--domain <host>] [--no-containers]
//                       [--repo-config] [--projects]
//
// Idempotent. In order:
//   0. `npm ci` when `node_modules` is missing or does not match the exact
//      pins (never through a symlinked `node_modules`: that is a worktree);
//   1. login (`npx wrangler login` if needed) and the preflight
//      (scripts/preflight.ts), which fails fast with fix-it messages;
//   2. `--image registry` without a usable record: publish the runner image
//      (containers/runner/publish.ts) so the record is fresh;
//   2b. the global log (`--k2`, WP26): find or create the stage's K2 stream
//      `tartan_<stage>_log` (scripts/k2.ts; `--k2-stream <id>` names an
//      existing one instead) and bind it with the deployer's Secrets Store
//      consume token (`--k2-token-store`, `--k2-token-secret`; never read
//      here). Without a token the forge relays but dispatches inline;
//   3. render `.wrangler/deploy/wrangler.<stage>.jsonc` (render-config.ts);
//   4. build the SPA (`npm run build:web`), with `--build-ext` the Rust →
//      WASM extension packages (`deno task build:ext <name>`; publishing one
//      needs an admin token after the claim), and `npx wrangler deploy -c …`,
//      retried once when a container registry push times out;
//      for `registry`, the deployed image digest must equal the recorded one;
//   5. secrets, generated here and written through stdin only: on the first
//      deploy `TARTAN_SECRET` and `TARTAN_SETUP_TOKEN`; on a redeploy of an
//      unclaimed forge a new `TARTAN_SETUP_TOKEN` (a value only this run
//      knows, so the setup URL can be printed); after the claim it offers to
//      delete `TARTAN_SETUP_TOKEN`;
//   6. `POST /-/health/warm` (containers only; up to 2 min) so the first CI
//      run does not pay the container's cold start;
//   7. poll `/-/health` on workers.dev, then on the custom domain until this
//      stage answers (up to 10 min): a new connection per attempt, so an old
//      DNS answer cannot stick, and each attempt is classified (DNS, TLS,
//      another server, this stage unhealthy, healthy);
//   8. print the single-use setup URL `https://<host>/-/setup#t=<token>` once,
//      or with `--no-print-url` write it to a 0600 file, plus the IdP hint;
//      write the stage's deploy record `.wrangler/deploy/record.<stage>.json`.
//
// Deploy tooling only; runtime code never imports it.

import * as path from "node:path";
import type { HealthResponse } from "@tartan/contract";
import { logStreamName } from "../src/kernel/bus/config.ts";
import { cfK2Streams, ensureLogStream, retentionFor } from "./k2.ts";
import {
	defaultOutPath,
	type K2Render,
	LANE_MODE_VALUES,
	type LaneModeOverride,
	renderConfig,
	type RenderOptions,
	validateRegistryRef,
	WORKLOAD_TRANSPORT_VALUES,
	type WorkloadTransportOverride,
} from "./render-config.ts";
import {
	type Auth,
	type CfApi,
	denoRun,
	formatChecks,
	parseFlags,
	PLAN_FLAGS,
	planFromFlags,
	type PreflightDeps,
	PreflightError,
	type PreflightPlan,
	readTextOrNull,
	REPO_ROOT,
	type Run,
	runPreflight,
	stageNames,
	UsageError,
	wrangler,
} from "./preflight.ts";

export const SECRET_NAMES = {
	root: "TARTAN_SECRET",
	setup: "TARTAN_SETUP_TOKEN",
} as const;

export const HEALTH_TIMEOUT_MS = 3 * 60_000;
export const DOMAIN_TIMEOUT_MS = 10 * 60_000;
export const DOMAIN_INTERVAL_MS = 10_000;
export const ATTEMPT_TIMEOUT_MS = 10_000;
/** The shortest attempt worth starting before a deadline. */
export const MIN_ATTEMPT_MS = 1_000;
export const WARM_TIMEOUT_MS = 2 * 60_000;
/** Per warm-up request: generous, for a new container app's cold start. */
export const WARM_ATTEMPT_TIMEOUT_MS = 90_000;

export class DeployError extends Error {
	override name = "DeployError";
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type DeployOptions = PreflightPlan & {
	readonly evictionFlag: boolean;
	readonly devTools: boolean;
	/** `TARTAN_REPO_CONFIG = "on"` (ADR repo config): off unless asked; needs containers. */
	readonly repoConfig: boolean;
	/** `TARTAN_PROJECTS = "scan"` (WP25): cuenv projects; off unless asked. */
	readonly projects: boolean;
	readonly printUrl: boolean;
	readonly urlFile: string;
	/** true: delete without asking; false: never; undefined: ask on a TTY. */
	readonly deleteSetupToken?: boolean;
	readonly keepSetupToken: boolean;
	readonly build: boolean;
	/** `--build-ext`: build the WASM extension packages (`EXT_PACKAGES`) too. */
	readonly buildExt: boolean;
	/** `--lane-mode`: the stage's override of `LANE_MODE` (after its live lane acceptance). */
	readonly laneMode?: LaneModeOverride;
	/** `--workload-transport`: the stage's override of `WORKLOAD_TRANSPORT` (needs `--k2` with the token). */
	readonly workloadTransport?: WorkloadTransportOverride;
	readonly account?: string;
	/** The global log (WP26); absent: no stream, every run dispatches inline. */
	readonly k2?: DeployK2;
};

/** `--k2`: the stream (found or created, or given) and the token's Secrets Store names. */
export type DeployK2 = {
	readonly streamId?: string;
	readonly retentionSeconds?: number;
	readonly maxStreams?: number;
	readonly token?: { readonly storeId: string; readonly secretName: string };
};

export const DEPLOY_FLAGS = {
	...PLAN_FLAGS,
	"no-eviction-flag": "bool",
	"dev-tools": "bool",
	"repo-config": "bool",
	projects: "bool",
	"no-print-url": "bool",
	"url-file": "value",
	"delete-setup-token": "bool",
	"keep-setup-token": "bool",
	"skip-build": "bool",
	"build-ext": "bool",
	"lane-mode": "value",
	"workload-transport": "value",
	k2: "bool",
	"k2-stream": "value",
	"k2-retention": "value",
	"k2-max-streams": "value",
	"k2-token-store": "value",
	"k2-token-secret": "value",
} as const;

export const DEPLOY_USAGE =
	`Usage: deno task deploy -- --stage <stage> [options]

  --stage <stage>         required; the Worker is tartan-<stage>
  --domain <host>         attach a Workers Custom Domain (zone in this account)
  --take-domain           move <host> from another Worker on purpose
  --no-containers         no runner image and no CI (no Docker needed)
  --image <variant>       dockerfile (default, built here with Docker) |
                          registry (the digest containers/runner/publish.ts recorded)
  --image-record <path>   the registry record (default .wrangler/deploy/runner-image.json)
  --no-eviction-flag      drop durable_object_io_tasks_prevent_eviction
  --dev-tools             TARTAN_DEV_TOOLS=1 (dev and dev-* stages only)
  --repo-config           TARTAN_REPO_CONFIG=on: evaluate each repo's root CUE
                          package tartan (needs containers; off by default)
  --projects              TARTAN_PROJECTS=scan: cuenv #Projects become the repos'
                          projects, with project pages (off by default)
  --no-print-url          write the setup URL to a 0600 file instead of printing it
  --url-file <path>       that file (default .wrangler/deploy/setup-url.<stage>.txt)
  --keep-setup-token      do not issue a new setup token on an unclaimed forge
  --delete-setup-token    after the claim, delete TARTAN_SETUP_TOKEN without asking
  --skip-build            reuse web/dist instead of building the SPA
  --lane-mode <mode>      TARTAN_LANE_MODE: this stage's lane mode (import | branch;
                          default the compiled LANE_MODE), after its live lane acceptance
  --workload-transport <t> TARTAN_WORKLOAD_TRANSPORT: local | k2 (k2 needs --k2 and the token),
                          after the stage's live K2 acceptance
  --build-ext             also build the Rust → WASM extension packages
                          (needs cargo, the wasm32-unknown-unknown target,
                          wasm-tools and jco; never committed, built here)
  --k2                    the global log: find or create the K2 stream tartan_<stage>_log
                          and bind it (K2 public beta; Workers Paid)
  --k2-stream <id>        use this existing K2 stream id instead (implies --k2)
  --k2-retention <s>      a new stream's retention (default by stage; 3600-2592000)
  --k2-max-streams <n>    refuse a new stream at n streams on the account (default 18)
  --k2-token-store <id>   the K2 Consume token's Secrets Store id …
  --k2-token-secret <name> … and secret name (without them runs dispatch inline)
  --account <id|name>     pick the Cloudflare account (or CLOUDFLARE_ACCOUNT_ID)`;

export const optionsFromArgs = (
	args: readonly string[],
	root: string,
): DeployOptions | undefined => {
	const flags = parseFlags(args, DEPLOY_FLAGS);
	if (flags.has("help")) return undefined;
	const plan = planFromFlags(flags, root);
	if (flags.has("dev-tools") && !/^dev(?:-|$)/.test(plan.stage)) {
		throw new UsageError(
			`--dev-tools needs a dev or dev-* stage, not ${
				JSON.stringify(plan.stage)
			}`,
		);
	}
	if (flags.has("repo-config") && flags.has("no-containers")) {
		throw new UsageError(
			"--repo-config needs containers: the CUE evaluator runs in the sandbox",
		);
	}
	if (flags.has("delete-setup-token") && flags.has("keep-setup-token")) {
		throw new UsageError(
			"--delete-setup-token and --keep-setup-token exclude each other",
		);
	}
	const urlFile = flags.get("url-file");
	if (urlFile !== undefined && !flags.has("no-print-url")) {
		throw new UsageError("--url-file needs --no-print-url");
	}
	const account = flags.get("account");
	const k2 = k2FromFlags(flags);
	return {
		...plan,
		evictionFlag: !flags.has("no-eviction-flag"),
		devTools: flags.has("dev-tools"),
		repoConfig: flags.has("repo-config"),
		projects: flags.has("projects"),
		printUrl: !flags.has("no-print-url"),
		urlFile: path.resolve(
			root,
			typeof urlFile === "string"
				? urlFile
				: `.wrangler/deploy/setup-url.${plan.stage}.txt`,
		),
		deleteSetupToken: flags.has("delete-setup-token") ? true : undefined,
		keepSetupToken: flags.has("keep-setup-token"),
		build: !flags.has("skip-build"),
		buildExt: flags.has("build-ext"),
		...switchOverrides(flags),
		account: typeof account === "string" ? account : undefined,
		...(k2 === undefined ? {} : { k2 }),
	};
};

/** `--lane-mode` and `--workload-transport` (validated here and again by render-config). */
const switchOverrides = (
	flags: Map<string, string | true>,
): Pick<DeployOptions, "laneMode" | "workloadTransport"> => {
	const laneMode = flags.get("lane-mode");
	const transport = flags.get("workload-transport");
	if (
		laneMode !== undefined &&
		!(LANE_MODE_VALUES as readonly unknown[]).includes(laneMode)
	) {
		throw new UsageError(`--lane-mode is ${LANE_MODE_VALUES.join(", ")}`);
	}
	if (
		transport !== undefined &&
		!(WORKLOAD_TRANSPORT_VALUES as readonly unknown[]).includes(transport)
	) {
		throw new UsageError(
			`--workload-transport is ${WORKLOAD_TRANSPORT_VALUES.join(" or ")}`,
		);
	}
	if (
		transport === "k2" &&
		(!flags.has("k2-token-store") ||
			!(flags.has("k2") || flags.has("k2-stream")))
	) {
		throw new UsageError(
			"--workload-transport k2 needs --k2 (or --k2-stream) with --k2-token-store and --k2-token-secret",
		);
	}
	return {
		...(laneMode === undefined
			? {}
			: { laneMode: laneMode as LaneModeOverride }),
		...(transport === undefined
			? {}
			: { workloadTransport: transport as WorkloadTransportOverride }),
	};
};

const intFlag = (
	flags: Map<string, string | true>,
	name: string,
): number | undefined => {
	const value = flags.get(name);
	if (value === undefined) return undefined;
	const n = Number(value);
	if (typeof value !== "string" || !Number.isInteger(n) || n < 1) {
		throw new UsageError(`--${name} needs a positive integer`);
	}
	return n;
};

/** The global log flags (WP26). */
export const k2FromFlags = (
	flags: Map<string, string | true>,
): DeployK2 | undefined => {
	const stream = flags.get("k2-stream");
	const store = flags.get("k2-token-store");
	const secret = flags.get("k2-token-secret");
	const any =
		["k2", "k2-stream", "k2-retention", "k2-max-streams"].some((f) =>
			flags.has(f)
		) || store !== undefined || secret !== undefined;
	if (!any) return undefined;
	if ((store === undefined) !== (secret === undefined)) {
		throw new UsageError("--k2-token-store and --k2-token-secret go together");
	}
	if (
		stream !== undefined &&
		(flags.has("k2-retention") || flags.has("k2-max-streams"))
	) {
		throw new UsageError(
			"--k2-stream names an existing stream: drop --k2-retention/--k2-max-streams",
		);
	}
	return {
		...(typeof stream === "string" ? { streamId: stream } : {}),
		...(intFlag(flags, "k2-retention") === undefined
			? {}
			: { retentionSeconds: intFlag(flags, "k2-retention") }),
		...(intFlag(flags, "k2-max-streams") === undefined
			? {}
			: { maxStreams: intFlag(flags, "k2-max-streams") }),
		...(typeof store === "string" && typeof secret === "string"
			? { token: { storeId: store, secretName: secret } }
			: {}),
	};
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const BASE64URL = (bytes: Uint8Array): string =>
	btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_")
		.replace(/=+$/, "");

/** 32 random bytes, base64url (the `.dev.vars.example` format). */
export const generateSecret = (
	random: (n: number) => Uint8Array,
): string => BASE64URL(random(32));

export const setupUrl = (origin: string, token: string): string =>
	`${origin}/-/setup#t=${encodeURIComponent(token)}`;

export const idpHint = (origin: string): string =>
	[
		"In the wizard, paste your identity provider's issuer URL. Tartan registers itself if the IdP supports",
		"dynamic client registration (RFC 7591); otherwise register this redirect URI at your IdP and paste the",
		`client id: ${origin}/-/auth/callback`,
	].join("\n");

/** The workers.dev URL and version id from `wrangler deploy` output. */
export const parseDeployOutput = (
	text: string,
	worker: string,
): { readonly workersDev?: string; readonly versionId?: string } => {
	const url = new RegExp(
		`https://${worker.replace(/[-]/g, "\\-")}\\.[a-z0-9-]+\\.workers\\.dev`,
	).exec(text)?.[0];
	const version = /Current Version ID:\s*([0-9a-f-]{36})/i.exec(text)?.[1];
	return {
		...(url ? { workersDev: url } : {}),
		...(version ? { versionId: version } : {}),
	};
};

/** A container registry push that timed out (worth one retry). */
export const isRegistryPushTimeout = (output: string): boolean =>
	/(timed? ?out|timeout|ETIMEDOUT|deadline exceeded|ECONNRESET)/i.test(
		output,
	) &&
	/(push|registry|layer|upload|image)/i.test(output);

export type NodeModulesState =
	| { readonly state: "ok" }
	| { readonly state: "missing" }
	| { readonly state: "stale"; readonly mismatches: readonly string[] };

/** Every exact pin in package.json against `node_modules/<name>/package.json`. */
export const assessNodeModules = async (
	root: string,
	readText: (file: string) => Promise<string | null>,
): Promise<NodeModulesState> => {
	const manifest = JSON.parse(
		(await readText(path.join(root, "package.json"))) ?? "{}",
	) as {
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	const pins = {
		...manifest.dependencies,
		...manifest.devDependencies,
	};
	const mismatches: string[] = [];
	let found = 0;
	for (const [name, version] of Object.entries(pins)) {
		const text = await readText(
			path.join(root, "node_modules", name, "package.json"),
		);
		if (text === null) {
			mismatches.push(`${name} missing`);
			continue;
		}
		found++;
		const installed = String(JSON.parse(text).version ?? "");
		if (installed !== version) {
			mismatches.push(`${name} ${installed} ≠ ${version}`);
		}
	}
	if (found === 0 && Object.keys(pins).length > 0) return { state: "missing" };
	return mismatches.length === 0
		? { state: "ok" }
		: { state: "stale", mismatches };
};

export type SetupState = HealthResponse["setupState"];

export type SecretPlan = {
	/** Secrets to generate and put now. */
	readonly put: readonly string[];
	/** Whether this run knows a valid setup token (so it can print the URL). */
	readonly setupTokenKnown: boolean;
	/** Offer to delete TARTAN_SETUP_TOKEN (the forge is claimed). */
	readonly offerDelete: boolean;
	readonly notes: readonly string[];
};

/**
 * Which secrets this deploy writes. `TARTAN_SECRET` is generated only for a
 * new Worker: an existing forge without it already holds a generated root key
 * in ForgeDO storage, and replacing that root would make its sealed values
 * unreadable (the wizard shows how to move the key).
 */
export const planSecrets = (input: {
	readonly firstDeploy: boolean;
	readonly existing: ReadonlySet<string>;
	readonly setupState: SetupState;
	readonly keepSetupToken: boolean;
}): SecretPlan => {
	const notes: string[] = [];
	if (input.firstDeploy) {
		return {
			put: [SECRET_NAMES.root, SECRET_NAMES.setup],
			setupTokenKnown: true,
			offerDelete: false,
			notes,
		};
	}
	if (!input.existing.has(SECRET_NAMES.root)) {
		notes.push(
			"TARTAN_SECRET is not set: this forge uses the root key it generated at first boot (the setup wizard and Admin → Health show how to move it into the secret)",
		);
	}
	if (input.setupState === "done") {
		return {
			put: [],
			setupTokenKnown: false,
			offerDelete: input.existing.has(SECRET_NAMES.setup),
			notes,
		};
	}
	if (input.keepSetupToken) {
		notes.push(
			input.existing.has(SECRET_NAMES.setup)
				? "kept the existing TARTAN_SETUP_TOKEN (--keep-setup-token): open /-/setup and paste the token you hold"
				: "no TARTAN_SETUP_TOKEN (--keep-setup-token): the claim code is in the Worker's logs (Workers Logs)",
		);
		return { put: [], setupTokenKnown: false, offerDelete: false, notes };
	}
	return {
		put: [SECRET_NAMES.setup],
		setupTokenKnown: true,
		offerDelete: false,
		notes,
	};
};

const DIGEST = /sha256:[0-9a-f]{64}/g;

/**
 * The deployed image digest check for `--image registry` (U43): the
 * container application's description must name the recorded digest.
 */
export const checkDeployedDigest = (
	containersJson: unknown,
	appName: string,
	expectedRef: string,
): { readonly ok: boolean; readonly message: string } => {
	const expected = validateRegistryRef(expectedRef).split("@")[1];
	const apps = Array.isArray(containersJson) ? containersJson : [];
	const app = apps.find((a: { name?: unknown }) => a?.name === appName);
	if (app === undefined) {
		return { ok: false, message: `no container application ${appName}` };
	}
	const digests = new Set(JSON.stringify(app).match(DIGEST) ?? []);
	if (digests.has(expected)) {
		return { ok: true, message: `deployed image is ${expected}` };
	}
	return {
		ok: false,
		message: digests.size === 0
			? `${appName} reports no image digest; expected ${expected}`
			: `${appName} runs ${
				[...digests].join(", ")
			}, not the recorded ${expected}`,
	};
};

// ---------------------------------------------------------------------------
// Health, warm-up
// ---------------------------------------------------------------------------

export type Clock = {
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
};

/** Deno's `fetch` with a per-call `client` (`Deno.HttpClient`). */
export type ClientFetch = (
	input: string | URL | Request,
	init: RequestInit & { client: Deno.HttpClient },
) => Promise<Response>;

const NULL_BODY_STATUS = new Set([204, 205, 304]);

/**
 * A `fetch` that never reuses a connection. Each call gets its own HTTP
 * client with no idle pool, so it resolves the hostname again and opens a new
 * connection; the body is read before that client is closed. The process-wide
 * pool would keep a keep-alive connection to whatever server the hostname
 * pointed at before a Custom Domain replaced its DNS record, and every later
 * poll would ask that old server again.
 */
export const createFreshFetch = (deps: {
	readonly fetch: ClientFetch;
	readonly createClient: () => Deno.HttpClient;
}): typeof fetch =>
	(async (input: string | URL | Request, init?: RequestInit) => {
		const client = deps.createClient();
		try {
			const response = await deps.fetch(input, { ...init, client });
			const body = await response.arrayBuffer();
			return new Response(
				NULL_BODY_STATUS.has(response.status) ? null : body,
				{
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				},
			);
		} finally {
			client.close();
		}
	}) as typeof fetch;

/** Deno's `fetch` with a new client (no idle pool) per call. */
export const denoFreshFetch = (): typeof fetch =>
	createFreshFetch({
		fetch: (input, init) => fetch(input, init),
		createClient: () => Deno.createHttpClient({ poolMaxIdlePerHost: 0 }),
	});

/** What one `GET /-/health` attempt found. */
export type Probe =
	| { readonly kind: "healthy"; readonly health: HealthResponse }
	| {
		/**
		 * `dns`: the hostname does not resolve; `tls`: the TLS handshake or
		 * certificate check failed; `unreachable`: no connection or no answer in
		 * time; `foreign`: an answer, but not from this Tartan stage;
		 * `unhealthy`: this stage answered, but not 200.
		 */
		readonly kind: "dns" | "tls" | "unreachable" | "foreign" | "unhealthy";
		readonly detail: string;
	};

export type ProbeKind = Probe["kind"];
export type ProbeFailure = Extract<Probe, { readonly detail: string }>;

const DNS_ERROR =
	/dns error|failed to lookup address|nodename nor servname|name or service not known|no such host|name resolution|ENOTFOUND|EAI_AGAIN/i;
const TLS_ERROR =
	/certificate|\btls\b|\bssl\b|handshake|received fatal alert|alertreceived/i;

/** One error and its causes, without Deno's "error sending request for url (…)" prefix. */
const errorMessages = (error: unknown): string[] => {
	const messages: string[] = [];
	let current: unknown = error;
	for (let depth = 0; depth < 6 && current != null; depth++) {
		const message = current instanceof Error
			? current.message
			: String(current);
		messages.push(
			message.split("\n")[0]
				.replace(/^error sending request for url \([^)]*\):\s*/i, "")
				.replace(/^client error \([^)]*\):\s*/i, ""),
		);
		current = current instanceof Error ? current.cause : undefined;
	}
	return messages;
};

const isTimeout = (error: unknown): boolean => {
	let current: unknown = error;
	for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
		if (current.name === "TimeoutError") return true;
		current = current.cause;
	}
	return false;
};

/** Classifies a failed attempt (fetch rejected: no HTTP answer at all). */
const classifyFetchError = (
	error: unknown,
	attemptTimeoutMs: number,
): ProbeFailure => {
	if (isTimeout(error)) {
		return {
			kind: "unreachable",
			detail: `timed out after ${formatElapsed(attemptTimeoutMs)}`,
		};
	}
	const messages = errorMessages(error);
	const detail = messages.at(-1) || "fetch failed";
	const all = messages.join("\n");
	if (DNS_ERROR.test(all)) return { kind: "dns", detail };
	if (TLS_ERROR.test(all)) return { kind: "tls", detail };
	return { kind: "unreachable", detail };
};

/**
 * Classifies an HTTP answer. Only a `/-/health` body with `product: "Tartan"`
 * and this stage comes from this deploy; anything else is another server.
 */
const classifyResponse = (
	response: {
		readonly status: number;
		readonly headers: Headers;
		readonly text: string;
	},
	stage: string,
): Probe => {
	let body: Partial<HealthResponse> | null = null;
	try {
		const parsed: unknown = JSON.parse(response.text);
		if (typeof parsed === "object" && parsed !== null) {
			body = parsed as Partial<HealthResponse>;
		}
	} catch {
		body = null;
	}
	const server = response.headers.get("server")?.slice(0, 80);
	const answer = `HTTP ${response.status}${
		server ? `, server: ${server}` : ""
	}`;
	if (body?.product !== "Tartan") return { kind: "foreign", detail: answer };
	if (body.stage !== stage) {
		return {
			kind: "foreign",
			detail: `Tartan stage ${JSON.stringify(body.stage)} answered, ${answer}`,
		};
	}
	const bindings = typeof body.bindings === "object" && body.bindings !== null
		? body.bindings
		: {};
	if (response.status === 200) {
		return { kind: "healthy", health: { ...body, bindings } as HealthResponse };
	}
	const bad = Object.entries(bindings).filter(([, s]) => s !== "ok");
	return {
		kind: "unhealthy",
		detail: `HTTP ${response.status}; bindings not ok: ${
			bad.map(([n, s]) => `${n}=${s}`).join(", ") || "none"
		}`,
	};
};

/** `45s`, `2m05s`. */
export const formatElapsed = (ms: number): string => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60
		? `${s}s`
		: `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/** An attempt's timeout: its own limit, capped at the deadline. */
const attemptBudget = (limitMs: number, deadline: number, now: number) =>
	Math.max(1, Math.min(limitMs, deadline - now));

/**
 * The wait before the next attempt, or null when the deadline leaves less
 * than MIN_ATTEMPT_MS for one: an attempt started at the deadline would time
 * out at once and hide what the earlier attempts saw.
 */
const nextWait = (
	at: number,
	deadline: number,
	intervalMs: number,
): number | null => {
	const left = deadline - at;
	return left <= MIN_ATTEMPT_MS
		? null
		: Math.min(intervalMs, left - MIN_ATTEMPT_MS);
};

const describeProbe = (probe: Probe, stage: string): string => {
	switch (probe.kind) {
		case "healthy":
			return `healthy: stage ${probe.health.stage}, setup ${probe.health.setupState}, ${
				Object.keys(probe.health.bindings).length
			} bindings ok`;
		case "dns":
			return `the hostname does not resolve yet (${probe.detail})`;
		case "tls":
			return `the TLS handshake failed: the certificate is probably still being issued (${probe.detail})`;
		case "unreachable":
			return `no answer (${probe.detail})`;
		case "foreign":
			return `connected, but the answer is not from Tartan stage ${stage} (${probe.detail}): another server still answers for this hostname (an old DNS record, a cached lookup, or a route that is not live yet)`;
		case "unhealthy":
			return `stage ${stage} answered, but is not healthy yet (${probe.detail})`;
	}
};

export type DomainPollerDeps = {
	/** A fetch that opens a new connection per call (`createFreshFetch`). */
	readonly fetch: typeof fetch;
	readonly clock: Clock;
	readonly log: (line: string) => void;
	/** The per-attempt abort signal (default `AbortSignal.timeout`). */
	readonly timeout?: (ms: number) => AbortSignal;
};

export type DomainPollOptions = {
	readonly origin: string;
	readonly stage: string;
	/** The overall deadline. */
	readonly timeoutMs: number;
	readonly attemptTimeoutMs?: number;
	readonly intervalMs?: number;
};

/**
 * Polls `<origin>/-/health` until this stage answers 200. Every
 * attempt sends `connection: close` through a fetch that opens a new
 * connection, is cut off after `attemptTimeoutMs`, and is classified; a
 * progress line (with the elapsed time) is logged only when the
 * classification changes. Once the overall deadline leaves no room for
 * another attempt it throws a DeployError that names the last
 * classification.
 */
export const createDomainPoller = (deps: DomainPollerDeps) => {
	const timeout = deps.timeout ?? ((ms: number) => AbortSignal.timeout(ms));

	const probe = async (
		origin: string,
		stage: string,
		attemptTimeoutMs = ATTEMPT_TIMEOUT_MS,
	): Promise<Probe> => {
		try {
			const response = await deps.fetch(`${origin}/-/health`, {
				headers: { "cache-control": "no-store", connection: "close" },
				redirect: "manual",
				signal: timeout(attemptTimeoutMs),
			});
			const text = await response.text();
			return classifyResponse(
				{ status: response.status, headers: response.headers, text },
				stage,
			);
		} catch (error) {
			return classifyFetchError(error, attemptTimeoutMs);
		}
	};

	const poll = async (options: DomainPollOptions): Promise<HealthResponse> => {
		const { now, sleep } = deps.clock;
		const started = now();
		const deadline = started + options.timeoutMs;
		const attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
		let lastKind: ProbeKind | null = null;
		let changedAt = started;
		for (;;) {
			const result = await probe(
				options.origin,
				options.stage,
				attemptBudget(attemptTimeoutMs, deadline, now()),
			);
			const at = now();
			if (result.kind !== lastKind) {
				deps.log(
					`  [${formatElapsed(at - started)}] ${
						describeProbe(result, options.stage)
					}`,
				);
				changedAt = at;
			}
			lastKind = result.kind;
			if (result.kind === "healthy") return result.health;
			const wait = nextWait(at, deadline, options.intervalMs ?? 5_000);
			if (wait === null) {
				throw new DeployError(
					`${options.origin}/-/health did not answer as Tartan stage ${options.stage} within ${
						formatElapsed(options.timeoutMs)
					}; for the last ${formatElapsed(at - changedAt)}: ${
						describeProbe(result, options.stage)
					}`,
				);
			}
			await sleep(wait);
		}
	};

	return { probe, poll };
};

type RunnerInfo = NonNullable<HealthResponse["runner"]>;

/**
 * `POST /-/health/warm` until the runner's selftest has answered. The sandbox
 * allows one start per 10 minutes, so after the first POST a 429 means
 * "running": the result is then read from `/-/health`. Every request has its
 * own timeout, capped at the step deadline, so a request that never answers
 * cannot hold the deploy past it.
 */
export const warmUp = async (input: {
	readonly fetch: typeof fetch;
	readonly origin: string;
	readonly timeoutMs: number;
	readonly intervalMs?: number;
	/** Per POST (default WARM_ATTEMPT_TIMEOUT_MS); `/-/health` gets ATTEMPT_TIMEOUT_MS. */
	readonly attemptTimeoutMs?: number;
	readonly clock: Clock;
	/** The per-request abort signal (default `AbortSignal.timeout`). */
	readonly timeout?: (ms: number) => AbortSignal;
	readonly onWait?: (detail: string) => void;
}): Promise<
	{ readonly ok: true; readonly runner: RunnerInfo } | {
		readonly ok: false;
		readonly reason: string;
	}
> => {
	const timeout = input.timeout ?? ((ms: number) => AbortSignal.timeout(ms));
	const started = input.clock.now();
	const deadline = started + input.timeoutMs;
	const attemptTimeoutMs = input.attemptTimeoutMs ?? WARM_ATTEMPT_TIMEOUT_MS;
	let last = "no answer yet";
	for (;;) {
		const postMs = attemptBudget(attemptTimeoutMs, deadline, input.clock.now());
		try {
			const response = await input.fetch(`${input.origin}/-/health/warm`, {
				method: "POST",
				signal: timeout(postMs),
			});
			const body = await response.json().catch(() => null) as
				| Partial<RunnerInfo>
				| null;
			if (
				(response.status === 200 || response.status === 503) &&
				typeof body?.ok === "boolean" && "gitVersion" in body
			) {
				return body.ok ? { ok: true, runner: body as RunnerInfo } : {
					ok: false,
					reason: `the runner selftest failed (git ${
						body.gitVersion ?? "?"
					}, merge-tree ${body.mergeTree}, pnpm ${body.pnpmVersion ?? "?"})`,
				};
			}
			if (response.status === 429) {
				const healthMs = attemptBudget(
					ATTEMPT_TIMEOUT_MS,
					deadline,
					input.clock.now(),
				);
				const health = await input.fetch(`${input.origin}/-/health`, {
					signal: timeout(healthMs),
				}).then((r) => r.json()).catch(() => null) as HealthResponse | null;
				const runner = health?.runner;
				if (runner && runner.checkedAt >= started - 60_000) {
					return runner.ok
						? { ok: true, runner }
						: { ok: false, reason: "the runner selftest failed" };
				}
				last = "selftest running";
			} else {
				last = `HTTP ${response.status}`;
			}
		} catch (error) {
			last = classifyFetchError(error, postMs).detail;
		}
		const wait = nextWait(
			input.clock.now(),
			deadline,
			input.intervalMs ?? 10_000,
		);
		if (wait === null) {
			return {
				ok: false,
				reason: `no selftest result within ${
					formatElapsed(input.timeoutMs)
				} (${last})`,
			};
		}
		input.onWait?.(last);
		await input.clock.sleep(wait);
	}
};

// ---------------------------------------------------------------------------
// The deploy
// ---------------------------------------------------------------------------

/**
 * The WASM extension packages `--build-ext` builds (`extensions/<name>/`,
 * a Rust crate; `scripts/build-ext.ts` writes `dist/`).
 */
export const EXT_PACKAGES = ["acme-no-secrets"] as const;

/** The WASM target the extension crates build for. */
const WASM_TARGET = "wasm32-unknown-unknown";

/**
 * What `--build-ext` needs, checked before anything is deployed: `cargo`,
 * the wasm32 target (through `rustup`), `wasm-tools` (or `WASM_TOOLS`) and
 * jco (`node_modules/.bin/jco`, or `JCO`). Answers the missing items with
 * a fix for each; empty when all are there.
 */
export const extToolchainIssues = async (
	deps: Pick<DeployDeps, "run" | "root" | "readText" | "env">,
): Promise<string[]> => {
	const issues: string[] = [];
	const has = async (cmd: string, args: string[]) => {
		try {
			return (await deps.run(cmd, args, { cwd: deps.root })).code === 0;
		} catch {
			return false;
		}
	};
	if (!await has("cargo", ["--version"])) {
		issues.push("cargo is missing: install Rust (https://rustup.rs)");
	} else {
		let targets = "";
		try {
			const listed = await deps.run(
				"rustup",
				["target", "list", "--installed"],
				{ cwd: deps.root },
			);
			targets = listed.code === 0 ? listed.stdout : "";
		} catch {
			targets = "";
		}
		if (!targets.split(/\s+/).includes(WASM_TARGET)) {
			issues.push(
				`the ${WASM_TARGET} target is missing: rustup target add ${WASM_TARGET}`,
			);
		}
	}
	const wasmTools = deps.env("WASM_TOOLS") ?? "wasm-tools";
	if (!await has(wasmTools, ["--version"])) {
		issues.push(
			"wasm-tools is missing: cargo install --locked wasm-tools@1.248.0 (or set WASM_TOOLS)",
		);
	}
	const jco = deps.env("JCO");
	const jcoOk = jco !== undefined
		? await has(jco, ["--version"])
		: await deps.readText(
			path.join(
				deps.root,
				"node_modules",
				"@bytecodealliance",
				"jco",
				"package.json",
			),
		) !== null;
	if (!jcoOk) {
		issues.push("jco is missing: npm ci (it is a devDependency), or set JCO");
	}
	return issues;
};

export type DeployDeps = Omit<PreflightDeps, "login" | "account"> & {
	/** For the health polls: a new connection per call (`createFreshFetch`). */
	readonly freshFetch: typeof fetch;
	readonly sleep: (ms: number) => Promise<void>;
	readonly writeText: (
		file: string,
		text: string,
		options?: { readonly secret?: boolean },
	) => Promise<void>;
	readonly isSymlink: (file: string) => Promise<boolean>;
	readonly random: (n: number) => Uint8Array;
	readonly interactive: boolean;
	readonly confirm: (question: string) => Promise<boolean>;
	/** Prints the setup URL: the one place a secret reaches the terminal. */
	readonly printSecret: (line: string) => void;
};

export type DeployRecord = {
	readonly stage: string;
	/** The global log's stream and token names (ids and names only; WP26). */
	readonly k2?: {
		readonly streamId: string;
		readonly streamName: string;
		readonly token?: { readonly storeId: string; readonly secretName: string };
	};
	readonly worker: string;
	readonly accountId: string;
	readonly workersDev: string;
	readonly domain: string | null;
	readonly image: { readonly variant: string; readonly ref?: string };
	readonly versionId: string | null;
	readonly commit: string | null;
	readonly deployedAt: string;
	readonly runner?: RunnerInfo;
	readonly setupState: SetupState;
	readonly setupUrlFile?: string;
};

export const recordPath = (root: string, stage: string): string =>
	path.join(root, ".wrangler", "deploy", `record.${stage}.json`);

const listSecrets = async (
	api: CfApi | null,
	run: Run,
	worker: string,
): Promise<{ exists: boolean; names: Set<string> } | null> => {
	if (api !== null) {
		const response = await api.account(
			"GET",
			`/workers/scripts/${worker}/secrets`,
		);
		if (response.status === 404) return { exists: false, names: new Set() };
		if (response.status === 200 && Array.isArray(response.body?.result)) {
			return {
				exists: true,
				names: new Set(
					response.body.result.map((s: { name?: unknown }) => String(s.name)),
				),
			};
		}
	}
	const out = await wrangler(run, [
		"secret",
		"list",
		"--name",
		worker,
		"--format",
		"json",
	]);
	if (out.code !== 0) return null;
	try {
		const list = JSON.parse(out.stdout.slice(out.stdout.indexOf("[")));
		return {
			exists: true,
			names: new Set(list.map((s: { name?: unknown }) => String(s.name))),
		};
	} catch {
		return null;
	}
};

export const putSecret = async (
	run: Run,
	config: string,
	name: string,
	value: string,
	env: Record<string, string>,
): Promise<void> => {
	const out = await wrangler(run, ["secret", "put", name, "-c", config], {
		stdin: value,
		env,
	});
	if (out.code !== 0) {
		throw new DeployError(
			`wrangler secret put ${name} failed (exit ${out.code}): ${
				out.stderr.trim().split("\n").slice(-3).join(" ")
			}`,
		);
	}
};

export const runDeploy = async (
	options: DeployOptions,
	deps: DeployDeps,
): Promise<DeployRecord> => {
	const log = deps.log;
	const names = stageNames(options.stage);
	const clock: Clock = { now: deps.now, sleep: deps.sleep };
	const poller = createDomainPoller({ fetch: deps.freshFetch, clock, log });

	// 0. Dependencies.
	const modules = await assessNodeModules(deps.root, deps.readText);
	if (modules.state !== "ok") {
		const why = modules.state === "missing"
			? "node_modules is missing"
			: `node_modules does not match package.json (${
				modules.mismatches.slice(0, 3).join("; ")
			})`;
		if (await deps.isSymlink(path.join(deps.root, "node_modules"))) {
			throw new DeployError(
				`${why}, and node_modules is a symlink (a worktree): run \`npm ci\` in the checkout it points to`,
			);
		}
		log(`${why}: running npm ci`);
		const ci = await deps.run("npm", ["ci"], { io: "inherit", cwd: deps.root });
		if (ci.code !== 0) throw new DeployError(`npm ci failed (exit ${ci.code})`);
	}

	// 1. Login and preflight.
	const pre = await runPreflight(options, {
		...deps,
		account: options.account,
		login: deps.interactive,
	});
	log(`preflight for stage ${options.stage}:`);
	log(formatChecks(pre.checks));
	if (!pre.ok || pre.auth === null) {
		throw new PreflightError("preflight failed; fix the items marked fail");
	}
	if (options.buildExt) {
		const issues = await extToolchainIssues(deps);
		if (issues.length > 0) {
			throw new PreflightError(
				`--build-ext needs the Rust → WASM toolchain:\n  - ${
					issues.join("\n  - ")
				}`,
			);
		}
	}
	const auth: Auth = pre.auth;
	const childEnv = { CLOUDFLARE_ACCOUNT_ID: auth.account.id };
	const api = pre.api;

	// 2. The registry image record.
	let registryRef: string | undefined;
	if (options.containers && options.image === "registry") {
		if (pre.record?.valid) {
			registryRef = pre.record.ref;
		} else {
			log("publishing the runner image (containers/runner/publish.ts)");
			const publish = await deps.run(Deno.execPath(), [
				"run",
				"-A",
				"containers/runner/publish.ts",
				"--record",
				options.imageRecordPath,
			], { io: "inherit", cwd: deps.root });
			if (publish.code !== 0) {
				throw new DeployError(
					`publishing the runner image failed (exit ${publish.code})`,
				);
			}
			const text = await deps.readText(options.imageRecordPath);
			registryRef = validateRegistryRef(
				String(JSON.parse(text ?? "{}").ref ?? ""),
			);
		}
	}

	// 2b. The global log's stream (WP26).
	let k2: K2Render | undefined;
	if (options.k2 !== undefined) {
		let streamId = options.k2.streamId;
		if (streamId === undefined) {
			if (api === null) {
				throw new DeployError(
					"--k2 needs the account API (log in with wrangler), or pass --k2-stream <id>",
				);
			}
			retentionFor(options.stage, options.k2.retentionSeconds);
			const ensured = await ensureLogStream(cfK2Streams(api), {
				stage: options.stage,
				...(options.k2.retentionSeconds === undefined
					? {}
					: { retentionSeconds: options.k2.retentionSeconds }),
				...(options.k2.maxStreams === undefined
					? {}
					: { maxStreams: options.k2.maxStreams }),
			});
			for (const warning of ensured.warnings) log(`warning: ${warning}`);
			log(
				`${
					ensured.created ? "created" : "found"
				} K2 stream ${ensured.stream.name} (${ensured.stream.id})`,
			);
			streamId = ensured.stream.id;
		}
		k2 = {
			streamId,
			...(options.k2.token ? { token: options.k2.token } : {}),
		};
		if (options.k2.token === undefined) {
			log(
				"no --k2-token-store/--k2-token-secret: the forge relays every event to the global log and dispatches every run inline (manual step M10 adds the K2 Consume token)",
			);
		}
	}

	// 3. Render.
	const sourcePath = path.join(deps.root, "wrangler.jsonc");
	const configPath = defaultOutPath(sourcePath, options.stage);
	const renderOptions: RenderOptions = {
		stage: options.stage,
		domain: options.domain,
		containers: options.containers,
		image: registryRef === undefined
			? { kind: "dockerfile" }
			: { kind: "registry", ref: registryRef },
		evictionFlag: options.evictionFlag,
		devTools: options.devTools,
		repoConfig: options.repoConfig,
		projects: options.projects,
		...(options.laneMode === undefined ? {} : { laneMode: options.laneMode }),
		...(options.workloadTransport === undefined
			? {}
			: { workloadTransport: options.workloadTransport }),
		...(k2 === undefined ? {} : { k2 }),
		sourceDir: deps.root,
		outDir: path.dirname(configPath),
	};
	const rendered = renderConfig(
		(await deps.readText(sourcePath)) ??
			(() => {
				throw new DeployError(`${sourcePath} is missing`);
			})(),
		renderOptions,
	);
	if (k2 !== undefined && !rendered.includes('"EVENT_LOG"')) {
		throw new DeployError(
			"render-config.ts did not render the K2 binding (it needs --k2-stream support)",
		);
	}
	await deps.writeText(configPath, rendered);
	log(`rendered ${path.relative(deps.root, configPath)}`);

	// 4. Build and deploy.
	const before = await listSecrets(api, deps.run, names.worker);
	const firstDeploy = before !== null && !before.exists;
	if (options.build) {
		const build = await deps.run("npm", ["run", "build:web"], {
			io: "inherit",
			cwd: deps.root,
		});
		if (build.code !== 0) {
			throw new DeployError(`npm run build:web failed (exit ${build.code})`);
		}
	}
	if (options.buildExt) {
		for (const name of EXT_PACKAGES) {
			const ext = await deps.run("deno", ["task", "build:ext", name], {
				io: "inherit",
				cwd: deps.root,
			});
			if (ext.code !== 0) {
				throw new DeployError(
					`deno task build:ext ${name} failed (exit ${ext.code})`,
				);
			}
		}
		log(
			`built ${
				EXT_PACKAGES.join(", ")
			}: publish with an admin token after the claim (PUT /-/api/packages with dist/publish.json)`,
		);
	}
	const deploy = async () =>
		await wrangler(deps.run, ["deploy", "-c", configPath], {
			io: "tee",
			cwd: deps.root,
			env: childEnv,
		});
	let result = await deploy();
	if (
		result.code !== 0 && options.containers && registryRef === undefined &&
		isRegistryPushTimeout(result.stdout + result.stderr)
	) {
		log("the container registry push timed out: retrying the deploy once");
		result = await deploy();
	}
	if (result.code !== 0) {
		throw new DeployError(`wrangler deploy failed (exit ${result.code})`);
	}
	const parsed = parseDeployOutput(result.stdout + result.stderr, names.worker);
	const workersDev = parsed.workersDev ??
		(pre.workersDevSubdomain === null
			? undefined
			: `https://${names.worker}.${pre.workersDevSubdomain}.workers.dev`);
	if (workersDev === undefined) {
		throw new DeployError("could not tell the workers.dev URL of the deploy");
	}

	if (registryRef !== undefined) {
		const list = await wrangler(deps.run, ["containers", "list", "--json"], {
			env: childEnv,
		});
		let json: unknown = null;
		try {
			json = JSON.parse(list.stdout.slice(list.stdout.search(/[[{]/)));
		} catch {
			json = null;
		}
		const digest = checkDeployedDigest(json, names.containerApp, registryRef);
		if (!digest.ok) {
			throw new DeployError(`image digest check: ${digest.message}`);
		}
		log(digest.message);
	}

	// 5. Secrets of a new Worker go in before anything asks it for a key.
	const secretValues = new Map<string, string>();
	const putAll = async (list: readonly string[]) => {
		for (const name of list) {
			const value = generateSecret(deps.random);
			await putSecret(deps.run, configPath, name, value, childEnv);
			secretValues.set(name, value);
			log(`set secret ${name} (generated, written through stdin)`);
		}
	};
	let secretPlan: SecretPlan | null = null;
	if (firstDeploy) {
		secretPlan = planSecrets({
			firstDeploy: true,
			existing: new Set(),
			setupState: "fresh",
			keepSetupToken: options.keepSetupToken,
		});
		await putAll(secretPlan.put);
	}

	// 7a. Health on workers.dev.
	log(
		`waiting for ${workersDev}/-/health (up to ${
			formatElapsed(HEALTH_TIMEOUT_MS)
		})`,
	);
	let health = await poller.poll({
		origin: workersDev,
		stage: options.stage,
		timeoutMs: HEALTH_TIMEOUT_MS,
	});

	if (secretPlan === null) {
		const existing = await listSecrets(api, deps.run, names.worker);
		secretPlan = planSecrets({
			firstDeploy: false,
			existing: existing?.names ?? new Set(),
			setupState: health.setupState,
			keepSetupToken: options.keepSetupToken,
		});
		await putAll(secretPlan.put);
	}
	for (const note of secretPlan.notes) log(`note: ${note}`);
	if (secretPlan.put.length > 0) await deps.sleep(5_000); // let the new version answer

	// 6. Warm the container app.
	let runner: RunnerInfo | undefined;
	if (options.containers) {
		log("warming the runner container (POST /-/health/warm, up to 2 min)");
		const warm = await warmUp({
			fetch: deps.fetch,
			origin: workersDev,
			timeoutMs: WARM_TIMEOUT_MS,
			clock,
			onWait: (d) => log(`  … ${d}`),
		});
		if (warm.ok) {
			runner = warm.runner;
			log(
				`runner ready: git ${warm.runner.gitVersion}, pnpm ${warm.runner.pnpmVersion}`,
			);
		} else {
			log(
				`warning: runner warm-up did not finish: ${warm.reason}; the first CI run may wait for a cold start`,
			);
		}
	}

	// 7b. Health on the custom domain: DNS propagation and certificate
	// issuance can take minutes, and an old DNS record may answer meanwhile.
	const origin = options.domain === undefined
		? workersDev
		: `https://${options.domain}`;
	if (options.domain !== undefined) {
		log(
			`waiting for ${origin}/-/health (up to ${
				formatElapsed(DOMAIN_TIMEOUT_MS)
			}; a new connection per attempt)`,
		);
		health = await poller.poll({
			origin,
			stage: options.stage,
			timeoutMs: DOMAIN_TIMEOUT_MS,
			intervalMs: DOMAIN_INTERVAL_MS,
		});
	}

	// 8. The setup URL, once.
	let setupUrlFile: string | undefined;
	const token = secretValues.get(SECRET_NAMES.setup);
	if (health.setupState !== "done" && token !== undefined) {
		const url = setupUrl(origin, token);
		if (options.printUrl) {
			log("");
			log(
				"Open this single-use setup URL to claim the forge (it is shown once):",
			);
			deps.printSecret(`  ${url}`);
		} else {
			await deps.writeText(options.urlFile, `${url}\n`, { secret: true });
			setupUrlFile = options.urlFile;
			log("");
			log(`The single-use setup URL is in ${options.urlFile} (mode 0600).`);
		}
		log(idpHint(origin));
	} else if (health.setupState === "done") {
		log(`The forge is claimed: ${origin}`);
	}

	if (secretPlan.offerDelete && options.deleteSetupToken !== false) {
		const remove = options.deleteSetupToken === true ||
			(deps.interactive &&
				await deps.confirm(
					"The forge is claimed. Delete TARTAN_SETUP_TOKEN now (a new one can be set later for recovery)?",
				));
		if (remove) {
			const out = await wrangler(deps.run, [
				"secret",
				"delete",
				SECRET_NAMES.setup,
				"-c",
				configPath,
			], { stdin: "y\n", env: childEnv });
			if (out.code !== 0) {
				log(
					`warning: wrangler secret delete ${SECRET_NAMES.setup} failed (exit ${out.code})`,
				);
			} else {
				log(`deleted secret ${SECRET_NAMES.setup}`);
			}
		} else {
			log(
				`The forge is claimed; delete the setup token when you like: npx wrangler secret delete ${SECRET_NAMES.setup} --name ${names.worker}`,
			);
		}
	}

	const head = await deps.run("git", ["rev-parse", "HEAD"], { cwd: deps.root })
		.catch(() => null);
	const record: DeployRecord = {
		stage: options.stage,
		...(k2 === undefined ? {} : {
			k2: {
				streamId: k2.streamId,
				streamName: logStreamName(options.stage),
				...(k2.token ? { token: k2.token } : {}),
			},
		}),
		worker: names.worker,
		accountId: auth.account.id,
		workersDev,
		domain: options.domain ?? null,
		image: options.containers
			? { variant: options.image, ...(registryRef ? { ref: registryRef } : {}) }
			: { variant: "none" },
		versionId: parsed.versionId ?? null,
		commit: head?.code === 0 ? head.stdout.trim() : null,
		deployedAt: new Date(deps.now()).toISOString(),
		...(runner ? { runner } : {}),
		setupState: health.setupState,
		...(setupUrlFile ? { setupUrlFile } : {}),
	};
	const file = recordPath(deps.root, options.stage);
	// Each deploy writes a fresh record; destroy adds its outcome to it.
	await deps.writeText(file, `${JSON.stringify(record, null, "\t")}\n`);
	log(`deploy record: ${path.relative(deps.root, file)}`);
	return record;
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const realDeps = (): DeployDeps => ({
	run: denoRun,
	fetch,
	freshFetch: denoFreshFetch(),
	env: (name) => Deno.env.get(name),
	now: Date.now,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	root: REPO_ROOT,
	readText: readTextOrNull,
	writeText: async (file, text, options) => {
		await Deno.mkdir(path.dirname(file), { recursive: true });
		if (options?.secret) {
			await Deno.writeTextFile(file, text, { mode: 0o600 });
			await Deno.chmod(file, 0o600);
		} else {
			await Deno.writeTextFile(file, text);
		}
	},
	isSymlink: async (file) => {
		try {
			return (await Deno.lstat(file)).isSymlink;
		} catch {
			return false;
		}
	},
	random: (n) => crypto.getRandomValues(new Uint8Array(n)),
	denoVersion: Deno.version.deno,
	log: (line) => console.log(line),
	interactive: Deno.stdin.isTerminal(),
	confirm: (question) => Promise.resolve(confirm(question)),
	printSecret: (line) => console.log(line),
});

const main = async (): Promise<number> => {
	try {
		const options = optionsFromArgs(Deno.args, REPO_ROOT);
		if (options === undefined) {
			console.log(DEPLOY_USAGE);
			return 0;
		}
		await runDeploy(options, realDeps());
		return 0;
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`deploy: ${error.message}\n\n${DEPLOY_USAGE}`);
			return 2;
		}
		if (error instanceof DeployError || error instanceof PreflightError) {
			console.error(`deploy: ${error.message}`);
			return 1;
		}
		throw error;
	}
};

if (import.meta.main) Deno.exit(await main());
