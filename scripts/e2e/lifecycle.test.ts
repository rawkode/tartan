// Stage lifecycle on fakes: the account of CLOUDFLARE_ACCOUNT_ID is pinned
// for every wrangler call and asserted on the deploy record, secrets go
// through stdin, the IdP keeps no private key on disk, the name guard
// refuses a forge on the IdP's name, containers and repository config are on
// by default (the runner image as deploy provides it), and the e2e child's
// arguments merge the launcher's defaults with the caller's.

import {
	deepStrictEqual,
	equal,
	ok,
	rejects,
	throws,
} from "node:assert/strict";
import type { Run, RunOptions } from "../preflight.ts";
import {
	e2eEnv,
	MAX_FAILURES,
	runArgs,
	secretValues,
	takeListFlag,
	TOKEN_ENV,
} from "./e2e-cli.ts";
import {
	claimedForgeHealth,
	DEFAULT_IMAGE,
	deployArgs,
	deployForge,
	destroyArgs,
	type ForgeDeps,
	imageNote,
	imageOf,
} from "./forge-stage.ts";
import { GuardError } from "./guards.ts";
import { ensureIdp, type IdpDeps } from "./idp-stage.ts";
import { type StateFs, statePaths } from "./state.ts";
import { TOKEN_VARS } from "../../e2e/support/stage.ts";

const ROOT = "/repo";
const paths = statePaths(ROOT);
const ISSUER = "https://tartan-e2e--idp.acme.workers.dev";
const FORGE = "https://tartan-dev-e2e.acme.workers.dev";
/** Any account id: the harness names none of its own. */
const ACCOUNT = "0123456789abcdef0123456789abcdef";

const memoryFs = () => {
	const files = new Map<string, { text: string; mode: number }>();
	const fs: StateFs = {
		readText: (f) => Promise.resolve(files.get(f)?.text ?? null),
		mode: (f) => Promise.resolve(files.get(f)?.mode ?? null),
		writePrivate: (f, text) => {
			files.set(f, { text, mode: 0o600 });
			return Promise.resolve();
		},
		remove: (f) => {
			files.delete(f);
			return Promise.resolve();
		},
	};
	return { fs, files };
};

type Call = { cmd: string; args: readonly string[]; options?: RunOptions };

const recordingRun = (
	answer: (c: Call) => { code: number; stdout: string } = () => ({
		code: 0,
		stdout: "",
	}),
) => {
	const calls: Call[] = [];
	const run: Run = (cmd, args, options) => {
		const call = { cmd, args, options };
		calls.push(call);
		const a = answer(call);
		return Promise.resolve({ code: a.code, stdout: a.stdout, stderr: "" });
	};
	return { run, calls };
};

const healthFetch = (answers: Record<string, unknown>) =>
	((input: string | URL | Request) => {
		const url = String(input instanceof Request ? input.url : input);
		for (const [prefix, body] of Object.entries(answers)) {
			if (url.startsWith(prefix)) return Promise.resolve(Response.json(body));
		}
		return Promise.resolve(new Response("{}", { status: 404 }));
	}) as typeof fetch;

const idpDeps = (run: Run, fs: StateFs, fetchFn: typeof fetch): IdpDeps => ({
	run,
	fetch: fetchFn,
	fs,
	paths,
	root: ROOT,
	now: () => Date.UTC(2026, 9, 3),
	random: (n) => new Uint8Array(n).fill(7),
	sleep: () => Promise.resolve(),
	accountId: ACCOUNT,
	log: () => {},
});

