// The e2e launcher: `deno task e2e -- <sub-command>` (docs/testing/e2e.md).
//
//   stage up [--no-containers] [--image dockerfile|registry] [--rotate-idp]
//            [--k2 --k2-token-store <id> --k2-token-secret <name>]
//            [--lane-mode import|create|branch] [--workload-transport local|k2]
//            [--projects] [--build-ext] [--echo on|off]
//                                               IdP + dev-e2e forge (containers and repo config on by
//                                               default; the M2 switches are deploy's own flags);
//                                               claims a fresh forge (phase A)
//   stage reset [stage up flags]                stage down --keep-idp, then stage up
//   stage down [--keep-idp]                     destroy the forge (and the IdP)
//   stage status                                what is deployed, health, expiry
//   install                                     Chromium (and its headless shell) into the Playwright cache
//   list [e2e list args]                        the tests a run would select (no app contact)
//   run [e2e run args] [--drop-traces] [--keep-data] [--allow-drift]
//                                               provision → e2e run → teardown → trace sweep → leak scan
//   evidence <runId>                            leak-scanned summary into .private/e2e/evidence/<runId>/
//   agent [--ttl-days n] [--group g] [--out f]  one e2e-developer agent token and a pack group's MCP
//                                               URL (e2e/swarm by default), in a 0600 file under
//                                               .private/e2e/agent/ or --out (handoff.ts)
//
// The stage is always `dev-e2e`, in the account `CLOUDFLARE_ACCOUNT_ID`
// names (guards.ts); there is no `--stage` flag. Telemetry is off and model
// keys are gone for this process and every child (env.ts). Every request the
// launcher makes is bounded (http.ts). Exit codes: e2e's own (0, 1, 2, 3, 4,
// 130); 2 for a failed guard or preflight; 1 for a leak-scan hit.
//
// Deploy tooling: runtime code never imports this.

import * as path from "node:path";
import { derivePassword } from "../../tools/mock-idp/src/password.ts";
import {
	type PersonaName,
	PERSONAS,
	usernameOf,
} from "../../tools/mock-idp/src/users.ts";
import { HEALTH_PRODUCT } from "../../tools/mock-idp/src/app.ts";
import { b64url } from "../../tools/mock-idp/src/encoding.ts";
import { sharedDirOf } from "../../e2e/support/shared.ts";
import { denoRun } from "../preflight.ts";
import { resolveAccount } from "./cloudflare.ts";
import { assertNoDrift, driftOf } from "./drift.ts";
import { e2eEnv, runArgs, runE2e, secretValues } from "./e2e-cli.ts";
import { hardenEnv } from "./env.ts";
import {
	handoffOutRefusal,
	handoffPath,
	handoffText,
	mintHandoff,
} from "./handoff.ts";
import { copyEvidence, LAUNCHER_RUN_FILE } from "./evidence.ts";
import { createForgeApi } from "./forge-api.ts";
import {
	checkSwitches,
	claimedForgeHealth,
	deployForge,
	destroyForge,
	type ForgeDeps,
	forgeHealth,
	imageOf,
	type StagePlan,
	type StageSwitches,
} from "./forge-stage.ts";
import {
	accountIdFrom,
	assertAccount,
	checkDisk,
	GUARD_EXIT,
	GuardError,
	STAGE,
} from "./guards.ts";
import { timedFetch, WARM_TIMEOUT_MS } from "./http.ts";
import { ensureIdp, type IdpDeps, idpKid, removeIdp } from "./idp-stage.ts";
import { denoScanFs, scanOutput } from "./leakscan.ts";
import { createMasker } from "./mask.ts";
import { signInHeadless, signOut } from "./oidc-client.ts";
import { bins, createMaskedRun, ROOT } from "./proc.ts";
import {
	makeRunId,
	provision,
	type RunCredentials,
	teardown,
} from "./provision.ts";
import {
	SKIPPED_FILE,
	skippedLines,
	skippedMarkdown,
	skippedOf,
	type SkippedTest,
	tightenOutput,
} from "./report.ts";
import {
	denoStateFs,
	expiryWarning,
	readForgeRecord,
	readIdpState,
	readStageState,
	settleWait,
	statePaths,
} from "./state.ts";
import { sweepTraces } from "./traces.ts";

