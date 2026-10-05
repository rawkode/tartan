// The extension host beyond the conformance list: the mutex, the read-only
// render context and viewer-keyed render cache, per-call capabilities, slot
// roles, log attribution, tools (role, K12 for the provider, call cycles),
// context, gate and echo.

import {
	deepStrictEqual,
	notStrictEqual,
	ok,
	rejects,
	strictEqual,
} from "node:assert/strict";
import {
	type ExtensionModule,
	fromRpcError,
	SESSION_BOUNDS,
	type ToolContext,
} from "@tartan/contract";
import { createMemoryStorage } from "@tartan/ext-api/testing.ts";
import {
	addHello,
	deliveries,
	nextAlarm,
	poke,
	renderCtx,
	ROUTER_STREAM,
	viewer,
} from "./testing/conformance.ts";
import {
	agentActor,
	createFakeKernel,
	installationActor,
	makeEvent,
	NODES,
	OTHER_INSTALLATION_ID,
	PRINCIPALS,
	userActor,
} from "./testing/fakes.ts";
import {
	deferred,
	helloControl,
	helloManifest,
	helloModule,
	holdingLandSubmit,
} from "./testing/hello.ts";
import { createTestHost, query, type TestHost } from "./testing/memory.ts";
import { parseExtDoName } from "./host.ts";
import { INSTALLATION_REVALIDATE_MS } from "./installation.ts";

const errorOf = async (p: Promise<unknown>): Promise<string> => {
	try {
		await p;
		return "ok";
	} catch (error) {
		const e = fromRpcError(error);
		return e.reason ? `${e.code}:${e.reason}` : e.code;
	}
};

const withHost = async (
	fn: (t: TestHost) => Promise<void>,
	options: Parameters<typeof createTestHost>[0] = {},
) => {
	const t = await createTestHost(options);
	try {
		await fn(t);
	} finally {
		t.close();
	}
};

const toolCtx = (actor = userActor(PRINCIPALS.dev)): ToolContext => ({
	node: NODES.router.id,
	repo: NODES.router.id,
	scope: NODES.router.path,
	actor,
	mode: "enforce",
});

const CHANGE_A = "k".repeat(32);
const CHANGE_B = "m".repeat(32);

Deno.test("parseExtDoName reads the installation and scope from the DO name", () => {
	deepStrictEqual(parseExtDoName(`ext:i_${"0".repeat(26)}:node`), {
		installationId: `i_${"0".repeat(26)}`,
		scope: { kind: "node" },
	});
	deepStrictEqual(
		parseExtDoName(`ext:i_${"0".repeat(26)}:repo:${NODES.router.id}`)?.scope,
		{ kind: "repo", repoId: NODES.router.id },
	);
	strictEqual(parseExtDoName("ext:nope:node"), null);
});

Deno.test("a concurrent queue_enqueue during an awaited land.submit is serialized", async () => {
	await withHost(async (t) => {
		t.kernel.landSubmit = holdingLandSubmit;
		helloControl.trace.length = 0;
		const hold = deferred();
		helloControl.holds.set(CHANGE_A, hold);
		const first = t.host.callTool(
			"queue_enqueue",
			{ changeId: CHANGE_A },
			toolCtx(),
			SESSION_BOUNDS,
		);
		await new Promise((r) => setTimeout(r, 5));
		const second = t.host.callTool(
			"queue_enqueue",
			{ changeId: CHANGE_B },
			toolCtx(),
			SESSION_BOUNDS,
		);
		// A non-mutating tool bypasses the mutex and answers while A holds it.
		const status = await t.host.callTool(
			"queue_status",
			{ repo: NODES.router.path },
			toolCtx(),
			SESSION_BOUNDS,
		);
		deepStrictEqual(status, { partitions: [] });
		await new Promise((r) => setTimeout(r, 5));
		deepStrictEqual(helloControl.trace, [`start ${CHANGE_A}`]);
		strictEqual(
			t.kernel.called("land.submit").length,
			1,
			"A awaits land.submit",
		);
		hold.resolve();
		await Promise.all([first, second]);
		deepStrictEqual(helloControl.trace, [
			`start ${CHANGE_A}`,
			`end ${CHANGE_A}`,
			`start ${CHANGE_B}`,
			`end ${CHANGE_B}`,
		]);
		strictEqual(t.kernel.called("land.submit").length, 2);
		helloControl.holds.clear();
	});
});

