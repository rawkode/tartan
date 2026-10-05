// The `wasm` and `wasm-bundled` runtimes end to end in Deno, with the real
// build of `acme.no-secrets` (`deno task build:ext acme-no-secrets`): the
// host builds the facet's Worker code from the package files (shim, jco
// glue, core modules), the shim is evaluated as the facet would load it, and
// every call goes through the real component against in-memory SQLite.
// Ignored (not passed) when the package has not been built: building needs
// cargo, wasm-tools and jco.

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import {
	createUlid,
	type Envelope,
	type GateDecision,
	type Manifest,
	parseManifest,
	type RefAdvanceGateInput,
} from "@tartan/contract";
import { createMemoryStorage } from "@tartan/ext-api/testing.ts";
import { checkBundle } from "../../api/packages.ts";
import { runGateReplay } from "../../api/replay.ts";
import type { GateReplayRow } from "@tartan/contract/kernel.ts";
import { createExtensionHost, type HostStorage } from "../host.ts";
import { builtinPackageLoader, packageLoader } from "../runtime.ts";
import { builtins } from "../../../../builtins.ts";
import { viewer } from "../testing/conformance.ts";
import { createShimFacet } from "../testing/facet.ts";
import {
	createFakeInstallations,
	createFakeKernel,
	LANE_ID,
	NODES,
	PRINCIPALS,
	userActor,
} from "../testing/fakes.ts";
import { manualClock, repoScopeName } from "../testing/memory.ts";
import { localBridge } from "./bridge.ts";
import { createBundledWasmLoader } from "./bundled.ts";
import { createDynamicLoader, loaderIdOf } from "./dynamic.ts";

const DIST = new URL(
	"../../../../../extensions/acme-no-secrets/dist/",
	import.meta.url,
);

const readDist = async (): Promise<Map<string, Uint8Array> | null> => {
	try {
		const body = JSON.parse(
			await Deno.readTextFile(new URL("publish.json", DIST)),
		) as { manifest: unknown; files: Record<string, string> };
		return new Map([
			...Object.entries(body.files).map((
				[p, b64],
			) => [p, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))] as const),
			["tartan.json", new TextEncoder().encode(JSON.stringify(body.manifest))],
		]);
	} catch {
		return null;
	}
};

const b64 = (bytes: Uint8Array): string => {
	let text = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(text);
};

const files = await readDist();
const built = files !== null;
const ignore = !built;
if (!built) {
	console.warn(
		"acme-no-secrets is not built: run `deno task build:ext acme-no-secrets` (cargo, wasm-tools, jco)",
	);
}

const manifestOf = (f: Map<string, Uint8Array>): Manifest => {
	const parsed = parseManifest(
		JSON.parse(new TextDecoder().decode(f.get("tartan.json"))),
	);
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.manifest;
};

// AWS's documented example credentials (not real keys).
const ACCESS = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const CHANGE = "ch_01k60000000000000000000901";

const gateInput = (
	lines: { path: string; line: number; text: string }[],
	extra: Partial<RefAdvanceGateInput> = {},
): RefAdvanceGateInput => ({
	point: "ref.advance",
	repo: NODES.router.id,
	ref: "refs/heads/main",
	base: "a".repeat(40),
	head: "b".repeat(40),
	changeId: CHANGE,
	changedPaths: [...new Set(lines.map((l) => l.path))],
	addedLines: lines,
	truncated: false,
	workRefs: [],
	actor: userActor(PRINCIPALS.dev),
	...extra,
});

const LEAKY = [
	{ path: "config/prod.env", line: 1, text: `AWS_ACCESS_KEY_ID=${ACCESS}` },
	{ path: "config/prod.env", line: 2, text: `AWS_SECRET_ACCESS_KEY=${SECRET}` },
	{ path: "src/app.ts", line: 9, text: "export const x = 1;" },
];

const GATE_CTX = {
	node: NODES.router.id,
	repo: NODES.router.id,
	mode: "enforce" as const,
};