const log = (line: string) => console.log(`e2e: ${line}`);

// Secret values known so far; every child's output is masked with them.
const secrets: string[] = [];
const masked = createMaskedRun(() => createMasker(secrets));

const paths = statePaths(ROOT);
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));
/** Every launcher request has a deadline, body included. */
const bounded = timedFetch(fetch);
const env = (name: string) => Deno.env.get(name);

const idpDeps = (accountId: string): IdpDeps => ({
	run: denoRun,
	fetch: bounded,
	accountId,
	fs: denoStateFs,
	paths,
	root: ROOT,
	now: Date.now,
	random,
	sleep,
	log,
});

const forgeDeps = (accountId: string): ForgeDeps => ({
	run: denoRun,
	masked,
	fetch: bounded,
	fs: denoStateFs,
	paths,
	root: ROOT,
	deno: Deno.execPath(),
	now: Date.now,
	log,
	accountId,
});

const flag = (args: string[], name: string): boolean => {
	const i = args.indexOf(name);
	if (i === -1) return false;
	args.splice(i, 1);
	return true;
};

const option = (args: string[], name: string): string | undefined => {
	const i = args.indexOf(name);
	if (i === -1) return undefined;
	const value = args[i + 1];
	if (value === undefined || value.startsWith("-")) {
		throw new GuardError(`${name} needs a value`);
	}
	args.splice(i, 2);
	return value;
};

const passwordsFor = async (
	seed: string,
): Promise<Record<PersonaName, string>> =>
	Object.fromEntries(
		await Promise.all(
			PERSONAS.map(async (p) => [p, await derivePassword(seed, usernameOf(p))]),
		),
	) as Record<PersonaName, string>;

/** `/-/health` of the mock IdP, or null (bounded). */
const idpHealthOf = async (
	issuer: string,
): Promise<{ product?: unknown; ok?: unknown } | null> => {
	try {
		const response = await bounded(`${issuer}/-/health`);
		return await response.json() as { product?: unknown; ok?: unknown };
	} catch {
		return null;
	}
};

/**
 * The Playwright browsers the run needs are installed (the engine must never
 * download one). `@e2e-dev/web` checks the full Chromium build's executable
 * before every run and downloads it when it is missing, while headless
 * launches use the headless shell, so both must be in the cache.
 */
const ensureBrowser = async (): Promise<void> => {
	const out = await denoRun(bins(ROOT).playwright, [
		"install",
		"--dry-run",
		"chromium",
	], { cwd: ROOT });
	const dirs = [...out.stdout.matchAll(/Install location:\s*(\S+)/g)]
		.map((m) => m[1])
		.filter((d) => /chromium/.test(path.basename(d)));
	for (const dir of dirs) {
		try {
			await Deno.stat(dir);
		} catch {
			throw new GuardError(
				`the Playwright browser is not installed (${
					path.basename(dir)
				}): run \`deno task e2e -- install\``,
			);
		}
	}
	if (dirs.length < 2) {
		throw new GuardError(
			"could not tell where Playwright keeps Chromium and its headless shell",
		);
	}
};

/** `e2e/.e2e/` exists and is private before e2e writes into it. */
const privateOutput = async (): Promise<void> => {
	await Deno.mkdir(paths.output, { recursive: true, mode: 0o700 });
	await Deno.chmod(paths.output, 0o700);
};

const writePrivateText = async (file: string, text: string): Promise<void> => {
	await Deno.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await Deno.writeTextFile(file, text, { mode: 0o600 });
	await Deno.chmod(file, 0o600);
};

const writeLauncherRun = async (
	runId: string,
	exitCode: number,
	leaks: number,
	skipped: readonly SkippedTest[],
) => {
	await writePrivateText(
		path.join(paths.output, LAUNCHER_RUN_FILE),
		`${
			JSON.stringify(
				{
					runId,
					exitCode,
					finishedAt: new Date().toISOString(),
					leaks,
					skipped: skipped.length,
				},
				null,
				"\t",
			)
		}\n`,
	);
};

