// Repository config, pure parts (ADR repo config, "Testing"): the kernel's
// root
// file rules, the input key and the policy digest, positive-evidence reads
// of the root tree, CUE's error text, the job classifier and bundle, and
// stable plan lines (installations and repo policy).

import {
	deepStrictEqual,
	equal,
	match,
	notEqual,
	ok,
} from "node:assert/strict";
import {
	CUE_EVALUATOR_ID,
	CUE_JOB_VERSION,
	CUE_VERSION,
	isEvalOk,
	isPolicyPath,
	REPO_CONFIG_LIMITS,
} from "@tartan/contract";
import { MODE } from "@tartan/testkit";
import {
	buildCueBundle,
	classifyCueJob,
	CUE_JOB_EXIT,
	cueJobCommand,
} from "../runs/cue.ts";
import {
	isLoadIssue,
	normalizeCueErrors,
	refusedImport,
	refusedImportMessage,
} from "./issues.ts";
import {
	fileList,
	gitBlobOid,
	inputKeyOf,
	policyDigestOf,
	schemaKeyOf,
} from "./key.ts";
import {
	configureLine,
	installLine,
	overlayLine,
	overlayRemoveLine,
	planText,
	policyPlan,
	removeLine,
} from "./plan.ts";
import { readConfigAt, readPolicyDigest } from "./reader.ts";
import {
	checkConfigContents,
	type ConfigTreeEntry,
	rootCueEntries,
	selectConfigFiles,
} from "./rules.ts";
import { createTestRepo, cueFile } from "./testing/git.ts";

const OID = "a".repeat(40);
const file = (name: string, mode: string = MODE.file): ConfigTreeEntry => ({
	name,
	mode,
	hash: OID,
	type: mode === MODE.tree
		? "tree"
		: mode === MODE.symlink
		? "symlink"
		: mode === MODE.gitlink
		? "gitlink"
		: "blob",
});

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// The policy predicate and the root file rules
// ---------------------------------------------------------------------------

Deno.test("isPolicyPath: every root *.cue file of any package, byte for byte", () => {
	ok(isPolicyPath("tartan.cue"));
	ok(isPolicyPath("env.cue"));
	ok(isPolicyPath("_scratch.cue"));
	ok(isPolicyPath("a\u2028.cue"));
	ok(isPolicyPath(".cue"));
	ok(!isPolicyPath("services/api/x.cue"));
	ok(!isPolicyPath("cue.mod/module.cue"));
	ok(!isPolicyPath("x.CUE"));
	ok(!isPolicyPath("tartan.cue.bak"));
	ok(!isPolicyPath(".tartan/pipeline.yaml"));
	ok(!isPolicyPath(".tartan/extensions.cue"));
	ok(!isPolicyPath(""));
});

Deno.test("file rules: a symlink, a submodule, a directory or a non-ASCII name is INVALID_INPUT naming the path", () => {
	const cases: [ConfigTreeEntry, RegExp][] = [
		[file("link.cue", MODE.symlink), /symlink/],
		[file("sub.cue", MODE.gitlink), /submodule/],
		[file("dir.cue", MODE.tree), /directory/],
		[file("a\u2028.cue"), /ASCII/],
		[file("a b.cue"), /ASCII/],
		[file("é.cue"), /ASCII/],
		[file(".cue"), /ASCII/],
	];
	for (const [entry, re] of cases) {
		const r = selectConfigFiles([file("ok.cue"), entry]);
		ok(!r.ok, entry.name);
		if (!r.ok) {
			equal(r.path, entry.name);
			match(r.message, re, entry.name);
		}
	}
});

