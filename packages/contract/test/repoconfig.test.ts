// Repository config contract (ADR repo config): the policy predicate, the
// tartan.cue-eval/1 envelope checks and the manifest's repo-config rules.

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
	CUE_EVAL_CONTRACT,
	CUE_EVALUATOR_ID,
	cuePreviewSandboxName,
	cueSid,
	isPolicyPath,
	manifestPolicyIssues,
	parseEvalResponse,
	parseManifest,
	previewSandboxIndex,
	REPO_CONFIG_FILE_RE,
	REPO_CONFIG_LIMITS,
	repoConfigManifestIssues,
} from "../src/index.ts";

const base = {
	version: CUE_EVAL_CONTRACT,
	evaluator: CUE_EVALUATOR_ID,
	cueVersion: "v0.17.1",
};

Deno.test("isPolicyPath: every root *.cue file of any package, byte for byte (ADR repo config)", () => {
	ok(isPolicyPath("tartan.cue"));
	ok(isPolicyPath("env.cue"));
	ok(isPolicyPath("_x.cue"));
	ok(isPolicyPath("a\u2028.cue"));
	ok(!isPolicyPath("sub/x.cue"));
	ok(!isPolicyPath("./tartan.cue"));
	ok(!isPolicyPath("tartan.CUE"));
	ok(!isPolicyPath(".tartan"));
	ok(!isPolicyPath(".tartan/extensions.cue"));
	// Anything under a root entry named *.cue (the policy digest and
	// the evaluator's file rule both see that entry).
	ok(isPolicyPath("schema.cue/README.md"));
	ok(isPolicyPath("x.cue/y/z.ts"));
	ok(!isPolicyPath("services/x.cue/y"));
	ok(!isPolicyPath(".tartan/owners.yaml"));
	ok(!isPolicyPath(""));
});

Deno.test("the root file-name rule is ASCII only and has no line terminator", () => {
	ok(REPO_CONFIG_FILE_RE.test("tartan.cue"));
	ok(REPO_CONFIG_FILE_RE.test("review_2.cue"));
	// Names the CLI skips are still sent (it decides), so they pass.
	ok(REPO_CONFIG_FILE_RE.test("_scratch.cue"));
	ok(REPO_CONFIG_FILE_RE.test(".hidden.cue"));
	ok(!REPO_CONFIG_FILE_RE.test("a\u2028.cue"));
	ok(!REPO_CONFIG_FILE_RE.test("a b.cue"));
	ok(!REPO_CONFIG_FILE_RE.test("~tartan.cue"));
	ok(!REPO_CONFIG_FILE_RE.test("sub/x.cue"));
	ok(!REPO_CONFIG_FILE_RE.test("x.yaml"));
});

Deno.test("cueSid and the preview sandbox", () => {
	equal(cueSid("acme.no-secrets"), "acme_no_secrets");
	equal(cueSid("tartan.weave"), "tartan_weave");
	equal(cuePreviewSandboxName(previewSandboxIndex("ag_x")), "cue:preview:0");
	ok(previewSandboxIndex("ag_x", 4) < 4);
});

Deno.test("parseEvalResponse accepts both envelopes", () => {
	const okEnv = parseEvalResponse(
		JSON.stringify({ ...base, ok: { extensions: {} }, issues: [] }),
	);
	ok("ok" in okEnv);
	const err = parseEvalResponse({
		...base,
		error: { code: "BUILD_VALUE", message: "1 error" },
		issues: [{
			path: 'extensions."tartan.weave".settings.batch',
			msg: "invalid value 12 (out of bound <=4)",
			pos: [".tartan/extensions.cue:3:40"],
		}],
	});
	ok("error" in err && err.error.code === "BUILD_VALUE");
	equal(err.issues.length, 1);
});

Deno.test("parseEvalResponse refuses violations as INTERNAL, sizes as LIMIT_EXCEEDED", () => {
	const bad = parseEvalResponse("{not json");
	ok("error" in bad && bad.error.code === "INTERNAL");
	const extra = parseEvalResponse({ ...base, ok: 1, issues: [], extra: 1 });
	ok("error" in extra && extra.error.code === "INTERNAL");
	const wrong = parseEvalResponse({
		...base,
		error: { code: "NOPE", message: "x" },
		issues: [],
	});
	ok("error" in wrong && wrong.error.code === "INTERNAL");
	const pos = parseEvalResponse({
		...base,
		error: { code: "BUILD_VALUE", message: "x" },
		issues: [{ path: "", msg: "x", pos: ["no position"] }],
	});
	ok("error" in pos && pos.error.code === "INTERNAL");
	const huge = parseEvalResponse(
		"x".repeat(REPO_CONFIG_LIMITS.jsonBytes + 600 * 1024),
	);
	ok("error" in huge && huge.error.code === "LIMIT_EXCEEDED");
	let deep: unknown = 1;
	for (let i = 0; i < 40; i++) deep = { d: deep };
	const tooDeep = parseEvalResponse({ ...base, ok: deep, issues: [] });
	ok("error" in tooDeep && tooDeep.error.code === "LIMIT_EXCEEDED");
});

const manifest = (over: Record<string, unknown>) => {
	const parsed = parseManifest({
		schema: 1,
		id: "acme.thing",
		name: "Thing",
		version: "0.1.0",
		api: "tartan:ext@0.1.0",
		runtime: "js",
		entry: { js: "index.js" },
		storage: { scope: "repo" },
		permissions: {},
		...over,
	});
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.manifest;
};

Deno.test("manifest: repoOverridable needs config.cue and default keys", () => {
	deepStrictEqual(
		repoConfigManifestIssues(manifest({
			config: {
				default: { batch: 4 },
				cue: "config/settings.cue",
				repoOverridable: ["batch"],
			},
		})),
		[],
	);
	const issues = repoConfigManifestIssues(manifest({
		config: { default: { batch: 4 }, repoOverridable: ["batch", "nope"] },
	}));
	ok(issues.some((i) => i.includes("needs config.cue")));
	ok(issues.some((i) => i.includes("nope is not in config.default")));
});

Deno.test("manifest: no overridable keys with gates, review@1, checks@1 or targets", () => {
	const config = {
		default: { batch: 4, notify: "x" },
		cue: "config/settings.cue",
		repoOverridable: ["batch", "notify"],
		targets: ["notify"],
	};
	const gated = repoConfigManifestIssues(manifest({
		config,
		gates: [{ point: "ref.advance" }],
	}));
	ok(gated.some((i) => i.includes("gates")));
	ok(gated.some((i) => i.includes("notify is a target")));
	const review = manifestPolicyIssues(
		manifest({ config, provides: ["review@1"] }),
		{ bundled: false },
	);
	ok(review.some((i) => i.includes("review@1 provider")));
});

Deno.test("manifest: config.cue must be package-relative", () => {
	for (const cue of ["../x.cue", "/abs.cue", "a/../b.cue", "x.json"]) {
		ok(
			!parseManifest({
				schema: 1,
				id: "acme.thing",
				name: "Thing",
				version: "0.1.0",
				api: "tartan:ext@0.1.0",
				runtime: "js",
				entry: { js: "index.js" },
				storage: { scope: "repo" },
				permissions: {},
				config: { cue },
			}).ok,
			cue,
		);
	}
});
