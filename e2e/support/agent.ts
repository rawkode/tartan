// A scripted agent: what Claude Code or Codex does through Tartan's agent
// interface, without a model. It speaks MCP JSON-RPC with its own agent
// token (support/mcp.ts) and runs stock git with the token in a header
// scoped to the forge (support/git.ts). Its lane commands come from the lane
// handle the forge returns and are parsed, never run through a shell.
//
// Two agents exist per run, A and B: two agents of the same Developer,
// provisioned by the launcher (`TARTAN_E2E_DEVELOPER_AGENT`, `…_B`).

import { mkdir } from "node:fs/promises";
import * as path from "node:path";
import type { LaneHandle } from "@tartan/contract/interfaces.ts";
import {
	git,
	gitDate,
	gitEnv,
	gitOk,
	type GitResult,
	parseGitCommands,
} from "./git.ts";
import { type McpClient, mcpClient } from "./mcp.ts";
import { type Stage, tokensOf } from "./stage.ts";

export type AgentName = "A" | "B";

/** A lane handle with its git commands (an `open` lane). */
export type OpenLane = LaneHandle & {
	readonly git: { readonly start: string; readonly push: string };
};

export type ScriptedAgent = {
	readonly name: AgentName;
	readonly token: string;
	readonly mcp: McpClient;
	/** git's environment for this agent, HOME under `home`. */
	readonly env: (home: string) => Record<string, string>;
	/** `git clone` of `remote` into `<workdir>/<name>/clone`; returns the clone. */
	readonly clone: (workdir: string, remote: string) => Promise<string>;
	/** Polls `lanes_get` (bounded) until the lane is open with its commands. */
	readonly awaitOpen: (repo: string, lane: LaneHandle) => Promise<OpenLane>;
	/** Runs a lane handle's command text (`git.start` or `git.push`) in `cwd`. */
	readonly runLane: (text: string, cwd: string) => Promise<void>;
	/** Commits every change in `cwd` with `subject` and trailers. */
	readonly commit: (
		cwd: string,
		subject: string,
		trailers?: readonly string[],
	) => Promise<string>;
	/** git in one of this agent's clones; must succeed (scrubbed stdout). */
	readonly git: (cwd: string, args: readonly string[]) => Promise<string>;
	/** git in one of this agent's clones, whatever its exit code (scrubbed). */
	readonly gitResult: (
		cwd: string,
		args: readonly string[],
	) => Promise<GitResult>;
};

/** 2026-01-03T00:00:00Z: the date of every agent commit (fixed SHAs per content). */
export const AGENT_COMMIT_DATE = gitDate(1_767_398_400);

const LANE_OPEN_WAIT_MS = 60_000;

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** The token of agent `name`. */
export const agentToken = (stage: Stage, name: AgentName): string =>
	name === "A"
		? tokensOf(stage).developerAgent
		: tokensOf(stage).developerAgentB;

/** Agent `name`, speaking MCP at `/-/mcp/<scope>`. */
export const scriptedAgent = (
	stage: Stage,
	scope: string,
	name: AgentName,
): ScriptedAgent => {
	const token = agentToken(stage, name);
	const mcp = mcpClient(stage.origin, scope, token);
	const homes = new Map<string, string>();
	const env = (home: string) =>
		gitEnv({
			home,
			auth: { origin: stage.origin, token },
			date: AGENT_COMMIT_DATE,
		});
	const envOf = (cwd: string): Record<string, string> => {
		const home = homes.get(cwd);
		if (home === undefined) throw new Error(`${cwd} is not a clone of ${name}`);
		return env(home);
	};
	return {
		name,
		token,
		mcp,
		env,
		clone: async (workdir, remote) => {
			const root = path.join(workdir, `agent-${name.toLowerCase()}`);
			const home = path.join(root, "home");
			const clone = path.join(root, "clone");
			await mkdir(home, { recursive: true });
			await gitOk(["clone", "-q", remote, clone], {
				cwd: root,
				env: env(home),
				token,
			});
			homes.set(clone, home);
			return clone;
		},
		awaitOpen: async (repo, first) => {
			let lane = first;
			const deadline = Date.now() + LANE_OPEN_WAIT_MS;
			for (;;) {
				const commands = lane.git;
				if (lane.state === "open" && commands !== undefined) {
					return { ...lane, git: commands };
				}
				if (Date.now() > deadline) {
					throw new Error(
						`lane ${lane.id} of agent ${name} never opened (${
							LANE_OPEN_WAIT_MS / 1000
						} s)`,
					);
				}
				await sleep(2_000);
				({ lane } = await mcp.call<{ lane: LaneHandle }>("lanes_get", {
					repo,
					laneId: lane.id,
				}));
			}
		},
		runLane: async (text, cwd) => {
			for (const args of parseGitCommands(text)) {
				await gitOk(args, { cwd, env: envOf(cwd), token });
			}
		},
		commit: async (cwd, subject, trailers = []) => {
			const e = envOf(cwd);
			await gitOk(["add", "--all"], { cwd, env: e });
			await gitOk([
				"commit",
				"-q",
				"--no-verify",
				"-m",
				subject,
				...(trailers.length > 0 ? ["-m", trailers.join("\n")] : []),
			], { cwd, env: e });
			return (await gitOk(["rev-parse", "HEAD"], { cwd, env: e })).trim();
		},
		git: (cwd, args) => gitOk(args, { cwd, env: envOf(cwd), token }),
		gitResult: (cwd, args) => git(args, { cwd, env: envOf(cwd), token }),
	};
};
