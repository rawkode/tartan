/// <reference types="@cloudflare/vitest-pool-workers/types" />
// The js and wasm runtimes on the platform (vitest-pool-workers, workerd):
// the real ExtensionDO wired with the production package loader
// (`extensionPackages`): the package read from R2 (BLOBS), a Dynamic
// Worker from the Worker Loader, the facet `main` with its own SQLite, the
// RpcTarget capability bridge, `facets.abort` on a host timeout. Kernel
// ports and the registry are fakes (`ExtensionDO.rewire`).
//
// The wasm case uses the built `acme.no-secrets` (`deno task build:ext
// acme-no-secrets`) and is skipped when it has not been built.

import { runInDurableObject } from "cloudflare:test";
import {
	createUlid,
	extDoName,
	type Manifest,
	parseManifest,
	SESSION_BOUNDS,
} from "@tartan/contract";
import { describe, expect, it } from "vitest";
import { testEnv as env } from "../../../../../test/env.ts";
import { ExtensionDO, extensionPackages } from "../do.ts";
import {
	createFakeInstallations,
	createFakeKernel,
	NODES,
	PRINCIPALS,
	userActor,
} from "../testing/fakes.ts";
import { packagePrefix } from "./dynamic.ts";

const ulid = createUlid();
const SHA = "c".repeat(64);

const JS_MAIN = `
let calls = 0;
let stashed = null;
export default {
	async init(x) {
		x.sql.exec("INSERT INTO counters (k, n) VALUES ('init', 1) ON CONFLICT (k) DO UPDATE SET n = n + 1");
	},
	async onEvent(ev, x) {
		x.sql.exec("INSERT INTO deliveries (seq, type, actor) VALUES (?, ?, ?)", ev.seq, ev.type, x.actor.id);
	},
	async render(slot, ctx, props, x) {
		calls += 1;
		const n = x.sql.exec("SELECT COUNT(*) AS n FROM deliveries").one().n;
		let write = "ok";
		try { x.sql.exec("INSERT INTO deliveries (seq, type, actor) VALUES (0, 'x', 'y')"); } catch (e) { write = e.code + ":" + e.reason; }
		return { v: 1, root: { t: "text", text: "deliveries " + n + " viewer " + x.actor.id + " write " + write } };
	},
	async callTool(name, args, ctx, x) {
		if (name === "emit") {
			const id = await x.caps.events.emit("x.acme.hello-js.said", { by: x.actor.id });
			return { id: typeof id, now: x.caps.clock.now() > 0 };
		}
		if (name === "net") {
			try { await fetch("https://example.com/"); return { fetch: "allowed" }; }
			catch (e) { return { fetch: String(e.message ?? e) }; }
		}
		if (name === "denied") {
			try { await x.caps.runs.get("run_1", { repo: { id: ctx.repo } }); return { code: "ok" }; }
			catch (e) { return { code: e.code, reason: e.reason }; }
		}
		if (name === "stash") { stashed = x.caps; return { stashed: true }; }
		if (name === "use_stash") {
			try { await stashed.events.emit("x.acme.hello-js.late", {}); return { code: "ok" }; }
			catch (e) { return { code: e.code ?? String(e) }; }
		}
		if (name === "sleep") { await new Promise((r) => setTimeout(r, 30000)); return { slept: true }; }
		if (name === "calls") return { calls };
		throw new Error("no tool " + name);
	},
};
`;

const MIGRATION = [
	"CREATE TABLE counters (k TEXT PRIMARY KEY, n INTEGER NOT NULL)",
	"CREATE TABLE deliveries (seq INTEGER NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL)",
].join(";\n");

const tool = (name: string) => ({
	name,
	description: name,
	input: { type: "object" },
	role: 20,
});