/** What the run skipped and why: printed, and written to `skipped.md`. */
const reportSkipped = async (runId: string): Promise<SkippedTest[]> => {
	let report: unknown = null;
	try {
		report = JSON.parse(
			await Deno.readTextFile(path.join(paths.output, "report.json")),
		);
	} catch {
		log("no report.json: cannot list what was skipped");
		return [];
	}
	const skipped = skippedOf(report);
	for (const line of skippedLines(skipped)) log(line);
	await writePrivateText(
		path.join(paths.output, SKIPPED_FILE),
		skippedMarkdown(runId, skipped),
	);
	return skipped;
};

/** After any e2e invocation: end sessions found in traces, then the leak scan. */
const afterRun = async (forge: string, drop: boolean): Promise<number> => {
	const traces = await sweepTraces({
		fs: { ...denoScanFs, remove: (f) => Deno.remove(f) },
		outputDir: paths.output,
		signOut: (s) => signOut(bounded, forge, s),
		drop,
		log,
	});
	const scan = await scanOutput(paths.output, {
		secrets,
		revoked: traces.revoked,
	});
	for (const file of scan.unreadable) {
		await Deno.remove(file).catch(() => {});
	}
	for (const leak of scan.leaks) {
		console.error(
			`e2e: LEAK ${path.relative(ROOT, leak.file)}:${leak.line}: ${leak.rule}`,
		);
	}
	if (scan.leaks.length > 0) {
		// Never keep what leaked: the traces go, the report files stay for review.
		const zips = (await denoScanFs.walk(paths.output)).filter((f) =>
			f.endsWith(".zip")
		);
		for (const zip of zips) await Deno.remove(zip).catch(() => {});
	}
	await tightenOutput(paths.output);
	log(
		`leak scan: ${scan.leaks.length} leak(s), ${scan.revokedSessions} ended session cookie(s) and ${scan.spent} spent code(s) in traces`,
	);
	return scan.leaks.length;
};

/** The suites' cross-worker scratch (`e2e/support/shared.ts`) of a run. */
const removeShared = async (runId: string): Promise<void> => {
	const tmp = Deno.env.get("TMPDIR") ?? "/tmp";
	await Deno.remove(sharedDirOf(tmp, runId), { recursive: true }).catch(
		() => {},
	);
};

// ---------------------------------------------------------------------------

const stagePlanOf = (args: string[]): StagePlan => {
	const containers = !flag(args, "--no-containers");
	const image = imageOf(option(args, "--image"));
	const k2 = flag(args, "--k2");
	const tokenStore = option(args, "--k2-token-store");
	const tokenSecret = option(args, "--k2-token-secret");
	const laneMode = option(args, "--lane-mode");
	const workloadTransport = option(args, "--workload-transport");
	const projects = flag(args, "--projects");
	const buildExt = flag(args, "--build-ext");
	const echo = option(args, "--echo");
	if (!k2 && (tokenStore !== undefined || tokenSecret !== undefined)) {
		throw new GuardError("--k2-token-store and --k2-token-secret need --k2");
	}
	if (k2 && (tokenStore === undefined) !== (tokenSecret === undefined)) {
		throw new GuardError("--k2-token-store and --k2-token-secret go together");
	}
	const switches = checkSwitches({
		...(k2 && tokenStore !== undefined && tokenSecret !== undefined
			? { k2: { storeId: tokenStore, secretName: tokenSecret } }
			: {}),
		...(laneMode === undefined
			? {}
			: { laneMode: laneMode as StageSwitches["laneMode"] }),
		...(workloadTransport === undefined ? {} : {
			workloadTransport: workloadTransport as StageSwitches[
				"workloadTransport"
			],
		}),
		...(projects ? { projects } : {}),
		...(buildExt ? { buildExt } : {}),
		...(echo === undefined ? {} : { echo: echo as StageSwitches["echo"] }),
	});
	if (k2 && switches.k2 === undefined) {
		throw new GuardError(
			"--k2 on dev-e2e needs the consume token's --k2-token-store and --k2-token-secret",
		);
	}
	return { containers, image, switches };
};