const changeCtx = {
	slot: "change.sidebar" as const,
	node: NODES.router.id,
	repo: NODES.router.id,
	entity: { kind: "change", id: CHANGE },
	mode: "enforce" as const,
};

type Runtime = "wasm" | "wasm-bundled";

const setup = async (
	runtime: Runtime,
	config: Record<string, unknown> = {},
) => {
	const f = files!;
	const manifest = manifestOf(f);
	const clock = manualClock();
	const storage = createMemoryStorage();
	const kernel = createFakeKernel();
	const checked = checkBundle({
		manifest: JSON.parse(new TextDecoder().decode(f.get("tartan.json"))),
		files: Object.fromEntries(
			[...f].map(([p, b]) => [p, b64(b)]),
		),
	});
	const installations = createFakeInstallations(manifest, { config });
	installations.set((s) => ({ ...s, sha256: checked.sha256 }));
	const facet = createShimFacet();
	const dynamic = createDynamicLoader({
		enabled: runtime === "wasm",
		facets: facet.port,
		files: () => (path) => Promise.resolve(f.get(path) ?? null),
		bridge: localBridge,
		clock,
	});
	const glueUrl = `data:text/javascript,${
		encodeURIComponent(new TextDecoder().decode(f.get("ext.js")))
	}`;
	const { instantiate } = await import(glueUrl);
	const bundled = createBundledWasmLoader([{
		manifest,
		sha256: checked.sha256,
		instantiate,
		cores: Object.fromEntries(
			(manifest.entry.wasm ?? []).map((
				p,
			) => [p, new WebAssembly.Module(new Uint8Array(f.get(p)!))]),
		),
		migrations: [{
			n: 1,
			name: "init",
			sql: new TextDecoder().decode(f.get("migrations/0001_init.sql")),
		}],
	}], clock);
	const host = createExtensionHost({
		name: repoScopeName(),
		storage: storage as unknown as HostStorage,
		clock,
		ids: { ulid: createUlid({ now: clock.now }) },
		kernel: kernel.ports,
		installations,
		packages: packageLoader({
			builtin: builtinPackageLoader(builtins),
			dynamic,
			wasmBundled: bundled,
			dynamicEnabled: runtime === "wasm",
		}),
		budgets: { hold: 50 },
	});
	await host.ready();
	/** The extension's own tables: the facet's database, or the host's. */
	const ext = runtime === "wasm" ? facet.storage : storage;
	const rows = (sql: string) => ext.sql.exec(sql).toArray();
	const snapshot = () => installations.snapshot!;
	return { host, kernel, facet, storage, ext, rows, manifest, clock, snapshot };
};

