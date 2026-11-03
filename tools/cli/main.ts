// `tt`: log in to a Tartan forge and clone its repositories over HTTPS with
// stock git. Run with `deno run -A tools/cli/main.ts …` or compile it with
// `deno compile -A -o tt tools/cli/main.ts`.

import {
	authGitCredential,
	authLogin,
	authLogout,
	authSetupGit,
	authStatus,
	authToken,
} from "./auth.ts";
import { type Args, has, type Io, UsageError } from "./commands.ts";
import { createGit } from "./git.ts";
import { repoClone } from "./repo.ts";
import { configSchema, configShow, configVet } from "./repoconfig.ts";

const ENVIRONMENT = `ENVIRONMENT
  TARTAN_URL     the forge to use when --hostname is not given
  TARTAN_TOKEN   a token for TARTAN_URL (else the default forge); wins over the stored one
  TARTAN_CONFIG  the config file (default $XDG_CONFIG_HOME/tartan/config.json)`;

export const USAGE = `Work with a Tartan forge from the command line.

USAGE
  tt <command> <subcommand> [flags]

COMMANDS
  auth:    Log in, log out and set git up to use tt for HTTPS
  repo:    Clone repositories
  config:  Show, preview and export a repository's CUE config

FLAGS
  --help   Show help for a command

${ENVIRONMENT}

Run \`tt <command> --help\` for more about a command.`;

const HELP: Readonly<Record<string, string>> = {
	auth: `Authenticate tt and git with a Tartan forge.

USAGE
  tt auth <subcommand> [flags]

SUBCOMMANDS
  login:           Log in to a forge
  logout:          Log out of a forge
  status:          Show the forges you are logged in to
  token:           Print the token for a forge
  setup-git:       Set git up to use tt as the credential helper
  git-credential:  The credential helper git runs (not for people)`,
	"auth login": `Log in to a forge.

Without --with-token, tt prints where to create a token on the forge and
asks for it. With --with-token, the token is read from standard input. The
token is checked with the forge before it is stored, and the forge becomes
the default one.

USAGE
  tt auth login [--hostname <forge URL>] [--with-token]

FLAGS
  --hostname <forge URL>  The forge (default TARTAN_URL, else the default forge)
  --with-token            Read the token from standard input

EXAMPLES
  $ tt auth login --hostname https://code.example.com
  $ tt auth login --hostname https://code.example.com --with-token < token.txt`,
	"auth logout": `Remove a forge's stored token.

USAGE
  tt auth logout [--hostname <forge URL>]`,
	"auth status": `Check the token of each forge you are logged in to.

USAGE
  tt auth status [--hostname <forge URL>]`,
	"auth token": `Print the token tt uses for a forge.

USAGE
  tt auth token [--hostname <forge URL>]`,
	"auth setup-git": `Set git up to use tt as the credential helper.

For each forge (every one you are logged in to, or --hostname), the global
credential.<forge>.helper list is reset and then set to
\`tt auth git-credential\`.

USAGE
  tt auth setup-git [--hostname <forge URL>]`,
	"auth git-credential": `The git credential helper (git runs it).

USAGE
  tt auth git-credential get|store|erase`,
	repo: `Work with forge repositories.

USAGE
  tt repo <subcommand> [flags]

SUBCOMMANDS
  clone:  Clone a repository over HTTPS`,
	"repo clone": `Clone a repository over HTTPS with git.

A forge path (owner/…/repo) resolves against the default forge, or
--hostname, to https://<forge>/<path>.git. When git does not yet ask tt for
that forge (\`tt auth setup-git\`), the new clone gets the credential helper
in its own config. Flags after -- go to \`git clone\`.

USAGE
  tt repo clone <owner/…/repo | URL> [<dir>] [-- <git clone flags>]

FLAGS
  --hostname <forge URL>  The forge for a forge path

EXAMPLES
  $ tt repo clone acme/shop
  $ tt repo clone acme/platform/router router -- --depth 1`,
	config: `Work with a repository's Tartan config (the root CUE package tartan).

USAGE
  tt config <subcommand> [flags]

SUBCOMMANDS
  show:    Show the repository's current config
  vet:     Preview a lane's root *.cue files
  schema:  Write the forge's schema files, to run cue export locally`,
	"config show": `Show the repository's current config.

USAGE
  tt config show --repo <path> [--json] [--hostname <forge URL>]`,
	"config vet":
		`Preview a lane's root *.cue files (the current lanes/<id> branch by default).

Exits 0 when the config is ok or unchanged, 1 on errors or denials, and 3
when it is still evaluating after --wait seconds (default 60).

USAGE
  tt config vet --repo <path> [--lane <id>] [--wait <s>] [--json] [--hostname <forge URL>]`,
	"config schema":
		`Write the forge's schema files and a local module file into <dir>.

USAGE
  tt config schema --repo <path> --out <dir> [--hostname <forge URL>]`,
};

/** Flags that take a value when one follows. */
const VALUED = new Set(["hostname", "repo", "lane", "wait", "out"]);

/**
 * `--flag value`, `--flag=value`, bare `--flag` (true); repeats collect; `-h`
 * is `--help`; everything after `--` is passed through.
 */
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
			return { positional, flags, passthrough: argv.slice(i + 1) };
		}
		if (arg === "-h") {
			put("help", true);
			continue;
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
			next !== undefined && !next.startsWith("-") && VALUED.has(arg.slice(2))
		) {
			put(arg.slice(2), next);
			i += 1;
		} else {
			put(arg.slice(2), true);
		}
	}
	return { positional, flags, passthrough: [] };
};

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

type Command = (io: Io, args: Args) => Promise<number | void>;

const COMMANDS: Readonly<Record<string, Record<string, Command>>> = {
	auth: {
		login: authLogin,
		logout: authLogout,
		status: authStatus,
		token: authToken,
		"setup-git": authSetupGit,
		"git-credential": authGitCredential,
	},
	repo: { clone: repoClone },
	config: { show: configShow, vet: configVet, schema: configSchema },
};

/** Runs one command line; the exit code. */
export const run = async (io: Io, argv: readonly string[]): Promise<number> => {
	const args = parseArgs(argv);
	const [group, sub, ...positional] = args.positional;
	try {
		if (group === undefined || group === "help") {
			const topic = [sub, ...positional].join(" ");
			io.out(topic === "" ? USAGE : HELP[topic] ?? USAGE);
			return 0;
		}
		const subcommands = COMMANDS[group];
		if (subcommands === undefined) {
			throw new UsageError(`unknown command "${group}" for "tt"\n\n${USAGE}`);
		}
		const command = sub === undefined ? undefined : subcommands[sub];
		if (has(args, "help")) {
			io.out(HELP[command === undefined ? group : `${group} ${sub}`]);
			return 0;
		}
		if (command === undefined) {
			throw new UsageError(
				sub === undefined
					? HELP[group]
					: `unknown command "${sub}" for "tt ${group}"\n\n${HELP[group]}`,
			);
		}
		return (await command(io, { ...args, positional })) ?? 0;
	} catch (error) {
		io.err(error instanceof Error ? error.message : String(error));
		return error instanceof UsageError ? 2 : 1;
	}
};

if (import.meta.main) {
	Deno.exit(await run(denoIo(), Deno.args));
}