const stageUp = async (args: string[]): Promise<number> => {
	const plan = stagePlanOf(args);
	const rotate = flag(args, "--rotate-idp");
	if (args.length > 0) throw new GuardError(`unknown argument ${args[0]}`);
	await checkDisk(denoRun, ROOT);
	const accountId = accountIdFrom(env);
	const account = await resolveAccount({
		run: denoRun,
		root: ROOT,
		fetch: bounded,
		env,
		accountId,
	});
	const idp = await ensureIdp(idpDeps(accountId), {
		subdomain: account.subdomain,
		rotate,
	});
	const up = await deployForge(forgeDeps(accountId), {
		subdomain: account.subdomain,
		...plan,
	});
	log(`forge ${up.origin} is up (setup ${up.setupState})`);
	if (up.setupToken === null) return 0;

	// Phase A: claim the fresh forge through the wizard (claim/claim.e2e.ts).
	secrets.push(up.setupToken);
	await ensureBrowser();
	const runId = makeRunId(Date.now(), random(2));
	const childEnv = e2eEnv({
		origin: up.origin,
		issuer: idp.issuer,
		runId,
		containers: plan.containers,
		passwords: await passwordsFor(idp.seed),
		setupToken: up.setupToken,
	});
	secrets.push(...secretValues(childEnv));
	await privateOutput();
	const code = await runE2e(masked, ROOT, "run", [
		"--no-cache",
		"--tag",
		"claim",
		"--reporter",
		"list,junit,markdown",
		"tests/claim/claim.e2e.ts",
	], childEnv);
	const leaks = await afterRun(up.origin, false);
	await writeLauncherRun(runId, code, leaks, []);
	if (code !== 0) {
		throw new GuardError(
			"phase A (the claim) failed; setup unlock is rate limited (5 per 10 min), so it is not retried: read e2e/.e2e/summary.md, then run stage up again",
		);
	}
	await denoStateFs.remove(paths.setupUrl);
	log(
		"claimed the forge as e2e-owner and deleted the setup URL file; the next stage up deletes TARTAN_SETUP_TOKEN",
	);
	return leaks > 0 ? 1 : 0;
};

const stageDown = async (args: string[]): Promise<number> => {
	const keepIdp = flag(args, "--keep-idp");
	if (args.length > 0) throw new GuardError(`unknown argument ${args[0]}`);
	const accountId = accountIdFrom(env);
	const account = await resolveAccount({
		run: denoRun,
		root: ROOT,
		fetch: bounded,
		env,
		accountId,
	});
	await destroyForge(forgeDeps(accountId));
	if (!keepIdp) {
		await removeIdp(idpDeps(accountId), { subdomain: account.subdomain });
	}
	log(`stage ${STAGE} is down${keepIdp ? " (the IdP stays)" : ""}`);
	return 0;
};

const stageStatus = async (): Promise<number> => {
	const record = await readForgeRecord(denoStateFs, paths);
	const idp = await readIdpState(denoStateFs, paths);
	const stage = await readStageState(denoStateFs, paths);
	if (record === null) log("forge: no dev-e2e deploy record in this checkout");
	else {
		const h = await forgeHealth(bounded, record.origin);
		log(
			`forge: ${record.origin} (containers ${
				record.containers ? "on" : "off"
			}, commit ${record.commit?.slice(0, 12) ?? "unknown"}); health: ${
				h === null
					? "no answer"
					: `${String(h.product)} stage ${String(h.stage)}, setup ${
						String(h.setupState)
					}`
			}`,
		);
		const drift = await driftOf({ run: denoRun, root: ROOT }, record.commit);
		if (drift.paths.length > 0) {
			log(
				`warning: ${drift.paths.length} path(s) differ from the deployed commit`,
			);
		}
	}
	if (idp === null) log("idp: no local IdP state in this checkout");
	else {
		const kid = await idpKid(bounded, idp.issuer);
		const health = await idpHealthOf(idp.issuer);
		log(
			`idp: ${idp.issuer}; health ${
				health?.product === HEALTH_PRODUCT
					? `ok=${String(health.ok)}`
					: "no answer"
			}; key ${idp.kid} (${
				kid === idp.kid ? "matches /jwks" : `served: ${kid ?? "none"}`
			})`,
		);
	}
	if (stage !== null) {
		log(`stage: up since ${stage.upAt}, expires ${stage.expiresAt}`);
	}
	const warning = expiryWarning(stage, Date.now());
	if (warning !== null) log(`warning: ${warning}`);
	return 0;
};

