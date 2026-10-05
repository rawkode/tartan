// Installation administration beyond install and mode:
// uninstall deletes the removed installations' ExtensionDO data, and
// a Maintainer reads an installation's console and dead letters.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type { ExtScope, InstallationDto } from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import { type Defer, handleInstallationsRequest } from "./installations.ts";
import {
	agentToken,
	type ApiFixture,
	apiFixture,
	OWNER,
	PACK,
	session,
} from "./test/fixture.ts";

const MAINT = "u_maint";
const DEV = "u_dev";

const setup = () => {
	const a = apiFixture([PACK]);
	// A third repo under acme/platform: two pages of `listRepos` (two per page).
	a.fx.tree.add("acme/platform/api", "repo");
	a.fx.tree.grant("acme/platform", MAINT, 40);
	a.fx.tree.grant("acme/platform", DEV, 30);
	return a;
};

const request = (
	a: ApiFixture,
	method: string,
	rest: string,
	auth: AuthContext | null = session(MAINT),
	defer?: Defer,
	body?: unknown,
) =>
	handleInstallationsRequest(
		a.deps,
		new Request(
			`https://forge.test/-/api/installations/${rest}`,
			body === undefined ? { method } : {
				method,
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		),
		rest.split("?")[0],
		auth,
		defer,
	);

const install = (a: ApiFixture, extId: string, node = "acme/platform") =>
	a.registry.facade.install(OWNER, {
		extId,
		version: "0.1.0",
		node,
		mode: "enforce",
	});

/** The scopes `deleteData` reached, as `<installation> <scope>` (repo scopes by path). */
const deleted = (a: ApiFixture): string[] =>
	a.calls
		.filter((c) => c.method === "deleteData")
		.map((c) => {
			const scope = c.scope as ExtScope;
			return `${c.installationId} ${
				scope.kind === "node" ? "node" : a.fx.tree.nodeSync(scope.repoId)?.path
			}`;
		})
		.sort();

Deno.test("uninstall deletes the node scope, or every repo scope under the node", async () => {
	const a = setup();
	const work = await install(a, "tartan.work");
	const board = await install(a, "tartan.board");
	equal((await request(a, "DELETE", work.id)).status, 204);
	deepStrictEqual(deleted(a), [
		`${work.id} acme/platform/api`,
		`${work.id} acme/platform/edge`,
		`${work.id} acme/platform/router`,
	]);
	a.calls.length = 0;
	equal((await request(a, "DELETE", board.id)).status, 204);
	deepStrictEqual(deleted(a), [`${board.id} node`]);
});

Deno.test("uninstalling a pack cleans up each member it removes (a pack has no host)", async () => {
	const a = setup();
	const pack = await install(a, "tartan.pack.swarm");
	const members = (await a.registry.facade.inForce(
		a.nodeId("acme/platform"),
	)).map((i) => i.installation).filter((i) =>
		i.pack === "tartan.pack.swarm" && i.id !== pack.id
	);
	equal(members.length, 2);
	const byExt = (ext: string) =>
		members.find((m) => m.extId === ext) as InstallationDto;
	equal((await request(a, "DELETE", pack.id, session(OWNER))).status, 204);
	deepStrictEqual(
		deleted(a),
		[
			`${byExt("tartan.board").id} node`,
			`${byExt("tartan.work").id} acme/platform/api`,
			`${byExt("tartan.work").id} acme/platform/edge`,
			`${byExt("tartan.work").id} acme/platform/router`,
		].sort(),
	);
});

Deno.test("uninstalling a pack also deletes the data of a member that was disabled", async () => {
	const a = setup();
	const pack = await install(a, "tartan.pack.swarm");
	const members = (await a.registry.facade.inForce(
		a.nodeId("acme/platform"),
	)).map((i) => i.installation).filter((i) =>
		i.pack === "tartan.pack.swarm" && i.id !== pack.id
	);
	const byExt = (ext: string) =>
		members.find((m) => m.extId === ext) as InstallationDto;
	// The kill switch on one member (setMode does not cascade from packs).
	const work = byExt("tartan.work");
	equal(
		(await request(a, "PUT", `${work.id}/mode`, session(OWNER), undefined, {
			mode: "disabled",
		})).status,
		200,
	);
	ok(
		!(await a.registry.facade.inForce(a.nodeId("acme/platform"))).some((i) =>
			i.installation.id === work.id
		),
		"disabled members are not in force",
	);
	equal((await request(a, "DELETE", pack.id, session(OWNER))).status, 204);
	deepStrictEqual(
		deleted(a),
		[
			`${byExt("tartan.board").id} node`,
			`${work.id} acme/platform/api`,
			`${work.id} acme/platform/edge`,
			`${work.id} acme/platform/router`,
		].sort(),
	);
});

Deno.test("the registry answers an uninstall with every row it removed", async () => {
	const a = setup();
	const pack = await install(a, "tartan.pack.swarm");
	const node = a.nodeId("acme/platform");
	const all = (await a.registry.facade.inForce(node)).map((i) =>
		i.installation
	);
	const board = all.find((i) => i.extId === "tartan.board")!;
	await a.registry.facade.setMode(OWNER, board.id, "disabled");
	const removed = await a.registry.facade.uninstall(OWNER, pack.id);
	deepStrictEqual(
		removed.map((i) => `${i.extId} ${i.mode}`).sort(),
		[
			"tartan.board disabled",
			"tartan.pack.swarm enforce",
			"tartan.work enforce",
		],
	);
	equal(removed.find((i) => i.id === pack.id)?.extId, "tartan.pack.swarm");
	equal((await a.registry.facade.inForce(node)).length, 0);
	const solo = await install(a, "tartan.board");
	deepStrictEqual(
		(await a.registry.facade.uninstall(OWNER, solo.id)).map((i) => i.id),
		[solo.id],
	);
});

Deno.test("cleanup runs after the response when deferred; a failing host is logged, never fails the uninstall", async () => {
	const a = setup();
	const board = await install(a, "tartan.board");
	a.failDelete(board.id);
	const deferred: Promise<void>[] = [];
	const res = await request(
		a,
		"DELETE",
		board.id,
		session(MAINT),
		(work) => deferred.push(work),
	);
	equal(res.status, 204);
	equal(deferred.length, 1);
	await deferred[0];
	deepStrictEqual(deleted(a), [`${board.id} node`]);
	deepStrictEqual(a.logs, [{
		level: "error",
		event: "uninstall.cleanup_failed",
		installation: board.id,
		scope: "node",
		code: "internal",
	}]);
	equal((await request(a, "GET", board.id)).status, 404, "uninstalled");
});

type ConsoleBody = { scope: ExtScope; lines: { seq: number }[] };
type DeadBody = { scope: ExtScope; deadLetters: { event_id: string }[] };

Deno.test("a Maintainer reads a node-scoped installation's console and dead letters", async () => {
	const a = setup();
	const board = await install(a, "tartan.board");
	const res = await request(
		a,
		"GET",
		`${board.id}/console?since=7&limit=9000`,
	);
	equal(res.status, 200);
	const body = (await res.json()) as ConsoleBody;
	deepStrictEqual(body.scope, { kind: "node" });
	deepStrictEqual(body.lines.map((l) => l.seq), [8]);
	const call = a.calls.find((c) => c.method === "console");
	deepStrictEqual(call?.args, [7, 500], "since kept, limit clamped");
	const dead = await request(a, "GET", `${board.id}/dead-letters`);
	equal(dead.status, 200);
	deepStrictEqual(
		((await dead.json()) as DeadBody).deadLetters.map((d) => d.event_id),
		["e_1"],
	);
	equal(
		(await request(a, "GET", `${board.id}/console?repo=acme/platform/router`))
			.status,
		400,
		"a node-scoped installation takes no repo",
	);
	equal(
		(await request(a, "GET", `${board.id}/console?since=x&limit=-3`)).status,
		200,
	);
	deepStrictEqual(
		a.calls.filter((c) => c.method === "console").at(-1)?.args,
		[0, 1],
	);
});

Deno.test("a repo-scoped installation's admin reads name a repo inside its node", async () => {
	const a = setup();
	const work = await install(a, "tartan.work");
	equal((await request(a, "GET", `${work.id}/console`)).status, 400);
	const res = await request(
		a,
		"GET",
		`${work.id}/dead-letters?repo=acme/platform/router`,
	);
	equal(res.status, 200);
	deepStrictEqual(((await res.json()) as DeadBody).scope, {
		kind: "repo",
		repoId: a.nodeId("acme/platform/router"),
	});
	// By id as well as by path.
	equal(
		(await request(
			a,
			"GET",
			`${work.id}/console?repo=${a.nodeId("acme/platform/edge")}`,
		)).status,
		200,
	);
	// Outside the installation's node, missing, or not a repo: 404 (K12).
	for (const repo of ["other/secret", "acme/platform/nope", "acme/platform"]) {
		equal(
			(await request(a, "GET", `${work.id}/console?repo=${repo}`)).status,
			404,
			repo,
		);
	}
});

Deno.test("console and dead letters are Maintainer-only (admin scope for tokens)", async () => {
	const a = setup();
	const board = await install(a, "tartan.board");
	for (const rest of [`${board.id}/console`, `${board.id}/dead-letters`]) {
		equal((await request(a, "GET", rest, session(MAINT))).status, 200, rest);
		equal((await request(a, "GET", rest, session(DEV))).status, 403, rest);
		equal(
			(await request(
				a,
				"GET",
				rest,
				agentToken(MAINT, { maxRole: 40, scopes: ["api"] }),
			)).status,
			403,
			`${rest} without the admin scope`,
		);
		equal((await request(a, "GET", rest, null)).status, 401, rest);
	}
	// The repo hint is resolved only after the role check: no probing.
	const work = await install(a, "tartan.work");
	equal(
		(await request(
			a,
			"GET",
			`${work.id}/console?repo=other/secret`,
			session(
				DEV,
			),
		)).status,
		403,
	);
	ok(
		!a.calls.some((c) =>
			c.method === "console" && c.installationId === work.id
		),
	);
});

type BreakerBody = {
	scope: ExtScope;
	breaker: { state: string; recentStrikes: number; strikes: unknown[] };
};

Deno.test("breaker: a Maintainer reads the circuit breaker; only an Owner resets it, never an agent", async () => {
	const a = setup();
	const board = await install(a, "tartan.board");
	const read = await request(a, "GET", `${board.id}/breaker`);
	equal(read.status, 200);
	const body = (await read.json()) as BreakerBody;
	deepStrictEqual(body.scope, { kind: "node" });
	equal(body.breaker.state, "open");
	equal(body.breaker.recentStrikes, 3);
	equal(body.breaker.strikes.length, 1);
	equal(
		(await request(a, "GET", `${board.id}/breaker`, session(DEV))).status,
		403,
	);
	equal((await request(a, "GET", `${board.id}/breaker`, null)).status, 401);
	// A Maintainer cannot reset; nothing reaches the host.
	equal((await request(a, "POST", `${board.id}/breaker`)).status, 403);
	ok(!a.calls.some((c) => c.method === "resetBreaker"));
	// An Owner's agent token is refused even with the role and scopes.
	equal(
		(await request(
			a,
			"POST",
			`${board.id}/breaker`,
			agentToken(OWNER, { maxRole: 50, scopes: ["api", "admin"] }),
		)).status,
		403,
	);
	ok(!a.calls.some((c) => c.method === "resetBreaker"));
	const reset = await request(a, "POST", `${board.id}/breaker`, session(OWNER));
	equal(reset.status, 200);
	equal(((await reset.json()) as BreakerBody).breaker.state, "closed");
	deepStrictEqual(
		a.calls.filter((c) => c.method === "resetBreaker").map((c) => c.args),
		[[OWNER]],
	);
	// A repo-scoped installation names its repo, as for the console.
	const work = await install(a, "tartan.work");
	equal((await request(a, "GET", `${work.id}/breaker`)).status, 400);
	equal(
		(await request(a, "GET", `${work.id}/breaker?repo=acme/platform/router`))
			.status,
		200,
	);
	equal(
		(await request(a, "PUT", `${board.id}/breaker`, session(OWNER))).status,
		404,
	);
});
