// The extension fan-out (K8, K9): gates with defaults and `onTruncated`, echo
// with prefetched inputs, the `context_get` assembler (golden) and MCP tool
// listing/routing, on real hosts over in-memory storage.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
	type ExtensionModule,
	type GateInput,
	type PrefetchedInputs,
	SESSION_BOUNDS,
} from "@tartan/contract";
import type {
	AuthContext,
	InstallationInForce,
} from "@tartan/contract/kernel.ts";
import {
	assembleContextPack,
	createExtDispatchWith,
	type DispatchDeps,
	type DispatchHost,
} from "./fanout.ts";
import {
	createFakeKernel,
	type FakeKernel,
	inForce,
	INSTALLATION_ID,
	LANE_ID,
	NODES,
	OTHER_INSTALLATION_ID,
	PRINCIPALS,
	userActor,
} from "./testing/fakes.ts";
import { helloManifest, helloModule } from "./testing/hello.ts";
import { createTestHost, type TestHost } from "./testing/memory.ts";

const AT = { nodeId: NODES.router.id, repoId: NODES.router.id };

const advance = (truncated: boolean, changeId = "k".repeat(32)): GateInput => ({
	point: "ref.advance",
	repo: NODES.router.id,
	ref: "refs/heads/main",
	base: "a".repeat(40),
	head: "b".repeat(40),
	changeId,
	changedPaths: [],
	addedLines: [],
	truncated,
	workRefs: [],
	actor: userActor(PRINCIPALS.dev),
});

type Setup = {
	readonly kernel: FakeKernel;
	readonly hosts: Map<string, TestHost>;
	readonly installed: InstallationInForce[];
	readonly deps: DispatchDeps;
	close(): void;
};

const setup = async (
	installs: readonly {
		readonly id: string;
		readonly mode?: "enforce" | "shadow" | "disabled";
		readonly module?: () => ExtensionModule;
	}[],
	overrides: Partial<DispatchDeps> = {},
): Promise<Setup> => {
	const kernel = createFakeKernel();
	const hosts = new Map<string, TestHost>();
	const installed: InstallationInForce[] = [];
	for (const install of installs) {
		const overridesDto = { id: install.id, mode: install.mode ?? "enforce" };
		const t = await createTestHost({
			kernel,
			installation: overridesDto,
			name: `ext:${install.id}:repo:${NODES.router.id}`,
			...(install.module ? { module: install.module } : {}),
		});
		hosts.set(install.id, t);
		installed.push(inForce(helloManifest(), overridesDto));
	}
	const deps: DispatchDeps = {
		clock: { now: () => Date.now() },
		inForce: () => Promise.resolve(installed),
		provider: (iface) =>
			Promise.resolve(
				installed.find((i) =>
					i.installation.mode === "enforce" &&
					(i.manifest.provides ?? []).includes(iface as never)
				) ?? null,
			),
		protocolCards: () =>
			Promise.resolve([{
				installation: INSTALLATION_ID,
				ext: "tartan.hello",
				md: "Push early.",
			}]),
		host: (installationId) =>
			hosts.get(installationId)!.host as unknown as DispatchHost,
		lane: (_repoId, laneId) =>
			kernel.ports.repo(NODES.router.id).core.getLane(laneId),
		laneRange: (_repoId, laneId) =>
			kernel.ports.repo(NODES.router.id).core.laneRange(laneId),
		addedLines: () =>
			Promise.resolve({
				lines: [{ path: "a.ts", line: 1, text: "x" }],
				truncated: false,
			}),
		diffPaths: (source, base, head) =>
			kernel.ports.probe.diffPaths(source, base, head),
		node: (id) => kernel.ports.node({ id }),
		effectiveRole: (principals, nodeId) =>
			kernel.ports.effectiveRole(principals, nodeId),
		...overrides,
	};
	return {
		kernel,
		hosts,
		installed,
		deps,
		close: () => {
			for (const t of hosts.values()) t.close();
		},
	};
};

Deno.test("a truncated ref.advance input vetoes by default (onTruncated) even when the gate allows", async () => {
	const s = await setup([{ id: INSTALLATION_ID }]);
	try {
		const out = await createExtDispatchWith(s.deps).gates(
			"ref.advance",
			advance(true),
			AT,
		);
		strictEqual(out.calls.length, 1);
		deepStrictEqual(out.calls[0].outcome, {
			kind: "decision",
			decision: { decision: "allow", message: "fine" },
		});
		deepStrictEqual(
			[out.effective[0].decision, out.effective[0].basis],
			["veto", "truncated"],
		);
		strictEqual(out.blocked, true);
		const full = await createExtDispatchWith(s.deps).gates(
			"ref.advance",
			advance(false),
			AT,
		);
		strictEqual(full.blocked, false);
		strictEqual(full.effective[0].basis, "answer");
	} finally {
		s.close();
	}
});

