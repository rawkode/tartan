// `tt auth`: log in to a forge (the token is checked with `whoami` before it
// is stored), show, print and forget tokens, and act as git's credential
// helper for the forges you logged in to.

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
import {
	type CliConfig,
	configPath,
	knownOrigins,
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
import { createMcpClient } from "./mcp.ts";

/** Where a signed-in person creates an agent and its `tagt_` token. */
export const TOKEN_PAGE = "/-/agents";

const TOKEN_RE = /^(tagt|tpat)_[A-Za-z0-9_-]{43}$/;

type Principal = { readonly id: string; readonly handle: string };

const whoami = async (
	io: Io,
	origin: string,
	token: string,
): Promise<Principal> => {
	const who = answered(
		io,
		await createMcpClient(origin, token, io.fetch).call("", "whoami"),
	);
	return who.value.principal as Principal;
};

const targetOrigin = (io: Io, args: Args, config: CliConfig) => {
	const target = flag(args, "hostname") ?? io.env.get("TARTAN_URL") ??
		config.default;
	if (target === undefined) {
		throw new UsageError("--hostname <forge URL> is required");
	}
	return originOf(target);
};

export const authLogin = async (io: Io, args: Args): Promise<void> => {
	const path = configPath(io.env);
	const config = await readConfig(path);
	const origin = targetOrigin(io, args, config);
	let token: string;
	if (has(args, "with-token")) {
		token = (await io.readStdin()).trim();
	} else {
		io.err(`Create a token at ${origin}${TOKEN_PAGE}, then paste it here.`);
		token = ((await io.readSecret("Paste your token: ")) ??
			await io.readStdin()).trim();
	}
	if (!TOKEN_RE.test(token)) {
		throw new Error("that is not a Tartan token (tagt_… or tpat_…)");
	}
	const principal = await whoami(io, origin, token);
	await writeConfig(path, {
		...config,
		default: origin,
		forges: {
			...config.forges,
			[origin]: { token, principal: principal.id, handle: principal.handle },
		},
	});
	io.out(`Logged in to ${origin} as ${principal.handle} (${principal.id})`);
};

const masked = (token: string) => `${token.slice(0, 5)}${"*".repeat(8)}`;

/** Exit code: 0 when every listed forge accepts its token, else 1. */
export const authStatus = async (io: Io, args: Args): Promise<number> => {
	const config = await loadConfig(io);
	const hostname = flag(args, "hostname");
	const origins = hostname !== undefined
		? [originOf(hostname)]
		: knownOrigins(config, io.env);
	if (origins.length === 0) {
		io.err("You are not logged in to any forge. Run `tt auth login`.");
		return 1;
	}
	const active = resolveCredential(config, io.env)?.origin;
	let failed = false;
	for (const origin of origins) {
		const credential = resolveCredential(config, io.env, origin);
		if (credential === null) {
			io.out(`${origin}\n  Not logged in`);
			failed = true;
			continue;
		}
		const source = config.forges[origin]?.token === credential.token
			? configPath(io.env)
			: "TARTAN_TOKEN";
		let state: string;
		try {
			const who = await whoami(io, origin, credential.token);
			state = `Logged in as ${who.handle} (${who.id}) (${source})`;
		} catch (error) {
			failed = true;
			state = `The token in ${source} is invalid: ${
				error instanceof Error ? error.message : String(error)
			}`;
		}
		io.out(
			[
				origin,
				`  ${state}`,
				`  Active forge: ${origin === active}`,
				`  Token: ${masked(credential.token)}`,
			].join("\n"),
		);
	}
	return failed ? 1 : 0;
};

export const authLogout = async (io: Io, args: Args): Promise<void> => {
	const path = configPath(io.env);
	const config = await readConfig(path);
	const origin = targetOrigin(io, args, config);
	if (config.forges[origin] === undefined) {
		throw new Error(`not logged in to ${origin}`);
	}
	const { [origin]: _gone, ...forges } = config.forges;
	const rest = Object.keys(forges);
	const fallback = config.default === origin ? rest[0] : config.default;
	await writeConfig(path, {
		forges,
		...(fallback !== undefined ? { default: fallback } : {}),
	});
	io.out(`Logged out of ${origin}`);
};

export const authToken = async (io: Io, args: Args): Promise<void> => {
	io.out(requireCredential(await loadConfig(io), io, args).token);
};

export const authSetupGit = async (io: Io, args: Args): Promise<void> => {
	const config = await loadConfig(io);
	const hostname = flag(args, "hostname");
	const origins = hostname !== undefined
		? [originOf(hostname)]
		: knownOrigins(config, io.env);
	if (origins.length === 0) {
		throw new UsageError(
			"not logged in: run `tt auth login` first, or pass --hostname",
		);
	}
	for (const origin of origins) {
		const value = await installCredentialHelper(io.git, origin);
		io.out(`git now asks \`${value}\` for ${origin}`);
	}
};

export const authGitCredential = async (io: Io, args: Args): Promise<void> => {
	const action = args.positional[0];
	if (action !== "get" && action !== "store" && action !== "erase") {
		throw new UsageError("usage: tt auth git-credential get|store|erase");
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
