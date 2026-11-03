// `deno task dev`: a local Tartan forge in miniflare, with no Cloudflare
// account and no network beyond loopback (and the internet for imports).
//
// Two Workers run in one miniflare instance:
// - `tartan`: the real Worker (src/index.ts), bundled with esbuild the way
//   wrangler bundles it, with the bindings of wrangler.jsonc. Durable
//   Objects, Workflows, R2, KV and the Worker Loader are miniflare's own.
// - `tartan-dev` (tools/dev/worker.ts): the front door, Tartan's outbound
//   service, the mock IdP and the bindings miniflare cannot run locally
//   (Artifacts, AI) as fakes.
//
// What differs from a deployed stage: everything is in memory and gone when
// the process stops; CI runs have no container (TartanSandbox is a plain
// Durable Object, so runs report `unavailable`); the global log (K2) is off;
// every sign-in is the one dev user (tools/dev/worker.ts `DEV_USER`).
//
// Usage: deno task dev [--port 8787] [--skip-web-build] [--tunnel]
//        [--tls-cert localhost.pem --tls-key localhost-key.pem]
// --tunnel serves plain HTTP on loopback behind a Cloudflare quick tunnel
// (cloudflared, no account), so the forge is at a public, trusted https URL;
// the automatic sign-in then needs the one-off key link the launcher prints.
// --skip-web-build serves the existing web/dist instead of rebuilding it.
// The certificate is the --tls-cert/--tls-key pair, else `localhost.pem` and
// `localhost-key.pem` in $XDG_DATA_HOME/tartan-dev (~/.local/share/tartan-dev),
// else self-signed, which browsers (and the desktop app's browser pane)
// refuse; the launcher then prints the mkcert commands that make the pair.

import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { artifactsNamespace, COMPAT_DATE } from "@tartan/contract";
import {
	type Args,
	certDir,
	defaultTls,
	mkcertHint,
	parseArgs,
	quickTunnelOrigin,
	type Tls,
} from "./args.ts";

const ROOT = new URL("../../", import.meta.url);
const fromRoot = (path: string): string => new URL(path, ROOT).pathname;

const OUT_DIR = fromRoot(".wrangler/tmp/dev");
const STAGE = "dev-local";
const DEV_IDP_ISSUER = "https://idp.tartan-dev.test";
// wrangler.jsonc minus `durable_object_io_tasks_prevent_eviction`, which
// miniflare's workerd rejects (as in vitest.config.ts).
const COMPAT_FLAGS = ["nodejs_compat", "global_fetch_strictly_public"];
const CRON_MS = 5 * 60_000;

const isFile = (path: string): Promise<boolean> =>
	Deno.stat(path).then((s) => s.isFile, () => false);

/** The --tls pair, else the default pair when both files exist, else null. */
const resolveTls = async (args: Args, dir: string | null) => {
	if (args.tls) return args.tls;
	if (dir === null) return null;
	const tls: Tls = defaultTls(dir);
	return (await isFile(tls.cert)) && (await isFile(tls.key)) ? tls : null;
};

