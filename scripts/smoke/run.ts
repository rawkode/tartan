// The smoke runner (`deno task smoke`).
//
//   deno task smoke -- --local [--suite git|lanes|all] [--only A1,U45]
//       Runs the drivers against the smoke Workers' handlers in process, with
//       FakeArtifacts behind them and stock git on loopback ports. Proves the
//       drivers and handlers work; says nothing about the platform.
//   deno task smoke -- --stage dev [--deploy] [--teardown] [--suite …] [--only …]
//       Live: deploys the throwaway `tartan-smoke-*` Workers (with
//       `--deploy`), runs the suites against them, writes evidence under
//       scripts/smoke/evidence/<date>/ (gitignored), leak-scans it, and
//       with `--teardown` deletes every `tartan-smoke-*` repo and the Workers. Keys live in
//       scripts/smoke/.dev.vars (gitignored, mode 600) and are never printed.
//
// Only `dev` and `dev-*` stages are accepted; never production.

import { createFakeArtifacts } from "@tartan/testkit";
import { createRecorder } from "./lib/evidence.ts";
import { gitEnv } from "./lib/git.ts";
import type { SmokeContext, WorkerTarget } from "./lib/context.ts";
import { api } from "./lib/context.ts";
import { scanDirs } from "./lib/leakscan.ts";
import { createGitApp, createMemoryRecorder } from "./worker-git/src/app.ts";
import {
	createLanesApp,
	createMemoryCapStore,
} from "./worker-lanes/src/app.ts";
import { runGitSuite } from "./suites/git.ts";
import { runLanesSuite } from "./suites/lanes.ts";
import { runBoxSuite } from "./suites/box.ts";
import { runRuntimeSuite } from "./suites/runtime.ts";

const SMOKE_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const EVIDENCE_DIR = `${SMOKE_DIR}/evidence`;
const VARS_FILE = `${SMOKE_DIR}/.dev.vars`;
const STAGE_RE = /^dev(-wp\d{2})?$/;

type Args = {
	local: boolean;
	stage: string;
	suites: string[];
	only: Set<string> | null;
	deploy: boolean;
	teardown: boolean;
	small: boolean;
	write: boolean;
};