const jsManifest = (): Manifest => {
	const parsed = parseManifest({
		schema: 1,
		id: "acme.hello-js",
		name: "Hello JS",
		version: "0.1.0",
		api: "tartan:ext@0.1.0",
		runtime: "js",
		entry: { js: "main.js" },
		storage: { scope: "repo", migrations: ["migrations/0001_init.sql"] },
		permissions: {},
		subscribe: [{ event: "x.acme.hello.*" }],
		backfill: "all",
		contributes: {
			slots: [{
				slot: "repo.sidebar",
				id: "count",
				dynamic: true,
				cache: "none",
			}],
			tools: ["emit", "net", "denied", "stash", "use_stash", "sleep", "calls"]
				.map(tool),
		},
	});
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.manifest;
};

const put = async (m: Manifest, files: Record<string, string | Uint8Array>) => {
	const prefix = packagePrefix(m.id, m.version, SHA);
	for (const [path, body] of Object.entries(files)) {
		await env.BLOBS.put(`${prefix}${path}`, body);
	}
};

const wire = async (m: Manifest, budgets: Record<string, number> = {}) => {
	const installationId = `i_${ulid()}`;
	const name = extDoName(installationId, {
		kind: "repo",
		repoId: NODES.router.id,
	});
	const kernel = createFakeKernel();
	const installations = createFakeInstallations(m, { id: installationId });
	installations.set((s) => ({ ...s, sha256: SHA }));
	const stub = env.EXT.getByName(name);
	await runInDurableObject(stub, async (instance, state) => {
		await ExtensionDO.rewire(instance, (defaults) => ({
			...defaults,
			kernel: kernel.ports,
			installations,
			// The production loader, minus the tail sink (no tail in the pool).
			packages: extensionPackages(
				{ ...state, exports: {} } as unknown as DurableObjectState,
				env,
			),
			budgets: { hold: 100, ...budgets },
		}));
	});
	return { stub, kernel, installationId };
};

const ctx = {
	slot: "repo.sidebar" as const,
	node: NODES.router.id,
	repo: NODES.router.id,
	mode: "enforce" as const,
};
const toolCtx = {
	node: NODES.router.id,
	repo: NODES.router.id,
	scope: NODES.router.path,
	actor: userActor(PRINCIPALS.dev),
	mode: "enforce" as const,
};
const viewer = {
	actor: userActor(PRINCIPALS.dev),
	role: 30,
	kind: "user" as const,
};
const stream = `repo:${NODES.router.id}` as const;

describe("js runtime: a Dynamic Worker facet of the ExtensionDO", () => {
	it("migrates and inits in the facet's own SQLite, delivers events and renders read-only", async () => {
		const m = jsManifest();
		await put(m, {
			"main.js": JS_MAIN,
			"migrations/0001_init.sql": MIGRATION,
		});
		const w = await wire(m);
		w.kernel.addEvent(NODES.router.id, { type: "x.acme.hello.one" });
		w.kernel.addEvent(NODES.router.id, { type: "x.acme.hello.two" });
		await w.stub.poke({ stream, head: 2 });
		const doc = await w.stub.render("count", ctx, viewer);
		const text = (doc.root as { text: string }).text;
		expect(text).toBe(
			`deliveries 2 viewer ${PRINCIPALS.dev} write denied:read-only`,
		);
		// The extension's tables are the facet's: the host DB has none.
		const tables = await runInDurableObject(
			w.stub,
			(_i, state) =>
				state.storage.sql.exec(
					"SELECT name FROM sqlite_master WHERE name IN ('deliveries', 'counters')",
				).toArray(),
		);
		expect(tables).toEqual([]);
	});

	it("capabilities cross per call (RpcTarget); a stashed one fails; no network", async () => {
		const m = jsManifest();
		await put(m, {
			"main.js": JS_MAIN,
			"migrations/0001_init.sql": MIGRATION,
		});
		const w = await wire(m);
		const call = (name: string) =>
			w.stub.callTool(name, {}, toolCtx, SESSION_BOUNDS);
		expect(await call("emit")).toEqual({ id: "string", now: true });
		expect(
			w.kernel.appended.some((e) =>
				(e as { type: string }).type === "x.acme.hello-js.said"
			),
		).toBe(true);
		expect(await call("denied")).toEqual({ code: "denied", reason: "grant" });
		expect(await call("stash")).toEqual({ stashed: true });
		const late = await call("use_stash") as { code: string };
		expect(late.code).not.toBe("ok");
		const net = await call("net") as { fetch: string };
		expect(net.fetch).not.toBe("allowed");
	});

	it("a host timeout aborts the facet (a breaker strike); the next call starts fresh code", async () => {
		const m = jsManifest();
		await put(m, {
			"main.js": JS_MAIN,
			"migrations/0001_init.sql": MIGRATION,
		});
		const w = await wire(m, { tool: 300 });
		const call = (name: string) =>
			w.stub.callTool(name, {}, toolCtx, SESSION_BOUNDS);
		await w.stub.render("count", ctx, viewer);
		expect(await call("calls")).toEqual({ calls: 1 });
		const slept = await (call("sleep") as Promise<unknown>).catch((
			e: unknown,
		) => String(e));
		expect(String(slept)).toMatch(/exceeded 300 ms/);
		const strikes = await runInDurableObject(
			w.stub,
			(_i, state) =>
				state.storage.sql.exec("SELECT kind FROM _strikes").toArray(),
		);
		expect(strikes).toEqual([{ kind: "timeout" }]);
		// The facet restarted after the abort and answers again. (Module
		// globals live in the Dynamic Worker's isolate, keyed by the loader
		// id, so they survive a facet restart; only the facet object is new.)
		const again = await call("calls") as { calls: number };
		expect(again.calls).toBeGreaterThanOrEqual(1);
	});
});

