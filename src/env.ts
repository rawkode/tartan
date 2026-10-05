// The Worker's bindings, hand-written (no `wrangler types` codegen). Mirrors
// wrangler.jsonc and the vitest inline miniflare options; a binding added to
// one is added to all three in the same integrator commit. Secrets are
// optional: the button path boots without them.

import type { BusDO } from "./do/bus.ts";
import type { ForgeDO } from "./do/forge.ts";
import type { RepoDO } from "./do/repo.ts";
import type { ExtensionDO } from "./kernel/exthost/host/do.ts";
import type { K2Producer } from "./kernel/bus/k2.ts";
import type { InboxDO } from "./kernel/inbox/do.ts";
import type { IngestWorkflowParams } from "./kernel/ingest/workflow.ts";
import type { LandWorkflowParams } from "./kernel/land/workflow.ts";
import type { TartanSandbox } from "./kernel/runs/sandbox.ts";
import type { RunWorkflowParams } from "./kernel/runs/workflow.ts";
import type { SwarmWorkflowParams } from "./kernel/swarm/workflow.ts";

export interface Env {
	// --- Platform bindings -------------------------------------------------
	/** Vue SPA (`web/dist`), `run_worker_first: true`, SPA not-found handling. */
	readonly ASSETS: Fetcher;
	/**
	 * Artifacts namespace `tartan-<stage>`: canonical `r-<repoUlid>`, lane repos
	 * `l-<repoUlid>-<laneUlid>[-<n>]` (branch-backend lanes are refs).
	 */
	readonly ARTIFACTS: Artifacts;
	/** Dynamic Workers for `js`/`wasm` extensions. */
	readonly LOADER: WorkerLoader;
	readonly FORGE: DurableObjectNamespace<ForgeDO>;
	readonly REPO: DurableObjectNamespace<RepoDO>;
	readonly INBOX: DurableObjectNamespace<InboxDO>;
	readonly EXT: DurableObjectNamespace<ExtensionDO>;
	readonly SANDBOX: DurableObjectNamespace<TartanSandbox>;
	/** The global log consumer, `bus:<group>:<n>` (WP26). */
	readonly BUS: DurableObjectNamespace<BusDO>;
	/**
	 * The global log's K2 producer binding (WP26), rendered per stage only
	 * (`render-config.ts --k2-stream`); absent on the button path, where the
	 * relay is off and every run dispatches inline.
	 */
	readonly EVENT_LOG?: K2Producer;
	readonly RUNS: Workflow<RunWorkflowParams>;
	readonly LAND: Workflow<LandWorkflowParams>;
	readonly INGEST: Workflow<IngestWorkflowParams>;
	readonly SWARM: Workflow<SwarmWorkflowParams>;
	/** R2 `tartan-<stage>-blobs`: logs/ ext/ blame/ diffs/ bundles/. */
	readonly BLOBS: R2Bucket;
	/** workers-oauth-provider state (M2). */
	readonly OAUTH_KV: KVNamespace;
	readonly AI: Ai;