Deno.test("nodes with innerHTML, style, onClick, a non-link href or a //evil href render as the error chip", async () => {
	const bad: Record<string, unknown> = {
		innerHTML: { t: "text", text: "x", innerHTML: "<b>x</b>" },
		style: { t: "stack", children: [], style: "color:red" },
		onClick: { t: "button", text: "x", onClick: "alert(1)" },
		javascriptHref: { t: "link", text: "x", href: "javascript:alert(1)" },
		httpHref: { t: "link", text: "x", href: "http://example.com" },
		protocolRelative: { t: "link", text: "x", href: "//evil.example" },
		backslash: { t: "link", text: "x", href: "/\\evil.example" },
	};
	let current: unknown = null;
	const module: ExtensionModule = {
		...helloModule,
		render: () => Promise.resolve({ v: 1, root: current } as never),
	};
	await withHost(async (t) => {
		for (const [name, root] of Object.entries(bad)) {
			current = root;
			const doc = await t.host.render("bad", renderCtx, viewer(PRINCIPALS.dev));
			deepStrictEqual(doc.root, {
				t: "error-chip",
				text: "tartan.hello: render failed",
			}, name);
		}
		current = { t: "link", text: "ok", href: "/acme/router" };
		strictEqual(
			(await t.host.render("bad", renderCtx, viewer(PRINCIPALS.dev))).root.t,
			"link",
		);
	}, { module: () => module });
});

Deno.test("the forge stream is drained filtered to the installation subtree", async () => {
	await withHost(async (t) => {
		t.kernel.forgeLog.push(
			makeEvent({ type: "node.created", seq: 1, stream: "forge" }),
		);
		await t.host.poke({ stream: "forge", head: 1 });
		const reads = t.kernel.called("forgeEvents.read");
		ok(reads.length > 0);
		for (const read of reads) {
			strictEqual(
				(read.args[2] as { subtreeNodeId: string }).subtreeNodeId,
				NODES.acme.id,
			);
		}
	}, {
		manifest: helloManifest({
			subscribe: [{ event: "node.*" }],
			permissions: {
				...helloManifest().permissions,
				"events.read": ["node.*"],
			},
		}),
	});
});

Deno.test("a forge read that stopped at its scan bound is not taken as caught up; the event past it is delivered", async () => {
	await withHost(async (t) => {
		// Many matching events outside the installation's subtree, then one in it.
		for (let seq = 1; seq <= 7; seq++) {
			t.kernel.forgeLog.push(
				makeEvent({
					type: "node.created",
					seq,
					stream: "forge",
					node: seq === 7 ? NODES.acme.id : NODES.secret.id,
				}),
			);
		}
		t.kernel.forgeScan.max = 3;
		t.kernel.forgeScan.visible = (e) => e.node === NODES.acme.id;
		await t.host.poke({ stream: "forge", head: 7 });
		for (let i = 0; i < 5 && deliveries(t).length === 0; i++) {
			await nextAlarm(t);
		}
		deepStrictEqual(deliveries(t).map((d) => d.seq), [7]);
	}, {
		manifest: helloManifest({
			subscribe: [{ event: "node.*" }],
			permissions: {
				...helloManifest().permissions,
				"events.read": ["node.*"],
			},
		}),
	});
});

Deno.test("two viewers get different cached renders; a role-cached slot is shared by role", async () => {
	let renders = 0;
	const counting: ExtensionModule = {
		...helloModule,
		render: (...args) => {
			renders += 1;
			return helloModule.render!(...args);
		},
	};
	await withHost(async (t) => {
		const a = await t.host.render(
			"greeting",
			renderCtx,
			viewer(PRINCIPALS.dev, 30),
		);
		const b = await t.host.render(
			"greeting",
			renderCtx,
			viewer(PRINCIPALS.maintainer, 40),
		);
		notStrictEqual(JSON.stringify(a), JSON.stringify(b));
		ok(JSON.stringify(a).includes(PRINCIPALS.dev));
		ok(JSON.stringify(b).includes(PRINCIPALS.maintainer));
		strictEqual(renders, 2);
		await t.host.render("greeting", renderCtx, viewer(PRINCIPALS.dev, 30));
		strictEqual(renders, 2, "the same viewer hits the cache");
		// cache: "role": same role and kind share one entry.
		await t.host.render("metric", renderCtx, viewer(PRINCIPALS.dev, 30));
		await t.host.render("metric", renderCtx, viewer(PRINCIPALS.reporter, 30));
		strictEqual(renders, 3);
		await t.host.render("metric", renderCtx, viewer(PRINCIPALS.maintainer, 40));
		strictEqual(renders, 4);
		strictEqual(query(t, "SELECT 1 FROM _render_cache").length, 4);
	}, { module: () => counting });
});

