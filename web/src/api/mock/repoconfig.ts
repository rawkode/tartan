// Mock repository config (WP23, ADR repo config) for the sample
// repo, with the kernel's paths, roles and response shapes
// (src/kernel/repoconfig/http.ts):
//
//   GET    /-/api/repos/<repoId>/config[/schema|/evals/<inputKey>]
//   POST   /-/api/repos/<repoId>/config/(preview|apply|reevaluate|override)
//   GET    /-/api/repos/<repoId>/lanes/<laneId>/config
//   POST   /-/api/repos/<repoId>/lanes/<laneId>/policy-signoff {head, policyDigest}
//   DELETE /-/api/repos/<repoId>/lanes/<laneId>/policy-signoff?head=<sha>
//   GET    /-/api/nodes/<nodeId>/config-approvals
//
// The sample repo's trunk has `tartan.cue` (package tartan: the CI
// pipeline); the lane of the change on the change page adds a Weave overlay
// and an approved own install, so the change card has a plan to show.

import type { NodeDto } from "@tartan/contract/api.ts";
import type {
	ConfigApprovalDto,
	PolicySignoffDto,
	RepoConfigEvalDto,
	RepoConfigPreviewDto,
	RepoConfigSchemaDto,
	RepoConfigStateDto,
} from "@tartan/contract/repoconfig.ts";
import { LANE_IDS, LANES } from "./coord.ts";
import {
	instId,
	MOCK_NOW,
	mockUlid,
	OWNER_ID,
	REPO_ID,
	SHAS,
} from "./fixtures.ts";

const MIN = 60_000;
const EVALUATOR = "cue@v0.17.1/cli+job@2+rules@2";
const hex = (seed: string, n = 64): string =>
	Array.from(
		{ length: n },
		(_, i) =>
			"0123456789abcdef"[(seed.charCodeAt(i % seed.length) * (i + 3)) % 16],
	).join("");

export const CONFIG_KEYS = {
	trunk: hex("trunk-key"),
	lane: hex("lane-key"),
	digest: hex("lane-digest"),
} as const;

const ACME = mockUlid(11);
const LANE = LANE_IDS.limits;
const laneHead = LANES.find((l) => l.id === LANE)?.head ?? SHAS.lane;

const PIPELINE = {
	jobs: {
		test: { each: "affected", cwd: "{{project.root}}", run: "pnpm test" },
	},
	on: { change: ["test"] },
};

export const CONFIG_APPROVALS: readonly ConfigApprovalDto[] = [{
	nodeId: ACME,
	nodePath: "acme",
	extId: "acme.no-secrets",
	version: "0.2.0",
	packageSha256: hex("no-secrets-0.2.0"),
	backgroundRole: 20,
	approvedBy: OWNER_ID,
	approvedAt: MOCK_NOW - 3 * 24 * 60 * MIN,
	needsReapproval: false,
}];

const trunkState = (): RepoConfigStateDto => ({
	repoId: REPO_ID,
	enabled: true,
	status: "current",
	held: false,
	evaluator: EVALUATOR,
	cueVersion: "v0.17.1",
	trunkSha: SHAS.c3,
	appliedSha: SHAS.c3,
	appliedKey: CONFIG_KEYS.trunk,
	appliedEpoch: 3,
	appliedSeq: 3,
	appliedAt: MOCK_NOW - 2 * 60 * MIN,
	appliedBy: [OWNER_ID],
	lastEvaluatedAt: MOCK_NOW - 2 * 60 * MIN,
	plan: [],
	policy: {
		newest: {
			trunkSeq: 3,
			sha: SHAS.c3,
			policyDigest: hex("trunk-digest"),
			inputKey: CONFIG_KEYS.trunk,
			status: "ok",
			issues: [],
			at: MOCK_NOW - 2 * 60 * MIN,
		},
		inForce: {
			trunkSeq: 3,
			sha: SHAS.c3,
			policyDigest: hex("trunk-digest"),
			inputKey: CONFIG_KEYS.trunk,
			status: "ok",
			issues: [],
			at: MOCK_NOW - 2 * 60 * MIN,
		},
		exact: true,
		pending: false,
		pipeline: PIPELINE,
	},
	rootFiles: [{ name: "tartan.cue", oid: hex("tartan.cue", 40) }],
	legacyDir: false,
	updatedAt: MOCK_NOW - 2 * 60 * MIN,
	effective: [
		{
			extId: "tartan.ci",
			version: "0.1.0",
			mode: "enforce",
			installationId: instId("tartan.ci"),
			nodePath: "acme",
			source: "inherited",
			overridable: [],
			repoPolicy: ["pipeline"],
			settings: {},
			managed: false,
			hasGates: true,
		},
		{
			extId: "tartan.review",
			version: "0.1.0",
			mode: "enforce",
			installationId: instId("tartan.review"),
			nodePath: "acme",
			source: "inherited",
			overridable: [],
			repoPolicy: ["owners"],
			settings: {},
			managed: false,
			hasGates: true,
		},
		{
			extId: "tartan.weave",
			version: "0.1.0",
			mode: "enforce",
			installationId: instId("tartan.weave"),
			nodePath: "acme",
			source: "inherited",
			overridable: ["batch", "debounceMs"],
			repoPolicy: [],
			settings: { batch: 4, debounceMs: 2000 },
			managed: false,
			hasGates: false,
		},
	],
	approvals: CONFIG_APPROVALS,
	epoch: 3,
});