Deno.test("K8/K9: an enforce veto blocks; a shadow veto is recorded and never blocks", async () => {
	const s = await setup([
		{ id: INSTALLATION_ID, mode: "shadow" },
		{ id: OTHER_INSTALLATION_ID, mode: "disabled" },
	]);
	try {
		const veto = advance(false, "v".repeat(32));
		const out = await createExtDispatchWith(s.deps).gates(
			"ref.advance",
			veto,
			AT,
		);
		strictEqual(out.calls.length, 1, "disabled installations are not called");
		strictEqual(out.effective[0].mode, "shadow");
		strictEqual(out.effective[0].decision, "veto");
		strictEqual(out.blocked, false);
	} finally {
		s.close();
	}
	const e = await setup([{ id: INSTALLATION_ID }]);
	try {
		const out = await createExtDispatchWith(e.deps).gates(
			"ref.advance",
			advance(false, "v".repeat(32)),
			AT,
		);
		strictEqual(out.blocked, true);
	} finally {
		e.close();
	}
});

Deno.test("gate timeouts and errors take the manifest default (stricter on truncated input)", async () => {
	const slow: ExtensionModule = {
		...helloModule,
		gate: () => new Promise(() => {}),
	};
	const s = await setup([{ id: INSTALLATION_ID, module: () => slow }]);
	try {
		const dispatch = createExtDispatchWith(s.deps);
		const out = await dispatch.gates("push", {
			point: "push",
			repo: NODES.router.id,
			target: "repo",
			commands: [],
			actor: userActor(PRINCIPALS.dev),
			truncated: false,
		}, AT);
		strictEqual(out.calls[0].outcome.kind, "timeout");
		// The push gate declares default "veto".
		deepStrictEqual([out.effective[0].decision, out.effective[0].basis], [
			"veto",
			"default",
		]);
		strictEqual(out.blocked, true);
	} finally {
		s.close();
	}
	const failing: ExtensionModule = {
		...helloModule,
		gate: () => Promise.reject(new Error("gate crashed")),
	};
	const f = await setup([{ id: INSTALLATION_ID, module: () => failing }]);
	try {
		const dispatch = createExtDispatchWith(f.deps);
		const allowed = await dispatch.gates("ref.advance", advance(false), AT);
		strictEqual(allowed.calls[0].outcome.kind, "error");
		deepStrictEqual(
			[allowed.effective[0].decision, allowed.effective[0].basis],
			[
				"allow",
				"default",
			],
		);
		const truncated = await dispatch.gates("ref.advance", advance(true), AT);
		deepStrictEqual([
			truncated.effective[0].decision,
			truncated.effective[0].basis,
		], [
			"veto",
			"truncated",
		]);
	} finally {
		f.close();
	}
});

Deno.test("echo: inputs prefetched from the lane range; lines sanitized and prefixed; a missing input is truncated", async () => {
	const seen: PrefetchedInputs[] = [];
	const recording: ExtensionModule = {
		...helloModule,
		echo: (ev, input, x) => {
			seen.push(input);
			return helloModule.echo!(ev, input, x);
		},
	};
	const s = await setup([{ id: INSTALLATION_ID, module: () => recording }]);
	try {
		const ev = s.kernel.addEvent(NODES.router.id, {
			type: "push.accepted",
			data: { target: LANE_ID, after: "b".repeat(40) },
		});
		const lines = await createExtDispatchWith(s.deps).echo(ev, AT);
		deepStrictEqual(lines, [
			"[hello] saw [31mpush.accepted[0m",
			"[hello] second line",
		]);
		deepStrictEqual(seen[0].addedLines, [{ path: "a.ts", line: 1, text: "x" }]);
		strictEqual(seen[0].truncated, false);
		deepStrictEqual(s.kernel.called("core.laneRange")[0].args, [
			NODES.router.id,
			LANE_ID,
		]);

		const broken = createExtDispatchWith({
			...s.deps,
			addedLines: () => Promise.reject(new Error("probe down")),
		});
		await broken.echo(ev, AT);
		strictEqual(seen[1].addedLines, undefined);
		strictEqual(seen[1].truncated, true);
	} finally {
		s.close();
	}
});

