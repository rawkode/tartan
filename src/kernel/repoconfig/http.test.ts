// The repository-config HTTP API on fakes (`http.ts`): who may read, preview,
// sign off, apply, re-evaluate, override, approve and opt in, and that the
// person's acts refuse every token (K13.3, ADR repo config).

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	createUlid,
	denied,
	type Lane,
	type NodeDto,
	PERMISSION_MIN_ROLE,
	type RepoConfigHeadDto,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import { createRepoConfigHttp, type RepoConfigHttpDeps } from "./http.ts";

const ulid = createUlid();
const REPO = ulid();
const OTHER_REPO = ulid();
const GROUP = ulid();
const LANE = `ln_${ulid()}`;
const OTHER_LANE = `ln_${ulid()}`;
const FOREIGN_LANE = `ln_${ulid()}`;
const INSTALLATION = `i_${ulid()}`;
const REPORTER = `u_${ulid()}`;
const DEVELOPER = `u_${ulid()}`;
const MAINTAINER = `u_${ulid()}`;
const OWNER = `u_${ulid()}`;
const AGENT = `a_${ulid()}`;
const OTHER_AGENT = `a_${ulid()}`;
const STRANGER = `u_${ulid()}`;
/** Signed in, with no role anywhere and no read: the nodes do not exist for them. */
const OUTSIDER = `u_${ulid()}`;
const SHA = "a".repeat(40);
const KEY = "b".repeat(64);
const DIGEST = "c".repeat(64);

const ROLES: Record<string, number> = {
	[REPORTER]: 20,
	[DEVELOPER]: 30,
	[MAINTAINER]: 40,
	[OWNER]: 50,
	[AGENT]: 40,
	[OTHER_AGENT]: 30,
	// A non-member reading a public repo: the public view.
	[STRANGER]: 10,
};

const auth = (
	principal: string,
	via: AuthContext["via"] = "session",
): AuthContext => ({
	principal,
	kind: principal.startsWith("a_") ? "agent" : "user",
	via,
	scopes: via === "session" ? [] : ["repo:read", "repo:write", "lanes", "mcp"],
	nodeId: null,
	laneId: null,
	maxRole: 50,
	isAdmin: false,
});

const nodeOf = (id: string, kind: NodeDto["kind"], path: string): NodeDto =>
	({
		id,
		kind,
		path,
		slug: path.split("/").at(-1)!,
		visibility: "public",
	}) as unknown as NodeDto;

const NODES = new Map<string, NodeDto>([
	[REPO, nodeOf(REPO, "repo", "acme/router")],
	[OTHER_REPO, nodeOf(OTHER_REPO, "repo", "acme/other")],
	[GROUP, nodeOf(GROUP, "group", "acme")],
]);

const laneOf = (id: string, repoId: string, owner: string): Lane =>
	({
		id,
		repoId,
		owner,
		delegates: owner === AGENT ? [] : [AGENT],
		head: SHA,
		base: SHA,
	}) as unknown as Lane;

const LANES = new Map<string, Lane>([
	[LANE, laneOf(LANE, REPO, AGENT)],
	// Another agent's lane that delegates to AGENT.
	[OTHER_LANE, laneOf(OTHER_LANE, REPO, OTHER_AGENT)],
	[FOREIGN_LANE, laneOf(FOREIGN_LANE, OTHER_REPO, AGENT)],
]);

const HEAD = {
	repoId: REPO,
	enabled: true,
	status: "current",
	held: false,
	evaluator: "cue@v0.17.1/cli+job@2+rules@2",
	appliedBy: [],
	plan: [],
	policy: { newest: null, inForce: null, exact: true, pending: false },
	rootFiles: [{ name: "tartan.cue", oid: "d".repeat(40) }],
	legacyDir: false,
} as unknown as RepoConfigHeadDto;