/** Another repo of the mock: no root `.cue` file, nothing applied. */
const unconfigured = (repoId: string): RepoConfigStateDto => ({
	repoId,
	enabled: true,
	status: "unconfigured",
	held: false,
	evaluator: EVALUATOR,
	appliedBy: [],
	plan: [],
	policy: { newest: null, inForce: null, exact: true, pending: false },
	rootFiles: [],
	legacyDir: false,
	effective: [],
	approvals: CONFIG_APPROVALS,
	epoch: 3,
});

const lanePreview = (): RepoConfigPreviewDto => ({
	laneId: LANE,
	head: laneHead,
	inputKey: CONFIG_KEYS.lane,
	status: "ok",
	policyTouched: true,
	policyDigest: CONFIG_KEYS.digest,
	issues: [],
	denials: [],
	plan: [
		{
			op: "overlay",
			extId: "tartan.weave",
			installationId: instId("tartan.weave"),
			nodePath: "acme",
			changes: [{ key: "batch", from: 4, to: 2 }],
			text: "overlay tartan.weave (inherited from /acme): batch 4 → 2",
		},
		{
			op: "install",
			extId: "acme.no-secrets",
			version: "0.2.0",
			mode: "enforce",
			enabled: true,
			settings: { severity: "hunk", allow: ["services/api/fixtures/**"] },
			text: "install acme.no-secrets 0.2.0 (enforce)",
		},
	],
	evaluatedAt: MOCK_NOW - 3 * MIN,
});

const SCHEMA: RepoConfigSchemaDto = {
	repoId: REPO_ID,
	epoch: 3,
	schemaKey: hex("schema-key"),
	files: {
		"cue.mod/pkg/tartan.dev/ext/ext.cue":
			'package ext\n\n#Mode: "enforce" | "shadow"\n',
		"~tartan.cue":
			'package tartan\n\nimport "tartan.dev/ext"\n\nextensions?: ext.#Extensions\n',
	},
	entries: [],
	exportCommand: "CUE_REGISTRY=none cue export -E --out json .:tartan",
};

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const error = (status: number, code: string, message: string): Response =>
	json({ error: code, message }, status);

export type RepoConfigMock = {
	readonly answer: (req: {
		readonly path: string;
		readonly method: string;
		readonly query: URLSearchParams;
		readonly body: Record<string, unknown>;
		readonly signedIn: boolean;
		readonly role: number;
		readonly principal: string | undefined;
		readonly nodes: readonly NodeDto[];
	}) => Response | null;
};

