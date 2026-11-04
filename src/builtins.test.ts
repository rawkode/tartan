// Every `extensions/**/tartan.json` is a valid
// manifest (zod + normative JSON Schema + policy), `src/builtins.ts` maps every
// builtin id to the module in `extensions/<dir>/src/index.ts`, the embedded
// migrations and protocol cards match the package files and the migrations
// apply cleanly to SQLite, and the M0 stub modules implement exactly the hooks
// their manifests declare.

import {
	deepStrictEqual,
	equal,
	ok,
	rejects,
	strictEqual,
} from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
	type ExtCtx,
	type ExtensionModule,
	GateDecisionSchema,
	INTERFACE_IDS,
	isTartanError,
	type Manifest,
	manifestPolicyIssues,
	parseManifest,
	type SlotContext,
	SLOTS,
	validateUi,
} from "@tartan/contract";
import { loadSchema } from "../packages/contract/test/helpers.ts";
import { LEGACY_SOURCES } from "./kernel/exthost/host/testing/legacy-builtins.ts";
import {
	BUILTIN_SOURCES,
	builtins,
	type BuiltinSource,
	checkBuiltin,
	createBuiltinRegistry,
	migrationPath,
} from "./builtins.ts";

const EXTENSIONS = new URL("../extensions/", import.meta.url);
const SKIP_DIRS = new Set(["node_modules", "dist", "target", "src"]);

type Found = {
	readonly dir: string;
	readonly raw: Record<string, unknown>;
	readonly manifest: Manifest;
};

/** Every `tartan.json` under `extensions/`, nested pack manifests included. */
const findManifests = async (dir = ""): Promise<string[]> => {
	const found: string[] = [];
	const root = new URL(dir, EXTENSIONS);
	if (dir === "" && !(await Deno.stat(root).then(() => true, () => false))) {
		return found;
	}
	for await (const entry of Deno.readDir(new URL(dir, EXTENSIONS))) {
		if (entry.isFile && entry.name === "tartan.json") {
			found.push(dir.replace(/\/$/, ""));
		} else if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
			found.push(...(await findManifests(`${dir}${entry.name}/`)));
		}
	}
	return found.sort();
};

const readText = (dir: string, path: string): Promise<string> =>
	Deno.readTextFile(new URL(`${dir}/${path}`, EXTENSIONS));

const exists = async (dir: string, path: string): Promise<boolean> => {
	try {
		return (await Deno.stat(new URL(`${dir}/${path}`, EXTENSIONS))).isFile;
	} catch {
		return false;
	}
};

const loadAll = async (): Promise<Found[]> =>
	await Promise.all((await findManifests()).map(async (dir) => {
		const raw = JSON.parse(await readText(dir, "tartan.json"));
		const parsed = parseManifest(raw);
		ok(parsed.ok, `${dir}: ${parsed.ok ? "" : parsed.errors.join("; ")}`);
		return { dir, raw, manifest: parsed.manifest };
	}));

const found = await loadAll();
const bundled = found.filter((f) => f.manifest.runtime === "builtin");

/**
 * `extensions/<dir>/src/index.ts` of a package: the Swarm pack uses the
 * card-less `packs/src`; the Classic pack has its own module for its card.
 */
const moduleDir = (dir: string): string =>
	dir === "packs/swarm" ? "packs" : dir;

// A pattern `p` covers event pattern `q` when every type `q` matches, `p` matches.
const covers = (p: string, q: string): boolean =>
	p === "*" || p === q || (p.endsWith(".*") && q.startsWith(p.slice(0, -1)));

const NO_CTX = undefined as unknown as ExtCtx;
const SLOT_CTX: SlotContext = {
	node: "01k6aaaaaaaaaaaaaaaaaaaaaa",
	mode: "enforce",
};

Deno.test("every package under extensions/ is listed here", () => {
	deepStrictEqual(found.map((f) => f.manifest.id).sort(), ["rawkode.issues"]);
});

Deno.test("extensions/**/tartan.json validate: JSON Schema, zod and policy", async () => {
	const schema = await loadSchema("schema/manifest-1.json");
	for (const { dir, raw, manifest } of found) {
		const json = schema(raw);
		ok(json.valid, `${dir} (json schema): ${json.errors.join("; ")}`);
		const isBundled = manifest.id.startsWith("tartan.");
		deepStrictEqual(
			manifestPolicyIssues(manifest, { bundled: isBundled }),
			[],
			`${dir} policy`,
		);
		equal(manifest.version, "0.2.0", `${dir} version`);
	}
});