const harness = () => {
	const calls: unknown[][] = [];
	// deno-lint-ignore no-explicit-any
	const record = (name: string, value: unknown) => (...args: any[]): any => {
		calls.push([name, ...args]);
		return Promise.resolve(value);
	};
	const deps: RepoConfigHttpDeps = {
		node: (id) => Promise.resolve(NODES.get(id) ?? null),
		access: (a, _target, perm) => {
			const role = a === null ? 0 : ROLES[a.principal] ?? 0;
			if (role < PERMISSION_MIN_ROLE[perm]) {
				return Promise.reject(denied("role", `needs ${perm}`));
			}
			return Promise.resolve({
				role: role as 10,
				member: (role >= 20 ? role : 0) as 0,
			});
		},
		repoconfig: (repoId) => ({
			state: () => Promise.resolve({ ...HEAD, repoId }),
			evaluation: (key) =>
				Promise.resolve(
					key === KEY ? { inputKey: KEY, status: "ok" } as never : null,
				),
			preview: record("preview", { laneId: LANE, status: "evaluating" }),
			previewOf: (laneId) =>
				Promise.resolve(
					laneId === LANE ? { laneId, status: "ok" } as never : null,
				),
			signOff: record("signOff", { laneId: LANE, head: SHA }),
			revokeSignOff: record("revokeSignOff", undefined),
			apply: record("apply", HEAD),
			reevaluate: record("reevaluate", HEAD),
			override: record("override", HEAD),
		}),
		lane: (_repoId, laneId) => Promise.resolve(LANES.get(laneId) ?? null),
		registry: {
			repoConfigSchema: record("repoConfigSchema", {
				repoId: REPO,
				files: {},
			}),
			repoConfigEffective: () =>
				Promise.resolve({ effective: [], approvals: [], epoch: 7 }),
			requestConfigApproval: record("requestConfigApproval", {
				state: "checking",
			}),
			revokeConfigApproval: record("revokeConfigApproval", undefined),
			configApprovals: record("configApprovals", {
				approvals: [],
				requests: [],
			}),
			setRepoOverrides: record("setRepoOverrides", { id: INSTALLATION }),
			installation: (id: string) =>
				Promise.resolve(
					id === INSTALLATION
						? { id, nodeId: GROUP, nodePath: "acme" } as never
						: null,
				),
		} as unknown as RepoConfigHttpDeps["registry"],
	};
	return { http: createRepoConfigHttp(deps), calls };
};

const req = (method: string, path: string, body?: unknown) =>
	new Request(`https://forge.test${path}`, {
		method,
		...(body === undefined ? {} : {
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
		}),
	});

const reason = async (res: Response) =>
	((await res.json()) as { reason?: string }).reason;

Deno.test("config reads: members only (Reporter+); the state merges ForgeDO's rows", async () => {
	const { http } = harness();
	const get = (who: AuthContext | null, rest?: string) =>
		http.config(req("GET", "/x"), { repoId: REPO, rest }, who);
	equal((await get(null)).status, 401);
	equal((await get(auth(STRANGER))).status, 403);
	const res = await get(auth(REPORTER));
	equal(res.status, 200);
	const body = await res.json() as Record<string, unknown>;
	equal(body.repoId, REPO);
	equal(body.epoch, 7);
	deepStrictEqual(body.effective, []);
	deepStrictEqual(body.rootFiles, [{
		name: "tartan.cue",
		oid: "d".repeat(40),
	}]);
	equal((await get(auth(REPORTER), "schema")).status, 200);
	equal((await get(auth(REPORTER), `evals/${KEY}`)).status, 200);
	equal((await get(auth(REPORTER), `evals/${"e".repeat(64)}`)).status, 404);
	equal((await get(auth(REPORTER), "evals/nope")).status, 400);
	equal((await get(auth(REPORTER), "nope")).status, 404);
	// Not a repo, or no such node.
	equal(
		(await http.config(req("GET", "/x"), { repoId: GROUP }, auth(OWNER)))
			.status,
		404,
	);
	equal(
		(await http.config(req("GET", "/x"), { repoId: "nope" }, auth(OWNER)))
			.status,
		404,
	);
});

Deno.test("preview: the lane must belong to the repo; an agent names only its own or delegated lanes", async () => {
	const { http, calls } = harness();
	const preview = (who: AuthContext, laneId: string) =>
		http.config(
			req("POST", "/x", { laneId }),
			{ repoId: REPO, rest: "preview" },
			who,
		);
	equal((await preview(auth(AGENT, "agent-token"), FOREIGN_LANE)).status, 404);
	const others = await preview(auth(OTHER_AGENT, "agent-token"), LANE);
	equal(others.status, 403);
	equal(await reason(others), "lane-op");
	equal((await preview(auth(AGENT, "agent-token"), LANE)).status, 200);
	// OTHER_LANE delegates to AGENT.
	equal((await preview(auth(AGENT, "agent-token"), OTHER_LANE)).status, 200);
	// A person who reads the repo may preview any lane of it.
	equal((await preview(auth(REPORTER), OTHER_LANE)).status, 200);
	equal((await preview(auth(STRANGER), LANE)).status, 403);
	deepStrictEqual(
		calls.filter((c) => c[0] === "preview").map((c) => c.slice(1)),
		[[LANE, AGENT], [OTHER_LANE, AGENT], [OTHER_LANE, REPORTER]],
	);
	const bad = await http.config(
		req("POST", "/x", { laneId: "nope" }),
		{ repoId: REPO, rest: "preview" },
		auth(REPORTER),
	);
	equal(bad.status, 400);
});

