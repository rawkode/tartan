// `tartan` commands (WP11): login, whoami, lane
// open/status/list/close, inbox, credential, hooks. Each takes its I/O as
// dependencies so tests drive it without a terminal.

import {
	type CliConfig,
	type CliEnv,
	configPath,
	type Credential,
	originOf,
	readConfig,
	resolveCredential,
	writeConfig,
} from "./config.ts";
import {
	credentialAnswer,
	installCredentialHelper,
	parseCredentialInput,
} from "./credential.ts";
import type { Git } from "./git.ts";
import { formatRejections, installGitHook, prePush } from "./hooks.ts";
import { readLanes, recordLane } from "./lanes.ts";
import { createMcpClient, type FetchLike, type ToolAnswer } from "./mcp.ts";

export type Io = {
	readonly env: CliEnv;
	readonly git: Git;
	readonly fetch: FetchLike;
	out(text: string): void;
	err(text: string): void;
	readStdin(): Promise<string>;
	/** A secret typed at the terminal (not echoed); null when stdin is not a TTY. */
	readSecret(prompt: string): Promise<string | null>;
	sleep(ms: number): Promise<void>;
};

export type Args = {
	readonly positional: readonly string[];
	readonly flags: Readonly<Record<string, string | true | readonly string[]>>;
};

export const flag = (args: Args, name: string): string | undefined => {
	const v = args.flags[name];
	return typeof v === "string" ? v : Array.isArray(v) ? v.at(-1) : undefined;
};
const flags = (args: Args, name: string): string[] => {
	const v = args.flags[name];
	return typeof v === "string" ? [v] : Array.isArray(v) ? [...v] : [];
};
export const has = (args: Args, name: string) => args.flags[name] !== undefined;

export class UsageError extends Error {
	override readonly name = "UsageError";
}

export const loadConfig = (io: Io) => readConfig(configPath(io.env));

export const requireCredential = (
	config: CliConfig,
	io: Io,
	args: Args,
): Credential => {
	const credential = resolveCredential(config, io.env, flag(args, "forge"));
	if (credential === null) {
		throw new UsageError(
			"not logged in: run `tartan login <forge URL>` or set TARTAN_URL and TARTAN_TOKEN",
		);
	}
	return credential;
};

/** Prints the forge's notices (stderr) and fails on a tool error. */
export const answered = (io: Io, answer: ToolAnswer): ToolAnswer => {
	if (answer.notices !== null) io.err(answer.notices);
	if (answer.isError) throw new Error(answer.text);
	return answer;
};

const json = (value: unknown) => JSON.stringify(value, null, 2);

// ---------------------------------------------------------------------------
// login, whoami
// ---------------------------------------------------------------------------

export const login = async (io: Io, args: Args): Promise<void> => {
	const target = args.positional[0] ?? io.env.get("TARTAN_URL");
	if (target === undefined) {
		throw new UsageError("usage: tartan login <forge URL>");
	}
	const origin = originOf(target);
	const token = has(args, "token-stdin")
		? (await io.readStdin()).trim()
		: io.env.get("TARTAN_TOKEN") ??
			(await io.readSecret(`Token for ${origin}: `))?.trim() ??
			(await io.readStdin()).trim();
	if (!/^(tagt|tpat)_[A-Za-z0-9_-]{43}$/.test(token)) {
		throw new Error("that is not a Tartan token (tagt_… or tpat_…)");
	}
	const who = answered(
		io,
		await createMcpClient(origin, token, io.fetch).call("", "whoami"),
	);
	const principal = who.value.principal as { id: string; handle: string };
	const path = configPath(io.env);
	const config = await readConfig(path);
	await writeConfig(path, {
		...config,
		default: origin,
		forges: {
			...config.forges,
			[origin]: { token, principal: principal.id, handle: principal.handle },
		},
	});
	io.out(`logged in to ${origin} as ${principal.handle} (${principal.id})`);
};

export const whoami = async (io: Io, args: Args): Promise<void> => {
	const credential = requireCredential(await loadConfig(io), io, args);
	const who = answered(
		io,
		await createMcpClient(credential.origin, credential.token, io.fetch).call(
			flag(args, "scope") ?? "",
			"whoami",
		),
	);
	io.out(json(who.value));
};

// ---------------------------------------------------------------------------
// lane
// ---------------------------------------------------------------------------

type Handle = {
	id: string;
	mode: "repo" | "branch";
	state: string;
	remote: string;
	ref: string;
	branch: string;
	base: string;
	git?: { start: string; push: string };
};

const LANE_POLL_MS = 2_000;

