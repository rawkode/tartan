// `tartan config show|vet|schema` (WP23) against the local forge stand-in:
// the MCP tools each command calls, vet's polling and exit codes, and that
// `schema` writes only the schema's own paths plus a local module file.

import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { createUlid, LOCAL_MODULE_FILE } from "@tartan/contract";
import type { Io } from "./commands.ts";
import { createGit } from "./git.ts";
import { parseArgs, run } from "./main.ts";
import { configSchema } from "./repoconfig.ts";
import { startFakeForge } from "./testing/server.ts";

const ulid = createUlid();
const TOKEN = `tagt_${"A".repeat(43)}`;
const LANE = `ln_${ulid()}`;
const KEY = "b".repeat(64);

const setup = async () => {
	const forge = startFakeForge({ token: TOKEN });
	const dir = await Deno.makeTempDir({ prefix: "tartan-cli-config-" });
	const env: Record<string, string> = {
		TARTAN_URL: forge.origin,
		TARTAN_TOKEN: TOKEN,
		TARTAN_CONFIG: `${dir}/tartan.json`,
		GIT_CONFIG_GLOBAL: `${dir}/gitconfig`,
		GIT_CONFIG_NOSYSTEM: "1",
	};
	await Deno.writeTextFile(`${dir}/gitconfig`, "");
	await Deno.mkdir(`${dir}/work`);
	const lines: string[] = [];
	const errors: string[] = [];
	const io: Io = {
		env: { get: (name) => env[name] },
		git: createGit(`${dir}/work`, env),
		fetch: (input, init) => fetch(input, init),
		out: (text) => void lines.push(text),
		err: (text) => void errors.push(text),
		readStdin: () => Promise.resolve(""),
		readSecret: () => Promise.resolve(null),
		sleep: () => Promise.resolve(),
	};
	return {
		forge,
		dir,
		io,
		lines,
		errors,
		close: async () => {
			await forge.close();
			await Deno.remove(dir, { recursive: true });
		},
	};
};

Deno.test("config show calls repo_config_get at the repo scope", async () => {
	const t = await setup();
	try {
		t.forge.setTools((name) =>
			name === "repo_config_get" ? { status: "current" } : { error: "x" }
		);
		equal(await run(t.io, ["config", "show", "--repo", "acme/router"]), 0);
		deepStrictEqual(t.forge.toolCalls.map((c) => [c.name, c.scope, c.args]), [
			["repo_config_get", "acme/router", { repo: "acme/router" }],
		]);
		match(t.lines.join("\n"), /current/);
	} finally {
		await t.close();
	}
});

Deno.test("config vet previews the lane, polls by input key and exits by status", async () => {
	const t = await setup();
	try {
		let polls = 0;
		t.forge.setTools((name) => {
			if (name === "repo_config_preview") {
				return { laneId: LANE, status: "evaluating", inputKey: KEY };
			}
			polls += 1;
			return polls < 2
				? { error: "not_found", message: "not yet" }
				: { laneId: LANE, status: "error", inputKey: KEY };
		});
		const code = await run(t.io, [
			"config",
			"vet",
			"--repo",
			"acme/router",
			"--lane",
			LANE,
		]);
		equal(code, 1);
		deepStrictEqual(
			t.forge.toolCalls.map((c) => c.name),
			["repo_config_preview", "repo_config_result", "repo_config_result"],
		);
		deepStrictEqual(t.forge.toolCalls[1].args, {
			repo: "acme/router",
			inputKey: KEY,
		});
		ok(t.errors.some((e) => e.includes("evaluating")));
		// A clean lane (no root *.cue change) exits 0.
		t.forge.setTools(() => ({ laneId: LANE, status: "clean" }));
		equal(
			await run(t.io, [
				"config",
				"vet",
				"--repo",
				"acme/router",
				"--lane",
				LANE,
			]),
			0,
		);
		// No lane named and no lanes/<id> branch: a usage error.
		equal(await run(t.io, ["config", "vet", "--repo", "acme/router"]), 2);
	} finally {
		await t.close();
	}
});

Deno.test("config schema writes the schema files and a local module file; foreign paths are refused", async () => {
	const t = await setup();
	try {
		const files = {
			"~tartan.cue": "package tartan\n",
			"cue.mod/pkg/tartan.dev/ext/ext.cue": "package ext\n",
			"cue.mod/pkg/tartan.dev/ext/x/tartan_ci/settings.cue":
				"package settings\n",
		};
		t.forge.setTools(() => ({ files, exportCommand: "cue export .:tartan" }));
		const out = `${t.dir}/schema`;
		equal(
			await run(t.io, [
				"config",
				"schema",
				"--repo",
				"acme/router",
				"--out",
				out,
			]),
			0,
		);
		for (const [path, text] of Object.entries(files)) {
			equal(await Deno.readTextFile(`${out}/${path}`), text);
		}
		equal(
			await Deno.readTextFile(`${out}/cue.mod/module.cue`),
			LOCAL_MODULE_FILE,
		);
		match(t.lines.join("\n"), /cue export -E --out json \.:tartan/);
		// An answer naming a path outside the schema is refused before writing it.
		t.forge.setTools(() => ({
			files: { ...files, "../escape.cue": "x" },
		}));
		await rejects(
			configSchema(
				t.io,
				parseArgs(["--repo", "acme/router", "--out", `${t.dir}/two`]),
			),
			/refusing schema path/,
		);
		await rejects(Deno.stat(`${t.dir}/escape.cue`));
	} finally {
		await t.close();
	}
});
