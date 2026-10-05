// FakeKernelCaps enforces CAPS_METHOD_POLICY exactly as `capsDenial` does,
// plus K12 confinement, the repo routing rule and the per-call grant checks.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	CAPS_METHODS,
	capsDenial,
	type CapsMethod,
	type InstallMode,
	isTartanError,
	type ManifestPermissions,
} from "@tartan/contract";
import { createFakeKernelCaps } from "../src/index.ts";

const REPO = "01k6rrrrrrrrrrrrrrrrrrrrrr";
const OTHER = "01k6zzzzzzzzzzzzzzzzzzzzzz";
const nodes = { [REPO]: "/acme/shop", [OTHER]: "/other/repo" };

const reasonOf = async (p: Promise<unknown>): Promise<string | null> => {
	try {
		await p;
		return null;
	} catch (e) {
		ok(isTartanError(e), String(e));
		return e.reason ?? e.code;
	}
};

/** Calls `method` with arguments that pass every per-call check. */
const callWith = (
	caps: ReturnType<typeof createFakeKernelCaps>,
	method: CapsMethod,
): Promise<unknown> => {
	const repo = { id: REPO };
	const src = { repoId: REPO };
	const args: Partial<Record<CapsMethod, unknown[]>> = {
		"repo.info": [repo],
		"repo.resolveRef": [repo, "main"],
		"repo.readFile": [repo, "main", "a"],
		"repo.readTree": [repo, "main", ""],
		"repo.log": [repo, "main"],
		"repo.diffPaths": [src, "a", "b"],
		"repo.hunks": [src, "a", "b", []],
		"repo.merge3": [[]],
		"repo.laneRange": ["ln_x", { repo }],
		"repo.diff": [{ ...src, sha: "a" }, { ...src, sha: "b" }],
		"repo.projectGraph": [repo, "a"],
		"repo.affected": [repo, "a", "b"],
		"repo.treeHash": [repo, "a", ""],
		"repo.blame": [repo, "a", "p"],
		"repo.policy": [repo, "a"],
		"lanes.open": [{ repo, owner: "u_x" }],
		"lanes.adopt": [{ repo, ref: "refs/heads/x", owner: "u_x" }],
		"lanes.list": [{ repo }],
		"land.submit": [{ repo, ref: "refs/heads/main" }],
		"runs.start": [{ repo, source: src }],
		"notes.contribute": [repo, "c", {}],
		"events.emit": ["toy.seen", {}],
		"events.read": [`repo:${REPO}`, 0, ["push.*"]],
		"notify.send": ["u_x", { kind: "info", severity: "info", text: "t" }],
		"authz.check": ["u_x", repo, "read"],
		"principals.presence": [repo],
		"interfaces.call": ["work@1", "work_list", {}],
		"timers.set": ["k", 1],
		"timers.clear": ["k"],
	};
	const fn = method.split(".").reduce<unknown>(
		(o, k) => (o as Record<string, unknown>)[k],
		caps,
	) as (...a: unknown[]) => unknown;
	return Promise.resolve().then(() =>
		fn(...(args[method] ?? ["x", { repo }, { repo }]))
	);
};

const ALL_GRANTS: ManifestPermissions = {
	repo: "read",
	lanes: ["open", "adopt", "close", "archive", "delegate", "sync", "restack"],
	land: ["refs/heads/*"],
	"land.report": true,
	runs: ["start", "cancel"],
	notes: true,
	notify: true,
	"events.read": ["push.*"],
	"interfaces.call": ["work@1"],
	"agents.dispatch": ["worker"],
	ai: true,
};

Deno.test("every KernelCaps method exists on the fake", () => {
	const caps = createFakeKernelCaps();
	for (const method of CAPS_METHODS) {
		const [ns, name] = method.split(".");
		equal(
			typeof (caps as unknown as Record<string, Record<string, unknown>>)[ns][
				name
			],
			"function",
			method,
		);
	}
});

Deno.test("the fake's gate equals capsDenial for every method and context", async () => {
	const contexts: {
		grants: ManifestPermissions;
		mode: InstallMode;
		readOnly: boolean;
	}[] = [];
	for (const grants of [ALL_GRANTS, { repo: "none" } as ManifestPermissions]) {
		for (const mode of ["enforce", "shadow"] as const) {
			for (const readOnly of [false, true]) {
				contexts.push({ grants, mode, readOnly });
			}
		}
	}
	for (const c of contexts) {
		const caps = createFakeKernelCaps({
			nodes,
			props: { ...c, repo: REPO },
			responses: Object.fromEntries(CAPS_METHODS.map((m) => [m, "scripted"])),
			isMutatingTool: () => true,
		});
		for (const method of CAPS_METHODS) {
			if (method === "clock.now" || method === "ids.ulid") continue;
			const expected = capsDenial(method, { ...c, mutatingTool: true });
			const got = await reasonOf(callWith(caps, method));
			equal(got, expected, `${method} ${JSON.stringify(c)}`);
		}
	}
});