const repoArg = (args: Args): string => {
	const repo = flag(args, "repo");
	if (repo === undefined) throw new UsageError("--repo <path> is required");
	return repo.replace(/^\/+/, "").replace(/\.git$/, "");
};

/** The next free `lane-<n>` remote name. */
const nextLaneRemote = async (git: Git): Promise<string> => {
	const remotes = (await git(["remote"])).stdout.split("\n");
	let n = 1;
	while (remotes.includes(`lane-${n}`)) n += 1;
	return `lane-${n}`;
};

const inRepo = async (git: Git) =>
	(await git(["rev-parse", "--is-inside-work-tree"])).code === 0;

export const laneOpen = async (io: Io, args: Args): Promise<void> => {
	const credential = requireCredential(await loadConfig(io), io, args);
	const client = createMcpClient(credential.origin, credential.token, io.fetch);
	const repo = repoArg(args);
	const purpose = flag(args, "purpose") ?? args.positional[0];
	if (purpose === undefined) {
		throw new UsageError("--purpose <text> is required");
	}
	const prefixes = flags(args, "prefix");
	const projects = flags(args, "project");
	const opened = answered(
		io,
		await client.call(repo, "lanes_open", {
			repo,
			purpose,
			...(prefixes.length + projects.length > 0
				? { footprint: { prefixes, projects } }
				: {}),
		}),
	);
	let handle = opened.value.lane as Handle;
	const deadline = Date.now() + Number(flag(args, "wait") ?? "60") * 1000;
	while (handle.state === "opening" && Date.now() < deadline) {
		io.err(`lane ${handle.id} is opening…`);
		await io.sleep(LANE_POLL_MS);
		const got = answered(
			io,
			await client.call(repo, "lanes_get", { repo, laneId: handle.id }),
		);
		handle = got.value.lane as Handle;
	}
	if (handle.git === undefined) {
		throw new Error(
			`lane ${handle.id} is still ${handle.state}; poll it with tartan lane status ${handle.id} --repo ${repo}`,
		);
	}
	let remoteName: string | undefined;
	if (!has(args, "no-remote") && await inRepo(io.git)) {
		if (handle.mode === "repo") {
			remoteName = await nextLaneRemote(io.git);
			await io.git(["remote", "add", remoteName, handle.remote]);
		}
		await recordLane(io.git, {
			laneId: handle.id,
			repo,
			mode: handle.mode,
			remote: handle.remote,
			ref: handle.ref,
			branch: handle.branch,
			...(remoteName ? { remoteName } : {}),
			...(credential.principal ? { owner: credential.principal } : {}),
		});
	}
	if (has(args, "json")) {
		io.out(json({ lane: handle, ...(remoteName ? { remoteName } : {}) }));
		return;
	}
	io.out(
		[
			`lane ${handle.id} (${handle.mode}) is open`,
			`start: ${handle.git.start}`,
			`push:  ${handle.git.push}`,
			...(remoteName
				? [
					`(remote ${remoteName} added: git push ${remoteName} HEAD:${handle.ref})`,
				]
				: []),
		].join("\n"),
	);
};

export const laneStatus = async (io: Io, args: Args): Promise<void> => {
	const credential = requireCredential(await loadConfig(io), io, args);
	const laneId = args.positional[0];
	if (laneId === undefined) {
		throw new UsageError("usage: tartan lane status <laneId>");
	}
	const recorded = (await readLanes(io.git)).find((l) => l.laneId === laneId);
	const repo = flag(args, "repo") ?? recorded?.repo;
	if (repo === undefined) throw new UsageError("--repo <path> is required");
	const got = answered(
		io,
		await createMcpClient(credential.origin, credential.token, io.fetch).call(
			repo,
			"lanes_get",
			{ repo, laneId },
		),
	);
	io.out(json(got.value.lane));
};

export const laneList = async (io: Io, args: Args): Promise<void> => {
	const credential = requireCredential(await loadConfig(io), io, args);
	const repo = repoArg(args);
	const got = answered(
		io,
		await createMcpClient(credential.origin, credential.token, io.fetch).call(
			repo,
			"lanes_list",
			{ repo, ...(has(args, "mine") ? { mine: true } : {}) },
		),
	);
	const lanes = got.value.lanes as {
		id: string;
		mode: string;
		state: string;
		owner: string;
		remote: string;
		ref: string;
	}[];
	if (has(args, "json")) {
		io.out(json(lanes));
		return;
	}
	for (const l of lanes) {
		io.out(
			`${l.id}  ${l.state.padEnd(9)} ${
				l.mode.padEnd(6)
			} ${l.owner}  ${l.remote} ${l.ref}`,
		);
	}
};