for (const runtime of ["wasm", "wasm-bundled"] as const) {
	Deno.test({
		name:
			`${runtime}: the ref.advance gate vetoes added credentials and records them`,
		ignore,
		fn: async () => {
			const t = await setup(runtime);
			const decision = await t.host.gate(
				"ref.advance",
				gateInput(LEAKY),
				GATE_CTX,
			);
			strictEqual(decision.decision, "veto");
			ok(
				decision.message.startsWith(
					"3 credentials added: .env file at config/prod.env:1",
				),
				decision.message,
			);
			strictEqual(decision.fullScan, true);
			deepStrictEqual(
				decision.annotations?.map((a) => `${a.path}:${a.line}`),
				["config/prod.env:1", "config/prod.env:1", "config/prod.env:2"],
			);
			ok(!JSON.stringify(decision).includes(ACCESS), "masked");
			const findings = t.rows(
				"SELECT kind, masked, source, change_id FROM findings ORDER BY line, kind",
			);
			deepStrictEqual(findings.map((r) => r.kind), [
				"aws-access-key",
				"env-file",
				"aws-secret-key",
			]);
			ok(findings.every((r) => r.change_id === CHANGE && r.source === "gate"));
			deepStrictEqual(
				t.rows("SELECT point, verdict FROM decisions"),
				[{ point: "ref.advance", verdict: "veto" }],
			);
			if (runtime === "wasm") {
				// The facet's own database; the host's holds no extension table.
				strictEqual(
					t.storage.sql.exec(
						"SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'findings'",
					).one().n,
					0,
				);
				// One loader id per installation and package.
				strictEqual(t.facet.gets[0], loaderIdOf(t.snapshot()));
				ok(
					/^x:acme\.no-secrets@0\.1\.0#[0-9a-f]{16}:i_[0-9a-z]{26}$/.test(
						t.facet.gets[0],
					),
				);
				const code = t.facet.codes[0];
				strictEqual(code.mainModule, "shim.js");
				strictEqual(code.globalOutbound, null);
				deepStrictEqual(code.env, {});
				deepStrictEqual(Object.keys(code.modules).sort(), [
					"ext.core.wasm",
					"ext.core2.wasm",
					"ext.core3.wasm",
					"ext.js",
					"shim.js",
				]);
			}
		},
	});

	Deno.test({
		name:
			`${runtime}: a clean change is allowed; truncated and clean is left to onTruncated`,
		ignore,
		fn: async () => {
			const t = await setup(runtime);
			const clean = await t.host.gate(
				"ref.advance",
				gateInput([{ path: "README.md", line: 1, text: "hello" }]),
				GATE_CTX,
			);
			deepStrictEqual(
				clean,
				{
					decision: "allow",
					message: "no credentials in 1 added line",
				} satisfies GateDecision,
			);
			const truncated = await t.host.gate(
				"ref.advance",
				gateInput([{ path: "README.md", line: 1, text: "hello" }], {
					truncated: true,
				}),
				GATE_CTX,
			);
			strictEqual(truncated.decision, "allow");
			strictEqual(truncated.fullScan, undefined);
		},
	});

	Deno.test({
		name: `${runtime}: a gate replay is advisory and writes nothing`,
		ignore,
		fn: async () => {
			const t = await setup(runtime);
			const d = await t.host.gate(
				"ref.advance",
				gateInput(LEAKY, { advisory: true }),
				GATE_CTX,
			);
			strictEqual(d.decision, "veto");
			strictEqual(t.rows("SELECT * FROM findings").length, 0);
			strictEqual(t.rows("SELECT * FROM decisions").length, 0);
		},
	});

	Deno.test({
		name:
			`${runtime}: the push echo warns with remote: lines and stores the lane's findings`,
		ignore,
		fn: async () => {
			const t = await setup(runtime);
			const ev = t.kernel.addEvent(NODES.router.id, {
				type: "push.accepted",
				data: {
					pushId: "p_01k60000000000000000000001",
					target: LANE_ID,
					ref: `refs/heads/lanes/${LANE_ID}`,
					before: "a".repeat(40),
					after: "b".repeat(40),
					via: "gateway",
				},
			}) as Envelope;
			const echo = await t.host.echo(ev, {
				addedLines: LEAKY,
				truncated: false,
			});
			strictEqual(echo.timedOut, false);
			strictEqual(echo.lines.length, 4);
			ok(
				echo.lines[0].startsWith(
					"[no-secrets] .env file at config/prod.env:1 (prod.env)",
				),
				echo.lines[0],
			);
			ok(echo.lines.every((l) => !l.includes(ACCESS) && !l.includes(SECRET)));
			deepStrictEqual(
				t.rows("SELECT DISTINCT lane_id, source FROM findings"),
				[{ lane_id: LANE_ID, source: "echo" }],
			);
			// The same push again stores each finding once.
			await t.host.echo(ev, { addedLines: LEAKY, truncated: false });
			strictEqual(t.rows("SELECT * FROM findings").length, 3);
			const quiet = await t.host.echo(ev, {
				addedLines: [{ path: "a.ts", line: 1, text: "ok" }],
				truncated: false,
			});
			deepStrictEqual(quiet.lines, []);
		},
	});

	Deno.test({
		name:
			`${runtime}: the sidebar, the gate chip and the repo tab render from the records`,
		ignore,
		fn: async () => {
			const t = await setup(runtime);
			const pending = await t.host.render(
				"no-secrets",
				{ ...changeCtx, slot: "change.gate" },
				viewer(PRINCIPALS.dev),
			);
			deepStrictEqual(pending.root, {
				t: "badge",
				text: "no-secrets: pending",
				tone: "muted",
			});
			await t.host.gate("ref.advance", gateInput(LEAKY), GATE_CTX);
			const sidebar = await t.host.render(
				"findings",
				changeCtx,
				viewer(PRINCIPALS.dev),
			);
			strictEqual(sidebar.root.t, "section");
			const json = JSON.stringify(sidebar);
			ok(json.includes("Advance vetoed"), json);
			ok(json.includes("AKIA…MPLE"), json);
			deepStrictEqual(sidebar.refreshOn, ["gate.decided"]);
			const chip = await t.host.render(
				"no-secrets",
				{ ...changeCtx, slot: "change.gate" },
				viewer(PRINCIPALS.dev),
			);
			deepStrictEqual(chip.root, {
				t: "badge",
				text: "no-secrets: 3 credentials",
				tone: "danger",
			});
			const tab = await t.host.render(
				"secrets",
				{
					slot: "repo.tab",
					node: NODES.router.id,
					repo: NODES.router.id,
					mode: "enforce",
					extra: { route: "secrets" },
				},
				viewer(PRINCIPALS.dev),
			);
			ok(JSON.stringify(tab).includes("config/prod.env"));
			ok(!JSON.stringify(tab).includes("error-chip"));
		},
	});

	Deno.test({
		name:
			`${runtime}: the scan tool reports a change's findings and scans snippets`,
		ignore,
		fn: async () => {
			const t = await setup(runtime);
			await t.host.gate("ref.advance", gateInput(LEAKY), GATE_CTX);
			const ctx = {
				node: NODES.router.id,
				repo: NODES.router.id,
				scope: "acme/router",
				actor: userActor(PRINCIPALS.dev),
				mode: "enforce" as const,
			};
			const bounds = {
				maxRole: 30 as const,
				scopes: null,
				nodeId: NODES.router.id,
				laneId: null,
			};
			const stored = await t.host.callTool(
				"scan",
				{ changeId: CHANGE },
				ctx,
				bounds,
			) as { clean: boolean; verdict: string; findings: unknown[] };
			strictEqual(stored.clean, false);
			strictEqual(stored.verdict, "veto");
			strictEqual(stored.findings.length, 3);
			const snippet = await t.host.callTool(
				"scan",
				{ changeId: CHANGE, text: `key: ${ACCESS}\n`, path: "deploy.yaml" },
				ctx,
				bounds,
			) as { findings: { path: string; line: number; value: string }[] };
			deepStrictEqual(snippet.findings, [{
				path: "deploy.yaml",
				line: 1,
				kind: "aws-access-key",
				value: "AKIA…MPLE",
			}]);
		},
	});

	Deno.test({
		name: `${runtime}: allow globs from the installation config skip fixtures`,
		ignore,
		fn: async () => {
			const fixture = [{
				path: "fixtures/aws.env",
				line: 1,
				text: `KEY=${ACCESS}`,
			}];
			const strict = await setup(runtime);
			strictEqual(
				(await strict.host.gate("ref.advance", gateInput(fixture), GATE_CTX))
					.decision,
				"veto",
			);
			const allowing = await setup(runtime, { allow: ["fixtures/**"] });
			deepStrictEqual(
				await allowing.host.gate("ref.advance", gateInput(fixture), GATE_CTX),
				{ decision: "allow", message: "no credentials in 1 added line" },
			);
		},
	});
}

