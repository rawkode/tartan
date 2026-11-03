// `deno task dev` arguments and where its trusted localhost certificate lives.
// Pure, so tools/dev/args.test.ts runs without miniflare.

export type Tls = { readonly cert: string; readonly key: string };

export type Args = {
	readonly port: number;
	readonly buildWeb: boolean;
	/** PEM files from --tls-cert/--tls-key; absent → look in `certDir`. */
	readonly tls?: Tls;
	/** --tunnel: plain HTTP locally behind a Cloudflare quick tunnel. */
	readonly tunnel: boolean;
};

export const parseArgs = (argv: readonly string[]): Args => {
	let port = 8787;
	let buildWeb = true;
	let tunnel = false;
	let cert: string | undefined;
	let key: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--skip-web-build") buildWeb = false;
		else if (arg === "--tunnel") tunnel = true;
		else if (arg === "--port") port = Number(argv[++i]);
		else if (arg === "--tls-cert") cert = argv[++i];
		else if (arg === "--tls-key") key = argv[++i];
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("--port needs a port number");
	}
	if ((cert === undefined) !== (key === undefined)) {
		throw new Error("--tls-cert and --tls-key go together");
	}
	if (tunnel && cert !== undefined) {
		throw new Error("--tunnel serves plain HTTP locally; drop --tls-cert");
	}
	return {
		port,
		buildWeb,
		tunnel,
		...(cert !== undefined && key !== undefined ? { tls: { cert, key } } : {}),
	};
};

/**
 * The default certificate directory: `$XDG_DATA_HOME/tartan-dev`, else
 * `~/.local/share/tartan-dev`; null without either variable.
 */
export const certDir = (
	env: (name: string) => string | undefined,
): string | null => {
	const data = env("XDG_DATA_HOME") ||
		(env("HOME") ? `${env("HOME")}/.local/share` : undefined);
	return data ? `${data}/tartan-dev` : null;
};

/** The pair `deno task dev` looks for in `dir` (mkcert's file names). */
export const defaultTls = (dir: string): Tls => ({
	cert: `${dir}/localhost.pem`,
	key: `${dir}/localhost-key.pem`,
});

const QUICK_TUNNEL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** The quick tunnel's public origin in one line of cloudflared output, or null. */
export const quickTunnelOrigin = (line: string): string | null =>
	QUICK_TUNNEL_RE.exec(line)?.[0] ?? null;

/** The commands that make the default pair, printed when it is missing. */
export const mkcertHint = (dir: string): string => {
	const { cert, key } = defaultTls(dir);
	return [
		"mkcert -install",
		`mkdir -p ${dir}`,
		`mkcert -cert-file ${cert} -key-file ${key} localhost`,
	].join("\n");
};
