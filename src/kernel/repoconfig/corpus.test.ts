// Repository config against the real CUE v0.17.1 CLI (ADR repo config,
// "Testing"): the corpus through tartan.cue-eval/1
// with the `cli.ts` evaluator (the production classifier behind it),
// compared with a direct `cue export .:tartan` of the same files, the CLI's
// package selection among root files, the import rule, and the schema
// layout of `generateSchema`. Needs `CUE_BIN` pointing at cue v0.17.1;
// skipped (with a message) without it.

import {
	deepStrictEqual,
	equal,
	match,
	notEqual,
	ok,
} from "node:assert/strict";
import {
	CUE_EVAL_CONTRACT,
	CUE_EVALUATOR_ID,
	DEFAULT_EVAL_LIMITS,
	type EvalResponse,
	FORGE_BINDING_FILE,
	isEvalOk,
	REPO_CONFIG_LIMITS,
	REPO_CONFIG_POSITION_RE,
} from "@tartan/contract";
import { MONOREPO_TARTAN_FILES } from "@tartan/testkit";
import { settingsCue as ciSettings } from "../../../extensions/ci/src/settings-cue.ts";
import ciManifest from "../../../extensions/ci/tartan.json" with {
	type: "json",
};
import { settingsCue as reviewSettings } from "../../../extensions/review/src/settings-cue.ts";
import reviewManifest from "../../../extensions/review/tartan.json" with {
	type: "json",
};
import { settingsCue as weaveSettings } from "../../../extensions/weave/src/settings-cue.ts";
import weaveManifest from "../../../extensions/weave/tartan.json" with {
	type: "json",
};
import { validatePipeline } from "../../../extensions/ci/src/pipeline/schema.ts";
import { validateOwners } from "../../../extensions/review/src/owners.ts";
import { checkResolved } from "../exthost/registry/repoconfig/check.ts";
import {
	generateSchema,
	selfCheckInput,
} from "../exthost/registry/repoconfig/schemagen.ts";
import { createCliEvaluator } from "./evaluators/cli.ts";
import { normalizeCueErrors } from "./issues.ts";
import {
	caseRequest,
	CORPUS_SCHEMA,
	cueBin,
	NO_SECRETS_SETTINGS,
	oracleExport,
} from "./testing/corpus.ts";

const BIN = cueBin();
if (BIN === null) {
	console.warn(
		"corpus.test.ts: CUE_BIN is not set; the CLI-backed repository-config tests are skipped",
	);
}

const cliTest = (name: string, fn: (bin: string) => Promise<void>) =>
	Deno.test({
		name,
		ignore: BIN === null,
		sanitizeResources: false,
		fn: () => fn(BIN!),
	});

const evaluate = (bin: string) => createCliEvaluator({ cueBin: bin });

const errorOf = (r: EvalResponse) => {
	if (isEvalOk(r)) {
		throw new Error(`expected an error, got ${JSON.stringify(r.ok)}`);
	}
	return r;
};

const okOf = (r: EvalResponse) => {
	if (!isEvalOk(r)) {
		throw new Error(`expected a value, got ${JSON.stringify(r)}`);
	}
	return r.ok as Record<string, unknown>;
};

const PIPELINE = {
	timeout: "15m",
	jobs: {
		install: { run: "pnpm install --frozen-lockfile" },
		lint: {
			needs: ["install"],
			each: "affected",
			cwd: "{{project.root}}",
			run: "pnpm lint",
			optional: true,
		},
		test: {
			needs: ["install"],
			each: "affected",
			cwd: "{{project.root}}",
			run: "pnpm test",
		},
	},
	on: {
		change: ["install", "lint", "test"],
		land: ["install", "test"],
		push: { branches: ["release/*"], jobs: ["install", "test"] },
	},
	lanes: { ci: "on-submit" },
};
const OWNERS = {
	rules: [{
		paths: ["services/api/**"],
		sensitivity: 2,
		owners: ["@platform"],
	}],
};

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