const run = async (cmd: string, cmdArgs: string[]): Promise<void> => {
	const { code } = await new Deno.Command(cmd, {
		args: cmdArgs,
		cwd: fromRoot("."),
		stdout: "inherit",
		stderr: "inherit",
	}).output();
	if (code !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} failed`);
};

type Module = {
	readonly type: "ESModule" | "CompiledWasm";
	readonly path: string;
};

/**
 * Bundles one Worker entry to `<OUT_DIR>/<name>/index.js` (ESM, wasm copied
 * next to it) and lists its modules, the entry first.
 */
const bundle = async (
	name: string,
	entry: string,
): Promise<readonly Module[]> => {
	const outdir = `${OUT_DIR}/${name}`;
	const { metafile } = await build({
		metafile: true,
		entryPoints: [fromRoot(entry)],
		outdir,
		entryNames: "index",
		bundle: true,
		format: "esm",
		platform: "neutral",
		target: "es2023",
		conditions: ["workerd", "worker", "browser"],
		mainFields: ["module", "main"],
		external: ["cloudflare:*", "node:*"],
		loader: { ".wasm": "copy" },
		tsconfig: fromRoot("tsconfig.json"),
		logLevel: "warning",
	});
	const outputs = Object.keys(metafile.outputs).map((path) => fromRoot(path));
	const main = `${outdir}/index.js`;
	return [
		{ type: "ESModule", path: main },
		...outputs.filter((path) => path.endsWith(".wasm")).map((path) => ({
			type: "CompiledWasm" as const,
			path,
		})),
	];
};

type Tunnel = { readonly origin: string; readonly child: Deno.ChildProcess };

/** The text lines of a byte stream; one iterator, so it can be resumed. */
const linesOf = (
	stream: ReadableStream<Uint8Array>,
): AsyncIterableIterator<string> => {
	const chunks = stream.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	const next = async (): Promise<IteratorResult<string>> => {
		for (;;) {
			const newline = buffered.indexOf("\n");
			if (newline >= 0) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				return { value: line, done: false };
			}
			const { value, done } = await chunks.read();
			if (done) {
				if (buffered === "") return { value: undefined, done: true };
				const line = buffered;
				buffered = "";
				return { value: line, done: false };
			}
			buffered += decoder.decode(value, { stream: true });
		}
	};
	const iterator: AsyncIterableIterator<string> = {
		next,
		[Symbol.asyncIterator]: () => iterator,
	};
	return iterator;
};

/**
 * Starts a Cloudflare quick tunnel (`cloudflared`, no account) to `local` and
 * resolves with its `https://*.trycloudflare.com` origin. cloudflared's log
 * keeps being read so its pipe never fills; error lines are echoed.
 */
const startTunnel = async (local: string): Promise<Tunnel> => {
	let child: Deno.ChildProcess;
	try {
		child = new Deno.Command("cloudflared", {
			args: ["tunnel", "--no-autoupdate", "--url", local],
			stdout: "null",
			stderr: "piped",
		}).spawn();
	} catch (err) {
		if (err instanceof Deno.errors.NotFound) {
			throw new Error(
				"--tunnel needs cloudflared on PATH, e.g. " +
					"`nix shell nixpkgs#cloudflared -c deno task dev --tunnel`",
			);
		}
		throw err;
	}
	const lines = linesOf(child.stderr);
	const timeout = setTimeout(() => child.kill(), 60_000);
	for await (const line of lines) {
		const origin = quickTunnelOrigin(line);
		if (origin === null) continue;
		clearTimeout(timeout);
		(async () => {
			for await (const next of lines) {
				if (/\bERR\b/.test(next)) console.error(`[cloudflared] ${next}`);
			}
		})();
		return { origin, child };
	}
	clearTimeout(timeout);
	throw new Error("cloudflared did not report a quick tunnel URL in 60 s");
};

const randomKey = (): string =>
	btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
		.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const main = async (args: Args): Promise<void> => {
	const { port } = args;
	const dir = certDir((name) => Deno.env.get(name));
	const tls = args.tunnel ? null : await resolveTls(args, dir);
	const tunnel = args.tunnel
		? await startTunnel(`http://127.0.0.1:${port}`)
		: null;
	const devKey = tunnel ? randomKey() : "";
	await Deno.remove(OUT_DIR, { recursive: true }).catch(() => {});
	if (args.buildWeb) await run("npm", ["run", "build:web"]);
	const [tartanModules, devModules] = await Promise.all([
		bundle("tartan", "src/index.ts"),
		bundle("tartan-dev", "tools/dev/worker.ts"),
	]);
	const dev = (entrypoint: string) => ({ name: "tartan-dev", entrypoint });

	const mf = new Miniflare(convertV4MiniflareOptions({
		// The setup wizard takes only an https canonical origin (contract
		// HttpsUrl). Behind a tunnel, Cloudflare serves https and miniflare
		// plain HTTP on loopback, with `upstream` making the Workers see the
		// public https URL. Otherwise a trusted pair when there is one, else
		// miniflare's self-signed certificate for localhost.
		...(tunnel ? { host: "127.0.0.1", port, upstream: tunnel.origin } : {
			host: "localhost",
			port,
			https: true,
			...(tls
				? {
					httpsCert: await Deno.readTextFile(tls.cert),
					httpsKey: await Deno.readTextFile(tls.key),
				}
				: {}),
		}),
		workers: [
			{
				// The first worker gets the incoming requests.
				name: "tartan-dev",
				modules: [...devModules],
				modulesRoot: `${OUT_DIR}/tartan-dev`,
				compatibilityDate: COMPAT_DATE,
				compatibilityFlags: ["nodejs_compat"],
				serviceBindings: { TARTAN: "tartan" },
				workflows: {
					INGEST: {
						name: "tartan-ingest",
						className: "IngestWorkflow",
						scriptName: "tartan",
					},
				},
				bindings: {
					ARTIFACTS_NAMESPACE: artifactsNamespace(STAGE),
					DEV_IDP_ISSUER,
					DEV_KEY: devKey,
				},
			},
			{
				name: "tartan",
				modules: [...tartanModules],
				modulesRoot: `${OUT_DIR}/tartan`,
				compatibilityDate: COMPAT_DATE,
				compatibilityFlags: COMPAT_FLAGS,
				outboundService: dev("Outbound"),
				serviceBindings: {
					ARTIFACTS: dev("FakeArtifacts"),
					AI: dev("FakeAi"),
				},
				assets: {
					directory: fromRoot("web/dist"),
					binding: "ASSETS",
					routerConfig: {
						has_user_worker: true,
						invoke_user_worker_ahead_of_assets: true,
					},
					assetConfig: {
						not_found_handling: "single-page-application",
					},
				},
				durableObjects: {
					FORGE: { className: "ForgeDO", useSQLite: true },
					REPO: { className: "RepoDO", useSQLite: true },
					INBOX: { className: "InboxDO", useSQLite: true },
					EXT: { className: "ExtensionDO", useSQLite: true },
					SANDBOX: { className: "TartanSandbox", useSQLite: true },
					BUS: { className: "BusDO", useSQLite: true },
				},
				workflows: {
					RUNS: { name: "tartan-run", className: "RunWorkflow" },
					LAND: { name: "tartan-land", className: "LandWorkflow" },
					INGEST: { name: "tartan-ingest", className: "IngestWorkflow" },
					SWARM: { name: "tartan-swarm", className: "SwarmWorkflow" },
				},
				workerLoaders: { LOADER: {} },
				r2Buckets: { BLOBS: "tartan-blobs" },
				kvNamespaces: { OAUTH_KV: "tartan-oauth-kv" },
				bindings: {
					TARTAN_STAGE: STAGE,
					TARTAN_FEATURES: "echo,oauth",
					TARTAN_DEV_TOOLS: "0",
					TARTAN_MAX_PUSH_MB: "95",
					TARTAN_JUDGE_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
					OIDC_ISSUER: "",
					OIDC_CLIENT_ID: "",
				},
			},
		],
	}));

	const ready = await mf.ready;
	const origin = tunnel?.origin ?? ready.origin;
	console.log(`
[tartan-dev] forge:  ${origin}
[tartan-dev] setup:  open ${origin}/-/setup, unlock with the "setup code"
             line printed below, use ${origin} as the canonical origin
             and ${DEV_IDP_ISSUER} as the IdP issuer.
[tartan-dev] sign-in is automatic as "dev"; state is in memory only.
`);
	if (tunnel) {
		console.log(
			`[tartan-dev] tunnel: public; the automatic sign-in needs this link ` +
				`once per browser:\n\n    ${origin}/-/tartan-dev/sign-in?key=${devKey}\n`,
		);
	} else if (tls) {
		console.log(`[tartan-dev] tls:    ${tls.cert}`);
	} else {
		const where = dir ?? "<dir>";
		console.log(
			`[tartan-dev] tls:    self-signed: browsers refuse it, and git needs ` +
				`GIT_SSL_NO_VERIFY=1. For a trusted certificate (once):\n\n` +
				mkcertHint(where).replace(/^/gm, "    ") + "\n",
		);
	}

	// The deployed 5-minute cron (wrangler.jsonc `triggers.crons`), once at
	// start and then on the same period. miniflare's Fetcher type omits
	// `scheduled`, which workerd's service binding has.
	const tartan = await mf.getWorker("tartan") as unknown as {
		scheduled(options: { cron: string }): Promise<{ outcome: string }>;
	};
	const tick = () =>
		tartan.scheduled({ cron: "*/5 * * * *" }).then(
			({ outcome }) => {
				if (outcome !== "ok") console.error(`[tartan-dev] cron: ${outcome}`);
			},
			(err: unknown) => console.error(`[tartan-dev] cron failed: ${err}`),
		);
	await tick();
	console.log("[tartan-dev] cron ran once; next every 5 minutes");
	const cron = setInterval(tick, CRON_MS);

	const stop = async () => {
		clearInterval(cron);
		tunnel?.child.kill();
		await mf.dispose();
		await Deno.remove(OUT_DIR, { recursive: true }).catch(() => {});
		Deno.exit(0);
	};
	Deno.addSignalListener("SIGINT", stop);
	Deno.addSignalListener("SIGTERM", stop);
};

await main(parseArgs(Deno.args));