Deno.test("a write in render is denied read-only for sql, kv and every effect", async () => {
	await withHost(async (t) => {
		const doc = await t.host.render(
			"effects",
			renderCtx,
			viewer(PRINCIPALS.dev),
		);
		strictEqual(doc.root.t, "code");
		const attempts = JSON.parse((doc.root as { text: string }).text);
		deepStrictEqual(attempts, {
			sql: "denied:read-only",
			kv: "denied:read-only",
			emit: "denied:read-only",
			notify: "denied:read-only",
			lanes: "denied:read-only",
			land: "denied:read-only",
			timers: "denied:read-only",
			tool: "denied:read-only",
		});
		strictEqual(query(t, "SELECT 1 FROM greetings").length, 0);
		strictEqual(t.kernel.called("events.append").length, 0);
	});
});

Deno.test("a write call bumps data_version and invalidates the render cache", async () => {
	await withHost(async (t) => {
		const before = await t.host.render(
			"greeting",
			renderCtx,
			viewer(PRINCIPALS.dev),
		);
		ok(JSON.stringify(before).includes("greetings: 0"));
		const out = await t.host.action(
			"greeting",
			"greet",
			{ text: "hi" },
			renderCtx,
			userActor(PRINCIPALS.dev),
			SESSION_BOUNDS,
		);
		deepStrictEqual(out, { v: 1, toast: { tone: "success", text: "greeted" } });
		const after = await t.host.render(
			"greeting",
			renderCtx,
			viewer(PRINCIPALS.dev),
		);
		ok(JSON.stringify(after).includes("greetings: 1"));
	});
});

Deno.test("a capability stashed in a module global fails on the next call (builtins too)", async () => {
	await withHost(async (t) => {
		helloControl.stash = null;
		await t.host.render("stash", renderCtx, viewer(PRINCIPALS.dev));
		ok(helloControl.stash !== null);
		const doc = await t.host.render(
			"use-stash",
			renderCtx,
			viewer(PRINCIPALS.dev),
		);
		ok(JSON.stringify(doc).includes("stash: unavailable"));
		helloControl.stash = null;
	});
});

Deno.test("caps are per call: the actor changes between two calls on the same module", async () => {
	await withHost(async (t) => {
		const a = await t.host.callTool(
			"tartan_hello_count",
			{},
			toolCtx(),
			SESSION_BOUNDS,
		)
			.catch(() => null);
		strictEqual(a, null, "extension tools are called by their own name");
		const first = await t.host.callTool(
			"count",
			{},
			toolCtx(userActor(PRINCIPALS.dev)),
			SESSION_BOUNDS,
		) as { actor: string };
		const second = await t.host.callTool(
			"count",
			{},
			toolCtx(userActor(PRINCIPALS.maintainer)),
			SESSION_BOUNDS,
		) as { actor: string };
		strictEqual(first.actor, PRINCIPALS.dev);
		strictEqual(second.actor, PRINCIPALS.maintainer);
	});
});

Deno.test("slot roles, unknown slots and invalid action results", async () => {
	await withHost(async (t) => {
		strictEqual(
			await errorOf(
				t.host.render("owners", renderCtx, viewer(PRINCIPALS.dev, 30)),
			),
			"denied:role",
		);
		const ok40 = await t.host.render(
			"owners",
			renderCtx,
			viewer(PRINCIPALS.maintainer, 40),
		);
		strictEqual(ok40.root.t, "stack");
		strictEqual(
			await errorOf(
				t.host.action(
					"nope",
					"greet",
					{},
					renderCtx,
					userActor(PRINCIPALS.dev),
					SESSION_BOUNDS,
				),
			),
			"not_found",
		);
		strictEqual(
			await errorOf(
				t.host.action(
					"greeting",
					"bad",
					{},
					renderCtx,
					userActor(PRINCIPALS.dev),
					SESSION_BOUNDS,
				),
			),
			"internal",
		);
		// The slot's role holds for actions too (defense in depth behind the slot API).
		strictEqual(
			await errorOf(
				t.host.action(
					"owners",
					"greet",
					{},
					renderCtx,
					userActor(PRINCIPALS.dev),
					SESSION_BOUNDS,
				),
			),
			"denied:role",
		);
		const asMaintainer = await t.host.action(
			"owners",
			"greet",
			{},
			renderCtx,
			userActor(PRINCIPALS.maintainer),
			SESSION_BOUNDS,
		);
		strictEqual(asMaintainer.toast?.text, "greeted");
	});
});