Deno.test("file rules: the CLI's own names are sent (it decides); other root entries and subdirectories are not read; 33 files are refused", () => {
	const r = selectConfigFiles([
		file("tartan.cue"),
		file("env.cue"),
		file("_scratch.cue"),
		file("x_tool.cue"),
		file("x_test.cue"),
		file("exec.cue", MODE.exec),
		file("README.md"),
		file("pipeline.yaml"),
		file("cue.mod", MODE.tree),
		file(".tartan", MODE.tree),
		file("services", MODE.tree),
		file("x.CUE"),
	]);
	ok(r.ok, JSON.stringify(r));
	if (r.ok) {
		deepStrictEqual(r.files.map((f) => f.name), [
			"_scratch.cue",
			"env.cue",
			"exec.cue",
			"tartan.cue",
			"x_test.cue",
			"x_tool.cue",
		]);
	}
	deepStrictEqual(
		rootCueEntries([file("b.cue"), file("a.cue"), file("c.txt")]).map((e) =>
			e.name
		),
		["a.cue", "b.cue"],
	);
	const many = Array.from({ length: 33 }, (_, i) => file(`f${i}.cue`));
	const r33 = selectConfigFiles(many);
	ok(!r33.ok);
	if (!r33.ok) match(r33.message, /33 root \.cue files; at most 32/);
	ok(selectConfigFiles(many.slice(0, 32)).ok);
});

Deno.test("file rules: UTF-8 and sizes are checked on the bytes, counted across packages; no package clause is read", () => {
	const of = (name: string, text: string | Uint8Array) => ({
		name,
		oid: OID,
		bytes: typeof text === "string" ? enc.encode(text) : text,
	});
	ok(checkConfigContents([of("a.cue", cueFile("x: 1"))]).ok);
	// Another package, no package clause, an @if attribute: the CLI decides.
	ok(checkConfigContents([of("env.cue", "package cuenv\n\nx: 1\n")]).ok);
	ok(checkConfigContents([of("n.cue", "x: 1\n")]).ok);
	ok(checkConfigContents([of("d.cue", `@if(debug)\n${cueFile("x: 1")}`)]).ok);
	const bin = checkConfigContents([of("a.cue", new Uint8Array([0xff, 0xfe]))]);
	ok(!bin.ok && /UTF-8/.test(bin.message) && bin.path === "a.cue");
	const big = checkConfigContents([
		of("a.cue", cueFile("x".repeat(REPO_CONFIG_LIMITS.fileBytes))),
	]);
	ok(!big.ok && /per root \.cue file/.test(big.message));
	// 257 KiB in total where another package's file pushes it over.
	const chunk = cueFile(`x: "${"y".repeat(64 * 1024 - 40)}"`);
	const total = checkConfigContents([
		...Array.from({ length: 4 }, (_, i) => of(`f${i}.cue`, chunk)),
		of("env.cue", `package cuenv\n\nx: "${"z".repeat(2048)}"\n`),
	]);
	ok(!total.ok && /in total/.test(total.message), JSON.stringify(total));
	ok(!total.ok && total.path === "env.cue");
});

// ---------------------------------------------------------------------------
// Input key and policy digest
// ---------------------------------------------------------------------------