Deno.test("manifests: slots, events and interfaces are consistent", () => {
	for (const { dir, manifest: m } of found) {
		for (const slot of m.contributes?.slots ?? []) {
			const kind = SLOTS[slot.slot as keyof typeof SLOTS].kind;
			equal(
				slot.dynamic,
				kind === "dynamic",
				`${dir} ${slot.slot}#${slot.id}: dynamic must match slot kind ${kind}`,
			);
			if (kind === "static+route") {
				ok(slot.route, `${dir} ${slot.slot}#${slot.id}: needs a route`);
			}
			if (slot.cache === "role") {
				equal(
					slot.slot,
					"hud.metric",
					`${dir}: cache 'role' only on hud.metric`,
				);
			}
		}
		const reads = m.permissions["events.read"] ?? [];
		for (const sub of m.subscribe ?? []) {
			ok(
				reads.some((p) => covers(p, sub.event)),
				`${dir}: subscription ${sub.event} not covered by permissions.events.read`,
			);
		}
		const known = new Set<string>(INTERFACE_IDS);
		for (
			const ref of [
				...(m.requires ?? []),
				...(m.permissions["interfaces.call"] ?? []),
			]
		) {
			ok(known.has(ref), `${dir}: unknown interface ${ref}`);
		}
		const toolNames = (m.contributes?.tools ?? []).map((t) => t.name);
		for (const name of toolNames) {
			ok(
				!INTERFACE_IDS.some((i) => name.startsWith(`${i.split("@")[0]}_`)),
				`${dir}: ${name} looks like an interface tool; interface tools come from provides`,
			);
		}
	}
});

Deno.test("builtins.ts maps every bundled manifest to its extension module", async () => {
	deepStrictEqual(
		[...builtins.ids].sort(),
		bundled.map((f) => f.manifest.id).sort(),
		"registry ids == bundled manifests on disk",
	);
	ok(!builtins.has("rawkode.issues"), "third-party wasm is not bundled");
	for (const { dir, manifest } of bundled) {
		const pkg = builtins.get(manifest.id);
		ok(pkg, `${manifest.id} registered`);
		equal(pkg.manifest.entry.builtin, manifest.id);
		deepStrictEqual(
			pkg.manifest,
			manifest,
			`${dir}: registry manifest == file`,
		);
		const mod = await import(
			new URL(`${moduleDir(dir)}/src/index.ts`, EXTENSIONS).href
		);
		strictEqual(
			pkg.module,
			mod.extension,
			`${dir}: module is the extension export`,
		);
		strictEqual(mod.default, mod.extension, `${dir}: default export`);
		strictEqual(pkg.migrations, mod.migrations, `${dir}: migrations export`);
		strictEqual(pkg.protocol, mod.protocol, `${dir}: protocol export`);
		strictEqual(
			pkg.settingsCue,
			mod.settingsCue,
			`${dir}: settingsCue export`,
		);
	}
	equal(builtins.all().length, builtins.ids.length);
});

Deno.test("embedded migrations and protocol cards match the package files", async () => {
	for (const src of BUILTIN_SOURCES) {
		const m = builtins.get((src.manifest as { id: string }).id)!.manifest;
		for (const mig of src.migrations) {
			const path = migrationPath(mig);
			ok(await exists(src.dir, path), `${src.dir}/${path} exists`);
			equal(mig.sql, await readText(src.dir, path), `${src.dir}/${path} drift`);
		}
		if (m.config?.cue) {
			const cue = await readText(src.dir, m.config.cue);
			equal(src.settingsCue, cue, `${src.dir}/${m.config.cue} drift`);
		}
		if (m.contributes?.protocol) {
			const card = await readText(src.dir, m.contributes.protocol);
			equal(src.protocol, card, `${src.dir}/${m.contributes.protocol} drift`);
			ok(
				new TextEncoder().encode(card).length <= 2048,
				`${src.dir}: card ≤ 2 KB`,
			);
		}
	}
	// Non-bundled packages ship their own files at publish time
	// (rawkode.issues: migrations/0001_init.sql and protocol.md, checked by
	// `checkBundle` when it is built).
});

Deno.test("builtin migrations apply in order to a fresh SQLite database", () => {
	for (const pkg of builtins.all()) {
		const db = new DatabaseSync(":memory:");
		try {
			for (const mig of pkg.migrations) db.exec(mig.sql);
			if (pkg.manifest.kind === "extension") {
				const tables = db.prepare(
					"SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'",
				).get() as { n: number };
				ok(tables.n > 0, `${pkg.manifest.id}: migrations create tables`);
			}
			const reserved = db.prepare(
				"SELECT name FROM sqlite_master WHERE name LIKE '\\_%' ESCAPE '\\'",
			).all();
			deepStrictEqual(
				reserved,
				[],
				`${pkg.manifest.id}: _* names are host-reserved`,
			);
		} finally {
			db.close();
		}
	}
});