Deno.test("a render reads only inside the viewed node's subtree, whoever the viewer is", async () => {
	const module: ExtensionModule = {
		...helloModule,
		render: async (_slot, _ctx, _props, x) => {
			const outcome = async (id: string) => {
				try {
					await x.caps.repo.info({ id });
					return "ok";
				} catch (error) {
					const e = fromRpcError(error);
					return `${e.code}:${e.reason}`;
				}
			};
			return {
				v: 1,
				root: {
					t: "text",
					text: `${await outcome(NODES.router.id)} ${await outcome(
						NODES.platformApi.id,
					)}`,
				},
			};
		},
	};
	await withHost(async (t) => {
		for (
			const v of [viewer(PRINCIPALS.dev), {
				role: 20,
				kind: "anonymous" as const,
			}]
		) {
			const doc = await t.host.render("greeting", renderCtx, v);
			deepStrictEqual(doc.root, { t: "text", text: "ok denied:role" });
		}
	}, { module: () => module });
});

Deno.test("the K12 root (installation node) is resolved once per revalidation interval", async () => {
	await withHost(async (t) => {
		for (let i = 0; i < 5; i++) {
			await t.host.callTool("count", {}, toolCtx(), SESSION_BOUNDS);
			addHello(t, "emit");
			await poke(t);
		}
		const lookups = t.kernel.called("node").filter((c) =>
			(c.args[0] as { id?: string }).id === NODES.acme.id
		);
		strictEqual(lookups.length, 1);
		t.clock.advance(INSTALLATION_REVALIDATE_MS);
		addHello(t, "emit");
		await poke(t);
		strictEqual(
			t.kernel.called("node").filter((c) =>
				(c.args[0] as { id?: string }).id === NODES.acme.id
			).length,
			2,
		);
	});
});

Deno.test("tools: role, K12 for the provider, input validation and call cycles", async () => {
	await withHost(async (t) => {
		// queue_enqueue needs Developer (30); a Reporter is denied.
		strictEqual(
			await errorOf(
				t.host.callTool(
					"queue_enqueue",
					{ changeId: CHANGE_A },
					toolCtx(userActor(PRINCIPALS.reporter)),
					SESSION_BOUNDS,
				),
			),
			"denied:role",
		);
		// An agent with no grants of its own acts with its user's role, capped by its token.
		const agent = agentActor(PRINCIPALS.agent, PRINCIPALS.dev);
		strictEqual(
			await errorOf(
				t.host.callTool(
					"queue_enqueue",
					{ changeId: CHANGE_A },
					toolCtx(agent),
					{ maxRole: 20, scopes: ["mcp"], nodeId: null, laneId: null },
				),
			),
			"denied:role",
		);
		// A target outside the installation subtree.
		strictEqual(
			await errorOf(
				t.host.callTool(
					"queue_enqueue",
					{ changeId: CHANGE_A },
					{ ...toolCtx(), node: NODES.secret.id, repo: NODES.secret.id },
					SESSION_BOUNDS,
				),
			),
			"denied:scope",
		);
		strictEqual(
			await errorOf(
				t.host.callTool(
					"queue_enqueue",
					{ changeId: "nope" },
					toolCtx(),
					SESSION_BOUNDS,
				),
			),
			"invalid",
		);
		strictEqual(
			await errorOf(
				t.host.callTool(
					"queue_enqueue",
					{ changeId: CHANGE_A },
					toolCtx(),
					SESSION_BOUNDS,
					[OTHER_INSTALLATION_ID, t.installations.snapshot!.installation.id],
				),
			),
			"conflict",
		);
		strictEqual(
			await errorOf(t.host.callTool("nope", {}, toolCtx(), SESSION_BOUNDS)),
			"not_found",
		);
		// Another installation calling in the background carries its role in bounds.
		strictEqual(
			await errorOf(
				t.host.callTool(
					"queue_enqueue",
					{ changeId: CHANGE_A },
					toolCtx(installationActor(OTHER_INSTALLATION_ID)),
					{ maxRole: 20, scopes: null, nodeId: NODES.acme.id, laneId: null },
				),
			),
			"denied:role",
		);
		const entry = await t.host.callTool(
			"queue_enqueue",
			{ changeId: CHANGE_A },
			toolCtx(installationActor(OTHER_INSTALLATION_ID)),
			{ maxRole: 30, scopes: null, nodeId: NODES.acme.id, laneId: null },
		);
		deepStrictEqual((entry as { changeId: string }).changeId, CHANGE_A);
	});
});

