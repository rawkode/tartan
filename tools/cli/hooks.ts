// `tartan hooks install --git` and the hook body `tartan hooks pre-push` (WP11;
// M1). The installed hook re-invokes this CLI; the checks are in `prepush.ts`.
// Lane ownership comes from the clone's lane record, else from the forge
// (`whoami` + `lanes_get` over MCP); when neither can answer, a lane target is
// refused (`git push --no-verify` overrides).

import {
	type CliConfig,
	type CliEnv,
	originOf,
	resolveCredential,
	tokenKind,
} from "./config.ts";
import { invocation, shellQuote } from "./credential.ts";
import { type Git, gitConfig, gitOk } from "./git.ts";
import { readLanes } from "./lanes.ts";
import { createMcpClient, type FetchLike } from "./mcp.ts";
import {
	checkSizes,
	checkTarget,
	classifyRemote,
	DEFAULT_MAX_PUSH_BYTES,
	newObjects,
	parsePushLines,
	type PushRemote,
	type Rejection,
} from "./prepush.ts";

export const HOOK_MARKER = "# tartan pre-push hook";

export const hookScript = (command: readonly string[]): string =>
	[
		"#!/bin/sh",
		HOOK_MARKER,
		"# Installed by `tartan hooks install --git` (fails fast before any upload).",
		`exec ${command.map(shellQuote).join(" ")} hooks pre-push "$@"`,
		"",
	].join("\n");

export type InstallResult = {
	readonly path: string;
	readonly forge: string | null;
	readonly defaultBranch: string;
	readonly maxPushBytes: number | null;
};

/** The forge limits from `/.well-known/tartan.json`, or null when unreachable. */
const fetchLimits = async (
	origin: string,
	fetcher: FetchLike,
): Promise<number | null> => {
	try {
		const res = await fetcher(`${origin}/.well-known/tartan.json`);
		if (!res.ok) {
			await res.body?.cancel();
			return null;
		}
		const body = await res.json() as { limits?: { maxPushBytes?: number } };
		const max = body.limits?.maxPushBytes;
		return typeof max === "number" && max > 0 ? max : null;
	} catch {
		return null;
	}
};