Deno.test({
	name: "wasm: migrations run once in the facet; abort restarts the component",
	ignore,
	fn: async () => {
		const t = await setup("wasm");
		await t.host.gate("ref.advance", gateInput(LEAKY), GATE_CTX);
		await t.host.gate("ref.advance", gateInput(LEAKY), GATE_CTX);
		deepStrictEqual(
			t.rows("SELECT n, name FROM _ext_migrations"),
			[{ n: 1, name: "init" }],
		);
		strictEqual(t.facet.loads(), 1);
		await t.host.abort("upgrade");
		await t.host.gate("ref.advance", gateInput(LEAKY), GATE_CTX);
		strictEqual(t.facet.loads(), 2, "a fresh facet after abort");
		strictEqual(t.rows("SELECT * FROM decisions").length, 3);
	},
});

Deno.test({
	name:
		"wasm: the published bundle passes checkBundle; a tampered import record is rejected",
	ignore,
	fn: () => {
		const f = files!;
		const body = (over: Record<string, Uint8Array> = {}) => ({
			manifest: JSON.parse(new TextDecoder().decode(f.get("tartan.json"))),
			files: Object.fromEntries(
				[...f, ...Object.entries(over)].map((
					[p, b],
				) => [p, b64(b)]),
			),
		});
		ok(checkBundle(body()).sha256.length === 64);
		const fewer = new TextEncoder().encode(
			JSON.stringify(["tartan:ext/sql@0.1.0#exec"]),
		);
		try {
			checkBundle(body({ "imports.json": fewer }));
			throw new Error("accepted");
		} catch (error) {
			const issues = (error as { details?: { issues?: string[] } }).details
				?.issues ?? [];
			ok(
				issues.some((i) => i.startsWith("imports.json does not match")),
				JSON.stringify(issues),
			);
		}
	},
});

