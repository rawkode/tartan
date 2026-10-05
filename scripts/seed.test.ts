// Demo seed against a fake REST forge and the
// swarm's fake forge for MCP and git: the base (HUD, groups, packs, the demo
// repo imported from the mirror, the docs repo, the real agents with their
// tokens handed to the operator's file only), each beat's own state (work
// items, seeded actors' changes with the scripted conflict, the swarm),
// idempotence, honest refusals (no mirror, no seeded history yet), the dev
// stage gate, the CLI's arguments, and the demo mirror built with stock git.

import {
	deepStrictEqual,
	equal,
	match,
	ok,
	rejects,
	throws,
} from "node:assert/strict";
import { beatOf, DEMO } from "../fixtures/demo/beats.ts";
import { assertDevStage, createForgeClient } from "../fixtures/demo/client.ts";
import {
	buildMirror,
	parseLsTree,
	placeholderFor,
	planMirror,
	runGit,
} from "../fixtures/demo/mirror.ts";
import { seedBeat, type SeedDeps } from "../fixtures/demo/seed.ts";
import { createFakeRest } from "../fixtures/demo/testing.ts";
import { SAMPLE_FILES } from "../src/kernel/swarm/sample.ts";
import { createFakeForge } from "../src/kernel/swarm/testing/fakeforge.ts";
import { assertOutsideRepo, parseSeedArgs } from "./seed.ts";

const ORIGIN = "https://dev.example.com";
const TOKEN = "tpat_secret_owner_token";

const setup = async (stage = "dev-demo") => {
	const rest = createFakeRest(stage);
	const forge = await createFakeForge(SAMPLE_FILES, DEMO.repo);
	const logs: string[] = [];
	const saved: Record<string, string>[] = [];
	const pushed: { url: string; dir: string }[] = [];
	const deps: SeedDeps = {
		client: createForgeClient({
			origin: ORIGIN,
			token: TOKEN,
			fetch: rest.fetch,
		}),
		portFor: (token) => forge.portFor(token),
		pushMirror: (url, dir) => {
			pushed.push({ url, dir });
			return Promise.resolve();
		},
		saveAgentTokens: (tokens) => {
			saved.push(tokens);
			return Promise.resolve();
		},
		log: (line) => logs.push(line),
		now: () => 1_790_000_000_000,
	};
	return { rest, forge, logs, saved, pushed, deps };
};