const declaredHooks = (m: Manifest): Set<keyof ExtensionModule> => {
	const hooks = new Set<keyof ExtensionModule>();
	if ((m.subscribe?.length ?? 0) > 0) hooks.add("onEvent");
	if ((m.gates?.length ?? 0) > 0) hooks.add("gate");
	if ((m.echo?.length ?? 0) > 0) hooks.add("echo");
	if ((m.contributes?.slots?.length ?? 0) > 0) hooks.add("render");
	if ((m.contributes?.context?.length ?? 0) > 0) hooks.add("context");
	if (
		(m.contributes?.tools?.length ?? 0) > 0 || (m.provides?.length ?? 0) > 0
	) {
		hooks.add("callTool");
	}
	return hooks;
};

/**
 * Builtins whose owning WP replaced the M0 stub; they keep the hook check and
 * test their behaviour in their own packages (WP12: work, changes, board;
 * WP13: radar; WP14: ci, review; WP15: weave, fifo).
 */
const IMPLEMENTED_BUILTINS: ReadonlySet<string> = new Set([
	"tartan.work",
	"tartan.changes",
	"tartan.board",
	"tartan.radar",
	"tartan.ci",
	"tartan.review",
	"tartan.weave",
	"tartan.fifo",
	"tartan.hud",
]);

Deno.test("stub modules implement exactly the declared hooks, as no-ops", async () => {
	for (const pkg of builtins.all()) {
		const { manifest: m, module: mod } = pkg;
		const id = m.id;
		const declared = declaredHooks(m);
		for (
			const hook of [
				"onEvent",
				"gate",
				"echo",
				"render",
				"context",
				"callTool",
			] as const
		) {
			equal(
				hook in mod,
				declared.has(hook),
				`${id}: ${hook} implemented iff declared`,
			);
		}
		if (m.kind === "pack") {
			deepStrictEqual(Object.keys(mod), [], `${id}: packs carry no code`);
			continue;
		}
		if (IMPLEMENTED_BUILTINS.has(id)) continue;
		ok(mod.init, `${id}: init`);
		await mod.init(NO_CTX);
		for (const slot of m.contributes?.slots ?? []) {
			const doc = await mod.render!(slot.id, SLOT_CTX, {}, NO_CTX);
			const checked = validateUi(doc);
			ok(
				checked.ok,
				`${id} render ${slot.id}: ${
					checked.ok ? "" : checked.errors.join("; ")
				}`,
			);
		}
		if (mod.context) {
			deepStrictEqual(await mod.context(undefined as never, NO_CTX), []);
		}
		if (mod.echo) {
			deepStrictEqual(
				await mod.echo(undefined as never, { truncated: false }, NO_CTX),
				[],
			);
		}
		if (mod.gate) {
			const decision = await mod.gate(
				"ref.advance",
				undefined as never,
				NO_CTX,
			);
			ok(
				GateDecisionSchema.safeParse(decision).success,
				`${id}: gate decision shape`,
			);
		}
		if (mod.callTool) {
			await rejects(
				mod.callTool("anything", {}, undefined as never, NO_CTX),
				(e: unknown) => isTartanError(e) && e.code === "not_implemented",
				`${id}: tools fail with not_implemented`,
			);
		}
	}
});

Deno.test("the registry rejects broken packages", () => {
	const good = LEGACY_SOURCES.find((s) => s.dir === "weave")!;
	const raw = good.manifest as Record<string, unknown>;
	const variants: [string, BuiltinSource][] = [
		["wrong entry", {
			...good,
			manifest: { ...raw, entry: { builtin: "tartan.fifo" } },
		}],
		["missing migration", { ...good, migrations: [] }],
		["undeclared card", { ...good, protocol: undefined }],
		["undeclared settings", { ...good, settingsCue: undefined }],
		["non-bundled id", { ...good, manifest: { ...raw, id: "acme.weave" } }],
		["invalid manifest", {
			...good,
			manifest: { ...raw, api: "tartan:ext@9" },
		}],
	];
	for (const [label, src] of variants) {
		equal(checkBuiltin(src).ok, false, label);
	}
	let threw = false;
	try {
		createBuiltinRegistry([good, good]);
	} catch (e) {
		threw = isTartanError(e) && e.code === "internal";
	}
	ok(threw, "duplicate ids throw");
	threw = false;
	try {
		createBuiltinRegistry(LEGACY_SOURCES.filter((s) => s.dir !== "board"));
	} catch (e) {
		threw = isTartanError(e) && /tartan\.board/.test(e.message);
	}
	ok(threw, "a pack member missing from the bundle throws");
});