cliTest(
	"corpus valid: package tartan beside cuenv's env.cue; byte-equal to the oracle; repo policy and kernel fields",
	async (bin) => {
		const req = await caseRequest("valid");
		const r = await evaluate(bin).evaluate(req);
		const value = okOf(r);
		equal(isEvalOk(r) && r.cueVersion, "v0.17.1");
		equal(isEvalOk(r) && r.evaluator, CUE_EVALUATOR_ID);
		const oracle = await oracleExport(bin, req.files);
		equal(oracle.code, 0, oracle.stderr);
		equal(JSON.stringify(value), JSON.stringify(JSON.parse(oracle.stdout)));
		deepStrictEqual(value, {
			projects: {
				shared: { root: "packages/shared" },
				api: {
					root: "services/api",
					deps: ["shared"],
					sensitive: true,
					owners: ["@platform"],
				},
				web: { root: "services/web", deps: ["shared"] },
				worker: { root: "services/worker", deps: ["shared"] },
			},
			global: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"],
			extensions: {
				"acme.labels": { enabled: true, mode: "enforce", settings: {} },
				"acme.no-secrets": {
					enabled: true,
					mode: "enforce",
					settings: {
						severity: "hunk",
						allow: ["services/api/fixtures/**", "services/web/fixtures/**"],
					},
				},
				"tartan.ci": { settings: { pipeline: PIPELINE } },
				"tartan.review": { settings: { owners: OWNERS } },
				// An unset optional overlay field (debounceMs) is not exported.
				"tartan.weave": { settings: { batch: 2 } },
			},
		});
		// The extensions' own validators accept what CUE exported (CUE is
		// never the boundary; they check again).
		const ext = value.extensions as Record<
			string,
			{ settings: Record<string, unknown> }
		>;
		ok(validatePipeline(ext["tartan.ci"].settings.pipeline).ok);
		ok(validateOwners(ext["tartan.review"].settings.owners).ok);
	},
);

cliTest(
	"corpus invalid and invalid-closed: the issues equal the oracle's errors, positioned in root files",
	async (bin) => {
		for (const name of ["invalid", "invalid-closed"]) {
			const req = await caseRequest(name);
			const r = errorOf(await evaluate(bin).evaluate(req));
			equal(r.error.code, "BUILD_VALUE", name);
			const oracle = await oracleExport(bin, req.files);
			equal(oracle.code, 1, name);
			deepStrictEqual(r.issues, normalizeCueErrors(oracle.stderr), name);
		}
		const invalid = errorOf(
			await evaluate(bin).evaluate(await caseRequest("invalid")),
		);
		const msgs = invalid.issues.map((i) => `${i.path}: ${i.msg}`);
		ok(
			msgs.includes(
				'extensions."acme.no-secrets".settings.colour: field not allowed',
			),
		);
		ok(
			msgs.includes(
				'extensions."tartan.weave".settings.batch: invalid value 12 (out of bound <=4)',
			),
		);
		ok(
			msgs.some((m) =>
				m.startsWith(
					'extensions."acme.no-secrets".enabled: conflicting values "yes"',
				)
			),
		);
		// A bound error keeps positions in the repo's root file and in the
		// extension's own file.
		const bound = invalid.issues.find((i) =>
			i.msg.startsWith("invalid value 12")
		)!;
		deepStrictEqual(bound.pos, [
			"cue.mod/pkg/tartan.dev/ext/x/tartan_weave/settings.cue:8:21",
			"tartan.cue:8:46",
		]);
		match(invalid.error.message, /conflicting values "yes" and bool/);
		const closed = errorOf(
			await evaluate(bin).evaluate(await caseRequest("invalid-closed")),
		);
		deepStrictEqual(closed.issues, [
			{
				path: 'extensions."acme.unknown"',
				msg: "field not allowed",
				pos: ["tartan.cue:3:13"],
			},
			{
				path: 'extensions."tartan.weave".enabled',
				msg: "field not allowed",
				pos: ["tartan.cue:5:29"],
			},
			{
				path: 'extensions."tartan.weave".settings.resolver',
				msg: "field not allowed",
				pos: ["tartan.cue:7:39"],
			},
		]);
	},
);

cliTest(
	"corpus nesting and string: CUE's own guards, as the oracle reports them",
	async (bin) => {
		const nesting = errorOf(
			await evaluate(bin).evaluate(await caseRequest("pathological-nesting")),
		);
		equal(nesting.error.code, "LOAD_INSTANCE");
		equal(
			nesting.issues[0].msg,
			"expression exceeds maximum nesting depth of 10000",
		);
		match(nesting.issues[0].pos[0], /^tartan\.cue:3:\d+$/);
		const str = errorOf(
			await evaluate(bin).evaluate(await caseRequest("pathological-string")),
		);
		equal(str.error.code, "BUILD_VALUE");
		match(str.issues[0].msg, /^error in call to strings\.Repeat/);
		deepStrictEqual(str.issues[0].pos, ["tartan.cue:6:50"]);
	},
);