export const laneClose = async (io: Io, args: Args): Promise<void> => {
	const credential = requireCredential(await loadConfig(io), io, args);
	const laneId = args.positional[0];
	const reason = flag(args, "reason");
	if (laneId === undefined || reason === undefined) {
		throw new UsageError("usage: tartan lane close <laneId> --reason <text>");
	}
	const recorded = (await readLanes(io.git)).find((l) => l.laneId === laneId);
	const repo = flag(args, "repo") ?? recorded?.repo;
	if (repo === undefined) throw new UsageError("--repo <path> is required");
	answered(
		io,
		await createMcpClient(credential.origin, credential.token, io.fetch).call(
			repo,
			"lanes_close",
			{ repo, laneId, reason },
		),
	);
	io.out(`lane ${laneId} closed`);
};

// ---------------------------------------------------------------------------
// inbox
// ---------------------------------------------------------------------------

type NoticeView = {
	id: string;
	seq: number;
	severity: string;
	kind: string;
	source: string;
	sourceLabel?: string;
	text: string;
};

// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export const inbox = async (io: Io, args: Args): Promise<void> => {
	const credential = requireCredential(await loadConfig(io), io, args);
	const client = createMcpClient(credential.origin, credential.token, io.fetch);
	const repo = flag(args, "repo");
	const scope = repo ?? "";
	const answer = has(args, "wait")
		? await client.call(scope, "inbox_wait", {
			timeoutMs: Math.min(
				25_000,
				Number(typeof args.flags.wait === "string" ? args.flags.wait : 25_000),
			),
		})
		: await client.call(scope, "inbox_read", {
			...(repo ? { repo } : {}),
			...(flag(args, "since") ? { since: Number(flag(args, "since")) } : {}),
		});
	if (answer.isError) throw new Error(answer.text);
	const notices = answer.value.notices as NoticeView[];
	if (has(args, "json")) {
		io.out(json(notices));
	} else {
		if (answer.notices !== null) io.out(answer.notices);
		for (const n of notices) {
			io.out(
				`#${n.seq} [${n.severity}] ${n.kind} (${
					(n.sourceLabel ?? n.source).replace(CONTROL, "")
				}): ${n.text.replace(CONTROL, "")}`,
			);
		}
	}
	if (has(args, "ack") && notices.length > 0) {
		answered(
			io,
			await client.call(scope, "inbox_ack", { ids: notices.map((n) => n.id) }),
		);
	}
};

// ---------------------------------------------------------------------------
// credential, hooks
// ---------------------------------------------------------------------------

export const credential = async (io: Io, args: Args): Promise<void> => {
	const action = args.positional[0];
	if (action === "install") {
		const config = await loadConfig(io);
		const target = flag(args, "forge") ?? io.env.get("TARTAN_URL") ??
			config.default;
		if (target === undefined) {
			throw new UsageError("usage: tartan credential install --forge <URL>");
		}
		const value = await installCredentialHelper(io.git, originOf(target), {
			global: has(args, "global"),
		});
		io.out(`git now asks \`${value}\` for ${originOf(target)}`);
		return;
	}
	const input = await io.readStdin();
	if (action !== "get") return; // `store` and `erase`: nothing to keep
	const answer = credentialAnswer(
		parseCredentialInput(input),
		await loadConfig(io),
		io.env,
	);
	if (answer !== "") io.out(answer.trimEnd());
};

export const hooks = async (io: Io, args: Args): Promise<number> => {
	const action = args.positional[0];
	if (action === "install") {
		if (!has(args, "git")) {
			throw new UsageError(
				"usage: tartan hooks install --git (the Claude Code hooks are M2)",
			);
		}
		const result = await installGitHook(io.git, {
			force: has(args, "force"),
			fetch: io.fetch,
			...(flag(args, "forge") ? { forge: flag(args, "forge") } : {}),
		});
		io.out(
			`installed ${result.path} (forge ${
				result.forge ?? "unknown"
			}, trunk ${result.defaultBranch}${
				result.maxPushBytes ? `, ${result.maxPushBytes} bytes per push` : ""
			})`,
		);
		return 0;
	}
	if (action === "pre-push") {
		const url = args.positional[2] ?? args.positional[1];
		if (url === undefined) {
			throw new UsageError("usage: tartan hooks pre-push <remote> <url>");
		}
		const rejections = await prePush(
			{
				git: io.git,
				config: await loadConfig(io),
				env: io.env,
				fetch: io.fetch,
			},
			url,
			await io.readStdin(),
		);
		if (rejections.length === 0) return 0;
		io.err(formatRejections(rejections));
		return 1;
	}
	throw new UsageError(
		"usage: tartan hooks install --git | hooks pre-push <remote> <url>",
	);
};