Deno.test("K12: refs outside the installation subtree are denied(scope)", async () => {
	const caps = createFakeKernelCaps({
		nodes,
		props: { grants: ALL_GRANTS },
		responses: { "repo.info": { ok: true }, "repo.diffPaths": [] },
	});
	deepStrictEqual(await caps.repo.info({ path: "/acme/shop" }), { ok: true });
	equal(await reasonOf(caps.repo.info({ path: "/other/repo" })), "scope");
	equal(await reasonOf(caps.repo.info({ path: "/acme-other" })), "scope");
	equal(await reasonOf(caps.repo.info({ id: OTHER })), "scope");
	equal(
		await reasonOf(caps.repo.info({ id: "01k6unknownnnnnnnnnnnnnnnn" })),
		"scope",
	);
	equal(
		await reasonOf(caps.repo.diffPaths({ repoId: OTHER }, "a", "b")),
		"scope",
	);
	equal(caps.denials().length, 5);
});

Deno.test("repo routing: id-keyed calls of a node-scoped installation must name the repo", async () => {
	const nodeScoped = createFakeKernelCaps({
		nodes,
		props: { grants: ALL_GRANTS },
		responses: { "lanes.get": { id: "ln_x" } },
	});
	equal(await reasonOf(nodeScoped.lanes.get("ln_x")), "invalid");
	deepStrictEqual(
		await nodeScoped.lanes.get("ln_x", { repo: { id: REPO } }),
		{ id: "ln_x" },
	);
	const repoScoped = nodeScoped.with({ repo: REPO });
	deepStrictEqual(await repoScoped.lanes.get("ln_x"), { id: "ln_x" });
});

Deno.test("per-call grants: land refs, events.read patterns, interface ids", async () => {
	const caps = createFakeKernelCaps({
		nodes,
		props: {
			grants: {
				...ALL_GRANTS,
				land: ["refs/heads/main"],
				"events.read": ["push.*", "lane.opened"],
			},
		},
		responses: {
			"land.submit": { batchId: "lb_x" },
			"events.read": [],
			"interfaces.call": null,
		},
	});
	const req = (ref: string) =>
		({ repo: { id: REPO }, ref }) as unknown as Parameters<
			typeof caps.land.submit
		>[0];
	deepStrictEqual(await caps.land.submit(req("refs/heads/main")), {
		batchId: "lb_x",
	});
	equal(await reasonOf(caps.land.submit(req("refs/heads/other"))), "grant");
	deepStrictEqual(
		await caps.events.read(`repo:${REPO}`, 0, ["push.accepted", "lane.opened"]),
		[],
	);
	equal(
		await reasonOf(caps.events.read(`repo:${REPO}`, 0, ["lane.closed"])),
		"grant",
	);
	equal(
		await reasonOf(caps.events.read(`repo:${OTHER}`, 0, ["push.*"])),
		"scope",
	);
	equal(
		await reasonOf(caps.interfaces.call("review@1", "x", {})),
		"grant",
	);
});

Deno.test("read-only: effects denied, non-mutating tools allowed", async () => {
	const caps = createFakeKernelCaps({
		props: { grants: ALL_GRANTS, readOnly: true },
		isMutatingTool: (_iface, tool) => tool !== "work_list",
		responses: { "interfaces.call": ["item"] },
	});
	equal(await reasonOf(caps.events.emit("toy.seen", {})), "read-only");
	equal(await reasonOf(caps.timers.set("k", 1)), "read-only");
	deepStrictEqual(await caps.interfaces.call("work@1", "work_list", {}), [
		"item",
	]);
	equal(
		await reasonOf(caps.interfaces.call("work@1", "work_claim", {})),
		"read-only",
	);
});

Deno.test("defaults, scripts, records; unscripted methods are not_implemented", async () => {
	let now = 1_790_000_000_000;
	const caps = createFakeKernelCaps({ now: () => now });
	equal(caps.clock.now(), now);
	now += 5;
	equal(caps.clock.now(), now);
	const id = await caps.events.emit("toy.seen", { n: 1 });
	ok(/^[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(id));
	await caps.timers.set("tick", 42);
	deepStrictEqual([...caps.timersSet], [["tick", 42]]);
	await caps.timers.clear("tick");
	equal(caps.timersSet.size, 0);
	equal(
		await reasonOf(caps.repo.log({ path: "/acme" }, "main")),
		"not_implemented",
	);
	caps.respond("repo.log", (args: readonly unknown[]) => [{ ref: args[1] }]);
	deepStrictEqual(await caps.repo.log({ path: "/acme" }, "main"), [{
		ref: "main",
	}]);
	deepStrictEqual(
		caps.effects().map((c) => c.method),
		["events.emit", "timers.set", "timers.clear"],
	);
});