cliTest(
	"corpus comprehension: killed at the 10 s wall clock (TIMEOUT)",
	async (bin) => {
		const started = Date.now();
		const r = errorOf(
			await evaluate(bin).evaluate(
				await caseRequest("pathological-comprehension"),
			),
		);
		equal(r.error.code, "TIMEOUT");
		ok(Date.now() - started < 15_000);
	},
);

cliTest(
	"corpus doubling: TIMEOUT or LIMIT_EXCEEDED (a short wall clock here; no RLIMIT_AS on this host)",
	async (bin) => {
		const r = errorOf(
			await evaluate(bin).evaluate(
				await caseRequest("pathological-doubling", { wallClockS: 3 }),
			),
		);
		ok(["TIMEOUT", "LIMIT_EXCEEDED"].includes(r.error.code), r.error.code);
	},
);

cliTest(
	"corpus export over the file cap: LIMIT_EXCEEDED, never BUILD_VALUE, and no temporary path",
	async (bin) => {
		const r = errorOf(
			await evaluate(bin).evaluate(await caseRequest("pathological-export")),
		);
		// cue ignores SIGXFSZ: its write fails (EFBIG) and it exits 1, which
		// must not read as BUILD_VALUE naming the job directory. A `CUE_BIN`
		// that runs cue in a container escapes the shell's file cap, so the
		// JSON size limit may answer instead; both are LIMIT_EXCEEDED
		// (`evaluators/cli.test.ts` pins the file cap itself).
		equal(r.error.code, "LIMIT_EXCEEDED", JSON.stringify(r));
		match(r.error.message, /file cap|exported JSON of \d+ bytes/);
		ok(!/tartan-cue-|out\.json/.test(JSON.stringify(r)), JSON.stringify(r));
	},
);

cliTest(
	"corpus flood: inside the wall clock, at most 64 KiB of error text reaches the host",
	async (bin) => {
		const r = errorOf(await evaluate(bin).evaluate(await caseRequest("flood")));
		// 5,000 errors, sized so the error-text cap is what stops it, not the
		// wall clock (CUE's error collection grows with the square of the
		// count, so 50,000 errors could only TIMEOUT).
		ok(["BUILD_VALUE", "LIMIT_EXCEEDED"].includes(r.error.code), r.error.code);
		const text = JSON.stringify(r.issues) + r.error.message;
		ok(
			text.length <= REPO_CONFIG_LIMITS.stderrBytes + 16 * 1024,
			`${text.length}`,
		);
		ok(r.issues.length <= REPO_CONFIG_LIMITS.issues);
	},
);

// ---------------------------------------------------------------------------
// Package selection and the import rule
// ---------------------------------------------------------------------------

cliTest(
	"package selection: the CLI loads only package tartan; _x, *_tool, *_test, @if and package-less files are left out",
	async (bin) => {
		const req = await caseRequest("package-selection");
		const value = okOf(await evaluate(bin).evaluate(req));
		const oracle = await oracleExport(bin, req.files);
		equal(oracle.code, 0, oracle.stderr);
		deepStrictEqual(value, JSON.parse(oracle.stdout));
		// tartan.cue, ci.cue, review.cue and commented.cue (a comment naming
		// another package before `package tartan`) only; `bogus` is in every
		// file the CLI skips.
		deepStrictEqual(value, {
			projects: { api: { root: "services/api" } },
			global: ["go.work"],
			extensions: {
				"tartan.ci": { settings: { pipeline: PIPELINE } },
				"tartan.review": { settings: { owners: OWNERS } },
			},
		});
	},
);

cliTest(
	"package selection: only another package (or no package tartan) exports {}",
	async (bin) => {
		const value = okOf(
			await evaluate(bin).evaluate(await caseRequest("other-only")),
		);
		deepStrictEqual(value, {});
	},
);

