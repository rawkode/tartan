// tartan.pack.swarm and tartan.pack.classic: installing a
// pack must not hand a node M0 stubs that show "not implemented yet" panels,
// dead actions, tools that always fail or a `*` event drain. A stub may stay a
// member only while its manifest declares no surface at all.
//
// Member manifests are read from disk, not imported: an extension imports only
// its own files (`scripts/check-imports.ts`).

import {
	type Manifest,
	manifestPolicyIssues,
	parseManifest,
	RESERVED_TOOL_NAMES,
} from "@tartan/contract";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	extension as classicModule,
	migrations as classicMigrations,
	protocol as classicCard,
} from "../classic/src/index.ts";
import classicJson from "../classic/tartan.json" with { type: "json" };
import swarmJson from "../swarm/tartan.json" with { type: "json" };

/**
 * First-party builtins that are still M0 stubs (no owning WP has replaced
 * them; compare `IMPLEMENTED_BUILTINS` in `src/builtins.test.ts`). Drop an id
 * here when its implementation lands.
 */
const M0_STUBS: ReadonlySet<string> = new Set([
	"tartan.epics",
]);

const parsed = (raw: unknown, what: string): Manifest => {
	const r = parseManifest(raw);
	if (!r.ok) throw new Error(`${what}: ${r.errors.join("; ")}`);
	return r.manifest;
};

const PACKS: readonly Manifest[] = [
	parsed(swarmJson, "swarm"),
	parsed(classicJson, "classic"),
];

/** `tartan.weave` → `extensions/weave/tartan.json`. */
const memberManifest = async (id: string): Promise<Manifest> => {
	const dir = id.replace(/^tartan\./, "");
	const url = new URL(`../../${dir}/tartan.json`, import.meta.url);
	return parsed(JSON.parse(await Deno.readTextFile(url)), id);
};

/** Everything an installation exposes or reacts to (slots, tools, events…). */
const surface = (m: Manifest): string[] => [
	...(m.provides ?? []).map((i) => `provides ${i}`),
	...(m.subscribe ?? []).map((s) => `subscribe ${s.event}`),
	...(m.gates ?? []).map((g) => `gate ${g.point}`),
	...(m.echo ?? []).map((e) => `echo ${e.event}`),
	...(m.contributes?.slots ?? []).map((s) => `slot ${s.slot}#${s.id}`),
	...(m.contributes?.tools ?? []).map((t) => `tool ${t.name}`),
	...(m.contributes?.context ?? []).map((c) => `context ${c.id}`),
	...(m.contributes?.settings === undefined ? [] : ["settings"]),
];

Deno.test("packs validate: schema and bundled policy", () => {
	for (const pack of PACKS) {
		equal(pack.kind, "pack", pack.id);
		deepStrictEqual(manifestPolicyIssues(pack, { bundled: true }), [], pack.id);
		ok((pack.members ?? []).length > 0, `${pack.id}: members`);
	}
});

Deno.test("every pack member is a valid bundled extension at the listed version", async () => {
	for (const pack of PACKS) {
		for (const member of pack.members ?? []) {
			const m = await memberManifest(member.id);
			equal(m.id, member.id);
			equal(m.kind, "extension", `${pack.id}: ${member.id}`);
			equal(m.version, member.version, `${pack.id}: ${member.id} version`);
			deepStrictEqual(
				manifestPolicyIssues(m, { bundled: true }),
				[],
				`${pack.id}: ${member.id} policy`,
			);
		}
	}
});

Deno.test("installing a pack adds no M0 stub surface: no placeholder slots, dead actions, failing tools or events", async () => {
	for (const pack of PACKS) {
		for (const member of pack.members ?? []) {
			if (!M0_STUBS.has(member.id)) continue;
			deepStrictEqual(
				surface(await memberManifest(member.id)),
				[],
				`${pack.id}: member ${member.id} is an M0 stub with a surface`,
			);
		}
	}
});

Deno.test("no pack member subscribes to every event", async () => {
	for (const pack of PACKS) {
		for (const member of pack.members ?? []) {
			const m = await memberManifest(member.id);
			for (const sub of m.subscribe ?? []) {
				ok(sub.event !== "*", `${pack.id}: ${member.id} subscribes to *`);
			}
		}
	}
});

const memberOf = (pack: Manifest, id: string) =>
	(pack.members ?? []).find((m) => m.id === id);

Deno.test("the Classic pack: FIFO, human-required review, issues and pull requests, no radar", () => {
	const classic = PACKS[1];
	const ids = (classic.members ?? []).map((m) => m.id).sort();
	deepStrictEqual(ids, [
		"tartan.board",
		"tartan.changes",
		"tartan.ci",
		"tartan.fifo",
		"tartan.review",
		"tartan.work",
	]);
	deepStrictEqual(memberOf(classic, "tartan.review")?.config, {
		mode: "human-required",
	});
	deepStrictEqual(memberOf(classic, "tartan.work")?.config, {
		wording: "classic",
		labels: { work: "Issues", "new-work": "New issue" },
	});
	deepStrictEqual(memberOf(classic, "tartan.changes")?.config, {
		wording: "classic",
		labels: { changes: "Pull requests" },
	});
});

Deno.test("Classic member labels name slots the members declare", async () => {
	for (const member of PACKS[1].members ?? []) {
		const labels = (member.config as { labels?: Record<string, string> })
			?.labels;
		if (labels === undefined) continue;
		const m = await memberManifest(member.id);
		const declared = new Map(
			(m.contributes?.slots ?? []).map((s) => [s.id, s.label]),
		);
		for (const [id, label] of Object.entries(labels)) {
			ok(
				declared.get(id) !== undefined,
				`${member.id}: slot ${id} has a label`,
			);
			ok(label.length > 0 && label.length <= 40, `${member.id}: ${id}`);
		}
	}
});

Deno.test("the Classic card: embedded == protocol.md, ≤ 2 KB, names only real tools", async () => {
	const file = await Deno.readTextFile(
		new URL("../classic/protocol.md", import.meta.url),
	);
	equal(classicCard, file, "classic/src/index.ts drifted from protocol.md");
	ok(new TextEncoder().encode(file).length <= 2048);
	const named = [...file.matchAll(/`([a-z]+_[a-z_]+)[ `]/g)].map((m) => m[1]);
	ok(named.length >= 5, named.join(","));
	for (const tool of named) {
		ok(RESERVED_TOOL_NAMES.has(tool), `${tool} is a kernel or interface tool`);
	}
	ok(!file.includes("conflicts_"), "no radar tools in a Classic card");
	deepStrictEqual(Object.keys(classicModule), []);
	deepStrictEqual(classicMigrations, []);
});

Deno.test("the Swarm pack leaves tartan.hud out: it is installed once, on a namespace", () => {
	const swarm = PACKS[0].members ?? [];
	ok(!swarm.some((m) => m.id === "tartan.hud"), "hud is not a member");
});
