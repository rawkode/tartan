// `tartan`: the Tartan CLI (WP11). Run with
// `deno run -A tools/cli/main.ts …` or compile it with
// `deno compile -A -o tartan tools/cli/main.ts`.

import {
	type Args,
	credential,
	hooks,
	inbox,
	type Io,
	laneClose,
	laneList,
	laneOpen,
	laneStatus,
	login,
	UsageError,
	whoami,
} from "./commands.ts";
import { createGit } from "./git.ts";
import { configSchema, configShow, configVet } from "./repoconfig.ts";

export const USAGE = `tartan: the Tartan forge CLI

  tartan login <forge URL> [--token-stdin]    store a tagt_/tpat_ token (TARTAN_TOKEN wins)
  tartan whoami [--scope <path>]
  tartan lane open --repo <path> --purpose <text> [--prefix <p>]… [--project <p>]… [--wait <s>] [--no-remote] [--json]
  tartan lane status <laneId> [--repo <path>]
  tartan lane list --repo <path> [--mine] [--json]
  tartan lane close <laneId> --reason <text> [--repo <path>]
  tartan inbox [--repo <path>] [--since <seq>] [--wait [<ms>]] [--ack] [--json]
  tartan config show --repo <path> [--json]               Tartan config (root CUE package tartan)
  tartan config vet [--repo <path>] [--lane <id>] [--wait <s>] [--json]   preview a lane's root *.cue files
  tartan config schema --repo <path> --out <dir>          the forge's schema files, to run cue export locally
  tartan credential install [--forge <URL>] [--global]   git credential helper for the forge
  tartan credential get|store|erase                       (called by git)
  tartan hooks install --git [--force]                    pre-push size and target check
  tartan hooks pre-push <remote> <url>                    (called by the hook)

Every command takes --forge <URL> (else TARTAN_URL, else the login default).`;

/** `--flag value`, `--flag=value`, bare `--flag` (true); repeats collect. */
export const parseArgs = (argv: readonly string[]): Args => {
	const positional: string[] = [];
	const flags: Record<string, string | true | string[]> = {};
	const put = (name: string, value: string | true) => {
		const prev = flags[name];
		if (prev === undefined) flags[name] = value;
		else if (value === true) return;
		else if (Array.isArray(prev)) prev.push(value);
		else if (prev === true) flags[name] = value;
		else flags[name] = [prev, value];
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			positional.push(...argv.slice(i + 1));
			break;
		}
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		if (eq > 0) {
			put(arg.slice(2, eq), arg.slice(eq + 1));
			continue;
		}
		const next = argv[i + 1];
		if (
			next !== undefined && !next.startsWith("--") && VALUED.has(arg.slice(2))
		) {
			put(arg.slice(2), next);
			i += 1;
		} else {
			put(arg.slice(2), true);
		}
	}
	return { positional, flags };
};

/** Flags that take a value when one follows. */
const VALUED = new Set([
	"forge",
	"repo",
	"purpose",
	"prefix",
	"project",
	"wait",
	"reason",
	"since",
	"scope",
	"lane",
	"out",
]);

const readAll = async (): Promise<string> => {
	const chunks: Uint8Array[] = [];
	for await (const chunk of Deno.stdin.readable) chunks.push(chunk);
	return new TextDecoder().decode(
		chunks.reduce((all, c) => {
			const out = new Uint8Array(all.length + c.length);
			out.set(all);
			out.set(c, all.length);
			return out;
		}, new Uint8Array()),
	);
};

const readSecret = async (prompt: string): Promise<string | null> => {
	if (!Deno.stdin.isTerminal()) return null;
	await Deno.stderr.write(new TextEncoder().encode(prompt));
	Deno.stdin.setRaw(true);
	try {
		const bytes: number[] = [];
		const buf = new Uint8Array(1);
		while (true) {
			const n = await Deno.stdin.read(buf);
			if (n === null || buf[0] === 13 || buf[0] === 10) break;
			if (buf[0] === 3) throw new Error("cancelled");
			if (buf[0] === 127 || buf[0] === 8) bytes.pop();
			else bytes.push(buf[0]);
		}
		return new TextDecoder().decode(new Uint8Array(bytes));
	} finally {
		Deno.stdin.setRaw(false);
		await Deno.stderr.write(new TextEncoder().encode("\n"));
	}
};

export const denoIo = (): Io => ({
	env: { get: (name) => Deno.env.get(name) },
	git: createGit(),
	fetch: (input, init) => fetch(input, init),
	out: (text) => console.log(text),
	err: (text) => console.error(text),
	readStdin: readAll,
	readSecret,
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

/** Runs one command line; the exit code. */
export const run = async (io: Io, argv: readonly string[]): Promise<number> => {
	const [command, ...rest] = argv;
	const args = parseArgs(rest);
	const sub = { ...args, positional: args.positional.slice(1) };
	try {
		switch (command) {
			case "login":
				await login(io, args);
				return 0;
			case "whoami":
				await whoami(io, args);
				return 0;
			case "lane":
				switch (args.positional[0]) {
					case "open":
						await laneOpen(io, sub);
						return 0;
					case "status":
						await laneStatus(io, sub);
						return 0;
					case "list":
						await laneList(io, sub);
						return 0;
					case "close":
						await laneClose(io, sub);
						return 0;
				}
				throw new UsageError("usage: tartan lane open|status|list|close …");
			case "inbox":
				await inbox(io, args);
				return 0;
			case "config":
				switch (args.positional[0]) {
					case "show":
						await configShow(io, sub);
						return 0;
					case "vet":
						return await configVet(io, sub);
					case "schema":
						await configSchema(io, sub);
						return 0;
				}
				throw new UsageError("usage: tartan config show|vet|schema …");
			case "credential":
				await credential(io, args);
				return 0;
			case "hooks":
				return await hooks(io, args);
			case undefined:
			case "help":
			case "--help":
				io.out(USAGE);
				return 0;
			default:
				throw new UsageError(`unknown command ${command}\n\n${USAGE}`);
		}
	} catch (error) {
		io.err(`tartan: ${error instanceof Error ? error.message : String(error)}`);
		return error instanceof UsageError ? 2 : 1;
	}
};

if (import.meta.main) {
	Deno.exit(await run(denoIo(), Deno.args));
}