Deno.test("input key: edits outside the root *.cue files give the same key; another package's root file gives a new one", async () => {
	const repo = createTestRepo();
	const tartan = cueFile('extensions: "tartan.weave": settings: batch: 2');
	const env = "package cuenv\n\nenv: A: 1\n";
	const base = {
		"tartan.cue": tartan,
		"env.cue": env,
		"README.md": "a",
		"cue.mod/module.cue": 'module: "example.com/a@v0"\n',
		"services/x.cue": "package x\n",
	};
	const a = repo.commit(base);
	const b = repo.commit({
		...base,
		"README.md": "b",
		"cue.mod/module.cue": 'module: "example.com/b@v0"\n',
		"services/x.cue": "package x\n\ny: 2\n",
	}, [a]);
	const c = repo.commit({ ...base, "env.cue": `${env}env: B: 2\n` }, [b]);
	const rename = repo.commit({
		"pipeline.cue": tartan,
		"env.cue": env,
		"README.md": "a",
	}, [c]);
	const [sa, sb, sc, sr] = await Promise.all(
		[a, b, c, rename].map((sha) => readConfigAt(repo.reads, sha)),
	);
	ok(
		sa.kind === "files" && sb.kind === "files" && sc.kind === "files" &&
			sr.kind === "files",
	);
	const key = (files: { name: string; oid: string }[], schemaKey = "s") =>
		inputKeyOf({ evaluator: CUE_EVALUATOR_ID, schemaKey, files });
	equal(key([...sa.files]), key([...sb.files]));
	equal(sa.policyDigest, sb.policyDigest);
	// An edit to cuenv's env.cue (another package): a new key and digest.
	notEqual(key([...sc.files]), key([...sa.files]));
	notEqual(sc.policyDigest, sa.policyDigest);
	// A rename (tartan.cue → pipeline.cue): a new key (the resolved JSON is the same).
	notEqual(key([...sr.files]), key([...sa.files]));
	// The same files in another repo (a lane repo) give the same key.
	const lane = createTestRepo();
	const l = lane.commit({ "tartan.cue": tartan, "env.cue": env });
	const sl = await readConfigAt(lane.reads, l);
	ok(sl.kind === "files");
	equal(key([...sl.files]), key([...sa.files]));
	// A new schema (an approval change) and a new evaluator id are new keys.
	ok(key([...sa.files], "s2") !== key([...sa.files]));
	ok(
		inputKeyOf({
			evaluator: CUE_EVALUATOR_ID.replace("rules@2", "rules@3"),
			schemaKey: "s",
			files: [...sa.files],
		}) !== key([...sa.files]),
	);
	// Order does not matter; trees' 040000 and 40000 are one mode.
	deepStrictEqual(
		fileList([{ name: "b", oid: "2" }, { name: "a", oid: "1" }]),
		[["a", "1"], ["b", "2"]],
	);
	equal(
		policyDigestOf([
			{ name: "b.cue", mode: "040000", oid: "2" },
			{ name: "a.cue", mode: "100644", oid: "1" },
		]),
		policyDigestOf([
			{ name: "a.cue", mode: "100644", oid: "1" },
			{ name: "b.cue", mode: "40000", oid: "2" },
		]),
	);
	equal(policyDigestOf([]), null);
	equal(
		schemaKeyOf({ "b": "2", "a": "1" }),
		schemaKeyOf({ "a": "1", "b": "2" }),
	);
	equal(
		gitBlobOid(enc.encode("hello\n")),
		"ce013625030ba8dba906f756967f9e9ca394464a",
	);
});

// ---------------------------------------------------------------------------
// Positive evidence
// ---------------------------------------------------------------------------

Deno.test("positive evidence: null, empty and mismatched reads are unavailable, never absent", async () => {
	const repo = createTestRepo();
	const sha = repo.commit({ "tartan.cue": cueFile("x: 1"), "README": "r" });
	const s = await readConfigAt(repo.reads, sha);
	ok(s.kind === "files");
	equal(s.policyDigest, repo.policyDigest(sha));
	equal(await readPolicyDigest(repo.reads, sha), repo.policyDigest(sha));

	repo.faults.nullCommits.add(sha);
	equal((await readConfigAt(repo.reads, sha)).kind, "unavailable");
	equal(await readPolicyDigest(repo.reads, sha), undefined);
	repo.faults.nullCommits.clear();

	const root = (await repo.reads.readCommit(sha))!.treeHash;
	repo.faults.emptyTrees.add(root);
	equal((await readConfigAt(repo.reads, sha)).kind, "unavailable");
	equal(await readPolicyDigest(repo.reads, sha), undefined);
	repo.faults.emptyTrees.clear();
	repo.faults.nullTrees.add(root);
	equal((await readConfigAt(repo.reads, sha)).kind, "unavailable");
	repo.faults.nullTrees.clear();

	repo.faults.corruptBlobs.add(s.files[0].oid);
	const corrupt = await readConfigAt(repo.reads, sha);
	ok(corrupt.kind === "unavailable" && /hash mismatch/.test(corrupt.reason));
	repo.faults.corruptBlobs.clear();

	const thrower = {
		...repo.reads,
		readTree: () => Promise.reject(new Error("binding down")),
	};
	equal((await readConfigAt(thrower, sha)).kind, "unavailable");
});