Deno.test("context: only declared sections, each cut to its maxBytes", async () => {
	await withHost(async (t) => {
		const sections = await t.host.context({
			repo: NODES.router.path,
			repoId: NODES.router.id,
			maxBytes: 64,
			actor: userActor(PRINCIPALS.dev),
		}, SESSION_BOUNDS);
		strictEqual(sections.length, 1);
		strictEqual(sections[0].id, "hello");
		ok(new TextEncoder().encode(sections[0].md).length <= 64);
	});
});

Deno.test("gate and echo: decisions validated, echo lines sanitized and prefixed", async () => {
	await withHost(async (t) => {
		const advance = {
			point: "ref.advance" as const,
			repo: NODES.router.id,
			ref: "refs/heads/main",
			base: "a".repeat(40),
			head: "b".repeat(40),
			changeId: "v".repeat(32),
			changedPaths: [],
			addedLines: [],
			truncated: false,
			workRefs: [],
			actor: userActor(PRINCIPALS.dev),
		};
		deepStrictEqual(
			await t.host.gate("ref.advance", advance, renderCtx),
			{ decision: "veto", message: "vetoed by hello" },
		);
		strictEqual(
			await errorOf(t.host.gate("lane.open", advance as never, renderCtx)),
			"invalid",
		);
		const ev = t.kernel.addEvent(NODES.router.id, { type: "push.accepted" });
		const echo = await t.host.echo(ev, { truncated: false });
		deepStrictEqual(echo, {
			lines: ["[hello] saw [31mpush.accepted[0m", "[hello] second line"],
			timedOut: false,
		});
		ok(!echo.lines.some((l) => l.includes("\u001b")));
	});
});

Deno.test("background hooks act as the installation; the event's actor is only the trigger", async () => {
	await withHost(async (t) => {
		addHello(t, "note");
		await poke(t);
		const [d] = query<{ actor: string; trigger_actor: string }>(
			t,
			"SELECT actor, trigger_actor FROM deliveries",
		);
		strictEqual(d.actor, installationActor().id);
		strictEqual(d.trigger_actor, PRINCIPALS.dev);
	});
});

Deno.test("emitted events carry causedBy, depth + 1 and a deterministic idempotency key", async () => {
	await withHost(async (t) => {
		const cause = addHello(t, "emit");
		await poke(t);
		const [input] = t.kernel.appended;
		strictEqual(input.type, "x.tartan.hello.echoed");
		strictEqual(input.causedBy, cause.id);
		strictEqual(input.depth, 1);
		strictEqual(
			input.idemKey,
			`${
				t.installations.snapshot!.installation.id
			}:${cause.id}:x.tartan.hello.echoed:0`,
		);
		deepStrictEqual(input.source, {
			kind: "installation",
			id: t.installations.snapshot!.installation.id,
			ext: "tartan.hello@0.1.0",
		});
	});
});

Deno.test("K12: a repo-scoped host drains only its repo; a node-scoped one only its subtree", async () => {
	await withHost(async (t) => {
		strictEqual(
			await errorOf(
				t.host.poke({ stream: `repo:${NODES.secret.id}`, head: 1 }),
			),
			"denied:scope",
		);
	});
	const nodeScoped = helloManifest({
		storage: { scope: "node", migrations: ["migrations/0001_init.sql"] },
	});
	await withHost(async (t) => {
		strictEqual(
			await errorOf(
				t.host.poke({ stream: `repo:${NODES.secret.id}`, head: 1 }),
			),
			"denied:scope",
		);
		t.kernel.addEvent(NODES.platformApi.id, { type: "x.tartan.hello.note" });
		await t.host.poke({ stream: `repo:${NODES.platformApi.id}`, head: 1 });
		strictEqual(deliveries(t).length, 1);
	}, { manifest: nodeScoped });
});

