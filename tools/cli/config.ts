// `tartan` CLI configuration (WP11): the forges you
// logged in to and their tokens, in `$TARTAN_CONFIG`, else
// `$XDG_CONFIG_HOME/tartan/config.json`, else `~/.config/tartan/config.json`,
// written with mode 0600. `TARTAN_TOKEN` and `TARTAN_URL` override it.

export type ForgeEntry = {
	readonly token: string;
	/** The principal the token authenticates (from `whoami` at login). */
	readonly principal?: string;
	readonly handle?: string;
};

export type CliConfig = {
	readonly default?: string;
	readonly forges: Readonly<Record<string, ForgeEntry>>;
};

export type CliEnv = {
	get(name: string): string | undefined;
};

export const EMPTY_CONFIG: CliConfig = { forges: {} };

export const configPath = (env: CliEnv): string => {
	const explicit = env.get("TARTAN_CONFIG");
	if (explicit) return explicit;
	const xdg = env.get("XDG_CONFIG_HOME");
	const home = env.get("HOME") ?? env.get("USERPROFILE") ?? ".";
	return `${xdg ?? `${home}/.config`}/tartan/config.json`;
};

/** `https://host[:port]` of a URL or origin; throws for anything else. */
export const originOf = (value: string): string => {
	const url = new URL(value);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`not an http(s) URL: ${value}`);
	}
	return url.origin;
};

export const readConfig = async (path: string): Promise<CliConfig> => {
	try {
		const parsed = JSON.parse(await Deno.readTextFile(path)) as CliConfig;
		return { ...parsed, forges: parsed.forges ?? {} };
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) return EMPTY_CONFIG;
		throw error;
	}
};

export const writeConfig = async (
	path: string,
	config: CliConfig,
): Promise<void> => {
	const dir = path.slice(0, path.lastIndexOf("/"));
	if (dir !== "") await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
	await Deno.writeTextFile(path, JSON.stringify(config, null, "\t") + "\n", {
		mode: 0o600,
	});
	// `mode` applies on create only; tighten an existing file too.
	await Deno.chmod(path, 0o600).catch(() => {});
};

export type Credential = {
	readonly origin: string;
	readonly token: string;
	readonly principal?: string;
};

/**
 * The forge `TARTAN_TOKEN` belongs to: `TARTAN_URL`, else the configured
 * default. The token is never offered to any other host.
 */
const envTokenOrigin = (config: CliConfig, env: CliEnv): string | null => {
	const url = env.get("TARTAN_URL") ?? config.default;
	if (url === undefined) return null;
	try {
		return originOf(url);
	} catch {
		return null;
	}
};

/**
 * The forge and token to use: `--forge`, else `TARTAN_URL`, else the
 * configured default; the token from `TARTAN_TOKEN` (only for its own
 * forge), else the config. The stored principal is returned only with the
 * token it was stored for.
 */
export const resolveCredential = (
	config: CliConfig,
	env: CliEnv,
	forge?: string,
): Credential | null => {
	const wanted = forge ?? env.get("TARTAN_URL") ?? config.default;
	if (wanted === undefined) return null;
	const origin = originOf(wanted);
	const entry = config.forges[origin];
	const fromEnv = env.get("TARTAN_TOKEN");
	const token = fromEnv !== undefined && fromEnv !== "" &&
			envTokenOrigin(config, env) === origin
		? fromEnv
		: entry?.token;
	if (token === undefined || token === "") return null;
	return {
		origin,
		token,
		...(entry?.principal && entry.token === token
			? { principal: entry.principal }
			: {}),
	};
};

/** `agent` for `tagt_`, `user` for `tpat_`. */
export const tokenKind = (token: string): "agent" | "user" | null =>
	token.startsWith("tagt_")
		? "agent"
		: token.startsWith("tpat_")
		? "user"
		: null;