Deno.test("positive evidence: absent means no root *.cue file; .tartan/ and subdirectories are never read", async () => {
	const repo = createTestRepo();
	const none = repo.commit({ "README": "r" });
	const n = await readConfigAt(repo.reads, none);
	ok(n.kind === "absent" && n.policyDigest === null && !n.legacyDir);
	equal(await readPolicyDigest(repo.reads, none), null);
	// The retired layout: no root *.cue, a .tartan directory (migration hint).
	const legacy = repo.commit({
		".tartan/pipeline.yaml": "jobs: {}\n",
		".tartan/extensions.cue": cueFile("x: 1"),
		"README": "r",
	});
	const l = await readConfigAt(repo.reads, legacy);
	ok(l.kind === "absent" && l.legacyDir);
	const bad = repo.commit({ "a b.cue": cueFile("x: 1") });
	const b = await readConfigAt(repo.reads, bad);
	ok(b.kind === "invalid" && b.path === "a b.cue");
	// The digest covers every root *.cue entry, an invalid one included.
	ok(b.kind === "invalid" && b.policyDigest === repo.policyDigest(bad));
	// A repo's own cue.mod/ and subdirectory .cue files are never read.
	const mod = repo.commit({
		"cue.mod/module.cue": 'module: "evil.example/x@v0"\n',
		"cue.mod/pkg/tartan.dev/ext/ext.cue": "package ext\n",
		"services/api/x.cue": cueFile("y: 1"),
		"tartan.cue": cueFile("x: 1"),
	});
	const m = await readConfigAt(repo.reads, mod);
	ok(m.kind === "files");
	deepStrictEqual(m.files.map((f) => f.name), ["tartan.cue"]);
});

// ---------------------------------------------------------------------------
// CUE's error text and the classifier
// ---------------------------------------------------------------------------

const STDERR = [
	'extensions."tartan.weave".settings.batch: 2 errors in empty disjunction:',
	'extensions."tartan.weave".settings.batch: conflicting values 4 and 12:',
	"    ./tartan.cue:3:46",
	"    ./cue.mod/pkg/tartan.dev/ext/ext.cue:26:11",
	"    ./~tartan.cue:5:14",
	'extensions."a: b".x: field not allowed:',
	"    ./ci.cue:5:2",
	"    /not a position",
	"",
].join("\n");

Deno.test("CUE errors: paths are quote-aware, positions checked, module paths normalized, text capped", () => {
	const issues = normalizeCueErrors(STDERR);
	deepStrictEqual(issues, [
		{
			path: 'extensions."tartan.weave".settings.batch',
			msg: "2 errors in empty disjunction",
			pos: [],
		},
		{
			path: 'extensions."tartan.weave".settings.batch',
			msg: "conflicting values 4 and 12",
			pos: [
				"tartan.cue:3:46",
				"cue.mod/pkg/tartan.dev/ext/ext.cue:26:11",
				"~tartan.cue:5:14",
			],
		},
		{
			path: 'extensions."a: b".x',
			msg: "field not allowed",
			pos: ["ci.cue:5:2"],
		},
	]);
	const module = normalizeCueErrors(
		'tartan.local/j0123456789abcdef0123456789abcdef@v0: import failed: cannot find package "github.com/a/b":\n    ./ci.cue:3:8\n',
	);
	equal(module[0].path, "<module>");
	const refused = refusedImport(module);
	deepStrictEqual(refused, {
		importPath: "github.com/a/b",
		position: "ci.cue:3:8",
	});
	equal(
		refusedImportMessage(refused!),
		"package tartan may import only the CUE standard library and tartan.dev/ext: `ci.cue:3:8` imports `github.com/a/b`",
	);
	match(
		refusedImportMessage({
			importPath: "tartan.dev/ext/x/acme_nope:settings",
			position: "tartan.cue:3:8",
		}),
		/not provide/,
	);
	const flood = Array.from({ length: 300 }, (_, i) => `x${i}: bad`).join("\n");
	equal(normalizeCueErrors(flood).length, REPO_CONFIG_LIMITS.issues);
	const long = normalizeCueErrors(`x: ${"m".repeat(10_000)}`);
	ok(long[0].msg.length <= REPO_CONFIG_LIMITS.issueMessageBytes);
	const ctl = normalizeCueErrors("x: a\u0007b\u2028c");
	equal(ctl[0].msg, "abc");
	ok(
		isLoadIssue({
			path: "",
			msg: "expression exceeds maximum nesting depth of 10000",
			pos: [],
		}),
	);
	ok(!isLoadIssue({ path: "x", msg: "conflicting values 4 and 12", pos: [] }));
});

