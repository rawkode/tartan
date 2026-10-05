// Repository config views (ADR repo config, "User interface"):
// the pure parts of the settings page and the change card. Everything the
// repository controls (CUE messages, resolved settings, repo policy) is
// shown as text only; positions link to the blob view only when they name a
// root `<name>.cue` file that was sent, and forge positions (`cue.mod/…`,
// `~tartan.cue`) link to the schema view.

import type {
	EvalIssue,
	RepoConfigDenial,
	RepoConfigPlanLine,
	RepoConfigPreviewDto,
	RepoConfigPreviewState,
	RepoConfigStateDto,
	RepoConfigStatus,
} from "@tartan/contract/repoconfig.ts";
import { blobHref } from "../../router/params.ts";

// Copies of contract values (repoconfig.ts and common.ts import zod, which
// stays out of the browser bundle); `test/contract-parity.spec.ts` pins them.

/** `REPO_CONFIG_POSITION_RE`: a root `<name>.cue` position. */
export const REPO_CONFIG_POSITION_RE = /^([A-Za-z0-9_.-]+\.cue):(\d+):(\d+)$/;
/** `FORGE_BINDING_FILE`: the forge's binding file beside the root files. */
export const FORGE_BINDING_FILE = "~tartan.cue";
/** `NO_CHANGE_TEXT`. */
export const NO_CHANGE_TEXT = "no change";
/** `REPO_CONFIG_EXPORT_COMMAND`: what reproduces the forge's evaluation locally. */
export const REPO_CONFIG_EXPORT_COMMAND =
	"CUE_REGISTRY=none cue export -E --out json .:tartan";
/** `LEGACY_DIR_HINT`: the migration hint while trunk still has `.tartan/`. */
export const LEGACY_DIR_HINT =
	'.tartan/ is no longer read; the pipeline goes in extensions: "tartan.ci": settings: pipeline and the owners in extensions: "tartan.review": settings: owners, in any root file with package tartan';
/** `MANAGED_BY_TEXT`: the note on a managed installation's settings. */
export const MANAGED_BY_TEXT = "managed by package tartan in the repo root";
/** `ROLE.maintainer`, `ROLE.owner`. */
export const ROLE_MAINTAINER = 40;
export const ROLE_OWNER = 50;

export type Tone = "success" | "warning" | "danger" | "info" | "muted";

export type StatusView = {
	readonly label: string;
	readonly tone: Tone;
	readonly detail: string;
};

export const STATUS_VIEW: Readonly<Record<RepoConfigStatus, StatusView>> = {
	unconfigured: {
		label: "unconfigured",
		tone: "muted",
		detail: "No Tartan config is applied, and trunk has no package tartan.",
	},
	current: {
		label: "current",
		tone: "success",
		detail: "The applied config is trunk's.",
	},
	pending: {
		label: "pending",
		tone: "warning",
		detail:
			"A config change landed and is being evaluated. Lands of this repo wait until it resolves.",
	},
	failed: {
		label: "failed",
		tone: "danger",
		detail:
			"Trunk's config does not evaluate or was denied. The last good config stays in force.",
	},
	stale: {
		label: "stale",
		tone: "info",
		detail:
			"An approval or an installation above this repo changed. Re-evaluating in the background.",
	},
	"needs-apply": {
		label: "needs apply",
		tone: "warning",
		detail:
			"Trunk moved outside a land and its config differs. A Maintainer applies it.",
	},
};

export const PREVIEW_VIEW: Readonly<
	Record<RepoConfigPreviewState, StatusView>
> = {
	evaluating: {
		label: "evaluating…",
		tone: "info",
		detail: "The lane head's config is being evaluated.",
	},
	ok: {
		label: "evaluates",
		tone: "success",
		detail: "The lane head's config evaluates and the registry accepts it.",
	},
	error: {
		label: "error",
		tone: "danger",
		detail: "The lane head's config does not evaluate.",
	},
	denied: {
		label: "denied",
		tone: "danger",
		detail: "The config evaluates, but the registry would deny it.",
	},
	rate_limited: {
		label: "rate limited",
		tone: "warning",
		detail: "Too many previews: it is queued again shortly.",
	},
	unavailable: {
		label: "evaluator unavailable",
		tone: "warning",
		detail: "The evaluator could not run. The preview retries.",
	},
	clean: {
		label: "no config change",
		tone: "muted",
		detail: "This lane changes no root .cue file.",
	},
};

/** The first 12 hex digits of an input key or digest. */
export const shortKey = (key: string | null | undefined): string =>
	key ? key.slice(0, 12) : "";