const install = async (args: string[]): Promise<number> => {
	if (args.length > 0) throw new GuardError(`unknown argument ${args[0]}`);
	await checkDisk(denoRun, ROOT);
	const b = bins(ROOT);
	// Chromium and its headless shell: see `ensureBrowser`.
	const pw = await denoRun(b.playwright, ["install", "chromium"], {
		io: "inherit",
		cwd: ROOT,
	});
	if (pw.code !== 0) return pw.code;
	const tel = await denoRun("node", [b.e2e, "telemetry", "disable"], {
		io: "inherit",
		cwd: ROOT,
	});
	return tel.code;
};

/** Stage values for `list`, which never contacts the app: the real ones when present. */
const listEnv = async (): Promise<Record<string, string>> => {
	const record = await readForgeRecord(denoStateFs, paths).catch(() => null);
	const idp = await readIdpState(denoStateFs, paths).catch(() => null);
	const seed = idp?.seed ?? b64url(random(32));
	return e2eEnv({
		origin: record?.origin ?? "https://tartan-dev-e2e.offline.workers.dev",
		issuer: idp?.issuer ?? "https://tartan-e2e--idp.offline.workers.dev",
		runId: makeRunId(Date.now(), random(2)),
		containers: record?.containers ?? true,
		passwords: await passwordsFor(seed),
		...(record === null || record === undefined
			? {}
			: { switches: record.switches }),
	});
};

const list = async (args: string[]): Promise<number> => {
	const childEnv = await listEnv();
	secrets.push(...secretValues(childEnv));
	return await runE2e(masked, ROOT, "list", args, childEnv);
};

const run = async (args: string[]): Promise<number> => {
	const drop = flag(args, "--drop-traces");
	const keepData = flag(args, "--keep-data");
	const allowDrift = flag(args, "--allow-drift");
	// Merged with the defaults now, so a bad flag stops before anything is made.
	const e2eArgs = runArgs(args);
	await checkDisk(denoRun, ROOT);
	const accountId = accountIdFrom(env);
	const record = await readForgeRecord(denoStateFs, paths);
	if (record === null) {
		throw new GuardError("no dev-e2e stage in this checkout: run stage up");
	}
	assertAccount(record.accountId, accountId);
	assertNoDrift(await driftOf({ run: denoRun, root: ROOT }, record.commit), {
		allow: allowDrift,
		log,
	});
	const warning = expiryWarning(
		await readStageState(denoStateFs, paths),
		Date.now(),
	);
	if (warning !== null) log(`warning: ${warning}`);
	const idp = await readIdpState(denoStateFs, paths);
	if (idp === null) throw new GuardError("no IdP state here: run stage up");
	const settle = settleWait(record, Date.now());
	if (settle > 0) {
		log(
			`waiting ${
				Math.ceil(settle / 1000)
			} s for the deploy to settle (Durable Objects reset when the code changes)`,
		);
		await new Promise((r) => setTimeout(r, settle));
	}
	const health = await claimedForgeHealth(bounded, record.origin);
	if (health?.product !== "Tartan" || health.stage !== STAGE) {
		throw new GuardError(
			`${record.origin} does not answer as the ${STAGE} forge`,
		);
	}
	if (health.setupState !== "done") {
		throw new GuardError("the forge is not claimed yet: run stage up");
	}
	const idpHealth = await idpHealthOf(idp.issuer);
	if (idpHealth?.product !== HEALTH_PRODUCT || idpHealth.ok !== true) {
		throw new GuardError("the mock IdP is not healthy: run stage up");
	}
	await ensureBrowser();
	if (!record.containers) {
		log(
			"warning: the stage runs without containers: CI, Advances and repository config suites skip (see the skipped list at the end)",
		);
	}

	// Warm-up (best effort): the SPA, health, and the runner container.
	await bounded(`${record.origin}/`).then((r) => r.body?.cancel()).catch(
		() => {},
	);
	if (record.containers) {
		await timedFetch(fetch, WARM_TIMEOUT_MS)(
			`${record.origin}/-/health/warm`,
			{ method: "POST" },
		).then((r) => r.body?.cancel()).catch(() => {});
	}

	const passwords = await passwordsFor(idp.seed);
	secrets.push(...Object.values(passwords));
	const runId = makeRunId(Date.now(), random(2));
	log(`run ${runId} against ${record.origin}`);
	const api = createForgeApi(bounded, record.origin);
	let creds: RunCredentials | null = null;
	let ran = false;
	let code = 1;
	let leaks = 0;
	try {
		creds = await provision({
			api,
			signIn: (persona, invite) =>
				signInHeadless(bounded, {
					forge: record.origin,
					issuer: idp.issuer,
					username: usernameOf(persona),
					password: passwords[persona],
					...(invite === undefined ? {} : { invite }),
				}),
			signOut: (s) => signOut(bounded, record.origin, s),
			now: Date.now,
			log,
			packVersions: await packVersions(),
		}, runId);
		secrets.push(
			creds.ownerPat,
			creds.reporterPat,
			creds.readPat,
			creds.developerAgent,
			creds.developerAgentB,
		);
		const childEnv = e2eEnv({
			origin: record.origin,
			issuer: idp.issuer,
			runId,
			containers: record.containers,
			passwords,
			creds,
			switches: record.switches,
		});
		await privateOutput();
		ran = true;
		code = await runE2e(masked, ROOT, "run", e2eArgs, childEnv);
	} finally {
		// Whatever failed: what provisioning minted goes, even when the run
		// itself never started (provision undoes its own half-way state).
		if (creds !== null) {
			const down = await teardown(
				{
					api,
					signOut: (s) => signOut(bounded, record.origin, s),
					log,
				},
				creds,
				{ keepData },
			);
			for (const failure of down.failures) log(`teardown failure: ${failure}`);
		}
		await removeShared(runId);
		// The output directory belongs to this run only once e2e ran.
		if (ran) {
			const skipped = await reportSkipped(runId);
			leaks = await afterRun(record.origin, drop);
			await writeLauncherRun(runId, code, leaks, skipped);
		}
	}
	log(`run ${runId} finished with exit ${code}`);
	return leaks > 0 && code === 0 ? 1 : code;
};