const line = (o: Partial<Record<string, unknown>>) =>
	JSON.stringify({
		job: CUE_JOB_VERSION,
		cue: CUE_VERSION,
		rc: 0,
		ms: 12,
		out: "",
		outBytes: 0,
		err: "",
		errBytes: 0,
		...o,
	});

Deno.test("classifier: every exit code maps to one envelope; a refused import is INVALID_INPUT", () => {
	const okEnv = classifyCueJob(line({ out: "{}", outBytes: 2 }));
	ok(isEvalOk(okEnv));
	if (isEvalOk(okEnv)) deepStrictEqual(okEnv.ok, {});
	const code = (o: Partial<Record<string, unknown>>) => {
		const r = classifyCueJob(line(o));
		return isEvalOk(r) ? "ok" : r.error.code;
	};
	equal(code({ rc: CUE_JOB_EXIT.timeout }), "TIMEOUT");
	equal(code({ rc: CUE_JOB_EXIT.fileSize }), "LIMIT_EXCEEDED");
	equal(code({ rc: CUE_JOB_EXIT.killed }), "LIMIT_EXCEEDED");
	equal(
		code({
			rc: CUE_JOB_EXIT.goFatal,
			err: "fatal error: runtime: out of memory",
		}),
		"LIMIT_EXCEEDED",
	);
	equal(code({ rc: CUE_JOB_EXIT.goFatal, err: "panic: x" }), "INTERNAL");
	equal(
		code({ rc: CUE_JOB_EXIT.rejected, err: "bundle path refused" }),
		"INVALID_INPUT",
	);
	equal(code({ rc: 1, err: STDERR }), "BUILD_VALUE");
	equal(
		code({
			rc: 1,
			err:
				"expression exceeds maximum nesting depth of 10000:\n    ./tartan.cue:3:4\n",
		}),
		"LOAD_INSTANCE",
	);
	equal(
		code({
			rc: 1,
			err:
				'<module>: import failed: cannot find package "example.com/x":\n    ./tartan.cue:3:8\n',
		}),
		"INVALID_INPUT",
	);
	equal(code({ rc: 1, err: "" }), "INTERNAL");
	equal(code({ rc: 0, out: "not json", outBytes: 8 }), "INTERNAL");
	equal(
		code({ rc: 0, out: "", outBytes: REPO_CONFIG_LIMITS.jsonBytes + 1 }),
		"LIMIT_EXCEEDED",
	);
	// Version mismatches are INTERNAL (never cached).
	equal(code({ cue: "v0.16.0" }), "INTERNAL");
	equal(code({ job: 1 }), "INTERNAL");
	equal(classifyCueJob("garbage").issues.length, 0);
	equal(isEvalOk(classifyCueJob("garbage")), false);
});

