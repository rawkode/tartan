// Test-only: the repository-config corpus (testdata/corpus) as evaluation
// requests over the schema `generateSchema` builds for its fixture
// registry, and a direct `cue export .:tartan` of the same files (the
// oracle the evaluator must match). Each case directory holds a
// repository's ROOT `*.cue` files (ADR repo config: Tartan config is the root
// package `tartan`; other packages may sit beside it). Used by
// corpus.test.ts and the runner image test.

import {
	CUE_EVAL_CONTRACT,
	CUE_EVALUATOR_ID,
	DEFAULT_EVAL_LIMITS,
	type EvalLimits,
	type EvalRequest,
	forgeModuleFile,
} from "@tartan/contract";
import { settingsCue as ciSettings } from "../../../../extensions/ci/src/settings-cue.ts";
import { settingsCue as reviewSettings } from "../../../../extensions/review/src/settings-cue.ts";
import { settingsCue as weaveSettings } from "../../../../extensions/weave/src/settings-cue.ts";
import { generateSchema } from "../../exthost/registry/repoconfig/schemagen.ts";
import { freshModulePath } from "../evaluators/cli.ts";

/** acme.no-secrets' settings file (the third-party demo package, 0.2.0). */
export const NO_SECRETS_SETTINGS = `package settings

#Settings: {
	severity: "path" | *"hunk"
	allow: [...string]
}
`;

/**
 * The fixture registry's schema: two own installs (`acme.no-secrets` with a
 * `config.cue`, `acme.labels` without), and three installations in force
 * above the repository: Weave with repo overrides on (`batch`,
 * `debounceMs`), `tartan.ci` (repo policy `pipeline`) and `tartan.review`
 * (repo policy `owners`).
 */
export const CORPUS_SCHEMA = generateSchema({
	installs: [
		{
			extId: "acme.no-secrets",
			version: "0.2.0",
			settingsCue: NO_SECRETS_SETTINGS,
			approvalNode: "n_root",
			hasGates: true,
			repoPolicy: [],
		},
		{
			extId: "acme.labels",
			version: "1.0.0",
			settingsCue: null,
			approvalNode: "n_root",
			hasGates: false,
			repoPolicy: [],
		},
	],
	inForce: [
		{
			extId: "tartan.weave",
			version: "0.1.0",
			settingsCue: weaveSettings,
			installationId: "i_01k6aaaaaaaaaaaaaaaaaaaaaa",
			nodePath: "rawkode",
			repoPolicy: [],
			overridable: ["batch", "debounceMs"],
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
			extId: "tartan.review",
			version: "0.1.0",
			settingsCue: reviewSettings,
			installationId: "i_01k6cccccccccccccccccccccc",
			nodePath: "rawkode",
			repoPolicy: ["owners"],
			overridable: [],
		},
	],
});

const CORPUS = new URL("../testdata/corpus/", import.meta.url);

export const CASES = [
	"valid",
	"package-selection",
	"other-only",
	"import-registry",
	"import-repo-module",
	"import-job-module",
	"import-stdlib",
	"embed-parent",
	"embed-nonroot",
	"invalid",
	"invalid-closed",
	"pathological-comprehension",
	"pathological-doubling",
	"pathological-string",
	"pathological-export",
	"flood",
] as const;

/** 50,000 nested struct literals: CUE's parser refuses past 10,000. */
export const nestingCase = (depth = 50_000): string =>
	`package tartan\n\nextensions: "acme.labels": settings: x: ${
		"{a: ".repeat(depth)
	}1${"}".repeat(depth)}\n`;

/** The repository's root files of a case (`<name>.cue` → text). */
export const caseFiles = async (
	name: string,
): Promise<Record<string, string>> => {
	if (name === "pathological-nesting") {
		return { "tartan.cue": nestingCase() };
	}
	const out: Record<string, string> = {};
	for await (const entry of Deno.readDir(new URL(`${name}/`, CORPUS))) {
		if (!entry.isFile || !entry.name.endsWith(".cue")) continue;
		out[entry.name] = await Deno.readTextFile(
			new URL(`${name}/${entry.name}`, CORPUS),
		);
	}
	return out;
};

export const caseRequest = async (
	name: string,
	limits: Partial<EvalLimits> = {},
): Promise<EvalRequest> => ({
	version: CUE_EVAL_CONTRACT,
	evaluator: CUE_EVALUATOR_ID,
	inputKey: "0".repeat(64),
	files: { ...CORPUS_SCHEMA.files, ...(await caseFiles(name)) },
	limits: { ...DEFAULT_EVAL_LIMITS, ...limits },
});

/**
 * The oracle: `cue export -E --out json .:tartan` of the request's files in
 * a fresh module directory (with a module file of its own), nothing else
 * (no limits, no classification), killed after `timeoutMs`.
 */
export const oracleExport = async (
	cueBin: string,
	files: Readonly<Record<string, string>>,
	timeoutMs = 20_000,
): Promise<{ code: number; stdout: string; stderr: string }> => {
	const dir = await Deno.makeTempDir({ prefix: "tartan-oracle-" });
	try {
		const all = {
			...files,
			"cue.mod/module.cue": forgeModuleFile(freshModulePath()),
		};
		for (const [path, text] of Object.entries(all)) {
			const full = `${dir}/${path}`;
			await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
				recursive: true,
			});
			await Deno.writeTextFile(full, text);
		}
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);
		try {
			const out = await new Deno.Command(cueBin, {
				args: ["export", "-E", "--out", "json", ".:tartan"],
				cwd: dir,
				clearEnv: true,
				env: { CUE_REGISTRY: "none", HOME: dir, PATH: "/usr/bin:/bin" },
				stdout: "piped",
				stderr: "piped",
				signal: ac.signal,
			}).output();
			return {
				code: out.code,
				stdout: new TextDecoder().decode(out.stdout),
				stderr: new TextDecoder().decode(out.stderr),
			};
		} finally {
			clearTimeout(timer);
		}
	} finally {
		await Deno.remove(dir, { recursive: true }).catch(() => {});
	}
};

/** `CUE_BIN`, when it is cue v0.17.1; otherwise the CLI tests skip. */
export const cueBin = (): string | null => {
	const bin = Deno.env.get("CUE_BIN");
	if (bin === undefined || bin === "") return null;
	try {
		const out = new Deno.Command(bin, {
			args: ["version"],
			stdout: "piped",
			stderr: "null",
		}).outputSync();
		const first = new TextDecoder().decode(out.stdout).split("\n")[0];
		if (first !== "cue version v0.17.1") {
			throw new Error(`CUE_BIN is ${first}, the tests need cue v0.17.1`);
		}
		return bin;
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return null;
		throw error;
	}
};