export const createRepoConfigMock = (): RepoConfigMock => {
	let state = trunkState();
	const previews = new Map<string, RepoConfigPreviewDto>([[
		LANE,
		lanePreview(),
	]]);

	const answer: RepoConfigMock["answer"] = (req) => {
		const config = /^\/-\/api\/repos\/([^/]+)\/config(?:\/(.+))?$/.exec(
			req.path,
		);
		const laneRoute =
			/^\/-\/api\/repos\/([^/]+)\/lanes\/(ln_[^/]+)\/(config|policy-signoff)$/
				.exec(req.path);
		const approvals = /^\/-\/api\/nodes\/([^/]+)\/config-approvals$/.exec(
			req.path,
		);
		if (!config && !laneRoute && !approvals) return null;
		if (!req.signedIn) return error(401, "unauthenticated", "Sign in first.");
		if (req.role < 20) {
			return error(
				403,
				"denied",
				"repository config is visible to members only",
			);
		}
		if (approvals) {
			return json({ approvals: CONFIG_APPROVALS, requests: [] });
		}
		const repoId = (config ?? laneRoute)![1]!;
		if (!req.nodes.some((n) => n.id === repoId && n.kind === "repo")) {
			return error(404, "not_found", "no such repo");
		}
		if (repoId !== REPO_ID) {
			return config && config[2] === undefined && req.method === "GET"
				? json(unconfigured(repoId))
				: error(
					404,
					"not_found",
					"no repository-config preview for this lane yet",
				);
		}
		if (config) {
			const rest = config[2] ?? "";
			if (rest === "" && req.method === "GET") return json(state);
			if (rest === "schema" && req.method === "GET") return json(SCHEMA);
			const evals = /^evals\/([0-9a-f]{64})$/.exec(rest);
			if (evals && req.method === "GET") {
				const key = evals[1]!;
				const fromLane = [...previews.values()].find((p) => p.inputKey === key);
				if (key !== CONFIG_KEYS.trunk && fromLane === undefined) {
					return error(404, "not_found", "no cached evaluation for that key");
				}
				const evaluation: RepoConfigEvalDto = {
					inputKey: key,
					evaluator: EVALUATOR,
					cueVersion: "v0.17.1",
					origin: fromLane ? "preview" : "trunk",
					status: "ok",
					issues: [],
					files: [{ name: "tartan.cue", oid: hex(key, 40) }],
					firstSha: fromLane?.head ?? SHAS.c3,
					...(fromLane ? { firstLane: fromLane.laneId } : {}),
					finishedAt: MOCK_NOW - 3 * MIN,
				};
				return json(evaluation);
			}
			if (req.method === "POST") {
				if (rest === "preview") {
					const laneId = String(req.body["laneId"] ?? "");
					return json(
						previews.get(laneId) ?? {
							laneId,
							head: SHAS.lane,
							status: "clean",
							policyTouched: false,
							issues: [],
							denials: [],
							plan: [],
						},
					);
				}
				if (rest === "reevaluate" || rest === "apply") {
					if (req.role < 40) {
						return error(403, "denied", "a Maintainer must do this");
					}
					state = { ...state, lastEvaluatedAt: Date.now() };
					return json(state);
				}
				if (rest === "override") {
					if (req.role < 50) {
						return error(403, "denied", "an Owner must do this");
					}
					const action = req.body["action"];
					state = action === "clear"
						? { ...state, keptLastGoodBy: undefined }
						: { ...state, held: false, keptLastGoodBy: req.principal };
					return json(state);
				}
			}
			return error(404, "not_found", "no such repository-config endpoint");
		}
		const [, , laneId, what] = laneRoute!;
		const preview = previews.get(laneId!);
		if (what === "config" && req.method === "GET") {
			return preview ? json(preview) : error(
				404,
				"not_found",
				"no repository-config preview for this lane yet",
			);
		}
		if (req.role < 40) {
			return error(403, "denied", "a Maintainer must approve a policy change");
		}
		if (!preview) return error(404, "not_found", "no such lane in this repo");
		if (req.method === "POST") {
			const head = req.body["head"];
			const digest = req.body["policyDigest"];
			if (head !== preview.head || digest !== preview.policyDigest) {
				return error(409, "conflict", "the lane moved: review the new head");
			}
			const signoff: PolicySignoffDto = {
				laneId: laneId!,
				head: preview.head,
				policyDigest: preview.policyDigest ?? null,
				signedBy: req.principal ?? OWNER_ID,
				eventId: `ev_${mockUlid(7001)}`,
				at: Date.now(),
			};
			previews.set(laneId!, { ...preview, signoff });
			return json(signoff, 201);
		}
		if (req.method === "DELETE") {
			if (req.query.get("head") !== preview.signoff?.head) {
				return error(404, "not_found", "no sign-off at that head");
			}
			previews.set(laneId!, {
				...preview,
				signoff: { ...preview.signoff!, revokedAt: Date.now() },
			});
			return new Response(null, { status: 204 });
		}
		return error(404, "not_found", "no such lane endpoint");
	};

	return { answer };
};
