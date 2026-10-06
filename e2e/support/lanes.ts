// Lanes of the `repo` backend: each lane is a
// per-agent Artifacts repository created with `import()`, reached through
// its lane remote `/<repo>/-/lanes/<laneId>.git`, with branch lanes as the
// fallback. What the lane suites share:
//
// - `gitClone`: a working copy of any remote (the canonical repo or a lane
//   remote) with one token, through `support/git.ts` (the token only in an
//   extra header scoped to the forge);
// - the Owner's lane settings (`PUT /-/api/repos/<id>/lanes/settings`): a
//   repo's lane mode override, so the branch-lane policy suite keeps
//   branch lanes on a stage whose forge default is `import`;
// - a hand-built receive-pack request with an empty pack, for the one row
//   stock git cannot send (a stale `old` the gateway must refuse).
//
// Pure module (node only): the Deno unit tests import it too.

import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import * as path from "node:path";
import type {
	LanesResponse,
	RepoLaneSettingsDto,
} from "@tartan/contract/api.ts";
import type { Lane, LaneMode } from "@tartan/contract/lanes.ts";
import { commandSection, type ProbeCommand } from "./gateway.ts";
import { git, gitDate, gitEnv, gitOk, type GitResult } from "./git.ts";
import { boundedFetch, ok, query, tokenApi } from "./http.ts";
import { type Stage, tokensOf } from "./stage.ts";

/** Contract names, checked by `deno task check`. */
export const REPO_BACKEND: Lane["mode"] = "repo";
export const BRANCH_BACKEND: Lane["mode"] = "branch";
export const IMPORT_SEED: NonNullable<Lane["seed"]> = "import";
export const BRANCH_MODE: LaneMode = "branch";
export const IMPORT_MODE: LaneMode = "import";
/** The one writable ref of a lane repository (row L3 of the lane-remote table). */
export const LANE_MAIN = "refs/heads/main";

/** `/<repo>/-/lanes/<laneId>.git` (`laneRemotePath`). */
export const laneRemotePath = (repoPath: string, laneId: string): string =>
	`/${repoPath}/-/lanes/${laneId}.git`;

/** The `gitHttp` repo path of a lane remote (`<repo>/-/lanes/<laneId>`). */
export const laneHttpPath = (repoPath: string, laneId: string): string =>
	`${repoPath}/-/lanes/${laneId}`;

/** A working copy talking to one remote (`origin`) with one token. */
export type GitClone = {
	readonly dir: string;
	readonly run: (args: readonly string[]) => Promise<GitResult>;
	readonly runOk: (args: readonly string[]) => Promise<string>;
	/** Appends a line to `<name>.txt` and commits it; returns the commit. */
	readonly commit: (name: string) => Promise<string>;
	/** `ref` on `remote` (default origin), or null when it is not advertised. */
	readonly remoteHead: (ref: string, remote?: string) => Promise<string | null>;
};

/** `git clone <remote>` into `<workdir>/<label>-clone` with `token`. */
export const gitClone = async (
	stage: Stage,
	workdir: string,
	token: string,
	remote: string,
	label: string,
): Promise<GitClone> => {
	const home = path.join(workdir, `${label}-home`);
	const env = gitEnv({
		home,
		auth: { origin: stage.origin, token },
		date: gitDate(1_767_571_200),
	});
	const dir = path.join(workdir, `${label}-clone`);
	await gitOk(["clone", "-q", remote, dir], { cwd: workdir, env, token });
	const run = (args: readonly string[]) => git(args, { cwd: dir, env, token });
	const runOk = (args: readonly string[]) =>
		gitOk(args, { cwd: dir, env, token });
	return {
		dir,
		run,
		runOk,
		commit: async (name) => {
			await appendFile(path.join(dir, `${name}.txt`), `${name}\n`);
			await runOk(["add", "--all"]);
			await runOk(["commit", "-q", "--no-verify", "-m", `lanes ${name}`]);
			return (await runOk(["rev-parse", "HEAD"])).trim();
		},
		remoteHead: async (ref, remoteName = "origin") => {
			const out = await runOk(["ls-remote", remoteName, ref]);
			const line = out.split("\n").find((l) => l.endsWith(`\t${ref}`));
			return line === undefined ? null : line.split("\t")[0];
		},
	};
};