Deno.test("policy sign-off: a Maintainer+ person in a browser session; every token and lower role is refused", async () => {
	const { http, calls } = harness();
	const signoff = (who: AuthContext, method = "POST", query = "") =>
		http.lane(
			req(
				method,
				`/x${query}`,
				method === "POST" ? { head: SHA, policyDigest: DIGEST } : undefined,
			),
			{ repoId: REPO, laneId: LANE, what: "policy-signoff" },
			who,
		);
	for (
		const who of [
			auth(AGENT, "agent-token"),
			auth(MAINTAINER, "pat"),
			auth(OWNER, "oauth"),
		]
	) {
		const res = await signoff(who);
		equal(res.status, 403, who.via);
		equal(await reason(res), "session", who.via);
	}
	const low = await signoff(auth(DEVELOPER));
	equal(low.status, 403);
	equal(await reason(low), "role");
	equal((await signoff(auth(MAINTAINER))).status, 201);
	deepStrictEqual(calls.filter((c) => c[0] === "signOff"), [[
		"signOff",
		LANE,
		{ head: SHA, policyDigest: DIGEST },
		MAINTAINER,
	]]);
	// The body is checked: a digest is required (null when no root file).
	const missing = await http.lane(
		req("POST", "/x", { head: SHA }),
		{ repoId: REPO, laneId: LANE, what: "policy-signoff" },
		auth(OWNER),
	);
	equal(missing.status, 400);
	// Revocation: same rule, the head in the query.
	equal((await signoff(auth(MAINTAINER), "DELETE")).status, 400);
	equal(
		(await signoff(auth(MAINTAINER, "pat"), "DELETE", `?head=${SHA}`)).status,
		403,
	);
	equal(
		(await signoff(auth(MAINTAINER), "DELETE", `?head=${SHA}`)).status,
		204,
	);
	deepStrictEqual(calls.filter((c) => c[0] === "revokeSignOff"), [[
		"revokeSignOff",
		LANE,
		SHA,
		MAINTAINER,
	]]);
});

Deno.test("lane config: lane readers read the preview; another repo's lane is not found", async () => {
	const { http } = harness();
	const get = (who: AuthContext, laneId: string) =>
		http.lane(
			req("GET", "/x"),
			{ repoId: REPO, laneId, what: "config" },
			who,
		);
	equal((await get(auth(REPORTER), LANE)).status, 200);
	equal((await get(auth(REPORTER), OTHER_LANE)).status, 404);
	equal((await get(auth(REPORTER), FOREIGN_LANE)).status, 404);
	equal((await get(auth(STRANGER), LANE)).status, 403);
});

Deno.test("apply (Maintainer+, session), reevaluate (Maintainer+, session), override (Owner, session)", async () => {
	const { http, calls } = harness();
	const post = (who: AuthContext, rest: string, body?: unknown) =>
		http.config(req("POST", "/x", body), { repoId: REPO, rest }, who);
	const pat = await post(auth(OWNER, "pat"), "apply", { sha: SHA });
	equal(pat.status, 403);
	equal(await reason(pat), "session");
	equal((await post(auth(DEVELOPER), "apply", { sha: SHA })).status, 403);
	equal((await post(auth(MAINTAINER), "apply", { sha: "x" })).status, 400);
	equal((await post(auth(MAINTAINER), "apply", { sha: SHA })).status, 200);
	equal((await post(auth(DEVELOPER), "reevaluate")).status, 403);
	// Re-evaluating resets trunk work and backoffs, so it is a
	// person's act in a browser; a Maintainer's agent token is refused.
	const token = await post(auth(AGENT, "agent-token"), "reevaluate");
	equal(token.status, 403);
	equal(await reason(token), "session");
	equal((await post(auth(MAINTAINER), "reevaluate")).status, 200);
	equal(
		(await post(auth(MAINTAINER), "override", { action: "keep-last-good" }))
			.status,
		403,
	);
	equal(
		(await post(auth(OWNER, "agent-token"), "override", {
			action: "keep-last-good",
		})).status,
		403,
	);
	equal(
		(await post(auth(OWNER), "override", { action: "keep-last-good" })).status,
		200,
	);
	equal((await post(auth(OWNER), "override", { action: "nope" })).status, 400);
	deepStrictEqual(
		calls.filter((c) =>
			["apply", "reevaluate", "override"].includes(String(c[0]))
		),
		[
			["apply", SHA, MAINTAINER],
			["reevaluate", MAINTAINER],
			["override", "keep-last-good", OWNER],
		],
	);
});