cliTest(
	"import rule: a registry module, the repo's own module or a guessed job module is INVALID_INPUT naming the import and its position",
	async (bin) => {
		const cases: [string, string, string][] = [
			["import-registry", "github.com/acme/schemas/ci", "ci.cue:3:8"],
			[
				"import-repo-module",
				"example.com/acme/platform/schemas",
				"tartan.cue:4:8",
			],
			// Anything shaped like a job's module path is normalized to `<module>`.
			["import-job-module", "<module>", "tartan.cue:4:8"],
		];
		for (const [name, imported, position] of cases) {
			const r = errorOf(
				await evaluate(bin).evaluate(await caseRequest(name)),
			);
			equal(r.error.code, "INVALID_INPUT", name);
			equal(
				r.error.message,
				`package tartan may import only the CUE standard library and tartan.dev/ext: \`${position}\` imports \`${imported}\``,
				name,
			);
		}
		// The standard library resolves.
		deepStrictEqual(
			okOf(await evaluate(bin).evaluate(await caseRequest("import-stdlib"))),
			{ global: ["package.json"] },
		);
	},
);

cliTest(
	"@embed: a parent path is refused; a file that was never sent fails",
	async (bin) => {
		const parent = errorOf(
			await evaluate(bin).evaluate(await caseRequest("embed-parent")),
		);
		equal(parent.error.code, "LOAD_INSTANCE");
		ok(
			parent.issues.some((i) => /cannot refer to parent directory/.test(i.msg)),
		);
		const nonroot = errorOf(
			await evaluate(bin).evaluate(await caseRequest("embed-nonroot")),
		);
		equal(nonroot.error.code, "LOAD_INSTANCE");
		ok(nonroot.issues.some((i) => /no such file/.test(i.msg)));
	},
);

cliTest(
	"two jobs get different module paths; normalized messages are identical",
	async (bin) => {
		const req = await caseRequest("import-registry");
		const a = errorOf(await evaluate(bin).evaluate(req));
		const b = errorOf(await evaluate(bin).evaluate(req));
		deepStrictEqual(a.issues, b.issues);
		equal(a.error.message, b.error.message);
		// The raw oracle text carries a per-job module path; ours carries `<module>`.
		const raw1 = await oracleExport(bin, req.files);
		const raw2 = await oracleExport(bin, req.files);
		notEqual(raw1.stderr, raw2.stderr);
		ok(a.issues.every((i) => !/tartan\.local\/j/.test(i.path + i.msg)));
		ok(a.issues.some((i) => i.path === "<module>"));
	},
);

// ---------------------------------------------------------------------------
// The schema layout
// ---------------------------------------------------------------------------

const request = (
	files: Readonly<Record<string, string>>,
	repo: string,
	name = "tartan.cue",
) => ({
	version: CUE_EVAL_CONTRACT,
	evaluator: CUE_EVALUATOR_ID,
	inputKey: "0".repeat(64),
	files: { ...files, [name]: `package tartan\n\n${repo}\n` },
	limits: DEFAULT_EVAL_LIMITS,
});

cliTest(
	"schema: an unknown id, mode on an in-force entry and a provider as an own install are positioned 'field not allowed'",
	async (bin) => {
		// tartan.fifo (a provider) and acme.inherited (installed above, no
		// opt-in, no repo policy) are not in the schema at all.
		for (const id of ["tartan.fifo", "acme.inherited"]) {
			const r = errorOf(
				await evaluate(bin).evaluate(
					request(CORPUS_SCHEMA.files, `extensions: "${id}": mode: "shadow"`),
				),
			);
			deepStrictEqual(
				r.issues.map((i) => [i.path, i.msg, i.pos[0]]),
				[[`extensions."${id}"`, "field not allowed", "tartan.cue:3:13"]],
			);
		}
		// tartan.review (a gate and a provider) is in force with repo policy:
		// only `settings` exists, so `mode` (the K8 case) is not allowed.
		for (const id of ["tartan.review", "tartan.weave", "tartan.ci"]) {
			const r = errorOf(
				await evaluate(bin).evaluate(
					request(CORPUS_SCHEMA.files, `extensions: "${id}": mode: "shadow"`),
				),
			);
			deepStrictEqual(
				r.issues.map((i) => [i.path, i.msg, i.pos[0]]),
				[[
					`extensions."${id}".mode`,
					"field not allowed",
					`tartan.cue:3:${17 + id.length}`,
				]],
			);
		}
	},
);