Deno.test("log lines of two installations of one package stay apart and tagged", async () => {
	const kernel = createFakeKernel();
	const a = await createTestHost({ kernel });
	const b = await createTestHost({
		kernel,
		installation: { id: OTHER_INSTALLATION_ID },
		name: `ext:${OTHER_INSTALLATION_ID}:repo:${NODES.router.id}`,
	});
	try {
		addHello(a, "fail");
		await poke(a);
		await b.host.poke({
			stream: ROUTER_STREAM,
			head: kernel.head(NODES.router.id),
		});
		const linesA = (await a.host.console(0, 100)).map((r) => r.msg);
		const linesB = (await b.host.console(0, 100)).map((r) => r.msg);
		ok(linesA.length > 0 && linesB.length > 0);
		ok(linesA.every((l) => !l.includes(OTHER_INSTALLATION_ID)));
		ok(linesB.every((l) => l.includes(OTHER_INSTALLATION_ID)));
		ok(
			a.logs.some((l) => l.includes(a.installations.snapshot!.installation.id)),
		);
	} finally {
		a.close();
		b.close();
	}
});

Deno.test("deleteData empties the scope; the next call starts afresh", async () => {
	await withHost(async (t) => {
		addHello(t, "note");
		await poke(t);
		strictEqual(deliveries(t).length, 1);
		await t.host.deleteData();
		strictEqual(query(t, "SELECT 1 FROM _cursors").length, 0);
		await poke(t);
		strictEqual(
			deliveries(t).length,
			1,
			"backfill all redelivers into the fresh tables",
		);
	});
});

Deno.test("an unknown installation or a scope mismatch is refused", async () => {
	const storage = createMemoryStorage();
	try {
		const t = await createTestHost({
			storage,
			name: `ext:${OTHER_INSTALLATION_ID}:node`,
		});
		strictEqual(
			await errorOf(
				t.host.callTool("count", {}, toolCtx(), SESSION_BOUNDS),
			),
			"not_found",
		);
		// The page never breaks: a render that cannot even load is the error chip.
		const chip = await t.host.render(
			"greeting",
			renderCtx,
			viewer(PRINCIPALS.dev),
		);
		strictEqual(chip.root.t, "error-chip");
		deepStrictEqual(
			await t.host.context({
				repo: NODES.router.path,
				repoId: NODES.router.id,
				maxBytes: 64,
				actor: userActor(PRINCIPALS.dev),
			}, SESSION_BOUNDS),
			[],
		);
	} finally {
		storage.close();
	}
	await withHost(async (t) => {
		await rejects(t.host.poke({ stream: ROUTER_STREAM, head: 0 }));
	}, { name: `ext:${"i_01k60000000000000000000201"}:node` });
});

Deno.test("once the installation is uninstalled, its timers are dropped instead of retried, and the alarm is cleared", async () => {
	await withHost(async (t) => {
		addHello(t, "timer", { key: "tick", inMs: 60_000 });
		addHello(t, "timer", { key: "later", inMs: 120_000 });
		await poke(t);
		strictEqual(
			query(t, "SELECT 1 FROM _timers WHERE module = 'ext'").length,
			2,
		);
		// A host retry too: a drain timer on a stream.
		t.storage.sql.exec(
			"INSERT INTO _timers (module, key, at, attempts) VALUES ('host', ?, ?, 3)",
			`drain:${ROUTER_STREAM}`,
			t.clock.now() + 30_000,
		);
		// Uninstall: the registry bumps its version and forgets the installation.
		t.installations.set((s) => s);
		t.installations.snapshot = null;
		ok(await nextAlarm(t));
		// No row is left for the alarm (workerd's alarm itself: the workers test).
		deepStrictEqual(query(t, "SELECT module, key FROM _timers"), []);
		deepStrictEqual(query(t, "SELECT key FROM fired"), [], "nothing ran");
		ok(
			t.logs.some((l) =>
				l.startsWith("warn ") && l.includes("installation is gone") &&
				l.includes("dropped 3 timers")
			),
			t.logs.join("\n"),
		);
		ok(!await nextAlarm(t), "no alarm is left");
	});
});

Deno.test("a registry failure is still retried with backoff (only a missing installation is terminal)", async () => {
	await withHost(async (t) => {
		addHello(t, "timer", { key: "tick", inMs: 60_000 });
		await poke(t);
		t.installations.set((s) => s);
		const load = t.installations.load;
		t.installations.load = () => Promise.reject(new Error("registry down"));
		ok(await nextAlarm(t));
		const [row] = query<{ attempts: number }>(
			t,
			"SELECT attempts FROM _timers WHERE module = 'ext' AND key = 'tick'",
		);
		strictEqual(row?.attempts, 1, "rescheduled with backoff");
		t.installations.load = load;
		ok(await nextAlarm(t));
		deepStrictEqual(query(t, "SELECT key FROM fired"), [{ key: "tick" }]);
	});
});