declare global {
	interface ImportMeta {
		/** Vite's glob import (the pool transforms test files with Vite). */
		glob(
			pattern: string,
			options: { query: string; import: string; eager: true },
		): Record<string, unknown>;
	}
}

const built = import.meta.glob(
	"../../../../../extensions/acme-no-secrets/dist/publish.json",
	{ query: "?raw", import: "default", eager: true },
) as Record<string, string>;
const publish = Object.values(built)[0];

describe.skipIf(publish === undefined)(
	"wasm runtime: acme.no-secrets (Rust) in a facet",
	() => {
		it("vetoes an advance that adds an AWS key and renders the sidebar", async () => {
			const body = JSON.parse(publish!) as {
				manifest: unknown;
				files: Record<string, string>;
			};
			const parsed = parseManifest(body.manifest);
			if (!parsed.ok) throw new Error(parsed.errors.join("; "));
			const m = parsed.manifest;
			await put(
				m,
				Object.fromEntries(
					Object.entries(body.files).map((
						[p, b64],
					) => [p, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]),
				),
			);
			const w = await wire(m);
			const change = "ch_01k60000000000000000000901";
			const decision = await w.stub.gate("ref.advance", {
				point: "ref.advance",
				repo: NODES.router.id,
				ref: "refs/heads/main",
				base: "a".repeat(40),
				head: "b".repeat(40),
				changeId: change,
				changedPaths: ["config/prod.env"],
				addedLines: [{
					path: "config/prod.env",
					line: 3,
					text: "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
				}],
				truncated: false,
				workRefs: [],
				actor: userActor(PRINCIPALS.dev),
			}, { node: NODES.router.id, repo: NODES.router.id, mode: "enforce" });
			expect(decision.decision).toBe("veto");
			expect(decision.message).toContain(
				"AWS access key at config/prod.env:3 (AKIA…MPLE)",
			);
			const sidebar = await w.stub.render("findings", {
				slot: "change.sidebar",
				node: NODES.router.id,
				repo: NODES.router.id,
				entity: { kind: "change", id: change },
				mode: "enforce",
			}, viewer);
			expect(JSON.stringify(sidebar)).toContain("Advance vetoed");
			const scan = await w.stub.callTool(
				"scan",
				{
					changeId: change,
					text:
						"aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				},
				toolCtx,
				SESSION_BOUNDS,
			) as { findings: { kind: string }[] };
			expect(scan.findings.map((f) => f.kind)).toEqual(["aws-secret-key"]);
		});
	},
);