cliTest(
	"schema: two import levels keep 'field not allowed' positions in the repo's root file",
	async (bin) => {
		const r = errorOf(
			await evaluate(bin).evaluate(
				request(
					CORPUS_SCHEMA.files,
					'extensions: "acme.no-secrets": settings: severity: "hunk"\nextensions: "acme.no-secrets": settings: extra: 1',
					"policy.cue",
				),
			),
		);
		deepStrictEqual(r.issues, [{
			path: 'extensions."acme.no-secrets".settings.extra',
			msg: "field not allowed",
			pos: ["policy.cue:4:42"],
		}]);
		ok(REPO_CONFIG_POSITION_RE.test(r.issues[0].pos[0]));
	},
);

cliTest(
	"schema: {#Settings, #Policy} accept both key sets; an in-force entry takes only its policy and overridable keys",
	async (bin) => {
		const pipeline = await evaluate(bin).evaluate(
			request(
				CORPUS_SCHEMA.files,
				'extensions: "tartan.ci": settings: pipeline: jobs: test: run: "deno task test"',
			),
		);
		deepStrictEqual(okOf(pipeline), {
			extensions: {
				"tartan.ci": {
					settings: { pipeline: { jobs: { test: { run: "deno task test" } } } },
				},
			},
		});
		// tartan.ci's installation settings (`image`) are not repo policy.
		const image = errorOf(
			await evaluate(bin).evaluate(
				request(
					CORPUS_SCHEMA.files,
					'extensions: "tartan.ci": settings: image: "x"',
				),
			),
		);
		deepStrictEqual(image.issues.map((i) => [i.path, i.msg]), [[
			'extensions."tartan.ci".settings.image',
			"field not allowed",
		]]);
		// A pipeline's own closedness and bounds give positioned errors.
		const typo = errorOf(
			await evaluate(bin).evaluate(
				request(
					CORPUS_SCHEMA.files,
					'extensions: "tartan.ci": settings: pipeline: {jobs: test: {run: "x", needz: []}, timeout: "15 minutes"}',
				),
			),
		);
		ok(typo.issues.some((i) => i.path.endsWith("jobs.test.needz")));
		ok(typo.issues.some((i) => i.path.endsWith("pipeline.timeout")));
		// The owners' sensitivity bound.
		const owners = errorOf(
			await evaluate(bin).evaluate(
				request(
					CORPUS_SCHEMA.files,
					'extensions: "tartan.review": settings: owners: rules: [{paths: ["a/**"], sensitivity: 7}]',
				),
			),
		);
		ok(owners.issues.some((i) => /out of bound <=3/.test(i.msg)));
	},
);

cliTest(
	"schema: an overlay sets only its overridable keys; unset ones are never exported",
	async (bin) => {
		deepStrictEqual(
			okOf(
				await evaluate(bin).evaluate(
					request(
						CORPUS_SCHEMA.files,
						'extensions: "tartan.weave": settings: {}',
					),
				),
			),
			{ extensions: { "tartan.weave": { settings: {} } } },
		);
		deepStrictEqual(
			okOf(
				await evaluate(bin).evaluate(
					request(
						CORPUS_SCHEMA.files,
						'extensions: "tartan.weave": settings: {batch: 1, debounceMs: 0}',
					),
				),
			),
			{
				extensions: {
					"tartan.weave": { settings: { batch: 1, debounceMs: 0 } },
				},
			},
		);
		const bound = errorOf(
			await evaluate(bin).evaluate(
				request(
					CORPUS_SCHEMA.files,
					'extensions: "tartan.weave": settings: debounceMs: -1',
				),
			),
		);
		ok(
			bound.issues.some((i) => i.msg === "invalid value -1 (out of bound >=0)"),
		);
	},
);

cliTest(
	"schema: an unknown top-level field is exported by CUE and denied `shape` by the kernel, with the hint",
	async (bin) => {
		const value = okOf(
			await evaluate(bin).evaluate(
				request(CORPUS_SCHEMA.files, 'pipeline: jobs: test: run: "true"'),
			),
		);
		deepStrictEqual(value, { pipeline: { jobs: { test: { run: "true" } } } });
		const checked = checkResolved(value, {
			repo: { id: "n_repo", path: "rawkode/api" },
			ancestors: [],
			here: [],
			approvals: new Map(),
			packageOf: () => null,
			packageAnyOf: () => null,
			overlays: [],
		});
		equal(checked.denials.length, 1);
		equal(checked.denials[0].code, "shape");
		equal(checked.denials[0].path, "pipeline");
		match(
			checked.denials[0].message,
			/extensions: "tartan\.ci": settings: pipeline/,
		);
	},
);