export const parseArgs = (argv: readonly string[]): Args => {
	const value = (flag: string) => {
		const i = argv.indexOf(flag);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const local = argv.includes("--local");
	const suite = value("--suite") ?? "all";
	const only = value("--only");
	return {
		local,
		stage: local ? "local" : value("--stage") ?? "",
		suites: suite === "all" ? ["git", "lanes"] : suite.split(","),
		only: only ? new Set(only.split(",")) : null,
		deploy: argv.includes("--deploy"),
		teardown: argv.includes("--teardown"),
		small: local || argv.includes("--small"),
		write: !argv.includes("--no-write"),
	};
};

const randomHex = (bytes: number) =>
	Array.from(
		crypto.getRandomValues(new Uint8Array(bytes)),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");

/** KEY=VALUE pairs from scripts/smoke/.dev.vars; missing keys are generated. */
const loadVars = async (): Promise<Record<string, string>> => {
	let text = "";
	try {
		text = await Deno.readTextFile(VARS_FILE);
	} catch (e) {
		if (!(e instanceof Deno.errors.NotFound)) throw e;
	}
	const vars = Object.fromEntries(
		text.split("\n").filter((l) => l.includes("=")).map((l) => {
			const i = l.indexOf("=");
			return [l.slice(0, i), l.slice(i + 1)];
		}),
	);
	let changed = false;
	for (const k of ["SMOKE_KEY", "LANE_CAP_KEY"]) {
		if (!vars[k]) {
			vars[k] = randomHex(32);
			changed = true;
		}
	}
	if (changed) await saveVars(vars);
	return vars;
};

const saveVars = async (vars: Record<string, string>) => {
	await Deno.writeTextFile(
		VARS_FILE,
		Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
		{ mode: 0o600 },
	);
};

const wrangler = async (args: string[], stdin?: string) => {
	const child = new Deno.Command("npx", {
		args: ["wrangler", ...args],
		cwd: ROOT,
		env: { WRANGLER_SEND_METRICS: "false" },
		stdin: stdin === undefined ? "null" : "piped",
		stdout: "piped",
		stderr: "piped",
	}).spawn();
	if (stdin !== undefined) {
		const w = child.stdin.getWriter();
		await w.write(new TextEncoder().encode(stdin));
		await w.close();
	}
	const out = await child.output();
	const text = new TextDecoder().decode(out.stdout) +
		new TextDecoder().decode(out.stderr);
	if (!out.success) throw new Error(`wrangler ${args[0]} failed`);
	return text;
};

const WORKERS = {
	git: { dir: "worker-git", secrets: ["SMOKE_KEY"] },
	lanes: { dir: "worker-lanes", secrets: ["SMOKE_KEY", "LANE_CAP_KEY"] },
	box: { dir: "worker-box", secrets: ["SMOKE_KEY"] },
	runtime: { dir: "worker-runtime", secrets: ["SMOKE_KEY"] },
} as const;

/** The box Worker deploys the classic image unless `--box-dockerfile` (needs Docker). */
let boxConfig = "wrangler.classic.jsonc";
const configOf = (which: keyof typeof WORKERS) =>
	`${SMOKE_DIR}/${WORKERS[which].dir}/${
		which === "box" ? boxConfig : "wrangler.jsonc"
	}`;

/** Deploys one smoke Worker, puts its secrets, returns its workers.dev URL. */
const deployWorker = async (
	which: keyof typeof WORKERS,
	vars: Record<string, string>,
): Promise<string> => {
	const config = configOf(which);
	const out = await wrangler([
		"deploy",
		"-c",
		config,
		"--tsconfig",
		`${ROOT}/tsconfig.json`,
	]);
	const url = out.match(
		/https:\/\/tartan-smoke-[a-z]+\.[a-z0-9-]+\.workers\.dev/,
	)?.[0];
	if (!url) throw new Error(`no workers.dev URL in the ${which} deploy output`);
	for (const secret of WORKERS[which].secrets) {
		await wrangler(["secret", "put", secret, "-c", config], vars[secret]);
	}
	return url;
};

const teardownWorker = async (
	which: keyof typeof WORKERS,
	target: WorkerTarget | undefined,
) => {
	if (target && (which === "git" || which === "lanes")) {
		const prefix = `tartan-smoke-${which}`;
		const r = await api<{ matched: number }>(target, "/api/cleanup", {
			startsWith: prefix,
		});
		console.log(`teardown: deleted ${r.matched} ${prefix}-* repo(s)`);
	}
	const config = configOf(which);
	await wrangler(["delete", "-c", config, "--force"]);
	console.log(
		`teardown: deleted the tartan-smoke-${which} Worker; delete its empty Artifacts namespace with the REST call in docs/SMOKE.md`,
	);
};

/** In-process smoke Workers on loopback ports, backed by FakeArtifacts. */
const startLocal = (key: string, capKey: string) => {
	const servers: Deno.HttpServer[] = [];
	const serve = (handler: (r: Request) => Promise<Response> | Response) => {
		const s = Deno.serve(
			{ hostname: "127.0.0.1", port: 0, onListen: () => {} },
			handler,
		);
		servers.push(s);
		return `http://127.0.0.1:${s.addr.port}`;
	};
	// Fake remotes need their origin before they are served: bind first.
	const remotes = { git: "", lanes: "" };
	const fakeRoutes: Record<string, (r: Request) => Promise<Response>> = {};
	remotes.git = serve((r) => fakeRoutes.git(r));
	remotes.lanes = serve((r) => fakeRoutes.lanes(r));
	const gitFake = createFakeArtifacts({
		namespace: "tartan-smoke-git",
		origin: remotes.git,
		allowHttpImports: true,
		fetch: (r) => fetch(r),
	});
	const lanesFake = createFakeArtifacts({
		namespace: "tartan-smoke-lanes",
		origin: remotes.lanes,
		allowHttpImports: true,
		fetch: (r) => fetch(r),
	});
	fakeRoutes.git = gitFake.fetch;
	fakeRoutes.lanes = lanesFake.fetch;
	const recorder = createMemoryRecorder();
	// The trigger: one Workflow instance per ref update, as on the platform.
	gitFake.onPush((event) => {
		void recorder.record("wf-event", {
			instanceId: event.id,
			instanceCreatedAt: Date.now(),
			payload: event,
		});
	});
	const gitApp = createGitApp({
		artifacts: gitFake,
		smokeKey: key,
		recorder,
		upstreamFetch: (r) => fetch(r),
	});
	const lanesApp = createLanesApp({
		artifacts: lanesFake,
		capKey,
		smokeKey: key,
		store: createMemoryCapStore(),
		upstreamFetch: (r) => fetch(r),
		backstopMs: 0,
	});
	const git: WorkerTarget = { base: serve((r) => gitApp.fetch(r)), key };
	const lanes: WorkerTarget = { base: serve((r) => lanesApp.fetch(r)), key };
	return {
		git,
		lanes,
		stop: () => Promise.all(servers.map((s) => s.shutdown())),
	};
};

const main = async (): Promise<number> => {
	const args = parseArgs(Deno.args);
	if (Deno.args.includes("--box-dockerfile")) boxConfig = "wrangler.jsonc";
	if (!args.local && !STAGE_RE.test(args.stage)) {
		console.error(
			"smoke: pass --local, or --stage dev | dev-wpNN (never production)",
		);
		return 2;
	}
	const vars = args.local
		? { SMOKE_KEY: randomHex(32), LANE_CAP_KEY: randomHex(32) }
		: await loadVars();
	const tag = new Date().toISOString().replace(/\D/g, "").slice(4, 14);
	const tmp = await Deno.makeTempDir({ prefix: "tartan-smoke-" });
	let local: ReturnType<typeof startLocal> | null = null;
	let targets: {
		git?: WorkerTarget;
		lanes?: WorkerTarget;
		box?: WorkerTarget;
		runtime?: WorkerTarget;
	} = {};
	let failed = 0;
	try {
		if (args.local) {
			local = startLocal(vars.SMOKE_KEY, vars.LANE_CAP_KEY);
			targets = { git: local.git, lanes: local.lanes };
		} else {
			for (const which of ["git", "lanes", "box", "runtime"] as const) {
				if (!args.suites.includes(which)) continue;
				const urlKey = `${which.toUpperCase()}_URL`;
				if (args.deploy) {
					vars[urlKey] = await deployWorker(which, vars);
					await saveVars(vars);
				}
				if (!vars[urlKey]) {
					throw new Error(
						`no ${urlKey} in scripts/smoke/.dev.vars: run with --deploy`,
					);
				}
				targets[which] = { base: vars[urlKey], key: vars.SMOKE_KEY };
			}
		}
		for (const suite of args.suites) {
			const rec = createRecorder(suite, {
				stage: args.stage,
				dir: args.write && !args.local ? EVIDENCE_DIR : null,
			});
			const ctx: SmokeContext = {
				mode: args.local ? "local" : "live",
				stage: args.stage,
				small: args.small,
				tag,
				only: args.only,
				rec,
				tmp,
				env: gitEnv(`${tmp}/home`),
				git: targets.git,
				lanes: targets.lanes,
			};
			await Deno.mkdir(`${tmp}/home`, { recursive: true });
			console.log(`== ${suite} (${ctx.mode}, stage ${ctx.stage}, tag ${tag})`);
			if (suite === "git") await runGitSuite(ctx);
			else if (suite === "lanes") await runLanesSuite(ctx);
			else if (suite === "box") {
				if (ctx.mode === "local" || !targets.box) {
					console.log("box: live only (containers); skipped");
				} else await runBoxSuite(ctx, targets.box);
			} else if (suite === "runtime") {
				if (ctx.mode === "local" || !targets.runtime) {
					console.log("runtime: live only (Dynamic Workers); skipped");
				} else await runRuntimeSuite(ctx, targets.runtime);
			} else throw new Error(`unknown suite ${suite}`);
			failed += rec.results.filter((r) => !r.pass).length;
			const file = await rec.write();
			if (file) console.log(`evidence: ${file}`);
		}
		if (args.write && !args.local) {
			const leaks = await scanDirs([EVIDENCE_DIR]);
			if (leaks.length > 0) {
				for (const l of leaks) {
					console.error(`LEAK ${l.file}:${l.line} ${l.rule}`);
				}
				failed++;
			}
		}
		if (args.teardown && !args.local) {
			for (const which of ["git", "lanes", "box", "runtime"] as const) {
				if (args.suites.includes(which)) {
					await teardownWorker(which, targets[which]);
				}
			}
		}
	} finally {
		await local?.stop();
		await Deno.remove(tmp, { recursive: true });
	}
	console.log(
		failed === 0
			? "smoke: all checks passed"
			: `smoke: ${failed} check(s) failed`,
	);
	return failed === 0 ? 0 : 1;
};

if (import.meta.main) Deno.exit(await main());
