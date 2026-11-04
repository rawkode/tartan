// The `wasm` and `wasm-bundled` runtimes end to end in Deno, with the real
// build of `rawkode.issues` (`deno task build:ext issues`): the host builds
// the facet's Worker code from the package files (shim, jco glue, core
// modules), the shim is evaluated as the facet would load it, and every call
// goes through the real component against in-memory SQLite.
// Ignored (not passed) when the package has not been built: building needs
// cargo, wasm-tools and jco.

import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { createUlid, type Manifest, parseManifest } from "@tartan/contract";
import { createMemoryStorage } from "@tartan/ext-api/testing.ts";
import { checkBundle } from "../../api/packages.ts";
import { createExtensionHost, type HostStorage } from "../host.ts";
import { migrateExtension, migrateHostTables } from "../schema.ts";
import { builtinPackageLoader, packageLoader } from "../runtime.ts";
import { builtins } from "../../../../builtins.ts";
import { viewer } from "../testing/conformance.ts";
import { createShimFacet } from "../testing/facet.ts";
import {
	createFakeInstallations,
	createFakeKernel,
	NODES,
	PRINCIPALS,
	userActor,
} from "../testing/fakes.ts";
import { manualClock, repoScopeName } from "../testing/memory.ts";
import { localBridge } from "./bridge.ts";
import { createBundledWasmLoader } from "./bundled.ts";
import { createDynamicLoader, loaderIdOf } from "./dynamic.ts";

const DIST = new URL(
	"../../../../../extensions/issues/dist/",
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
		"rawkode.issues is not built: run `deno task build:ext issues` (cargo, wasm-tools, jco)",
	);
}

const manifestOf = (f: Map<string, Uint8Array>): Manifest => {
	const parsed = parseManifest(
		JSON.parse(new TextDecoder().decode(f.get("tartan.json"))),
	);
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.manifest;
};

const REPO = NODES.router.id;

const toolCtx = (actor: string = PRINCIPALS.dev) => ({
	node: REPO,
	repo: REPO,
	scope: NODES.router.path,
	actor: userActor(actor),
	mode: "enforce" as const,
});

const bounds = {
	maxRole: 30 as const,
	scopes: null,
	nodeId: REPO,
	laneId: null,
};

const tabCtx = {
	slot: "repo.tab" as const,
	node: REPO,
	repo: REPO,
	viewer: userActor(PRINCIPALS.dev),
	mode: "enforce" as const,
	extra: { route: "issues" },
};

type IssueOut = {
	number: number;
	title: string;
	body?: string;
	project: string | null;
	state: string;
	author: { kind: string; id: string };
	closedAt: number | null;
};

type Runtime = "wasm" | "wasm-bundled";

const setup = async (runtime: Runtime) => {
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
	const installations = createFakeInstallations(manifest);
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
		}, {
			n: 2,
			name: "project",
			sql: new TextDecoder().decode(f.get("migrations/0002_project.sql")),
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
	const tool = (
		name: string,
		args: Record<string, unknown>,
		actor: string = PRINCIPALS.dev,
	) => host.callTool(name, args, toolCtx(actor), bounds);
	return { host, facet, storage, rows, clock, snapshot, tool };
};