Deno.test("the IdP is deployed with its own config and the account of CLOUDFLARE_ACCOUNT_ID; secrets go through stdin", async () => {
	const { fs, files } = memoryFs();
	const { run, calls } = recordingRun((c) =>
		c.args[0] === "secret" && c.args[1] === "list"
			? { code: 0, stdout: "[]" }
			: { code: 0, stdout: "" }
	);
	const fetchFn = healthFetch({
		[`${ISSUER}/-/health`]: { product: "tartan-e2e-idp", ok: true },
		[`${ISSUER}/jwks`]: { keys: [{ kid: "e2e-x" }] },
	});
	const state = await ensureIdp(idpDeps(run, fs, fetchFn), {
		subdomain: "acme",
		rotate: false,
	});
	equal(state.issuer, ISSUER);
	deepStrictEqual(state.redirectUris, [`${FORGE}/-/auth/callback`]);
	for (const call of calls) {
		ok(call.cmd.endsWith("node_modules/.bin/wrangler"), "never npx");
		deepStrictEqual(call.options?.env, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT });
		const c = call.args.indexOf("-c");
		equal(call.args[c + 1], `${ROOT}/tools/mock-idp/wrangler.jsonc`);
		equal(call.args.includes("--account"), false);
		equal(call.args.includes("--name"), false);
	}
	const deploy = calls.find((c) => c.args[0] === "deploy");
	ok(deploy?.args.includes(`ISSUER:${ISSUER}`));
	ok(
		deploy?.args.includes(
			`ALLOWED_REDIRECT_URIS:${JSON.stringify([`${FORGE}/-/auth/callback`])}`,
		),
	);
	const puts = calls.filter((c) =>
		c.args[0] === "secret" && c.args[1] === "put"
	);
	deepStrictEqual(puts.map((c) => c.args[2]), [
		"E2E_IDP_SEED",
		"E2E_IDP_SIGNING_JWK",
	]);
	for (const put of puts) {
		ok(typeof put.options?.stdin === "string" && put.options.stdin.length > 40);
		for (const arg of put.args) {
			equal(arg.includes(String(put.options?.stdin)), false);
		}
	}
	const saved = files.get(paths.idp);
	equal(saved?.mode, 0o600);
	equal(saved?.text.includes('"d"'), false, "no private key on disk");
	equal(saved?.text.includes("E2E_IDP_SIGNING_JWK"), false);
});

Deno.test("an existing IdP with both secrets keeps its seed and key", async () => {
	const { fs } = memoryFs();
	const first = recordingRun((c) =>
		c.args[1] === "list" ? { code: 0, stdout: "[]" } : { code: 0, stdout: "" }
	);
	const fetchFn = healthFetch({
		[`${ISSUER}/-/health`]: { product: "tartan-e2e-idp", ok: true },
	});
	const a = await ensureIdp(idpDeps(first.run, fs, fetchFn), {
		subdomain: "acme",
		rotate: false,
	});
	const second = recordingRun((c) =>
		c.args[1] === "list"
			? {
				code: 0,
				stdout: '[{"name":"E2E_IDP_SEED"},{"name":"E2E_IDP_SIGNING_JWK"}]',
			}
			: { code: 0, stdout: "" }
	);
	const b = await ensureIdp(idpDeps(second.run, fs, fetchFn), {
		subdomain: "acme",
		rotate: false,
	});
	equal(b.seed, a.seed);
	equal(second.calls.filter((c) => c.args[1] === "put").length, 0);
	const rotated = recordingRun((c) =>
		c.args[1] === "list"
			? {
				code: 0,
				stdout: '[{"name":"E2E_IDP_SEED"},{"name":"E2E_IDP_SIGNING_JWK"}]',
			}
			: { code: 0, stdout: "" }
	);
	await ensureIdp(idpDeps(rotated.run, fs, fetchFn), {
		subdomain: "acme",
		rotate: true,
	});
	equal(rotated.calls.filter((c) => c.args[1] === "put").length, 2);
});

Deno.test("the IdP refuses to overwrite a Worker that answers as a Tartan forge", async () => {
	const { fs } = memoryFs();
	const { run, calls } = recordingRun();
	const fetchFn = healthFetch({
		[`${ISSUER}/-/health`]: { product: "Tartan", stage: "e2e-idp" },
	});
	await rejects(
		ensureIdp(idpDeps(run, fs, fetchFn), { subdomain: "acme", rotate: false }),
		GuardError,
	);
	equal(calls.length, 0);
});