const packVersions = async (): Promise<Record<string, string>> => {
	const out: Record<string, string> = {};
	for (const name of ["swarm", "classic"]) {
		const manifest = JSON.parse(
			await Deno.readTextFile(
				path.join(ROOT, "extensions", "packs", name, "tartan.json"),
			),
		) as { id: string; version: string };
		out[manifest.id] = manifest.version;
	}
	return out;
};

const evidence = async (args: string[]): Promise<number> => {
	const runId = args[0];
	if (runId === undefined || args.length > 1) {
		throw new GuardError("usage: evidence <runId>");
	}
	const result = await copyEvidence({
		readText: (f) => denoStateFs.readText(f),
		list: async (dir) => {
			const out: string[] = [];
			try {
				for await (const e of Deno.readDir(dir)) {
					if (e.isFile) out.push(path.join(dir, e.name));
				}
			} catch {
				// No failures directory.
			}
			return out.sort();
		},
		write: writePrivateText,
	}, { output: paths.output, evidenceRoot: paths.evidence, runId });
	for (const leak of result.leaks) {
		console.error(
			`e2e: LEAK ${path.relative(ROOT, leak.file)}:${leak.line}: ${leak.rule}`,
		);
	}
	if (result.leaks.length > 0) return 1;
	await tightenOutput(path.join(paths.evidence, runId));
	log(
		`copied ${result.copied} file(s) to ${
			path.relative(ROOT, paths.evidence)
		}/${runId}/`,
	);
	return 0;
};