for (const runtime of ["wasm", "wasm-bundled"] as const) {
	Deno.test({
		name:
			`${runtime}: tools create, list, get, close and reopen numbered issues`,
		ignore,
		fn: async () => {
			const t = await setup(runtime);
			t.clock.set(1_762_128_000_000);
			const first = await t.tool("create", {
				title: "  Push hangs on large packs ",
				body: "Steps: push 2 GB.",
			}) as { issue: IssueOut };
			deepStrictEqual(first.issue, {
				number: 1,
				title: "Push hangs on large packs",
				body: "Steps: push 2 GB.",
				project: null,
				state: "open",
				author: { kind: "user", id: PRINCIPALS.dev },
				createdAt: 1_762_128_000_000,
				updatedAt: 1_762_128_000_000,
				closedAt: null,
			});
			// A Reporter may open issues; numbers are per repository.
			const second = await t.tool(
				"create",
				{ title: "Docs typo" },
				PRINCIPALS.reporter,
			) as { issue: IssueOut };
			strictEqual(second.issue.number, 2);
			strictEqual(second.issue.author.id, PRINCIPALS.reporter);
			const closed = await t.tool("close", { number: 1 }) as {
				issue: IssueOut;
				changed: boolean;
			};
			strictEqual(closed.changed, true);
			strictEqual(closed.issue.state, "closed");
			ok(closed.issue.closedAt !== null);
			const again = await t.tool("close", { number: 1 }) as {
				changed: boolean;
			};
			strictEqual(again.changed, false, "closing twice is idempotent");
			const open = await t.tool("list", {}) as {
				state: string;
				issues: IssueOut[];
				open: number;
				closed: number;
			};
			strictEqual(open.state, "open");
			deepStrictEqual(open.issues.map((i) => i.number), [2]);
			strictEqual(open.issues[0].body, undefined, "list has no bodies");
			deepStrictEqual([open.open, open.closed], [1, 1]);
			const all = await t.tool("list", { state: "all", limit: 1 }) as {
				issues: IssueOut[];
			};
			deepStrictEqual(all.issues.map((i) => i.number), [2]);
			await t.tool("reopen", { number: 1 });
			const got = await t.tool("get", { number: 1 }) as { issue: IssueOut };
			strictEqual(got.issue.state, "open");
			strictEqual(got.issue.closedAt, null);
			strictEqual(got.issue.body, "Steps: push 2 GB.");
			deepStrictEqual(
				t.rows("SELECT number, state, author_id FROM issues ORDER BY number"),
				[
					{ number: 1, state: "open", author_id: PRINCIPALS.dev },
					{ number: 2, state: "open", author_id: PRINCIPALS.reporter },
				],
			);
			if (runtime === "wasm") {
				// The facet's own database; the host's holds no extension table.
				strictEqual(
					t.storage.sql.exec(
						"SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'issues'",
					).one().n,
					0,
				);
				// One loader id per installation and package.
				strictEqual(t.facet.gets[0], loaderIdOf(t.snapshot()));
				ok(
					/^x:rawkode\.issues@0\.2\.0#[0-9a-f]{16}:i_[0-9a-z]{26}$/.test(
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
			`${runtime}: tools file issues against a project and filter and scope by it`,
		ignore,
		fn: async () => {
			const t = await setup(runtime);
			const code = (want: string) => (e: unknown) =>
				(e as { code?: string }).code === want;
			const create = (title: string, project?: string) =>
				t.tool("create", {
					title,
					...(project === undefined ? {} : { project }),
				}) as Promise<{ issue: IssueOut }>;
			const list = (args: Record<string, unknown>) =>
				t.tool("list", args) as Promise<{
					project: string | null;
					issues: IssueOut[];
					open: number;
					closed: number;
				}>;
			strictEqual(
				(await create("Repo-wide")).issue.project,
				null,
				"an issue of the whole repository",
			);
			strictEqual(
				(await create("In core", "crates/core")).issue.project,
				"crates/core",
			);
			strictEqual(
				(await create("In the nested one", "crates/core/sub")).issue.project,
				"crates/core/sub",
			);
			await create("Also in core", "crates/core");

			const core = await list({ project: "crates/core", state: "all" });
			strictEqual(core.project, "crates/core");
			deepStrictEqual(core.issues.map((i) => i.number), [4, 2]);
			deepStrictEqual(core.issues.map((i) => i.project), [
				"crates/core",
				"crates/core",
			]);
			deepStrictEqual([core.open, core.closed], [2, 0]);
			const wide = await list({ state: "all" });
			strictEqual(wide.project, null);
			deepStrictEqual(wide.issues.map((i) => i.number), [4, 3, 2, 1]);
			deepStrictEqual([wide.open, wide.closed], [4, 0]);
			deepStrictEqual(
				(await list({ project: "crates/none", state: "all" })).issues,
				[],
			);

			// With a project, another's issue is not found; repo-wide reaches it.
			await rejects(
				t.tool("get", { number: 1, project: "crates/core" }),
				code("not_found"),
			);
			await rejects(
				t.tool("close", { number: 3, project: "crates/core" }),
				code("not_found"),
			);
			strictEqual(
				(await t.tool("get", { number: 2, project: "crates/core" }) as {
					issue: IssueOut;
				}).issue.project,
				"crates/core",
			);
			const closed = await t.tool("close", {
				number: 2,
				project: "crates/core",
			}) as { issue: IssueOut; changed: boolean };
			strictEqual(closed.issue.state, "closed");
			strictEqual(closed.issue.project, "crates/core");
			const stateful = await list({ project: "crates/core" });
			deepStrictEqual(stateful.issues.map((i) => i.number), [4]);
			deepStrictEqual([stateful.open, stateful.closed], [1, 1]);
			const reopened = await t.tool("reopen", { number: 2 }) as {
				issue: IssueOut;
			};
			strictEqual(reopened.issue.project, "crates/core");

			for (
				const bad of ["", "/crates", "../x", "crates//core", "crates/core/"]
			) {
				await rejects(create("Bad", bad), code("invalid"), bad);
				await rejects(list({ project: bad }), code("invalid"), bad);
			}
			await rejects(list({ project: 1 }), code("invalid"));

			// The tab's form files repo-wide issues, whatever its payload says.
			await t.host.action(
				"issues",
				"create",
				{ title: "From the tab", project: "crates/core" },
				tabCtx,
				userActor(PRINCIPALS.dev),
				bounds,
			);
			deepStrictEqual(
				t.rows("SELECT project FROM issues ORDER BY number DESC LIMIT 1"),
				[{ project: null }],
			);
			ok(
				JSON.stringify(
					await t.host.render("issues", tabCtx, viewer(PRINCIPALS.dev)),
				).includes("crates/core"),
				"the tab shows an issue's project",
			);
		},
	});

	Deno.test({
		name:
			`${runtime}: tools refuse bad input, unknown issues and a Reporter closing`,
		ignore,
		fn: async () => {
			const t = await setup(runtime);
			const code = (want: string) => (e: unknown) =>
				(e as { code?: string }).code === want;
			await rejects(t.tool("create", { title: "   " }), code("invalid"));
			await rejects(
				t.tool("create", { title: "x".repeat(201) }),
				code("invalid"),
			);
			await rejects(t.tool("get", { number: 0 }), code("invalid"));
			await rejects(t.tool("list", { state: "merged" }), code("invalid"));
			await rejects(t.tool("get", { number: 9 }), code("not_found"));
			await rejects(t.tool("reopen", { number: 9 }), code("not_found"));
			await t.tool("create", { title: "Mine" }, PRINCIPALS.reporter);
			await rejects(
				t.tool("close", { number: 1 }, PRINCIPALS.reporter),
				code("denied"),
				"close needs Developer",
			);
			strictEqual(t.rows("SELECT * FROM issues").length, 1);
		},
	});

	Deno.test({
		name:
			`${runtime}: the Issues tab lists issues and its form opens one as the viewer`,
		ignore,
		fn: async () => {
			const t = await setup(runtime);
			const empty = await t.host.render(
				"issues",
				tabCtx,
				viewer(PRINCIPALS.dev),
			);
			const emptyJson = JSON.stringify(empty);
			ok(emptyJson.includes("No issues yet"), emptyJson);
			ok(emptyJson.includes('"t":"form"'), emptyJson);
			const result = await t.host.action(
				"issues",
				"create",
				{ title: "From the tab", body: "**bold**" },
				tabCtx,
				userActor(PRINCIPALS.dev),
				bounds,
			);
			deepStrictEqual(result, {
				v: 1,
				toast: { tone: "success", text: "Opened #1" },
				refresh: ["issues"],
			});
			const refused = await t.host.action(
				"issues",
				"create",
				{ title: "" },
				tabCtx,
				userActor(PRINCIPALS.dev),
				bounds,
			);
			deepStrictEqual(refused, {
				v: 1,
				toast: { tone: "danger", text: "title is required" },
			});
			deepStrictEqual(
				t.rows("SELECT number, title, author_kind, author_id FROM issues"),
				[{
					number: 1,
					title: "From the tab",
					author_kind: "user",
					author_id: PRINCIPALS.dev,
				}],
			);
			const tab = await t.host.render(
				"issues",
				tabCtx,
				viewer(PRINCIPALS.dev),
			);
			const json = JSON.stringify(tab);
			ok(json.includes("From the tab"), json);
			ok(json.includes('"#1"'), json);
			ok(!json.includes("error-chip"), json);
		},
	});
}

Deno.test({
	name: "migration 0002 adds project to a database that already has issues",
	ignore,
	fn: () => {
		const f = files!;
		const sql = (n: string) =>
			new TextDecoder().decode(f.get(`migrations/${n}.sql`));
		const init = { n: 1, name: "init", sql: sql("0001_init") };
		const project = { n: 2, name: "project", sql: sql("0002_project") };
		const storage = createMemoryStorage();
		migrateHostTables(storage, manualClock());
		deepStrictEqual(
			migrateExtension(storage, [init], manualClock()),
			[1],
		);
		storage.sql.exec(
			"INSERT INTO issues (number, title, author_kind, author_id, created_at, updated_at) VALUES (1, 'old', 'user', 'u', 1, 1)",
		);
		deepStrictEqual(
			migrateExtension(storage, [init, project], manualClock()),
			[2],
			"only the new migration runs",
		);
		deepStrictEqual(
			storage.sql.exec("SELECT number, title, project FROM issues").toArray(),
			[{ number: 1, title: "old", project: null }],
		);
	},
});

Deno.test({
	name: "wasm: migrations run once in the facet; abort restarts the component",
	ignore,
	fn: async () => {
		const t = await setup("wasm");
		await t.tool("create", { title: "one" });
		await t.tool("create", { title: "two" });
		deepStrictEqual(
			t.rows("SELECT n, name FROM _ext_migrations"),
			[{ n: 1, name: "init" }, { n: 2, name: "project" }],
		);
		strictEqual(t.facet.loads(), 1);
		await t.host.abort("upgrade");
		const third = await t.tool("create", { title: "three" }) as {
			issue: IssueOut;
		};
		strictEqual(t.facet.loads(), 2, "a fresh facet after abort");
		strictEqual(third.issue.number, 3, "the data outlives the component");
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
