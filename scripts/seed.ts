// Seed a demo beat on a dev stage (WP20), or build the
// demo mirror. Dev stages only: the stage's `/-/health` must name a `^dev`
// stage, and the swarm part needs that stage's dev tools.
//
//   deno run -A scripts/seed.ts --origin https://<dev host> --beat <n> \
//     [--mirror <dir> | --mirror-url <https url>] [--agents-file <path>] \
//     [--swarm-max <n>] [--allow-missing] [--fixture <file.json>]
//   deno run -A scripts/seed.ts --build-mirror --from <clone> --out <dir> \
//     [--drop-content]
//
// TARTAN_TOKEN: the forge Owner's PAT with the `api`, `admin` and `mcp`
// scopes (and `repo:write` to push a local mirror in import mode). It is sent
// as a bearer header only, never printed. The real
// agents' tokens (claude-code, codex), when this run creates them, go to
// `--agents-file` (default `~/.config/tartan/demo-agents-<host>.json`, mode
// 0600, refused inside this repository).

import { createInProcessPort } from "../src/kernel/swarm/transport.ts";
import { beatOf, DEMO, type DemoFixture } from "../fixtures/demo/beats.ts";
import { assertDevStage, createForgeClient } from "../fixtures/demo/client.ts";
import { buildMirror } from "../fixtures/demo/mirror.ts";
import { type MirrorSource, seedBeat } from "../fixtures/demo/seed.ts";

export type SeedArgs =
	| {
		readonly kind: "seed";
		readonly origin: string;
		readonly beat: number;
		readonly mirror?: MirrorSource;
		readonly agentsFile?: string;
		readonly swarmMax?: number;
		readonly allowMissing: boolean;
		readonly fixture?: string;
	}
	| {
		readonly kind: "mirror";
		readonly from: string;
		readonly out: string;
		readonly dropContent: boolean;
	};

const valueOf = (args: readonly string[], name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return undefined;
	const v = args[i + 1];
	if (v === undefined || v.startsWith("--")) {
		throw new Error(`--${name} needs a value`);
	}
	return v;
};

export const parseSeedArgs = (args: readonly string[]): SeedArgs => {
	if (args.includes("--build-mirror")) {
		const from = valueOf(args, "from");
		const out = valueOf(args, "out");
		if (!from || !out) throw new Error("--build-mirror needs --from and --out");
		return {
			kind: "mirror",
			from,
			out,
			dropContent: args.includes("--drop-content"),
		};
	}
	const origin = valueOf(args, "origin");
	if (!origin) throw new Error("--origin is required");
	const url = new URL(origin);
	if (url.protocol !== "https:") throw new Error("--origin must be https");
	const beatText = valueOf(args, "beat");
	if (beatText === undefined || !/^\d+$/.test(beatText)) {
		throw new Error("--beat <n> is required");
	}
	const dir = valueOf(args, "mirror");
	const mirrorUrl = valueOf(args, "mirror-url");
	if (dir && mirrorUrl) {
		throw new Error("give --mirror or --mirror-url, not both");
	}
	if (mirrorUrl && !mirrorUrl.startsWith("https://")) {
		throw new Error("--mirror-url must be https");
	}
	const max = valueOf(args, "swarm-max");
	const agentsFile = valueOf(args, "agents-file");
	const fixture = valueOf(args, "fixture");
	return {
		kind: "seed",
		origin: url.origin,
		beat: Number(beatText),
		...(dir
			? { mirror: { dir } }
			: mirrorUrl
			? { mirror: { url: mirrorUrl } }
			: {}),
		...(agentsFile ? { agentsFile } : {}),
		...(max ? { swarmMax: Number(max) } : {}),
		allowMissing: args.includes("--allow-missing"),
		...(fixture ? { fixture } : {}),
	};
};

/** Refuses a path inside the repository (tokens must never land in a tracked tree). */
export const assertOutsideRepo = (path: string, repoRoot: string): void => {
	const abs = path.startsWith("/") ? path : `${Deno.cwd()}/${path}`;
	const root = repoRoot.replace(/\/+$/, "");
	if (abs === root || abs.startsWith(`${root}/`)) {
		throw new Error(
			`refusing to write agent tokens inside the repository (${path})`,
		);
	}
};

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/+$/, "");