const RECORD = (input: {
	containers: boolean;
	accountId?: string;
	setupState?: string;
}) =>
	JSON.stringify({
		stage: "dev-e2e",
		workersDev: FORGE,
		domain: null,
		accountId: input.accountId ?? ACCOUNT,
		image: input.containers ? { variant: "registry" } : { variant: "none" },
		commit: "a".repeat(40),
		setupState: input.setupState ?? "done",
	});

const forgeDeps = (input: {
	readonly record: string | null;
	readonly health?: Record<string, unknown>;
	readonly onDeploy?: (args: readonly string[]) => void;
}): ForgeDeps => {
	const { fs, files } = memoryFs();
	return {
		run:
			recordingRun((c) =>
				c.cmd === "git"
					? { code: 0, stdout: "0".repeat(40) }
					: { code: 0, stdout: "" }
			).run,
		masked: (_cmd, args) => {
			input.onDeploy?.(args);
			if (input.record !== null) {
				files.set(paths.record, { text: input.record, mode: 0o644 });
			}
			return Promise.resolve(0);
		},
		fetch: healthFetch(input.health ?? {}),
		fs,
		paths,
		root: ROOT,
		deno: "deno",
		now: () => Date.UTC(2026, 9, 3),
		log: () => {},
		accountId: ACCOUNT,
	};
};

Deno.test("stage up deploys with containers and repository config by default", async () => {
	const seen: (readonly string[])[] = [];
	const deps = forgeDeps({
		record: RECORD({ containers: true }),
		onDeploy: (args) => seen.push(args),
	});
	const up = await deployForge(deps, {
		subdomain: "acme",
		containers: true,
		image: "registry",
	});
	equal(up.origin, FORGE);
	equal(up.setupToken, null);
	const args = seen[0];
	equal(args[args.indexOf("--image") + 1], "registry");
	ok(args.includes("--repo-config"));
	equal(args.includes("--no-containers"), false);
	equal(args[args.indexOf("--account") + 1], ACCOUNT);
});

Deno.test("the deploy record must name the account and the containers stage up asked for", async () => {
	await rejects(
		deployForge(
			forgeDeps({
				record: RECORD({ containers: true, accountId: "f".repeat(32) }),
			}),
			{ subdomain: "acme", containers: true, image: "registry" },
		),
		GuardError,
	);
	await rejects(
		deployForge(forgeDeps({ record: RECORD({ containers: false }) }), {
			subdomain: "acme",
			containers: true,
			image: "registry",
		}),
		/containers off/,
	);
	await rejects(
		deployForge(forgeDeps({ record: null }), {
			subdomain: "acme",
			containers: false,
			image: "registry",
		}),
		GuardError,
	);
});

Deno.test("the image note says what deploy does with the runner image", () => {
	const valid = {
		valid: true,
		ref: "ttl.sh/x@sha256:" + "a".repeat(64),
		reason: "ok",
	} as const;
	ok(/reuses the recorded/.test(
		imageNote({ containers: true, image: "registry" }, valid),
	));
	ok(/publishes a new runner image \(published 30 h ago\)/.test(
		imageNote({ containers: true, image: "registry" }, {
			valid: false,
			reason: "published 30 h ago",
		}),
	));
	ok(/builds the runner image here/.test(
		imageNote({ containers: true, image: "dockerfile" }, null),
	));
	ok(/containers off/.test(
		imageNote({ containers: false, image: "registry" }, null),
	));
});

Deno.test("deploy and destroy are called for dev-e2e in the given account only", () => {
	const up = deployArgs({
		containers: true,
		image: "registry",
		claimed: false,
		accountId: ACCOUNT,
	});
	deepStrictEqual(up.slice(0, 5), [
		"run",
		"-A",
		"scripts/deploy.ts",
		"--stage",
		"dev-e2e",
	]);
	ok(up.includes("--dev-tools"));
	ok(up.includes("--no-print-url"));
	equal(up[up.indexOf("--account") + 1], ACCOUNT);
	equal(up[up.indexOf("--image") + 1], "registry");
	ok(up.includes("--repo-config"));
	equal(up.includes("--domain"), false);
	equal(up.includes("--delete-setup-token"), false);
	const off = deployArgs({
		containers: false,
		image: "registry",
		claimed: true,
		accountId: ACCOUNT,
	});
	ok(off.includes("--no-containers"));
	ok(off.includes("--delete-setup-token"));
	equal(off.includes("--repo-config"), false, "repo config needs containers");
	equal(off.includes("--image"), false);
	const down = destroyArgs(ACCOUNT);
	deepStrictEqual(down.slice(2, 5), [
		"scripts/destroy.ts",
		"--stage",
		"dev-e2e",
	]);
	equal(down[down.indexOf("--account") + 1], ACCOUNT);
});