Deno.test("context pack golden: kernel sections first, then by priority, fenced, cut to the budget", () => {
	const pack = assembleContextPack([
		{
			source: "i_b",
			id: "hint",
			title: "Hint",
			priority: "hints",
			md: "do x",
			untrusted: true,
			order: 3,
		},
		{
			source: "kernel",
			id: "protocol",
			title: "Protocol",
			priority: "kernel",
			md: "Push early.",
			untrusted: false,
			order: 0,
		},
		{
			source: "i_a",
			id: "lost",
			title: "Tried before",
			priority: "negative",
			md: "```\nclose the fence\n```",
			untrusted: true,
			order: 2,
		},
		{
			source: "i_c",
			id: "big",
			title: "Big",
			priority: "hints",
			md: "y".repeat(400),
			untrusted: true,
			order: 4,
		},
	], 60);
	strictEqual(
		pack.md,
		"## Protocol\n\nPush early.\n" +
			"## Tried before\n\n```untrusted (i_a)\nˋˋˋ\nclose the fence\nˋˋˋ\n```\n" +
			"## Hint\n\n```untrusted (i_b)\ndo x\n```\n" +
			// 240 bytes of budget (60 tokens), 132 used, 32 of fence: 76 left.
			"## Big\n\n```untrusted (i_c)\n" + "y".repeat(76) + "\n```\n",
	);
	deepStrictEqual(pack.sections.map((s) => [s.id, s.truncated]), [
		["protocol", false],
		["lost", false],
		["hint", false],
		["big", true],
	]);
	strictEqual(pack.truncated, true);
	ok(new TextEncoder().encode(pack.md).length <= 60 * 4);
});

Deno.test("context_get: protocol cards, the lane, then contributors' sections (≤ 8, fenced)", async () => {
	const s = await setup([{ id: INSTALLATION_ID }]);
	try {
		const pack = await createExtDispatchWith(s.deps).context({
			repo: {
				id: NODES.router.id,
				path: NODES.router.path,
				nodeId: NODES.router.id,
			},
			laneId: LANE_ID,
			actor: userActor(PRINCIPALS.dev),
		}, SESSION_BOUNDS);
		deepStrictEqual(pack.sections.map((x) => [x.source, x.id]), [
			["kernel", "protocol"],
			["kernel", "lane"],
			[INSTALLATION_ID, "hello"],
		]);
		ok(pack.md.includes("```untrusted (" + INSTALLATION_ID + ")"));
		ok(pack.md.includes(`lane: \`${LANE_ID}\``));
		strictEqual(pack.truncated, false);
	} finally {
		s.close();
	}
});

Deno.test("tools: kernel, interface and extension tools at a scope, filtered by role; routing", async () => {
	const s = await setup([{ id: INSTALLATION_ID }]);
	try {
		const dispatch = createExtDispatchWith(s.deps);
		const auth = (principal: string): AuthContext => ({
			principal,
			kind: "user",
			via: "session",
			scopes: [],
			nodeId: null,
			laneId: null,
			maxRole: 50,
			isAdmin: false,
		});
		const devTools =
			(await dispatch.tools(NODES.router.id, auth(PRINCIPALS.dev)))
				.map((t) => t.name);
		ok(devTools.includes("context_get"));
		ok(devTools.includes("queue_enqueue"));
		ok(devTools.includes("hello_count"));
		ok(!devTools.includes("lanes_sync"), "M2 kernel tools are not listed");
		const reporterTools =
			(await dispatch.tools(NODES.router.id, auth(PRINCIPALS.reporter)))
				.map((t) => t.name);
		ok(reporterTools.includes("queue_status"));
		ok(
			!reporterTools.includes("queue_enqueue"),
			"role 30 tool hidden from a Reporter",
		);
		ok(!reporterTools.includes("lanes_open"));
		deepStrictEqual(
			await dispatch.resolveTool(
				NODES.router.id,
				"whoami",
				auth(PRINCIPALS.dev),
			),
			{
				kind: "kernel",
				name: "whoami",
			},
		);
		const iface = await dispatch.resolveTool(
			NODES.router.id,
			"queue_enqueue",
			auth(PRINCIPALS.dev),
		);
		strictEqual(iface?.kind, "interface");
		const ext = await dispatch.resolveTool(
			NODES.router.id,
			"hello_count",
			auth(PRINCIPALS.dev),
		);
		strictEqual(ext?.kind, "extension");
		strictEqual(
			await dispatch.resolveTool(
				NODES.router.id,
				"work_claim",
				auth(PRINCIPALS.dev),
			),
			null,
		);
		strictEqual(
			await dispatch.resolveTool(NODES.router.id, "nope", auth(PRINCIPALS.dev)),
			null,
		);
	} finally {
		s.close();
	}
});