Deno.test("beat 1 from nothing: the base, the agents, the beat's items", async () => {
	const s = await setup();
	const report = await seedBeat(s.deps, {
		beat: beatOf(DEMO, 1),
		fixture: DEMO,
		mirror: { url: "https://github.com/example/demo-mirror.git" },
		allowMissing: false,
	});
	deepStrictEqual(
		s.rest.installs.map((i) => `${i.extId}@${i.node}`),
		[
			"tartan.hud@rawkode",
			"tartan.pack.swarm@rawkode/platform",
			"tartan.pack.classic@rawkode/docs",
		],
	);
	const repo = s.rest.nodes.get(DEMO.repo)!;
	equal(repo.kind, "repo");
	deepStrictEqual(repo.import, {
		url: "https://github.com/example/demo-mirror.git",
	});
	ok(s.rest.nodes.has(DEMO.docsRepo));
	deepStrictEqual(Object.keys(s.saved[0]!), ["claude-code", "codex"]);
	deepStrictEqual(
		s.rest.agents.map((a) => [a.handle, a.model]),
		[["claude-code", "claude"], ["codex", "gpt-5-codex"]],
	);
	deepStrictEqual(Object.keys(report.items), ["limits", "quota"]);
	match(report.items["limits"]!, /^rawkode\/platform\/edge\/router#\d+$/);
	ok(s.rest.calls.every((c) => c.bearer || c.path === "/-/health"));
	ok(!JSON.stringify(s.logs).includes("secret"), "no token in a log line");
});

Deno.test("seeding twice reuses everything: no duplicate nodes, installs, agents or items", async () => {
	const s = await setup();
	const opts = {
		beat: beatOf(DEMO, 1),
		fixture: DEMO,
		mirror: { url: "https://github.com/example/demo-mirror.git" },
		allowMissing: false,
	};
	const first = await seedBeat(s.deps, opts);
	const again = await seedBeat(s.deps, opts);
	equal(s.rest.installs.length, 3);
	equal(s.rest.agents.length, 2);
	equal(s.saved.length, 1, "existing agents get no new token");
	deepStrictEqual(again.items, first.items);
	equal(again.created.length, 0);
});

Deno.test("a local mirror is pushed into a repo in import mode, then completed", async () => {
	const s = await setup();
	await seedBeat(s.deps, {
		beat: beatOf(DEMO, 1),
		fixture: DEMO,
		mirror: { dir: "/tmp/demo-mirror" },
		allowMissing: false,
	});
	deepStrictEqual(s.rest.nodes.get(DEMO.repo)!.import, { mode: "push" });
	deepStrictEqual(s.pushed, [{
		url: `${ORIGIN}/${DEMO.repo}.git`,
		dir: "/tmp/demo-mirror",
	}]);
	equal(s.rest.nodes.get(DEMO.repo)!.imported, true);
});

Deno.test("beat 2: ten queued changes by seeded actors, two of them on the same file", async () => {
	const s = await setup();
	const report = await seedBeat(s.deps, {
		beat: beatOf(DEMO, 2),
		fixture: DEMO,
		mirror: { url: "https://github.com/example/demo-mirror.git" },
		allowMissing: false,
	});
	equal(report.changes, 11);
	equal(s.forge.changes.size, 11);
	const seeded = s.rest.agents.filter((a) => a.handle.startsWith("seeded-"));
	equal(seeded.length, 11);
	ok(seeded.every((a) => a.model === "seeded"), "seeded actors are labelled");
	const shared = [...s.forge.changes.values()].filter((c) =>
		c.by.endsWith("-10") || c.by.endsWith("-11")
	);
	equal(shared.length, 2);
	for (const change of shared) {
		const text = await s.forge.readFileAt(
			change.head,
			"services/api/src/seeded/shared.ts",
		);
		match(text!, /^export const ttl = (60|300);\n$/);
	}
	equal(s.forge.refs()["refs/heads/main"], s.forge.trunk, "trunk untouched");
});

Deno.test("beat 0 starts the swarm with the requested cap", async () => {
	const s = await setup();
	const report = await seedBeat(s.deps, {
		beat: beatOf(DEMO, 0),
		fixture: DEMO,
		mirror: { url: "https://github.com/example/demo-mirror.git" },
		allowMissing: false,
		swarmMax: 300,
	});
	equal(s.rest.swarms.length, 1);
	deepStrictEqual(s.rest.swarms[0]!.body, {
		repo: DEMO.repo,
		agents: 300,
		workItems: 600,
		minutes: 10,
	});
	equal(s.rest.swarms[0]!.max, "300");
	equal(report.swarm, s.rest.swarms[0]!.id);
});

Deno.test("what the forge cannot do yet is refused, or skipped and said so", async () => {
	const s = await setup();
	await rejects(
		seedBeat(s.deps, {
			beat: beatOf(DEMO, 1),
			fixture: DEMO,
			allowMissing: false,
		}),
		/--mirror <dir> or --mirror-url/,
	);
	// A forge without dev tools does not serve seedHistory (404).
	const t = await setup();
	t.rest.options.seedHistory = false;
	await rejects(
		seedBeat(t.deps, {
			beat: beatOf(DEMO, 3),
			fixture: DEMO,
			mirror: { url: "https://github.com/example/m.git" },
			allowMissing: false,
		}),
		/seedHistory/,
	);
	const u = await setup();
	u.rest.options.seedHistory = false;
	const report = await seedBeat(u.deps, {
		beat: beatOf(DEMO, 3),
		fixture: DEMO,
		allowMissing: true,
	});
	equal(report.skipped.length, 2);
	throws(() => beatOf(DEMO, 9), /no beat 9/);
});

Deno.test("beat 3 seeds 41 labelled Advances through WP10's dev-only seedHistory", async () => {
	const s = await setup();
	const report = await seedBeat(s.deps, {
		beat: beatOf(DEMO, 3),
		fixture: DEMO,
		mirror: { url: "https://github.com/example/m.git" },
		allowMissing: false,
	});
	deepStrictEqual(s.rest.seeded, [{ repo: DEMO.repo, count: 41 }]);
	deepStrictEqual(report.seeded, { advances: 41, withFakeKeys: [12, 31] });
	ok(
		s.rest.calls.some((c) =>
			c.method === "POST" && c.path.startsWith("/-/api/seed-history?repo=") &&
			c.bearer
		),
	);
});

Deno.test("dev stages only", async () => {
	for (const stage of ["dev", "dev-demo", "dev-wp20"]) assertDevStage(stage);
	for (const stage of ["prod", "judge-rec", "production", ""]) {
		throws(() => assertDevStage(stage), /dev stages only/);
	}
	const prod = createFakeRest("prod");
	const client = createForgeClient({
		origin: ORIGIN,
		token: TOKEN,
		fetch: prod.fetch,
	});
	const prodStage = (await client.health()).stage;
	throws(() => assertDevStage(prodStage), /dev stages only/);
});

Deno.test("seed arguments", () => {
	deepStrictEqual(
		parseSeedArgs([
			"--origin",
			"https://dev.example.com/x",
			"--beat",
			"2",
			"--mirror",
			"/m",
		]),
		{
			kind: "seed",
			origin: "https://dev.example.com",
			beat: 2,
			mirror: { dir: "/m" },
			allowMissing: false,
		},
	);
	deepStrictEqual(
		parseSeedArgs([
			"--build-mirror",
			"--from",
			"/a",
			"--out",
			"/b",
			"--drop-content",
		]),
		{ kind: "mirror", from: "/a", out: "/b", dropContent: true },
	);
	throws(() => parseSeedArgs(["--beat", "1"]), /--origin is required/);
	throws(() => parseSeedArgs(["--origin", "http://x", "--beat", "1"]), /https/);
	throws(
		() => parseSeedArgs(["--origin", "https://x", "--beat", "one"]),
		/--beat/,
	);
	throws(
		() =>
			parseSeedArgs([
				"--origin",
				"https://x",
				"--beat",
				"1",
				"--mirror",
				"/m",
				"--mirror-url",
				"https://g",
			]),
		/not both/,
	);
	const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
	throws(
		() => assertOutsideRepo(`${root}/tokens.json`, root),
		/inside the repository/,
	);
	assertOutsideRepo("/home/someone/.config/tartan/a.json", root);
});

// ---------------------------------------------------------------------------
// The demo mirror
// ---------------------------------------------------------------------------

Deno.test("mirror plan: binaries become placeholders, Terraform state and content/ can go", () => {
	const entries = parseLsTree(
		[
			"100644 blob aaaa 120\tREADME.md",
			"100644 blob bbbb 52000\tcontent/blog/hero.png",
			"100644 blob cccc 900\tcontent/blog/post.md",
			"100644 blob dddd 3000000\tinfra/terraform.tfstate/pack/x.pack",
			"100644 blob abab 400\tinfra/env/prod.tfstate.backup",
			"100755 blob eeee 300\tscripts/run.sh",
			"100644 blob ffff 2000000\tdata/huge.json",
			"160000 commit 1111 -\tvendor/sub",
		].join("\0") + "\0",
	);
	const plan = planMirror(entries);
	deepStrictEqual(plan.keep.map((e) => e.path), [
		"README.md",
		"content/blog/post.md",
		"scripts/run.sh",
	]);
	deepStrictEqual(plan.placeholders, [
		{ path: "content/blog/hero.png", ext: "png" },
		{ path: "data/huge.json", ext: "json" },
	]);
	deepStrictEqual(plan.dropped, [
		"infra/terraform.tfstate/pack/x.pack",
		"infra/env/prod.tfstate.backup",
		"vendor/sub",
	]);
	const noContent = planMirror(entries, { dropContent: true });
	ok(!noContent.keep.some((e) => e.path.startsWith("content/")));
	equal(placeholderFor("png")[1], 0x50, "a real PNG signature");
});

Deno.test("mirror build with stock git: one commit, placeholders, the source untouched", async () => {
	const dir = await Deno.makeTempDir({ prefix: "tartan-mirror-" });
	try {
		const src = `${dir}/src`;
		await Deno.mkdir(`${src}/content`, { recursive: true });
		await Deno.mkdir(`${src}/infra/terraform.tfstate`, { recursive: true });
		await runGit(["init", "--quiet", "-b", "main", src]);
		await Deno.writeTextFile(`${src}/README.md`, "# demo\n");
		await Deno.writeFile(
			`${src}/content/hero.png`,
			new Uint8Array(4096).fill(7),
		);
		await Deno.writeTextFile(
			`${src}/infra/terraform.tfstate/state`,
			"state\n",
		);
		const commit = async (message: string) => {
			await runGit(["add", "-A"], { cwd: src });
			await runGit([
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@t",
				"commit",
				"--quiet",
				"-m",
				message,
			], { cwd: src });
		};
		await commit("one");
		await Deno.writeTextFile(`${src}/README.md`, "# demo v2\n");
		await commit("two");
		const result = await buildMirror({ from: src, out: `${dir}/out` });
		const out = `${dir}/out`;
		equal(
			(await runGit(["rev-list", "--count", "main"], { cwd: out })).trim(),
			"1",
		);
		equal(result.placeholders, 1);
		equal(result.dropped, 1);
		const files =
			(await runGit(["ls-tree", "-r", "--name-only", "main"], { cwd: out }))
				.trim().split("\n");
		deepStrictEqual(files.sort(), ["README.md", "content/hero.png"]);
		equal(await Deno.readTextFile(`${out}/README.md`), "# demo v2\n");
		const png = await Deno.readFile(`${out}/content/hero.png`);
		ok(png.length < 100, "a tiny placeholder");
		equal(
			(await runGit(["for-each-ref", "--format=%(refname)"], { cwd: out }))
				.trim(),
			"refs/heads/main",
		);
		equal(
			(await runGit(["rev-list", "--count", "main"], { cwd: src })).trim(),
			"2",
		);
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
});