Deno.test("bundle: only the forge's schema, its binding file and root names; no module file; capped; the command quotes nothing it did not build", () => {
	ok(
		buildCueBundle({
			"cue.mod/pkg/tartan.dev/ext/ext.cue": "x",
			"cue.mod/pkg/tartan.dev/ext/x/tartan_weave/settings.cue": "x",
			"~tartan.cue": "x",
			"tartan.cue": "x",
			"env.cue": "x",
			"_scratch.cue": "x",
		}).ok,
	);
	for (
		const bad of [
			"cue.mod/module.cue",
			"../x.cue",
			"cue.mod/pkg/evil/x.cue",
			"sub/x.cue",
			".tartan/x.cue",
			"/etc/passwd",
			"a\u2028.cue",
			"a b.cue",
			"~other.cue",
		]
	) {
		ok(!buildCueBundle({ "~tartan.cue": "x", [bad]: "x" }).ok, bad);
	}
	const noBinding = buildCueBundle({ "tartan.cue": "x" });
	ok(!noBinding.ok && /~tartan\.cue/.test(noBinding.message));
	const big = buildCueBundle({
		"~tartan.cue": "x",
		"a.cue": "x".repeat(700 * 1024),
	});
	ok(!big.ok && /exceeds/.test(big.message));
	const cmd = cueJobCommand("cj_abc", {
		wallClockS: 10,
		addressSpaceKiB: 2097152,
		outputFileKiB: 4096,
		jsonBytes: 262144,
		stderrBytes: 65536,
	});
	match(cmd, /setpriv --reuid=tartan-git/);
	match(cmd, /CUE_JOB_TIMEOUT_S=10/);
	match(
		cmd,
		/\/opt\/tartan-cue\/cue-job\.sh \/opt\/tartan-cue\/bundles\/bundle-cj_abc\.json/,
	);
	// No new privileges; leftover tartan-git processes are killed
	// after the job, before the bundle is removed.
	match(cmd, /setpriv [^;]*--no-new-privs -- /);
	match(cmd, /rc=\$\?; pkill -KILL -u tartan-git; true; rm -f /);
	ok(!cmd.includes("/tmp/"), "no bundle in world-writable /tmp");
	let threw = false;
	try {
		cueJobCommand("x; rm -rf /", {
			wallClockS: 10,
			addressSpaceKiB: 1,
			outputFileKiB: 1,
			jsonBytes: 1,
			stderrBytes: 1,
		});
	} catch {
		threw = true;
	}
	ok(threw);
});

// ---------------------------------------------------------------------------
// Plan lines
// ---------------------------------------------------------------------------

Deno.test("plan lines: overlay, install, remove and configure read the same every time", () => {
	const lines = [
		overlayLine({
			extId: "tartan.weave",
			installationId: "i_x",
			nodePath: "rawkode",
			changes: [{ key: "batch", from: 4, to: 2 }],
		}),
		installLine({
			extId: "acme.no-secrets",
			version: "0.2.0",
			mode: "enforce",
			enabled: true,
			settings: {},
		}),
		installLine({
			extId: "acme.gate",
			version: "1.0.0",
			mode: "shadow",
			enabled: false,
			settings: {},
		}),
		removeLine("acme.no-secrets", "0.2.0"),
		configureLine({
			extId: "acme.no-secrets",
			version: "0.2.0",
			changes: [
				{ key: "mode", from: "shadow", to: "enforce" },
				{ key: "severity", from: "path", to: "hunk" },
			],
		}),
		overlayRemoveLine({
			extId: "tartan.weave",
			installationId: "i_x",
			nodePath: "rawkode",
		}),
	];
	deepStrictEqual(planText(lines), [
		"overlay tartan.weave (inherited from /rawkode): batch 4 → 2",
		"install acme.no-secrets 0.2.0 (enforce)",
		"install acme.gate 1.0.0 (disabled)",
		"remove acme.no-secrets",
		'configure acme.no-secrets: mode "shadow" → "enforce", severity "path" → "hunk"',
		"remove overlay tartan.weave (inherited from /rawkode)",
	]);
	deepStrictEqual(planText([]), ["no change"]);
});