/** The Owner's PAT on the run's nodes. */
export const ownerApi = (stage: Stage) =>
	tokenApi(stage.origin, tokensOf(stage).ownerPat);

/** Every lane of a repo, as the Owner reads them (`GET /-/api/lanes`). */
export const lanesOf = async (
	stage: Stage,
	repoPath: string,
): Promise<readonly Lane[]> => {
	const at = `/-/api/lanes?${query({ repo: repoPath, limit: "100" })}`;
	return ok("GET", "/-/api/lanes", await ownerApi(stage).get<LanesResponse>(at))
		.lanes;
};

/** One lane, as the Owner reads it. */
export const laneOf = async (
	stage: Stage,
	repoPath: string,
	laneId: string,
): Promise<Lane> => {
	const at = `/-/api/lanes/${encodeURIComponent(laneId)}?${
		query({ repo: repoPath })
	}`;
	return ok("GET", "/-/api/lanes/<id>", await ownerApi(stage).get<Lane>(at));
};

/** The repo's lane settings (Owner). */
export const laneSettingsOf = async (
	stage: Stage,
	repoId: string,
): Promise<RepoLaneSettingsDto> => {
	const at = `/-/api/repos/${encodeURIComponent(repoId)}/lanes/settings`;
	return ok("GET", at, await ownerApi(stage).get<RepoLaneSettingsDto>(at));
};

/**
 * Sets (or with null clears) the repo's lane mode override as its Owner:
 * `branch` keeps branch lanes on a stage whose default is `import`.
 */
export const setLaneMode = async (
	stage: Stage,
	repoId: string,
	laneMode: LaneMode | null,
): Promise<RepoLaneSettingsDto> => {
	const at = `/-/api/repos/${encodeURIComponent(repoId)}/lanes/settings`;
	return ok(
		"PUT",
		at,
		await ownerApi(stage).send<RepoLaneSettingsDto>("PUT", at, { laneMode }),
	);
};

/**
 * True when the stage's new lanes are `repo` lanes by default (deployed with
 * `--lane-mode import`).
 */
export const repoLanesByDefault = (stage: Stage): boolean =>
	stage.switches.laneMode === IMPORT_MODE;

// ---------------------------------------------------------------------------
// A hand-built receive-pack request (stock git cannot send a stale old)
// ---------------------------------------------------------------------------

/** An empty pack (version 2, no objects) with its SHA-1 trailer. */
export const emptyPack = (): Uint8Array => {
	const header = new Uint8Array([
		0x50,
		0x41,
		0x43,
		0x4b, // "PACK"
		0,
		0,
		0,
		2, // version 2
		0,
		0,
		0,
		0, // 0 objects
	]);
	const sum = createHash("sha1").update(header).digest();
	const out = new Uint8Array(header.length + sum.length);
	out.set(header, 0);
	out.set(sum, header.length);
	return out;
};

/** One receive-pack command with `report-status`, then an empty pack. */
export const receivePackBody = (command: ProbeCommand): Uint8Array => {
	const commands = new TextEncoder().encode(
		commandSection([command], ["report-status"]),
	);
	const pack = emptyPack();
	const out = new Uint8Array(commands.length + pack.length);
	out.set(commands, 0);
	out.set(pack, commands.length);
	return out;
};

/** The report-status `ng <ref> <reason>` line of a receive-pack answer, if any. */
export const ngReason = (answer: string, ref: string): string | null => {
	const m = new RegExp(
		`ng ${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} ([^\\n\\x00]+)`,
	).exec(answer);
	return m === null ? null : m[1].trim();
};

/** An anonymous smart-HTTP advertisement request (no credential at all). */
export const anonymousAdvertisement = (
	origin: string,
	repoPath: string,
	service: "git-upload-pack" | "git-receive-pack",
): Promise<{ readonly status: number; readonly text: string }> =>
	boundedFetch(
		`${origin}/${repoPath}.git/info/refs?service=${service}`,
		{ method: "GET", redirect: "manual" },
		`GET ${repoPath}.git/info/refs (anonymous)`,
		async (r) => ({ status: r.status, text: await r.text() }),
	);
