// `/-/api/installations` and `/-/api/packages`:
// authorization with credential bounds (Maintainer vs Owner), the
// install sheet, mode changes, uninstall, M2 routes, and publish validation.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import type {
	Advance,
	InstallationDto,
	PackageDto,
	PermissionSheet,
} from "@tartan/contract";
import type { AuthContext } from "@tartan/contract/kernel.ts";
import { handleInstallationsRequest } from "./installations.ts";
import {
	checkBundle,
	handlePackagesRequest,
	requiredFiles,
} from "./packages.ts";
import { bundled, manifest } from "../registry/test/fakes.ts";
import { agentToken, apiFixture, OWNER, session } from "./test/fixture.ts";

const MAINT = "u_maint";

const setup = () => {
	const a = apiFixture();
	a.fx.tree.grant("acme/platform", MAINT, 40);
	return a;
};

const call = (
	a: ReturnType<typeof setup>,
	method: string,
	rest: string | undefined,
	auth: AuthContext | null = session(MAINT),
	body?: unknown,
	query = "",
) =>
	handleInstallationsRequest(
		a.deps,
		new Request(
			`https://forge.test/-/api/installations${rest ? `/${rest}` : ""}${query}`,
			{
				method,
				...(body === undefined ? {} : {
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			},
		),
		rest,
		auth,
	);

const install = (extId: string, node: string, extra = {}) => ({
	extId,
	version: "0.1.0",
	node,
	mode: "enforce",
	...extra,
});

Deno.test("a Maintainer installs a plain package; an Owner is needed for providers of checks/review/queue or locks", async () => {
	const a = setup();
	const res = await call(
		a,
		"POST",
		undefined,
		session(MAINT),
		install("tartan.board", "acme/platform"),
	);
	equal(res.status, 201);
	const dto = (await res.json()) as InstallationDto;
	equal(dto.extId, "tartan.board");
	equal(dto.nodePath, "acme/platform");
	const locked = await call(
		a,
		"POST",
		undefined,
		session(MAINT),
		install("tartan.work", "acme/platform", { locked: true }),
	);
	equal(locked.status, 403);
	// A token capped below Maintainer is refused even for an Owner principal.
	const capped = await call(
		a,
		"POST",
		undefined,
		agentToken(OWNER, { scopes: ["api", "admin"], maxRole: 30 }),
		install("tartan.work", "acme/platform"),
	);
	equal(capped.status, 403);
	// A token without the admin scope cannot install.
	const noAdmin = await call(
		a,
		"POST",
		undefined,
		agentToken(OWNER, { maxRole: 50 }),
		install("tartan.work", "acme/platform"),
	);
	equal(noAdmin.status, 403);
	equal(
		(await call(
			a,
			"POST",
			undefined,
			session(OWNER),
			install("tartan.work", "acme/platform", { locked: true }),
		)).status,
		201,
	);
	equal(
		(await call(a, "POST", undefined, null, install("tartan.work", "acme")))
			.status,
		401,
	);
});

Deno.test("an agent token never installs, uninstalls or switches a mode, whatever its role and scopes", async () => {
	const a = setup();
	const agent = agentToken(OWNER, { scopes: ["api", "admin"], maxRole: 50 });
	const refused = await call(
		a,
		"POST",
		undefined,
		agent,
		install("tartan.work", "acme/platform"),
	);
	equal(refused.status, 403);
	equal(((await refused.json()) as { error: string }).error, "denied");
	const created = (await (await call(
		a,
		"POST",
		undefined,
		session(OWNER),
		install("tartan.work", "acme/platform"),
	)).json()) as InstallationDto;
	equal(
		(await call(a, "PUT", `${created.id}/mode`, agent, { mode: "shadow" }))
			.status,
		403,
	);
	equal((await call(a, "DELETE", created.id, agent)).status, 403);
	equal(
		(await a.registry.facade.installation(created.id))?.mode,
		"enforce",
	);
	// A person with the same role still can.
	equal(
		(await call(a, "PUT", `${created.id}/mode`, session(OWNER), {
			mode: "disabled",
		})).status,
		200,
	);
});

Deno.test("the install sheet lists permissions, replacement, Owner need and blocking issues", async () => {
	const a = setup();
	await a.registry.facade.install(
		OWNER,
		install("tartan.work", "acme") as never,
	);
	const res = await call(
		a,
		"POST",
		"sheet",
		session(MAINT),
		install("tartan.work", "acme/platform"),
	);
	equal(res.status, 200);
	const sheet = (await res.json()) as PermissionSheet;
	ok(sheet.lines.includes("provides work@1"));
	equal(sheet.needsOwner, false);
	deepStrictEqual(sheet.warnings, []);
	const locked = await a.registry.facade.install(
		OWNER,
		install("tartan.radar", "acme", { locked: true }) as never,
	);
	ok(locked.locked);
	const blocked = (await (await call(
		a,
		"POST",
		"sheet",
		session(MAINT),
		install("tartan.radar", "acme/platform"),
	)).json()) as PermissionSheet;
	ok(
		blocked.warnings.some((w) =>
			w.startsWith("blocked:") && w.includes("locked")
		),
	);
});

Deno.test("list, read, change mode and uninstall", async () => {
	const a = setup();
	const created = (await (await call(
		a,
		"POST",
		undefined,
		session(MAINT),
		install("tartan.board", "acme/platform"),
	)).json()) as InstallationDto;
	const list = await call(
		a,
		"GET",
		undefined,
		session(MAINT),
		undefined,
		"?node=acme/platform/router",
	);
	equal(list.status, 200);
	const listed = (await list.json()) as {
		installations: { installation: InstallationDto }[];
	};
	deepStrictEqual(listed.installations.map((i) => i.installation.id), [
		created.id,
	]);
	equal((await call(a, "GET", created.id)).status, 200);
	equal((await call(a, "GET", "i_nope")).status, 404);
	const mode = await call(a, "PUT", `${created.id}/mode`, session(MAINT), {
		mode: "disabled",
	});
	equal(mode.status, 200);
	equal(((await mode.json()) as InstallationDto).mode, "disabled");
	equal(
		(await call(a, "PUT", `${created.id}/mode`, session(MAINT), {
			mode: "bogus",
		})).status,
		400,
	);
	equal((await call(a, "DELETE", created.id)).status, 204);
	equal((await call(a, "GET", created.id)).status, 404);
	equal(
		a.fx.events.events.map((e) => e.type).join(","),
		"extension.installed,extension.mode.changed,extension.uninstalled",
	);
});

Deno.test("in force without a node: the caller's start node, never one that does not exist (e2e: invited users)", async () => {
	const a = setup();
	const startOf = async (auth: AuthContext) => {
		const res = await call(a, "GET", undefined, auth);
		return res.status === 200
			? ((await res.json()) as { node: { path: string } }).node.path
			: res.status;
	};
	// An invited user: a grant below a root, no namespace of their own.
	a.fx.tree.grant("acme/platform", "u_reporter", 20);
	equal(await startOf(session("u_reporter")), "acme/platform");
	// A grant on a root wins at the first level (the forge owner holds every root).
	equal(await startOf(session(OWNER)), "acme");
	// A token answers at its own node.
	const router = a.nodeId("acme/platform/router");
	equal(
		await startOf(agentToken(OWNER, { nodeId: router })),
		"acme/platform/router",
	);
	// Nothing readable: a clean 404 that says so.
	const none = await call(a, "GET", undefined, session("u_nobody"));
	equal(none.status, 404);
	ok(
		((await none.json()) as { message: string }).message.includes(
			"no namespace",
		),
	);
	// A named node that does not exist (the old default, the viewer's handle)
	// is a 404 naming it; a malformed one is a 400.
	const missing = await call(
		a,
		"GET",
		undefined,
		session("u_reporter"),
		undefined,
		"?node=e2e-reporter",
	);
	equal(missing.status, 404);
	equal(
		((await missing.json()) as { message: string }).message,
		"no node at e2e-reporter",
	);
	equal(
		(await call(
			a,
			"GET",
			undefined,
			session("u_reporter"),
			undefined,
			"?node=Not%20A%20Path",
		)).status,
		400,
	);
});

Deno.test("a subtree Maintainer cannot change or remove an ancestor's installation (K8)", async () => {
	const a = setup();
	const guard = await a.registry.facade.install(
		OWNER,
		install("tartan.board", "acme") as never,
	);
	equal(
		(await call(a, "PUT", `${guard.id}/mode`, session(MAINT), {
			mode: "disabled",
		})).status,
		403,
	);
	equal((await call(a, "DELETE", guard.id)).status, 403);
});

Deno.test("compare is not in this slice (501); the breaker route needs a real installation", async () => {
	const a = setup();
	equal((await call(a, "POST", "i_x/compare")).status, 501);
	equal((await call(a, "GET", "i_x/breaker")).status, 404);
});

const guardSetup = () => {
	const a = apiFixture([
		bundled(manifest("tartan.guard", {
			gates: [{ point: "ref.advance", default: "veto" }],
		})),
	]);
	a.fx.tree.grant("acme/platform", MAINT, 40);
	return a;
};

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

/** `count` done advances on a repo, newest first; `leaky` of them add an AWS key. */
const seedAdvances = (
	a: ReturnType<typeof guardSetup>,
	repoId: string,
	count: number,
	leaky: readonly number[],
) => {
	const list: Advance[] = Array.from({ length: count }, (_, i): Advance => {
		const base = i.toString(16).padStart(40, "0");
		const head = (i + 1).toString(16).padStart(40, "0");
		a.added.set(`${base}..${head}`, [{
			path: leaky.includes(i) ? "config/prod.env" : `src/f${i}.ts`,
			line: 1,
			text: leaky.includes(i) ? `KEY=${AWS_KEY}` : "export {}",
		}]);
		return {
			id: `adv_${i}`,
			batchId: `lb_01k6${String(i).padStart(22, "0")}`,
			attempt: 0,
			ref: "refs/heads/main",
			expectOld: base,
			newSha: head,
			ownerInstance: "w",
			leaseUntil: 0,
			step: "refs-pushed" as const,
			state: "done" as const,
			evidenceReused: false,
			createdAt: i,
		};
	}).reverse();
	// A failed advance is never replayed.
	list.splice(3, 0, { ...list[0], id: "adv_failed", state: "failed" as const });
	a.advances.set(repoId, list);
};

Deno.test("replay: a shadow gate over the last 41 advances would have vetoed 2", async () => {
	const a = guardSetup();
	const shadow = await a.registry.facade.install(MAINT, {
		...install("tartan.guard", "acme/platform"),
		mode: "shadow",
	} as never);
	const repo = a.nodeId("acme/platform/router");
	seedAdvances(a, repo, 41, [7, 30]);
	a.setGateReply((input) =>
		Promise.resolve(
			JSON.stringify(input).includes(AWS_KEY)
				? { decision: "veto", message: "AWS key" }
				: { decision: "allow", message: "clean" },
		)
	);
	const res = await call(a, "POST", `${shadow.id}/replay`, session(MAINT), {
		repo: "acme/platform/router",
		n: 41,
	});
	equal(res.status, 200);
	const body = await res.json() as {
		replayId: string;
		state: string;
		summary: { vetoed: number; of: number };
		results: { advanceId: string; decision: string }[];
	};
	equal(body.state, "done");
	deepStrictEqual(body.summary, { vetoed: 2, of: 41 });
	deepStrictEqual(
		body.results.filter((r) => r.decision === "veto").map((r) => r.advanceId),
		["adv_30", "adv_7"],
	);
	ok(!body.results.some((r) => r.advanceId === "adv_failed"));
	const gates = a.calls.filter((c) => c.method === "gate");
	equal(gates.length, 41);
	const first = gates[0].args[1] as {
		advisory: boolean;
		base: string;
		truncated: boolean;
	};
	equal(first.advisory, true);
	equal(first.truncated, false);
	deepStrictEqual(gates[0].scope, { kind: "repo", repoId: repo });
	// Read back from the repo's gate_replays.
	const again = await call(
		a,
		"GET",
		`${shadow.id}/replay/${body.replayId}`,
		session(MAINT),
		undefined,
		"?repo=acme/platform/router",
	);
	equal(again.status, 200);
	deepStrictEqual(
		((await again.json()) as { summary: unknown }).summary,
		{ vetoed: 2, of: 41 },
	);
});

Deno.test("replay: a gate that fails takes its default; the repo must be inside the subtree; Maintainers only", async () => {
	const a = guardSetup();
	const shadow = await a.registry.facade.install(MAINT, {
		...install("tartan.guard", "acme/platform"),
		mode: "shadow",
	} as never);
	const repo = a.nodeId("acme/platform/router");
	seedAdvances(a, repo, 3, []);
	a.setGateReply(() => Promise.reject(new Error("boom")));
	const res = await call(a, "POST", `${shadow.id}/replay`, session(MAINT), {
		repo,
	});
	const body = await res.json() as { summary: { vetoed: number; of: number } };
	deepStrictEqual(body.summary, { vetoed: 3, of: 3 }, "default veto");
	equal(
		(await call(a, "POST", `${shadow.id}/replay`, session(MAINT), {
			repo: "other/secret",
		})).status,
		404,
	);
	equal(
		(await call(a, "POST", `${shadow.id}/replay`, session("u_nobody"), {
			repo,
		})).status,
		403,
	);
	equal(
		(await call(a, "POST", `${shadow.id}/replay`, session(MAINT), {
			repo,
			n: 99,
		})).status,
		400,
	);
});

Deno.test("promote: shadow → enforce over HTTP, with the installing role", async () => {
	const a = guardSetup();
	const live = await a.registry.facade.install(
		MAINT,
		install("tartan.guard", "acme/platform") as never,
	);
	const shadow = await a.registry.facade.install(MAINT, {
		...install("tartan.guard", "acme/platform"),
		mode: "shadow",
	} as never);
	equal(
		(await call(a, "POST", `${shadow.id}/promote`, session("u_nobody")))
			.status,
		403,
	);
	const res = await call(a, "POST", `${shadow.id}/promote`, session(MAINT));
	equal(res.status, 200);
	equal(((await res.json()) as InstallationDto).mode, "enforce");
	equal((await a.registry.facade.installation(live.id))?.mode, "disabled");
});

const b64 = (text: string) => btoa(text);

const thirdParty = {
	schema: 1,
	id: "acme.guard",
	name: "Guard",
	version: "0.2.0",
	api: "tartan:ext@0.1.0",
	runtime: "js",
	entry: { js: "main.js" },
	storage: { scope: "repo", migrations: ["migrations/0001_init.sql"] },
	permissions: { repo: "read" },
	gates: [{ point: "ref.advance", default: "veto" }],
	contributes: {
		protocol: "protocol.md",
		tools: [{ name: "scan", description: "scan", input: "schemas/scan.json" }],
	},
};

const publish = (
	a: ReturnType<typeof setup>,
	body: unknown,
	auth = session(OWNER, { isAdmin: true }),
) =>
	handlePackagesRequest(
		a.deps,
		new Request("https://forge.test/-/api/packages", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		undefined,
		auth,
	);

const files = {
	"main.js": b64("export default {}"),
	"migrations/0001_init.sql": b64("CREATE TABLE t (a TEXT)"),
	"protocol.md": b64("Guard vetoes secrets."),
	"schemas/scan.json": b64("{}"),
};

Deno.test("publish validates the manifest and bundle, stores it in R2 and registers it", async () => {
	const a = setup();
	deepStrictEqual(
		requiredFiles(checkBundle({ manifest: thirdParty, files }).manifest),
		[
			"main.js",
			"migrations/0001_init.sql",
			"protocol.md",
			"schemas/scan.json",
		],
	);
	equal(
		(await publish(a, { manifest: thirdParty, files }, session(MAINT))).status,
		403,
	);
	const res = await publish(a, { manifest: thirdParty, files });
	equal(res.status, 201);
	const pkg = (await res.json()) as PackageDto;
	equal(pkg.bundled, false);
	ok(
		[...a.blobsStore.keys()].every((k) =>
			k.startsWith(`ext/acme.guard/0.2.0/${pkg.sha256}/`)
		),
	);
	ok(a.blobsStore.has(`ext/acme.guard/0.2.0/${pkg.sha256}/tartan.json`));
	equal((await publish(a, { manifest: thirdParty, files })).status, 409);
	// The same content hashes the same.
	equal(checkBundle({ manifest: thirdParty, files }).sha256, pkg.sha256);
	const list = await handlePackagesRequest(
		a.deps,
		new Request("https://forge.test/-/api/packages/acme.guard"),
		"acme.guard",
		session(MAINT),
	);
	equal(((await list.json()) as { packages: PackageDto[] }).packages.length, 1);
});

Deno.test("publish rejects policy violations, missing files, oversize cards and unsafe paths", async () => {
	const a = setup();
	const bad = async (body: unknown, needle: RegExp) => {
		const res = await publish(a, body);
		equal(res.status, 400);
		const text = JSON.stringify(await res.json());
		ok(needle.test(text), text);
	};
	await bad(
		{ manifest: { ...thirdParty, id: "tartan.guard" }, files },
		/reserved/,
	);
	await bad({
		manifest: {
			...thirdParty,
			runtime: "builtin",
			entry: { builtin: "tartan.x" },
		},
		files,
	}, /bundled/);
	await bad(
		{ manifest: { ...thirdParty, permissions: { ai: true } }, files },
		/builtin-only/,
	);
	await bad(
		{ manifest: thirdParty, files: { ...files, "main.js": undefined } },
		/missing file main\.js/,
	);
	await bad({
		manifest: thirdParty,
		files: { ...files, "protocol.md": b64("x".repeat(3000)) },
	}, /exceeds 2048/);
	await bad({
		manifest: thirdParty,
		files: { ...files, "schemas/scan.json": b64("nope") },
	}, /not JSON/);
	await bad({
		manifest: thirdParty,
		files: { ...files, "../escape.js": b64("x") },
	}, /invalid publish request/);
	await bad({
		manifest: {
			...thirdParty,
			contributes: { slots: [{ slot: "nowhere", id: "x" }] },
		},
		files,
	}, /unknown slot/);
	await bad(
		{ manifest: { ...thirdParty, schema: 2 }, files },
		/invalid manifest/,
	);
	equal(a.blobsStore.size, 0);
});