/** Where a position links: a sent root file's blob, the schema, or nowhere. */
export type PositionLink =
	| { readonly kind: "blob"; readonly href: string; readonly text: string }
	| { readonly kind: "schema"; readonly text: string }
	| { readonly kind: "text"; readonly text: string };

/**
 * A `file:line:col` position. `sent` names the root `*.cue` files the
 * evaluation was given; only those link to their blob at `ref`.
 */
export const positionLink = (
	pos: string,
	repoPath: string,
	ref: string,
	sent: ReadonlySet<string>,
): PositionLink => {
	const bare = pos.replace(/^\.\//, "");
	const m = REPO_CONFIG_POSITION_RE.exec(bare);
	if (m !== null && sent.has(m[1]!)) {
		return {
			kind: "blob",
			href: `${blobHref(repoPath, ref, m[1]!)}#L${m[2]}`,
			text: bare,
		};
	}
	if (
		bare.startsWith("cue.mod/") || bare.startsWith(`${FORGE_BINDING_FILE}:`)
	) {
		return { kind: "schema", text: bare };
	}
	return { kind: "text", text: bare };
};

/** One issue's display: its CUE path (or "package tartan") and message. */
export const issueTitle = (issue: EvalIssue): string =>
	issue.path === "" ? "package tartan" : issue.path;

/** "K8: …" style label of a denial code. */
export const DENIAL_LABEL: Readonly<Record<RepoConfigDenial["code"], string>> =
	{
		shape: "shape",
		too_large: "too large",
		unapproved: "needs Owner approval",
		inherited: "inherited",
		provider_floor: "providers stay manual",
		pack: "pack",
		policy_key: "not a repo-policy key",
		overlay_key: "not overridable",
		locked_gate: "K8: locked gate",
		locked_provider: "locked provider",
		invalid: "invalid",
		conflict: "conflict",
		scope: "K12: outside this repo",
	};

/** A plan with nothing to do reads "no change". */
export const planLines = (
	plan: readonly RepoConfigPlanLine[],
): readonly string[] =>
	plan.length === 0 ? [NO_CHANGE_TEXT] : plan.map((l) => l.text);

/** Whether the viewer may act: roles come from the view, the kernel decides. */
export const canMaintain = (role: number): boolean => role >= ROLE_MAINTAINER;
export const canOwn = (role: number): boolean => role >= ROLE_OWNER;

/** The settings page's actions, by state and role (the kernel re-checks). */
export const settingsActions = (
	state: Pick<RepoConfigStateDto, "enabled" | "status" | "held" | "trunkSha">,
	role: number,
): {
	readonly apply: boolean;
	readonly reevaluate: boolean;
	readonly keepLastGood: boolean;
} => ({
	apply: state.enabled && state.status === "needs-apply" &&
		state.trunkSha !== undefined && canMaintain(role),
	reevaluate: state.enabled && state.status !== "unconfigured" &&
		canMaintain(role),
	// Whenever lands are held: a pending resolution, or ForgeDO's
	// gate-missing hold (a revoked gate approval would otherwise hold lands
	// until a fix that cannot land).
	keepLastGood: state.enabled && state.held && canOwn(role),
});

/**
 * The card's sign-off button: a Maintainer+, a touched head whose digest is
 * known, evaluated (a rate-limited preview is queued again first), not yet
 * signed.
 */
export const canSignOff = (
	preview: RepoConfigPreviewDto,
	role: number,
): boolean =>
	canMaintain(role) && preview.policyTouched &&
	preview.policyDigest !== undefined && preview.status !== "evaluating" &&
	preview.status !== "rate_limited" &&
	(preview.signoff === undefined || preview.signoff.revokedAt !== undefined ||
		preview.signoff.head !== preview.head);

/** The sign-off in force for the preview's head, if any. */
export const activeSignoff = (preview: RepoConfigPreviewDto) =>
	preview.signoff !== undefined && preview.signoff.revokedAt === undefined &&
		preview.signoff.head === preview.head
		? preview.signoff
		: undefined;

/** Repository-controlled JSON as indented text (rendered with text interpolation only). */
export const jsonText = (value: unknown): string => {
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return "";
	}
};

/** The lane of a change, from the repo's `changes.*` events (newest wins). */
export const laneOfChange = (
	events: readonly { readonly type: string; readonly data: unknown }[],
	changeId: string,
): string | null => {
	let lane: string | null = null;
	for (const e of events) {
		if (!e.type.startsWith("changes.")) continue;
		const d = e.data as { changeId?: unknown; laneId?: unknown } | null;
		if (d?.changeId === changeId && typeof d.laneId === "string") {
			lane = d.laneId;
		}
	}
	return lane;
};