cliTest(
	"schema: a hidden helper and definitions are not exported; a repo cannot reach outside the module",
	async (bin) => {
		deepStrictEqual(
			okOf(
				await evaluate(bin).evaluate(
					request(
						CORPUS_SCHEMA.files,
						'_x: 2\n#Def: {a: 1}\nextensions: "tartan.weave": settings: batch: _x',
					),
				),
			),
			{ extensions: { "tartan.weave": { settings: { batch: 2 } } } },
		);
		const escape = errorOf(
			await evaluate(bin).evaluate(
				request(
					CORPUS_SCHEMA.files,
					'@extern(embed)\n\nx: _ @embed(file="../cue.mod/module.cue")',
				),
			),
		);
		ok(["LOAD_INSTANCE", "BUILD_VALUE"].includes(escape.error.code));
	},
);

const selfCheck = async (
	bin: string,
	pkg: Parameters<typeof selfCheckInput>[0],
) =>
	await evaluate(bin).evaluate({
		version: CUE_EVAL_CONTRACT,
		evaluator: CUE_EVALUATOR_ID,
		inputKey: "0".repeat(64),
		files: selfCheckInput(pkg),
		limits: DEFAULT_EVAL_LIMITS,
	});

cliTest(
	"self-check: Weave, tartan.ci (#Policy.pipeline), tartan.review (#Policy.owners) and a settings-less package give config.default",
	async (bin) => {
		const own = (extId: string, settings: unknown) => ({
			extensions: { [extId]: { enabled: true, mode: "enforce", settings } },
		});
		deepStrictEqual(
			okOf(
				await selfCheck(bin, {
					extId: "tartan.weave",
					version: "0.1.0",
					settingsCue: weaveSettings,
					repoPolicy: [],
				}),
			),
			own("tartan.weave", weaveManifest.config.default),
		);
		deepStrictEqual(
			okOf(
				await selfCheck(bin, {
					extId: "tartan.ci",
					version: "0.1.0",
					settingsCue: ciSettings,
					repoPolicy: ciManifest.config.repoPolicy,
				}),
			),
			own("tartan.ci", ciManifest.config.default),
		);
		deepStrictEqual(
			okOf(
				await selfCheck(bin, {
					extId: "tartan.review",
					version: "0.1.0",
					settingsCue: reviewSettings,
					repoPolicy: reviewManifest.config.repoPolicy,
				}),
			),
			own("tartan.review", reviewManifest.config.default),
		);
		deepStrictEqual(
			okOf(
				await selfCheck(bin, {
					extId: "acme.labels",
					version: "1.0.0",
					settingsCue: null,
					repoPolicy: [],
				}),
			),
			own("acme.labels", {}),
		);
		// An open list exports as `[]`: the package's config.default must say so.
		deepStrictEqual(
			okOf(
				await selfCheck(bin, {
					extId: "acme.no-secrets",
					version: "0.2.0",
					settingsCue: NO_SECRETS_SETTINGS,
					repoPolicy: [],
				}),
			),
			own("acme.no-secrets", { severity: "hunk", allow: [] }),
		);
	},
);

cliTest(
	"self-check: a #Policy without a declared key, or with a required field, fails",
	async (bin) => {
		const missing = errorOf(
			await selfCheck(bin, {
				extId: "acme.policy",
				version: "1.0.0",
				settingsCue:
					"package settings\n\n#Settings: {}\n#Policy: {other?: string}\n",
				repoPolicy: ["rules"],
			}),
		);
		equal(missing.error.code, "BUILD_VALUE");
		ok(missing.issues.some((i) => /field not allowed/.test(i.msg)));
		// A required #Policy field shows up in `settings`: not config.default.
		const required = okOf(
			await selfCheck(bin, {
				extId: "acme.policy",
				version: "1.0.0",
				settingsCue:
					'package settings\n\n#Settings: {}\n#Policy: {rules: [...string] | *["x"]}\n',
				repoPolicy: ["rules"],
			}),
		);
		deepStrictEqual(required, {
			extensions: {
				"acme.policy": {
					enabled: true,
					mode: "enforce",
					settings: { rules: ["x"] },
				},
			},
		});
	},
);

