// The e2e suites never reach a model and never send telemetry:
//
// - no `ai` or `@ai-sdk/*` package is a dependency;
// - the e2e sources use no agent step, `explore`, bug-bash or `unique()`,
//   and import nothing from `e2e/agent` or `e2e/oauth`;
// - the config declares no `agents`, keeps the replay cache off, gives the
//   web engine no `headers` or `basicAuth` (on workers.dev they would reach
//   every Worker on the account) and loads the no-telemetry module first;
// - Bearer tokens appear only in the Node-side helpers, never in page code;
//   no token or session cookie is written into a source file;
// - offline, `e2e list` loads the config and sends no telemetry even when
//   the CLI starts without any telemetry variable (`E2E_TELEMETRY_DEBUG=1`
//   prints what would be sent and sends nothing). A missing config is the
//   control: there the CLI does print an event, so the check is not vacuous.

import { equal, ok } from "node:assert/strict";
import * as path from "node:path";
import { ROOT } from "./proc.ts";

const E2E_DIR = path.join(ROOT, "e2e");

const walk = async (dir: string): Promise<string[]> => {
	const out: string[] = [];
	for await (const entry of Deno.readDir(dir)) {
		const p = path.join(dir, entry.name);
		if (entry.isDirectory && entry.name !== ".e2e") out.push(...await walk(p));
		else if (entry.isFile && p.endsWith(".ts")) out.push(p);
	}
	return out.sort();
};