/** `agent`: mints the handoff agent and writes its file; never prints the token. */
const agent = async (args: string[]): Promise<number> => {
	const ttl = option(args, "--ttl-days");
	const out = option(args, "--out");
	const group = option(args, "--group");
	if (args.length > 0) throw new GuardError(`unknown argument ${args[0]}`);
	const ttlDays = ttl === undefined ? 1 : Number(ttl);
	const file = out === undefined ? handoffPath(ROOT) : path.resolve(out);
	const dirMode = await Deno.stat(path.dirname(file)).then(
		(st) => st.mode === null ? null : st.mode & 0o777,
		() => null,
	);
	const refusal = handoffOutRefusal(ROOT, file, dirMode);
	if (refusal !== null) throw new GuardError(refusal);
	const accountId = accountIdFrom(env);
	const record = await readForgeRecord(denoStateFs, paths);
	if (record === null) {
		throw new GuardError("no dev-e2e stage in this checkout: run stage up");
	}
	assertAccount(record.accountId, accountId);
	const idp = await readIdpState(denoStateFs, paths);
	if (idp === null) throw new GuardError("no IdP state here: run stage up");
	const health = await claimedForgeHealth(bounded, record.origin);
	if (
		health?.product !== "Tartan" || health.stage !== STAGE ||
		health.setupState !== "done"
	) {
		throw new GuardError(
			`${record.origin} does not answer as the claimed ${STAGE} forge`,
		);
	}
	const passwords = await passwordsFor(idp.seed);
	secrets.push(...Object.values(passwords));
	const handoff = await mintHandoff({
		api: createForgeApi(bounded, record.origin),
		signIn: () =>
			signInHeadless(bounded, {
				forge: record.origin,
				issuer: idp.issuer,
				username: usernameOf("developer"),
				password: passwords.developer,
			}),
		signOut: (s) => signOut(bounded, record.origin, s),
		now: Date.now,
		random,
	}, {
		ttlDays,
		...(group === undefined ? {} : { group }),
		persist: async (h) => {
			secrets.push(h.token);
			await writePrivateText(file, handoffText(h));
		},
	});
	log(
		`agent ${handoff.handle} (${handoff.agentId}) on ${handoff.node}, expires ${handoff.expiresAt}; token and MCP URL in ${file} (0600)`,
	);
	return 0;
};

const USAGE = `Usage: deno task e2e -- <command>

  stage up [--no-containers] [--image dockerfile|registry] [--rotate-idp]
           [--k2 --k2-token-store <id> --k2-token-secret <name>]
           [--lane-mode import|create|branch] [--workload-transport local|k2]
           [--projects] [--build-ext] [--echo on|off]
  stage reset [stage up flags]
  stage down [--keep-idp]
  stage status
  install
  list [e2e list args]
  run [files...] [e2e run args] [--drop-traces] [--keep-data] [--allow-drift]
  evidence <runId>
  agent [--ttl-days n] [--group e2e/swarm|e2e/classic] [--out <file>]

CLOUDFLARE_ACCOUNT_ID names the account of the stage (stage commands and run).`;

export const main = async (argv: readonly string[]): Promise<number> => {
	const removed = hardenEnv(Deno.env);
	if (removed.length > 0) {
		log(`removed from the environment: ${removed.join(", ")}`);
	}
	const args = [...(argv[0] === "--" ? argv.slice(1) : argv)];
	const command = args.shift();
	try {
		switch (command) {
			case "stage": {
				const sub = args.shift();
				if (sub === "up") return await stageUp(args);
				if (sub === "down") return await stageDown(args);
				if (sub === "status") return await stageStatus();
				if (sub === "reset") {
					const plan = [...args];
					stagePlanOf([...args]);
					await stageDown(["--keep-idp"]);
					return await stageUp(plan);
				}
				throw new GuardError(`unknown stage command ${sub ?? "(none)"}`);
			}
			case "install":
				return await install(args);
			case "list":
				return await list(args);
			case "run":
				return await run(args);
			case "evidence":
				return await evidence(args);
			case "agent":
				return await agent(args);
			case "-h":
			case "--help":
			case "help":
				console.log(USAGE);
				return 0;
			default:
				// `deno task e2e [files…] [flags]` is a run.
				return await run(command === undefined ? args : [command, ...args]);
		}
	} catch (error) {
		if (error instanceof GuardError) {
			console.error(`e2e: ${error.message}`);
			return GUARD_EXIT;
		}
		console.error(`e2e: ${createMasker(secrets)((error as Error).message)}`);
		return GUARD_EXIT;
	}
};

if (import.meta.main) Deno.exit(await main(Deno.args));