Deno.test("a forge on the name that reports another stage is refused before deploy", async () => {
	let deployed = false;
	const deps = forgeDeps({
		record: null,
		health: { [`${FORGE}/-/health`]: { product: "Tartan", stage: "dev-demo" } },
		onDeploy: () => {
			deployed = true;
		},
	});
	await rejects(
		deployForge(deps, {
			subdomain: "acme",
			containers: false,
			image: "registry",
		}),
		GuardError,
	);
	equal(deployed, false);
});

const PASSWORDS = {
	owner: "p1-xxxxxx",
	developer: "p2-xxxxxx",
	reporter: "p3-xxxxxx",
	outsider: "p4-xxxxxx",
};

Deno.test("the e2e child gets run values only; every token is a secret", () => {
	const env = e2eEnv({
		origin: FORGE,
		issuer: ISSUER,
		runId: "r202610031200abcd",
		containers: false,
		passwords: PASSWORDS,
	});
	equal(env.TARTAN_E2E_CONTAINERS, "0");
	equal("TARTAN_E2E_SETUP_TOKEN" in env, false);
	equal("TARTAN_E2E_OWNER_PAT" in env, false);
	deepStrictEqual(secretValues(env).sort(), Object.values(PASSWORDS).sort());

	const creds = {
		runId: "r202610031200abcd",
		ownerPat: `tpat_${"a".repeat(43)}`,
		reporterPat: `tpat_${"b".repeat(43)}`,
		readPat: `tpat_${"c".repeat(43)}`,
		developerAgent: `tagt_${"d".repeat(43)}`,
		developerAgentB: `tagt_${"e".repeat(43)}`,
		revoke: { tokenIds: [], agentIds: [] },
		ownerSession: "s",
	};
	const full = e2eEnv({
		origin: FORGE,
		issuer: ISSUER,
		runId: creds.runId,
		containers: true,
		passwords: PASSWORDS,
		creds,
		setupToken: "x".repeat(20),
	});
	deepStrictEqual(
		secretValues(full).sort(),
		[
			...Object.values(PASSWORDS),
			creds.ownerPat,
			creds.reporterPat,
			creds.readPat,
			creds.developerAgent,
			creds.developerAgentB,
			"x".repeat(20),
		].sort(),
	);
	// The launcher writes exactly the variables the suites read.
	for (const [key, name] of Object.entries(TOKEN_ENV)) {
		equal(TOKEN_VARS[key as keyof typeof TOKEN_VARS].name, name, key);
	}
	deepStrictEqual(
		Object.keys(TOKEN_ENV).sort(),
		Object.keys(TOKEN_VARS).sort(),
	);
});