const defaultAgentsFile = (origin: string): string => {
	const home = Deno.env.get("HOME") ?? ".";
	return `${home}/.config/tartan/demo-agents-${new URL(origin).host}.json`;
};

const saveTokens = (path: string) => async (tokens: Record<string, string>) => {
	assertOutsideRepo(path, repoRoot);
	await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
	let existing: Record<string, string> = {};
	try {
		existing = JSON.parse(await Deno.readTextFile(path));
	} catch {
		// a new file
	}
	await Deno.writeTextFile(
		path,
		`${JSON.stringify({ ...existing, ...tokens }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
	await Deno.chmod(path, 0o600);
	console.log(
		`seed: agent tokens for ${
			Object.keys(tokens).join(", ")
		} written to ${path}`,
	);
};

/** `git push` of a mirror's HEAD with the token in a config env var (never in args or a file). */
const pushMirror = (token: string) => async (repoUrl: string, dir: string) => {
	const out = await new Deno.Command("git", {
		args: ["-C", dir, "push", "--quiet", repoUrl, "HEAD:refs/heads/main"],
		env: {
			GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "http.extraHeader",
			GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
		},
		stdout: "piped",
		stderr: "piped",
	}).output();
	if (!out.success) {
		const err = new TextDecoder().decode(out.stderr)
			.replaceAll(token, "[redacted]").trim();
		throw new Error(`git push of the mirror failed: ${err}`);
	}
};

const loadFixture = async (path?: string): Promise<DemoFixture> =>
	path ? { ...DEMO, ...JSON.parse(await Deno.readTextFile(path)) } : DEMO;

export const main = async (args: readonly string[]): Promise<number> => {
	const parsed = parseSeedArgs(args);
	if (parsed.kind === "mirror") {
		const result = await buildMirror(parsed);
		console.log(
			`seed: mirror ${parsed.out}: ${result.files} files (${result.placeholders} placeholders, ${result.dropped} dropped), pack ${
				(result.packKiB / 1024).toFixed(1)
			} MiB, commit ${result.commit.slice(0, 12)} from ${
				result.sourceSha.slice(0, 12)
			}`,
		);
		if (result.packKiB > 30 * 1024) {
			console.warn("seed: the mirror is over 30 MiB; try --drop-content");
		}
		return 0;
	}
	const token = Deno.env.get("TARTAN_TOKEN");
	if (!token) throw new Error("TARTAN_TOKEN is unset");
	const client = createForgeClient({ origin: parsed.origin, token });
	const health = await client.health();
	assertDevStage(health.stage);
	if (health.setupState !== "done") {
		throw new Error(
			`the forge is not claimed yet (setup: ${health.setupState})`,
		);
	}
	const fixture = await loadFixture(parsed.fixture);
	const started = Date.now();
	const report = await seedBeat(
		{
			client,
			portFor: (t, scope) =>
				createInProcessPort({
					handle: (req) => fetch(req),
					origin: parsed.origin,
					token: t,
					repo: scope,
				}),
			pushMirror: pushMirror(token),
			saveAgentTokens: saveTokens(
				parsed.agentsFile ?? defaultAgentsFile(parsed.origin),
			),
			log: (line) => console.log(`seed: ${line}`),
			now: () => Date.now(),
		},
		{
			beat: beatOf(fixture, parsed.beat),
			fixture,
			...(parsed.mirror ? { mirror: parsed.mirror } : {}),
			allowMissing: parsed.allowMissing,
			...(parsed.swarmMax ? { swarmMax: parsed.swarmMax } : {}),
		},
	);
	for (const line of report.skipped) console.warn(`seed: skipped: ${line}`);
	console.log(
		`seed: beat ${parsed.beat} ready in ${
			((Date.now() - started) / 1000).toFixed(1)
		} s; items ${JSON.stringify(report.items)}`,
	);
	return 0;
};

if (import.meta.main) {
	try {
		Deno.exit(await main(Deno.args));
	} catch (error) {
		console.error(`seed: ${error instanceof Error ? error.message : error}`);
		Deno.exit(1);
	}
}
