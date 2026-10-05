// `tartan config` (WP23, reviewed by WP11; ADR repo config "MCP, CLI and
// HTTP"): Tartan config is the CUE package `tartan` of a repo's
// root `*.cue` files.
//
//   tartan config show --repo <path> [--json]
//   tartan config vet [--repo <path>] [--lane <id>] [--wait <s>] [--json]
//   tartan config schema --repo <path> --out <dir>
//
// `vet` previews a lane (the current branch's `lanes/<id>` by default) and
// polls the result; it never signs off or applies (a person does that in a
// browser). `schema` writes the forge's schema files and a local
// `cue.mod/module.cue` into <dir>: copy the repo's root `*.cue` files there
// and run the printed `cue export` to reproduce the forge's evaluation.
// Repository-controlled text arrives fenced as untrusted from the forge and
// is printed as is.

import {
	FORGE_BINDING_FILE,
	LOCAL_MODULE_FILE,
	REPO_CONFIG_EXPORT_COMMAND,
} from "@tartan/contract";
import {
	answered,
	type Args,
	flag,
	has,
	type Io,
	loadConfig,
	requireCredential,
	UsageError,
} from "./commands.ts";
import { readLanes } from "./lanes.ts";
import { createMcpClient, type ToolAnswer } from "./mcp.ts";

const POLL_MS = 2_000;

/** Paths the forge's schema may write: the overlay package and the binding file. */
export const SCHEMA_PATH_RE =
	/^(cue\.mod\/pkg\/tartan\.dev\/ext\/ext\.cue|cue\.mod\/pkg\/tartan\.dev\/ext\/x\/[a-z0-9_]{1,64}\/settings\.cue|~tartan\.cue)$/;

const repoOf = (args: Args, fallback?: string): string => {
	const repo = flag(args, "repo") ?? args.positional[0] ?? fallback;
	if (repo === undefined) throw new UsageError("--repo <path> is required");
	return repo.replace(/^\/+/, "").replace(/\.git$/, "");
};

/** The text a tool answered: the kernel facts, then the forge's untrusted fence. */
const shown = (answer: ToolAnswer): string => answer.text;

export const configShow = async (io: Io, args: Args): Promise<void> => {
	const credential = requireCredential(await loadConfig(io), io, args);
	const repo = repoOf(args);
	const got = answered(
		io,
		await createMcpClient(credential.origin, credential.token, io.fetch)
			.call(repo, "repo_config_get", { repo }),
	);
	io.out(has(args, "json") ? JSON.stringify(got.value, null, 2) : shown(got));
};

/** The lane of the current branch (`lanes/<id>`), else the only recorded lane of the repo. */
const currentLane = async (io: Io, repo: string | undefined) => {
	const branch = await io.git(["symbolic-ref", "--short", "-q", "HEAD"]);
	const name = branch.code === 0 ? branch.stdout.trim() : "";
	const lanes = await readLanes(io.git);
	const byBranch = lanes.find((l) => l.branch === name) ??
		(/^lanes\/ln_[0-9A-Za-z]{26}$/.test(name)
			? { laneId: name.slice("lanes/".length), repo: undefined }
			: undefined);
	if (byBranch !== undefined) return byBranch;
	const mine = lanes.filter((l) => repo === undefined || l.repo === repo);
	return mine.length === 1 ? mine[0] : undefined;
};

/** Exit code: 0 ok or clean, 1 errors or denials, 3 still evaluating at the deadline. */
export const configVet = async (io: Io, args: Args): Promise<number> => {
	const credential = requireCredential(await loadConfig(io), io, args);
	const given = flag(args, "lane");
	const found = given === undefined
		? await currentLane(io, flag(args, "repo"))
		: undefined;
	const laneId = given ?? found?.laneId;
	if (laneId === undefined) {
		throw new UsageError(
			"--lane <id> is required (no lanes/<id> branch is checked out)",
		);
	}
	const repo = repoOf(args, found?.repo);
	const client = createMcpClient(credential.origin, credential.token, io.fetch);
	let got = answered(
		io,
		await client.call(repo, "repo_config_preview", { repo, laneId }),
	);
	const deadline = Date.now() + Number(flag(args, "wait") ?? "60") * 1000;
	while (got.value.status === "evaluating" && Date.now() < deadline) {
		io.err(`evaluating the root *.cue files of ${laneId}…`);
		await io.sleep(POLL_MS);
		const key = got.value.inputKey;
		const next = typeof key === "string"
			? await client.call(repo, "repo_config_result", { repo, inputKey: key })
			: await client.call(repo, "repo_config_preview", { repo, laneId });
		// The result is not stored yet: keep the last answer and poll again.
		if (!next.isError) got = answered(io, next);
	}
	io.out(has(args, "json") ? JSON.stringify(got.value, null, 2) : shown(got));
	switch (got.value.status) {
		case "ok":
		case "clean":
			return 0;
		case "evaluating":
			return 3;
		default:
			return 1;
	}
};

export const configSchema = async (io: Io, args: Args): Promise<void> => {
	const credential = requireCredential(await loadConfig(io), io, args);
	const repo = repoOf(args);
	const out = flag(args, "out");
	if (out === undefined) throw new UsageError("--out <dir> is required");
	const got = answered(
		io,
		await createMcpClient(credential.origin, credential.token, io.fetch)
			.call(repo, "repo_config_schema", { repo }),
	);
	const files = (got.value.files ?? {}) as Record<string, unknown>;
	if (typeof files[FORGE_BINDING_FILE] !== "string") {
		throw new Error(`the forge sent no ${FORGE_BINDING_FILE}`);
	}
	const dir = out.replace(/\/+$/, "");
	const write = async (path: string, text: string) => {
		const full = `${dir}/${path}`;
		await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
			recursive: true,
		});
		await Deno.writeTextFile(full, text);
	};
	for (const [path, text] of Object.entries(files)) {
		// Only the schema's own paths: nothing the answer names can escape <dir>.
		if (!SCHEMA_PATH_RE.test(path) || typeof text !== "string") {
			throw new Error(`refusing schema path ${JSON.stringify(path)}`);
		}
		await write(path, text);
	}
	await write("cue.mod/module.cue", LOCAL_MODULE_FILE);
	io.out(
		[
			`wrote ${Object.keys(files).length + 1} files to ${dir}`,
			`copy the repo's root *.cue files there, then: cd ${dir} && ${REPO_CONFIG_EXPORT_COMMAND}`,
		].join("\n"),
	);
};