const SOURCE_RULES: readonly { readonly rule: string; readonly re: RegExp }[] =
	[
		{
			rule: "agent step",
			re: /\bagent\s*\.\s*(?:act|assert|waitFor|extract)\b/,
		},
		{ rule: "agent fixture", re: /[{,]\s*agent\s*[,}:]/ },
		// Spreading a test's fixture object reads every fixture, `agent`
		// included (MODEL_UNAVAILABLE stops the whole run): name them.
		{ rule: "fixture spread", re: /\.\.\.\s*(?:fx|fixtures)\b/ },
		{ rule: "agentContext", re: /\bagentContext\b/ },
		{ rule: "explore", re: /\bexplore\s*\(|\be2e\s+explore\b/ },
		{ rule: "bug-bash", re: /\bbug-?bash\b/i },
		{ rule: "unique()", re: /\bunique\s*\(/ },
		{ rule: "e2e/agent", re: /["']e2e\/agent["']/ },
		{ rule: "e2e/oauth", re: /["']e2e\/oauth/ },
		{ rule: "model provider", re: /["']@ai-sdk\/|from\s+["']ai["']/ },
		{ rule: "token literal", re: /t(?:pat|agt)_[A-Za-z0-9_-]{43}/ },
		{ rule: "session cookie", re: /__Host-tartan-session=/ },
	];

/** The Node-side helpers that may hold a Bearer token. */
const TOKEN_FILES = ["support/git.ts", "support/http.ts", "support/mcp.ts"];

Deno.test("no model package is a dependency", async () => {
	const pkg = JSON.parse(
		await Deno.readTextFile(path.join(ROOT, "package.json")),
	) as Record<string, Record<string, string> | undefined>;
	const names = [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
	].flatMap((k) => Object.keys(pkg[k] ?? {}));
	const model = names.filter((n) => n === "ai" || n.startsWith("@ai-sdk/"));
	equal(model.join(", "), "");
});

/**
 * `@ai-sdk/provider` is a hard dependency of `e2e` itself: provider
 * interfaces only, no model client. Every other `@ai-sdk/*` package, and
 * `ai` (the SDK that calls models), must be absent.
 */
const ALLOWED_AI_SDK = new Set(["provider"]);

Deno.test("no model client is installed or locked (node_modules/ai is absent)", async () => {
	const modules = path.join(ROOT, "node_modules");
	let present = false;
	try {
		await Deno.stat(path.join(modules, "ai"));
		present = true;
	} catch (error) {
		ok(error instanceof Deno.errors.NotFound, String(error));
	}
	equal(present, false, "node_modules/ai is installed");
	const sdk: string[] = [];
	try {
		for await (const entry of Deno.readDir(path.join(modules, "@ai-sdk"))) {
			if (!ALLOWED_AI_SDK.has(entry.name)) sdk.push(`@ai-sdk/${entry.name}`);
		}
	} catch (error) {
		ok(error instanceof Deno.errors.NotFound, String(error));
	}
	equal(sdk.join(", "), "", "a model provider package is installed");
	const lock = JSON.parse(
		await Deno.readTextFile(path.join(ROOT, "package-lock.json")),
	) as { packages?: Record<string, unknown> };
	const locked = Object.keys(lock.packages ?? {}).filter((p) =>
		/(?:^|\/)node_modules\/ai$/.test(p) ||
		(/(?:^|\/)node_modules\/@ai-sdk\//.test(p) &&
			!ALLOWED_AI_SDK.has(p.split("/").at(-1) ?? ""))
	);
	equal(locked.join(", "), "", "a model package is in the lockfile");
});

/** Source without whole-line and block comments (prose may name what code may not do). */
const codeOf = (text: string): string =>
	text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
		.filter((line) => !/^\s*\/\//.test(line)).join("\n");

Deno.test("the e2e sources call no model and keep tokens out of the page", async () => {
	const hits: string[] = [];
	for (const file of await walk(E2E_DIR)) {
		const rel = path.relative(E2E_DIR, file);
		const text = await Deno.readTextFile(file);
		const code = codeOf(text);
		for (const { rule, re } of SOURCE_RULES) {
			// Credentials are checked in comments too.
			if (
				re.test(rule.includes("token") || rule.includes("cookie") ? text : code)
			) {
				hits.push(`${rel}: ${rule}`);
			}
		}
		if (
			!TOKEN_FILES.includes(rel) && /\bauthorization\b|\bBearer\b/i.test(code)
		) {
			hits.push(`${rel}: a Bearer credential outside the Node-side helpers`);
		}
	}
	equal(hits.join("\n"), "");
});

Deno.test("the source scan catches what it is for", () => {
	const caught = (snippet: string) =>
		SOURCE_RULES.filter(({ re }) => re.test(snippet)).map((r) => r.rule);
	equal(caught('await agent.act("sign in")').join(), "agent step");
	equal(
		caught("test('x', async ({ app, agent }) => {})").join(),
		"agent fixture",
	);
	equal(caught("await body({ ...fx, loop })").join(), "fixture spread");
	equal(caught("await explore(goal)").join(), "explore");
	equal(caught('import { gateway } from "ai";').join(), "model provider");
	equal(caught(`const t = "tagt_${"a".repeat(43)}";`).join(), "token literal");
	equal(caught('await app.open("/-/explore")').join(), "");
});

Deno.test("the config has no agents, no cache, no engine headers, and turns telemetry off first", async () => {
	const text = await Deno.readTextFile(path.join(E2E_DIR, "e2e.config.ts"));
	const code = text.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
	const firstImport = code.split("\n").find((l) => l.startsWith("import"));
	equal(firstImport, 'import "./support/no-telemetry.ts";');
	ok(!/\bagents\s*:/.test(code), "no agents key");
	ok(/\bcache:\s*"off"/.test(code), "the replay cache is off");
	ok(
		!/\bheaders\s*:|\bbasicAuth\b/.test(code),
		"no engine headers or basicAuth",
	);
	ok(!/\bconnect\s*:|\bBrowserProvider\b/.test(code), "a local browser only");
	const noTelemetry = await Deno.readTextFile(
		path.join(E2E_DIR, "support", "no-telemetry.ts"),
	);
	ok(noTelemetry.includes('process.env.E2E_TELEMETRY_DISABLED = "1"'));
	ok(noTelemetry.includes('process.env.DO_NOT_TRACK = "1"'));
});

const E2E_BIN = path.join(ROOT, "node_modules", "e2e", "dist", "cli", "bin.js");

const hasE2e = (() => {
	try {
		Deno.statSync(E2E_BIN);
		return true;
	} catch {
		return false;
	}
})();

/** `e2e list` with a clean environment: only PATH, temp dirs and the stage values. */
const list = async (config: string) => {
	const home = await Deno.makeTempDir({ prefix: "tartan-e2e-list-" });
	try {
		const out = await new Deno.Command("node", {
			args: [E2E_BIN, "list", "--config", config],
			cwd: ROOT,
			clearEnv: true,
			env: {
				PATH: Deno.env.get("PATH") ?? "",
				HOME: home,
				XDG_CONFIG_HOME: home,
				TMPDIR: home,
				// Prints any event instead of sending it.
				E2E_TELEMETRY_DEBUG: "1",
				TARTAN_E2E_ORIGIN: "https://tartan-dev-e2e.offline.workers.dev",
				TARTAN_E2E_ISSUER: "https://tartan-e2e--idp.offline.workers.dev",
				TARTAN_E2E_RUN_ID: "r202610050900abcd",
				TARTAN_E2E_CONTAINERS: "1",
				TARTAN_E2E_PASSWORD_OWNER: "o".repeat(43),
				TARTAN_E2E_PASSWORD_DEVELOPER: "d".repeat(43),
				TARTAN_E2E_PASSWORD_REPORTER: "r".repeat(43),
				TARTAN_E2E_PASSWORD_OUTSIDER: "x".repeat(43),
			},
			stdout: "piped",
			stderr: "piped",
		}).output();
		const decoder = new TextDecoder();
		return {
			code: out.code,
			stdout: decoder.decode(out.stdout),
			stderr: decoder.decode(out.stderr),
		};
	} finally {
		await Deno.remove(home, { recursive: true });
	}
};

Deno.test({
	name:
		"offline, e2e list loads every suite and sends no telemetry without any telemetry variable",
	ignore: !hasE2e,
	sanitizeResources: false,
	fn: async () => {
		const run = await list(path.join(E2E_DIR, "e2e.config.ts"));
		equal(run.code, 0, run.stderr);
		for (const file of await walk(path.join(E2E_DIR, "tests"))) {
			ok(
				run.stdout.includes(path.relative(E2E_DIR, file)),
				`${path.relative(E2E_DIR, file)} is collected`,
			);
		}
		ok(!run.stderr.includes("[telemetry]"), "no telemetry event");
		ok(!run.stdout.includes("[telemetry]"), "no telemetry event");

		// Control: without our config the CLI does record an event.
		const control = await list(path.join(ROOT, "e2e", "missing.config.ts"));
		ok(control.code !== 0);
		ok(
			control.stderr.includes("[telemetry]"),
			"the debug output shows events when telemetry is on",
		);
	},
});