Deno.test("config approvals: members read them; an Owner in a session approves and revokes", async () => {
	const { http, calls } = harness();
	const call = (
		who: AuthContext,
		method: string,
		extId?: string,
		body?: unknown,
	) =>
		http.approvals(
			req(method, "/x", body),
			{ nodeId: GROUP, ...(extId ? { extId } : {}) },
			who,
		);
	equal((await call(auth(REPORTER), "GET")).status, 200);
	equal((await call(auth(STRANGER), "GET")).status, 403);
	const body = { version: "0.2.0" };
	equal(
		(await call(auth(MAINTAINER), "PUT", "acme.no-secrets", body)).status,
		403,
	);
	const token = await call(
		auth(OWNER, "pat"),
		"PUT",
		"acme.no-secrets",
		body,
	);
	equal(token.status, 403);
	equal(await reason(token), "session");
	equal((await call(auth(OWNER), "PUT", "Not An Id", body)).status, 400);
	equal(
		(await call(auth(OWNER), "PUT", "acme.no-secrets", { version: "x" }))
			.status,
		400,
	);
	equal((await call(auth(OWNER), "PUT", "acme.no-secrets", body)).status, 202);
	equal((await call(auth(OWNER), "DELETE", "acme.no-secrets")).status, 204);
	deepStrictEqual(
		calls.filter((c) =>
			["requestConfigApproval", "revokeConfigApproval"].includes(String(c[0]))
		),
		[
			["requestConfigApproval", OWNER, GROUP, "acme.no-secrets", body],
			["revokeConfigApproval", OWNER, GROUP, "acme.no-secrets"],
		],
	);
});

Deno.test("repo overrides: an Owner at the installation's node, in a session", async () => {
	const { http, calls } = harness();
	const put = (who: AuthContext, installationId = INSTALLATION, on = true) =>
		http.repoOverrides(
			req("PUT", "/x", { on }),
			{ installationId },
			who,
		);
	equal((await put(auth(MAINTAINER))).status, 403);
	equal((await put(auth(OWNER, "pat"))).status, 403);
	equal((await put(auth(OWNER), `i_${ulid()}`)).status, 404);
	equal((await put(auth(OWNER), "not-an-id")).status, 404);
	equal((await put(auth(OWNER))).status, 200);
	deepStrictEqual(calls.filter((c) => c[0] === "setRepoOverrides"), [[
		"setRepoOverrides",
		OWNER,
		INSTALLATION,
		true,
	]]);
	ok(true);
});

Deno.test("a caller who cannot read the node gets the same 404 for a real installation, repo or node as for an unknown one", async () => {
	const { http, calls } = harness();
	const put = (installationId: string) =>
		http.repoOverrides(
			req("PUT", "/x", { on: true }),
			{ installationId },
			auth(OUTSIDER),
		);
	const real = await put(INSTALLATION);
	const unknown = await put(`i_${ulid()}`);
	equal(real.status, 404);
	equal(unknown.status, 404);
	deepStrictEqual(await real.json(), await unknown.json());
	const config = (repoId: string) =>
		http.config(req("GET", "/x"), { repoId, rest: "" }, auth(OUTSIDER));
	const repo = await config(REPO);
	const nothing = await config(ulid());
	equal(repo.status, 404);
	deepStrictEqual(await repo.json(), await nothing.json());
	const approvals = (nodeId: string) =>
		http.approvals(req("GET", "/x"), { nodeId }, auth(OUTSIDER));
	equal((await approvals(GROUP)).status, 404);
	equal((await approvals(ulid())).status, 404);
	equal(calls.filter((c) => c[0] === "setRepoOverrides").length, 0);
});