cliTest(
	"schema: generation is deterministic; the binding file is ~tartan.cue; the export runs locally from the files alone",
	async (bin) => {
		const installs = CORPUS_SCHEMA.entries.flatMap((e) =>
			e.kind === "install"
				? [{
					extId: e.extId,
					version: e.version,
					settingsCue: e.extId === "acme.no-secrets"
						? NO_SECRETS_SETTINGS
						: null,
					approvalNode: "n_root",
					hasGates: e.extId === "acme.no-secrets",
					repoPolicy: [],
				}]
				: []
		).reverse();
		const again = generateSchema({
			installs,
			inForce: [
				{
					extId: "tartan.review",
					version: "0.1.0",
					settingsCue: reviewSettings,
					installationId: "i_01k6cccccccccccccccccccccc",
					nodePath: "rawkode",
					repoPolicy: ["owners"],
					overridable: [],
				},
				{
					extId: "tartan.ci",
					version: "0.1.0",
					settingsCue: ciSettings,
					installationId: "i_01k6bbbbbbbbbbbbbbbbbbbbbb",
					nodePath: "rawkode",
					repoPolicy: ["pipeline"],
					overridable: [],
				},
				{
					extId: "tartan.weave",
					version: "0.1.0",
					settingsCue: weaveSettings,
					installationId: "i_01k6aaaaaaaaaaaaaaaaaaaaaa",
					nodePath: "rawkode",
					repoPolicy: [],
					overridable: ["debounceMs", "batch"],
				},
			],
		});
		equal(again.schemaKey, CORPUS_SCHEMA.schemaKey);
		deepStrictEqual(again.files, CORPUS_SCHEMA.files);
		ok(Object.hasOwn(CORPUS_SCHEMA.files, FORGE_BINDING_FILE));
		ok(!Object.hasOwn(CORPUS_SCHEMA.files, "cue.mod/module.cue"));
		const req = await caseRequest("valid");
		const oracle = await oracleExport(bin, req.files);
		equal(oracle.code, 0);
	},
);

// ---------------------------------------------------------------------------
// The demo monorepo's package tartan (`@tartan/testkit` MONOREPO_TARTAN_FILES)
// ---------------------------------------------------------------------------

/** What the demo's ci.cue and review.cue export (env.cue is package cuenv). */
const DEMO_EXPECTED = {
	extensions: {
		"tartan.ci": {
			settings: {
				pipeline: {
					timeout: "15m",
					jobs: {
						install: { run: "pnpm install --frozen-lockfile" },
						test: {
							needs: ["install"],
							each: "affected",
							cwd: "{{project.root}}",
							run: "pnpm test",
						},
					},
					on: { change: ["install", "test"], land: ["install", "test"] },
					lanes: { ci: "on-submit" },
				},
			},
		},
		"tartan.review": {
			settings: {
				owners: {
					rules: [
						{ paths: ["services/api/**"], sensitivity: 2 },
						{ paths: ["packages/shared/**"], sensitivity: 1 },
					],
				},
			},
		},
	},
};

Deno.test("the demo config's values pass tartan.ci's and tartan.review's own validators", () => {
	const ext = DEMO_EXPECTED.extensions;
	const pipeline = validatePipeline(ext["tartan.ci"].settings.pipeline);
	ok(pipeline.ok, JSON.stringify(pipeline));
	const owners = validateOwners(ext["tartan.review"].settings.owners);
	ok(owners.ok, JSON.stringify(owners));
});

cliTest(
	"the demo monorepo's package tartan evaluates beside cuenv's env.cue, byte-equal to the oracle",
	async (bin) => {
		const req = {
			...(await caseRequest("valid")),
			files: { ...CORPUS_SCHEMA.files, ...MONOREPO_TARTAN_FILES },
		};
		const value = okOf(await evaluate(bin).evaluate(req));
		deepStrictEqual(value, DEMO_EXPECTED);
		const oracle = await oracleExport(bin, req.files);
		equal(oracle.code, 0, oracle.stderr);
		deepStrictEqual(value, JSON.parse(oracle.stdout));
	},
);