Deno.test("plan lines: pipeline, owners, projects and global against trunk's policy; another package's edit is no change", () => {
	const policyKeys = new Map([
		["tartan.ci", ["pipeline"]],
		["tartan.review", ["owners"]],
	]);
	const before = {
		projects: { api: { root: "services/api" }, old: { root: "old" } },
		global: ["package.json"],
		extensions: {
			"tartan.ci": {
				settings: {
					pipeline: {
						timeout: "15m",
						jobs: { install: { run: "pnpm i" }, test: { run: "pnpm test" } },
					},
				},
			},
			"tartan.review": {
				settings: {
					owners: { rules: [{ paths: ["services/api/**"], sensitivity: 2 }] },
				},
			},
		},
	};
	const after = {
		projects: {
			api: { root: "services/api", sensitive: true },
			web: { root: "services/web" },
		},
		global: ["package.json", "pnpm-lock.yaml"],
		extensions: {
			"tartan.ci": {
				settings: {
					pipeline: {
						timeout: "20m",
						jobs: {
							install: { run: "pnpm i" },
							lint: { run: "pnpm lint" },
							test: { run: "pnpm test -r" },
						},
					},
				},
			},
			"tartan.review": {
				settings: {
					owners: {
						rules: [
							{ paths: ["services/api/**"], sensitivity: 3 },
							{ paths: ["web/**"], sensitivity: 1 },
						],
					},
				},
			},
		},
	};
	deepStrictEqual(planText(policyPlan({ before, after, policyKeys })), [
		'pipeline (tartan.ci): + job lint, ~ job test, timeout "15m" → "20m"',
		"owners (tartan.review): services/api/** sensitivity 2 → 3, + rule web/**",
		"projects: ~ api, - old, + web",
		"global: + pnpm-lock.yaml",
	]);
	// From no pipeline to one, and back.
	deepStrictEqual(
		planText(policyPlan({ before: {}, after, policyKeys })).slice(0, 2),
		["pipeline (tartan.ci): set", "owners (tartan.review): set"],
	);
	deepStrictEqual(
		planText(policyPlan({ before, after: {}, policyKeys })).slice(0, 2),
		["pipeline (tartan.ci): removed", "owners (tartan.review): removed"],
	);
	// The same config (an edit to cuenv's env.cue): no change.
	deepStrictEqual(
		planText(policyPlan({ before, after: before, policyKeys })),
		["no change"],
	);
});

Deno.test("retirement (ADR repo config): no runtime source under src, extensions or packages reads .tartan/pipeline.yaml or .tartan/owners.yaml", async () => {
	const root = new URL("../../../", import.meta.url);
	// A quoted path literal or the retired constants; shipped migrations are
	// forward-only history, and tests may name the old paths to prove them dead.
	const reader =
		/["'`]\.tartan\/(?:pipeline|owners)\.ya?ml["'`]|\b(?:PIPELINE_PATH|OWNERS_PATH)\b/;
	const skip = (path: string): boolean =>
		/(?:^|\/)(?:node_modules|test|testing|testdata|fixtures|dist)(?:\/|$)/.test(
			path,
		) || /\.test\.ts$/.test(path);
	const offenders: string[] = [];
	const walk = async (dir: string): Promise<void> => {
		for await (const entry of Deno.readDir(new URL(dir, root))) {
			const path = `${dir}/${entry.name}`;
			if (skip(path)) continue;
			if (entry.isDirectory) await walk(path);
			else if (/\.(?:ts|vue|json)$/.test(entry.name)) {
				const text = await Deno.readTextFile(new URL(path, root));
				if (reader.test(text)) offenders.push(path);
			}
		}
	};
	for (const dir of ["src", "extensions", "packages"]) await walk(dir);
	deepStrictEqual(offenders, []);
});