export const installGitHook = async (
	git: Git,
	options: {
		readonly force: boolean;
		readonly command?: string[];
		readonly fetch?: FetchLike;
		readonly forge?: string;
	},
): Promise<InstallResult> => {
	const hooksDir = await gitOk(git, [
		"rev-parse",
		"--path-format=absolute",
		"--git-path",
		"hooks",
	]);
	const path = `${hooksDir}/pre-push`;
	let existing: string | null = null;
	try {
		existing = await Deno.readTextFile(path);
	} catch {
		existing = null;
	}
	if (existing !== null && !existing.includes(HOOK_MARKER) && !options.force) {
		throw new Error(
			`${path} exists and is not Tartan's; rerun with --force to replace it`,
		);
	}
	await Deno.mkdir(hooksDir, { recursive: true });
	await Deno.writeTextFile(path, hookScript(options.command ?? invocation()), {
		mode: 0o755,
	});
	await Deno.chmod(path, 0o755).catch(() => {});

	const originUrl = await gitConfig(git, "remote.origin.url");
	let forge: string | null = options.forge ?? null;
	if (forge === null && originUrl !== null) {
		try {
			forge = originOf(originUrl);
		} catch {
			forge = null;
		}
	}
	if (forge !== null) await gitOk(git, ["config", "tartan.forge", forge]);
	const head = await git([
		"symbolic-ref",
		"--short",
		"refs/remotes/origin/HEAD",
	]);
	const defaultBranch = head.code === 0
		? head.stdout.trim().replace(/^origin\//, "")
		: "main";
	await gitOk(git, ["config", "tartan.defaultBranch", defaultBranch]);
	const maxPushBytes = forge === null
		? null
		: await fetchLimits(forge, options.fetch ?? fetch);
	if (maxPushBytes !== null) {
		await gitOk(git, ["config", "tartan.maxPushBytes", String(maxPushBytes)]);
	}
	return { path, forge, defaultBranch, maxPushBytes };
};

export type PrePushDeps = {
	readonly git: Git;
	readonly config: CliConfig;
	readonly env: CliEnv;
	readonly fetch?: FetchLike;
};

/** The forges this clone pushes to: its `tartan.forge`, the config's, `TARTAN_URL`. */
const knownForges = async (deps: PrePushDeps): Promise<Set<string>> => {
	const known = new Set(Object.keys(deps.config.forges));
	const add = (value: string | null | undefined) => {
		if (!value) return;
		try {
			known.add(originOf(value));
		} catch {
			// not a URL: names no forge
		}
	};
	add(await gitConfig(deps.git, "tartan.forge"));
	add(deps.env.get("TARTAN_URL"));
	return known;
};

/**
 * The hook body: every refusal, or none. `url` is the remote's URL as git
 * passes it; `stdin` git's ref lines.
 */
export const prePush = async (
	deps: PrePushDeps,
	url: string,
	stdin: string,
): Promise<Rejection[]> => {
	const remote = classifyRemote(url);
	if (remote === null) return [];
	if (!(await knownForges(deps)).has(remote.origin)) return [];
	const credential = resolveCredential(deps.config, deps.env, remote.origin);
	const kind = credential === null
		? "user"
		: tokenKind(credential.token) ?? "user";
	const defaultBranch = await gitConfig(deps.git, "tartan.defaultBranch") ??
		"main";
	const configuredMax = Number(
		deps.env.get("TARTAN_MAX_PUSH_BYTES") ??
			await gitConfig(deps.git, "tartan.maxPushBytes") ?? NaN,
	);
	const maxPushBytes = Number.isSafeInteger(configuredMax) && configuredMax > 0
		? configuredMax
		: DEFAULT_MAX_PUSH_BYTES;

	const record = await readLanes(deps.git);
	let principal: string | null | undefined = credential?.principal;
	const client = credential === null
		? null
		: createMcpClient(credential.origin, credential.token, deps.fetch);
	const isMine = async (laneId: string, target: PushRemote) => {
		if (record.some((l) => l.laneId === laneId)) return true;
		if (client === null) return false;
		try {
			if (principal === undefined) {
				const who = await client.call("", "whoami");
				principal = (who.value.principal as { id?: string })?.id ?? null;
			}
			const got = await client.call("", "lanes_get", {
				repo: target.repoPath,
				laneId,
			});
			if (got.isError) return false;
			const lane = got.value.lane as {
				owner?: string;
				delegates?: string[];
			};
			return principal !== null &&
				(lane.owner === principal ||
					(lane.delegates ?? []).includes(principal!));
		} catch {
			return false;
		}
	};

	const rejections: Rejection[] = [];
	for (const update of parsePushLines(stdin)) {
		const verdict = checkTarget(update, remote, { kind, defaultBranch });
		if (verdict.kind === "reject") {
			rejections.push(verdict.rejection);
			continue;
		}
		if (verdict.kind === "lane" && !(await isMine(verdict.laneId, remote))) {
			rejections.push({
				ref: update.remoteRef,
				reason: "not-your-lane",
				message:
					`${verdict.laneId} is not one of your lanes (check with tartan lane status ${verdict.laneId})`,
			});
			continue;
		}
		if (update.localSha === "0000000000000000000000000000000000000000") {
			continue;
		}
		rejections.push(
			...checkSizes(update.remoteRef, await newObjects(deps.git, update), {
				maxPushBytes,
			}),
		);
	}
	return rejections;
};

/** The lines the hook prints for its refusals (stderr). */
export const formatRejections = (rejections: readonly Rejection[]): string =>
	[
		"tartan pre-push: refusing this push before upload:",
		...rejections.map((r) => `  ${r.ref}: ${r.reason}: ${r.message}`),
		"(bypass with git push --no-verify; the forge still applies its policy)",
	].join("\n");