Deno.test("one failed shared setup never stops a run: the stop is above the largest suite's group", async () => {
	// S2-rem's rows all wait on one setup; count its tests from the source.
	const s2 = await Deno.readTextFile(
		new URL("../../e2e/tests/gateway/s2-policy.e2e.ts", import.meta.url),
	);
	const rows = (s2.match(/^\t\t\t\[T\./gm) ?? []).length;
	ok(rows > 5, "the S2 row table is found");
	ok(MAX_FAILURES > 35, `MAX_FAILURES ${MAX_FAILURES} leaves room for S2`);
});

Deno.test("run arguments keep the defaults and merge the caller's tags and reporters", () => {
	const args = runArgs(["tests/issues.e2e.ts", "--tag", "smoke"]);
	ok(args.includes("--no-cache"));
	equal(args[args.indexOf("--exclude-tag") + 1], "quarantine,claim");
	equal(args[args.indexOf("--reporter") + 1], "list,junit,markdown");
	equal(args[args.indexOf("--max-failures") + 1], String(MAX_FAILURES));
	deepStrictEqual(args.slice(-3), ["tests/issues.e2e.ts", "--tag", "smoke"]);

	// The caller's exclusions add to the defaults; they never replace them.
	const excluded = runArgs([
		"--exclude-tag",
		"slow",
		"--exclude-tag=known-bug",
	]);
	equal(excluded.filter((a) => a === "--exclude-tag").length, 1);
	equal(
		excluded[excluded.indexOf("--exclude-tag") + 1],
		"quarantine,claim,slow,known-bug",
	);
	equal(excluded.some((a) => a.startsWith("--exclude-tag=")), false);

	// Reporters too: junit and markdown always stay (evidence reads them).
	const own = runArgs(["--max-failures", "1", "--reporter", "list,json"]);
	equal(own.filter((a) => a === "--max-failures").length, 1);
	equal(own.filter((a) => a === "--reporter").length, 1);
	equal(own[own.indexOf("--reporter") + 1], "list,junit,markdown,json");

	throws(() => runArgs(["--exclude-tag"]), GuardError);
	throws(() => runArgs(["--reporter", "--tag"]), GuardError);
	deepStrictEqual(takeListFlag(["a", "--reporter=x,y", "b"], "--reporter"), {
		values: ["x", "y"],
		rest: ["a", "b"],
	});
});

Deno.test("repeated runs leave out the rate-limited tests", () => {
	const repeated = runArgs(["--repeat-each", "5", "tests/issues.e2e.ts"]);
	equal(
		repeated[repeated.indexOf("--exclude-tag") + 1],
		"quarantine,claim,rate-limited",
	);
	const once = runArgs([]);
	equal(once[once.indexOf("--exclude-tag") + 1], "quarantine,claim");
});

Deno.test("stage up builds the runner image here unless --image says registry", () => {
	// A ttl.sh digest needs that registry configured on the account; on an
	// account without it, a registry deploy fails with
	// IMAGE_REGISTRY_NOT_CONFIGURED after the Worker upload.
	equal(DEFAULT_IMAGE, "dockerfile");
	equal(imageOf(undefined), "dockerfile");
	equal(imageOf("registry"), "registry");
	equal(imageOf("dockerfile"), "dockerfile");
	throws(() => imageOf("ttl.sh"), GuardError);
	const args = deployArgs({
		containers: true,
		image: imageOf(undefined),
		claimed: true,
		accountId: "0123456789abcdef0123456789abcdef",
	});
	equal(args[args.indexOf("--image") + 1], "dockerfile");
});

Deno.test("the claimed-forge health guard retries a slow or wrong answer with backoff, then gives the last one", async () => {
	const answers: (Record<string, unknown> | "hang")[] = [
		"hang",
		{ product: "Tartan", stage: "dev-e2e", setupState: "fresh" },
		{ product: "Tartan", stage: "dev-e2e", setupState: "done" },
	];
	const asked: string[] = [];
	const fetchFn = ((url: string) => {
		asked.push(url);
		const next = answers.shift();
		return next === "hang" || next === undefined
			? Promise.reject(new Error("no answer after 30 s"))
			: Promise.resolve(Response.json(next));
	}) as unknown as typeof fetch;
	const slept: number[] = [];
	const sleep = (ms: number) => {
		slept.push(ms);
		return Promise.resolve();
	};
	const h = await claimedForgeHealth(fetchFn, FORGE, { sleep });
	equal(h?.setupState, "done");
	equal(asked.length, 3);
	deepStrictEqual(slept, [1_000, 3_000]);
	ok(asked.every((u) => u === `${FORGE}/-/health`));

	const never =
		(() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
	const none: number[] = [];
	equal(
		await claimedForgeHealth(never, FORGE, {
			backoffMs: [5, 5],
			sleep: (ms) => {
				none.push(ms);
				return Promise.resolve();
			},
		}),
		null,
	);
	deepStrictEqual(none, [5, 5], "three attempts, then the last answer");
});