	// --- Vars (wrangler.jsonc "vars") --------------------------------------
	readonly TARTAN_STAGE: string;
	/** Comma-separated feature flags; never "swarm" by default. */
	readonly TARTAN_FEATURES: string;
	/** "1" enables dev tools, only together with `TARTAN_STAGE` matching `^dev`. */
	readonly TARTAN_DEV_TOOLS: string;
	/** Push body cap in decimal MB (`MAX_PUSH_BYTES`, ≤ the zone plan's body limit). */
	readonly TARTAN_MAX_PUSH_MB: string;
	readonly TARTAN_JUDGE_MODEL: string;
	/** GitOps override of the IdP wizard step (empty = use the wizard). */
	readonly OIDC_ISSUER: string;
	readonly OIDC_CLIENT_ID: string;
	/**
	 * An optional shortening of `LANE_FALLBACK` to `branch`, read with
	 * `laneFallback` (constants.ts).
	 */
	readonly TARTAN_LANE_FALLBACK?: string;
	/**
	 * Repository config in CUE (ADR repo config): `on`
	 * evaluates the root package `tartan` (every root `*.cue` file is sent;
	 * the CLI selects the package), reads repo policy (the CI pipeline, the
	 * review owners, the projects) from it, holds lands while a policy change
	 * resolves and requires the policy sign-off (K13.1–K13.3); `off` (the
	 * default) does none of that, so there is no repo config at all
	 * (zero-config CI, no owners rules).
	 * `render-config.ts --no-containers` forces `off`.
	 */
	readonly TARTAN_REPO_CONFIG?: string;
	/** The K2 stream id `EVENT_LOG` writes to (rendered with the binding; WP26). */
	readonly TARTAN_K2_STREAM?: string;
	/**
	 * Per-stage override of `LANE_MODE` (`render-config.ts --lane-mode`),
	 * read with `laneModeOf`; absent = the compiled default.
	 */
	readonly TARTAN_LANE_MODE?: string;
	/**
	 * Per-stage override of `WORKLOAD_TRANSPORT`
	 * (`render-config.ts --workload-transport`, only with a K2 stream), read
	 * with `workloadTransportOf`; absent = the compiled default.
	 */
	readonly TARTAN_WORKLOAD_TRANSPORT?: string;
	/**
	 * Monorepo projects (WP25 slice A′): `scan` makes cuenv
	 * `#Project`s the primary project detector (a textual scan, Tier 0) and
	 * serves the projects API and pages; absent or `off` (the default) keeps
	 * the detector chain without cuenv and hides every project surface.
	 * Rendered by `render-config.ts --projects scan`.
	 */
	readonly TARTAN_PROJECTS?: string;

	// --- Secrets (`wrangler secret put`; all optional) ---------------------
	/**
	 * Root key (32 bytes, base64url); generated at first boot when absent. The
	 * capability-URL key `LANE_CAP_KEY` is derived from it (HKDF), never a
	 * secret of its own.
	 */
	readonly TARTAN_SECRET?: string;
	/** Previous root key, only while rotating. */
	readonly TARTAN_SECRET_PREVIOUS?: string;
	/** Single-use setup token; a logs claim code is used when absent. */
	readonly TARTAN_SETUP_TOKEN?: string;
	/** Confidential IdP clients only; public (PKCE) clients need none. */
	readonly OIDC_CLIENT_SECRET?: string;
	/**
	 * One-time token set by `deno task destroy`; authorizes
	 * `POST /-/admin/idp/deregister` once (404 when absent).
	 */
	readonly TARTAN_DESTROY_TOKEN?: string;
	/**
	 * The K2 Consume token (WP26): a Secrets Store binding
	 * (`render-config.ts --k2-token-store --k2-token-secret`), read only by
	 * the BusDO's K2 client. Without it runs dispatch inline.
	 */
	readonly TARTAN_K2_TOKEN?: SecretsStoreSecret;
}

/** Binding names that `/-/health` reports (every non-var binding of `wrangler.jsonc`). */
export const BINDING_NAMES = [
	"ASSETS",
	"ARTIFACTS",
	"LOADER",
	"FORGE",
	"REPO",
	"INBOX",
	"EXT",
	"SANDBOX",
	"BUS",
	"RUNS",
	"LAND",
	"INGEST",
	"SWARM",
	"BLOBS",
	"OAUTH_KV",
	"AI",
] as const satisfies readonly (keyof Env)[];

export type BindingName = typeof BINDING_NAMES[number];

/** Plain-text vars every deployment defines (wrangler.jsonc "vars"). */
export const VAR_NAMES = [
	"TARTAN_STAGE",
	"TARTAN_FEATURES",
	"TARTAN_DEV_TOOLS",
	"TARTAN_MAX_PUSH_MB",
	"TARTAN_JUDGE_MODEL",
	"OIDC_ISSUER",
	"OIDC_CLIENT_ID",
] as const satisfies readonly (keyof Env)[];