Deno.test({
	name:
		"wasm: a shadow replay of acme.no-secrets over 41 seeded advances would have vetoed 2",
	ignore,
	fn: async () => {
		const t = await setup("wasm");
		const repo = NODES.router.id;
		const advances = Array.from({ length: 41 }, (_, i) => ({
			id: `adv_${i}`,
			batchId: `lb_01k6${String(i).padStart(22, "0")}`,
			attempt: 0,
			ref: "refs/heads/main",
			expectOld: i.toString(16).padStart(40, "0"),
			newSha: (i + 1).toString(16).padStart(40, "0"),
			ownerInstance: "w",
			leaseUntil: 0,
			step: "refs-pushed" as const,
			state: "done" as const,
			evidenceReused: false,
			createdAt: i,
		})).reverse();
		const leaky = new Set([12, 33]);
		const linesOf = (head: string) => {
			const i = parseInt(head, 16) - 1;
			return leaky.has(i)
				? [{
					path: "deploy/prod.env",
					line: 4,
					text: `AWS_ACCESS_KEY_ID=${ACCESS}`,
				}]
				: [{ path: `src/m${i}.ts`, line: 1, text: "export const ok = true;" }];
		};
		const replays = new Map<string, GateReplayRow>();
		const installation = t.snapshot().installation;
		const out = await runGateReplay({
			land: () => ({
				advances: () => Promise.resolve({ advances }),
				recordReplay: (r) => {
					replays.set(r.id, {
						id: r.id,
						installation_id: r.installationId,
						advances_json: "[]",
						results_json: JSON.stringify(r.results),
						state: r.state,
						created_at: 0,
					});
					return Promise.resolve();
				},
				replay: (id) => Promise.resolve(replays.get(id) ?? null),
			}),
			probe: () => ({
				addedLines: (_s, _b, head) =>
					Promise.resolve({ lines: linesOf(head), truncated: false }),
				diffPaths: (_s, _b, head) =>
					Promise.resolve({
						paths: linesOf(head).map((l) => ({ path: l.path })),
						truncated: false,
					} as never),
			}),
			ext: () => t.host,
		}, {
			installation: { ...installation, mode: "shadow" },
			manifest: t.manifest,
			repoId: repo,
			n: 41,
			replayId: "gr_01k60000000000000000000001",
		});
		deepStrictEqual(out.summary, { vetoed: 2, of: 41 });
		deepStrictEqual(
			out.results.filter((r) => r.decision === "veto").map((r) => r.advanceId),
			["adv_33", "adv_12"],
		);
		// Advisory: the replay recorded nothing in the extension's own tables.
		strictEqual(t.rows("SELECT * FROM decisions").length, 0);
		strictEqual(replays.get("gr_01k60000000000000000000001")?.state, "done");
	},
});
