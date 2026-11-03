// What every `tt` command shares: its I/O as explicit dependencies (so tests
// drive it without a terminal), parsed arguments, and the credential lookup.

import {
	type CliConfig,
	type CliEnv,
	configPath,
	type Credential,
	readConfig,
	resolveCredential,
} from "./config.ts";
import type { Git } from "./git.ts";
import type { FetchLike, ToolAnswer } from "./mcp.ts";

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
	/** Everything after `--`, passed through untouched. */
	readonly passthrough: readonly string[];
};

export const flag = (args: Args, name: string): string | undefined => {
	const v = args.flags[name];
	return typeof v === "string" ? v : Array.isArray(v) ? v.at(-1) : undefined;
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
	const credential = resolveCredential(config, io.env, flag(args, "hostname"));
	if (credential === null) {
		throw new UsageError(
			"not logged in: run `tt auth login --hostname <forge URL>` or set TARTAN_URL and TARTAN_TOKEN",
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
