// `tt` against a local forge stand-in with stock git: `auth login
// --with-token` (checked with whoami, stored 0600), `auth status|token|logout`,
// `auth setup-git`, git running `tt auth git-credential get`, and `repo clone`
// over HTTP with and without `setup-git`.

import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { createUlid } from "@tartan/contract";
import type { Io } from "./commands.ts";
import { originOf, resolveCredential } from "./config.ts";
import { credentialAnswer, helperValue } from "./credential.ts";
import { createGit, type Git, gitOk } from "./git.ts";
import { parseArgs, run } from "./main.ts";
import { cloneTarget } from "./repo.ts";
import { startFakeForge } from "./testing/server.ts";

const ulid = createUlid();
const TOKEN = `tagt_${"A".repeat(43)}`;
const LANE = `ln_${ulid()}`;
const ME = `a_${ulid()}`;

type Sandbox = {
	readonly dir: string;
	readonly env: Record<string, string>;
	readonly git: Git;
	readonly bare: string;
	readonly head: string;
};

/** A temp dir with its own global git config, and a bare repo with one commit. */
const sandbox = async (
	extra: Record<string, string> = {},
): Promise<Sandbox> => {
	const dir = await Deno.makeTempDir({ prefix: "tt-cli-" });
	await Deno.writeTextFile(`${dir}/gitconfig`, "");
	const env = {
		GIT_CONFIG_GLOBAL: `${dir}/gitconfig`,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "Agent",
		GIT_AUTHOR_EMAIL: "agent@example.test",
		GIT_COMMITTER_NAME: "Agent",
		GIT_COMMITTER_EMAIL: "agent@example.test",
		TARTAN_CONFIG: `${dir}/tartan.json`,
		...extra,
	};
	await Deno.mkdir(`${dir}/work`);
	await Deno.mkdir(`${dir}/seed`);
	const bare = `${dir}/upstream.git`;
	const seed = createGit(`${dir}/seed`, env);
	await gitOk(seed, ["init", "-q", "-b", "main"]);
	await Deno.writeTextFile(`${dir}/seed/README.md`, "# shop\n");
	await gitOk(seed, ["add", "README.md"]);
	await gitOk(seed, ["commit", "-q", "-m", "trunk"]);
	const head = await gitOk(seed, ["rev-parse", "HEAD"]);
	await gitOk(seed, ["clone", "-q", "--bare", ".", bare]);
	return { dir, env, git: createGit(`${dir}/work`, env), bare, head };
};

const ioFor = (
	box: Sandbox,
	stdin = "",
): Io & { lines: string[]; errors: string[] } => {
	const lines: string[] = [];
	const errors: string[] = [];
	return {
		env: { get: (name) => box.env[name] },
		git: box.git,
		fetch: (input, init) => fetch(input, init),
		out: (text) => void lines.push(text),
		err: (text) => void errors.push(text),
		readStdin: () => Promise.resolve(stdin),
		readSecret: () => Promise.resolve(null),
		sleep: () => Promise.resolve(),
		lines,
		errors,
	};
};

const withForge = async (
	test: (
		forge: ReturnType<typeof startFakeForge>,
		box: Sandbox,
	) => Promise<void>,
	extra: Record<string, string> = {},
) => {
	const box = await sandbox(extra);
	const forge = startFakeForge({ token: TOKEN, bare: box.bare });
	forge.setTools((name) =>
		name === "whoami"
			? { principal: { id: ME, handle: "claude-1" } }
			: { error: "not_found" }
	);
	try {
		await test(forge, box);
	} finally {
		await forge.close();
		await Deno.remove(box.dir, { recursive: true });
	}
};

const login = async (forge: { origin: string }, box: Sandbox) => {
	const io = ioFor(box, `${TOKEN}\n`);
	const code = await run(io, [
		"auth",
		"login",
		"--hostname",
		forge.origin,
		"--with-token",
	]);
	equal(code, 0, io.errors.join("\n"));
	return io;
};

/** The values of a multi-valued git config key in one scope (empty ones too). */
const helpers = async (git: Git, scope: string, key: string) => {
	const out = await git(["config", scope, "--get-all", key]);
	equal(out.code, 0, out.stderr);
	return out.stdout.replace(/\n$/, "").split("\n");
};

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

Deno.test("parseArgs: values, repeats, bare flags, -h and the -- passthrough", () => {
	const parsed = parseArgs([
		"clone",
		"--hostname",
		"code.example.test",
		"--repo=a/b",
		"--repo=c/d",
		"--json",
		"-h",
		"acme/shop",
		"--",
		"--depth",
		"1",
	]);
	deepStrictEqual(parsed.positional, ["clone", "acme/shop"]);
	equal(parsed.flags.hostname, "code.example.test");
	deepStrictEqual(parsed.flags.repo, ["a/b", "c/d"]);
	equal(parsed.flags.json, true);
	equal(parsed.flags.help, true);
	deepStrictEqual(parsed.passthrough, ["--depth", "1"]);
});

Deno.test("originOf takes a bare host name as https", () => {
	equal(originOf("code.example.test"), "https://code.example.test");
	equal(originOf("http://127.0.0.1:8787/x"), "http://127.0.0.1:8787");
});

Deno.test("cloneTarget: a forge path resolves against the forge; a URL passes through", () => {
	const forge = () => "https://code.example.test";
	deepStrictEqual(cloneTarget("/acme/platform/router.git", forge), {
		url: "https://code.example.test/acme/platform/router.git",
		origin: "https://code.example.test",
	});
	deepStrictEqual(cloneTarget("https://other.test/a/b.git", forge), {
		url: "https://other.test/a/b.git",
		origin: "https://other.test",
	});
	for (const bad of ["shop", "acme/../etc", "acme/sh op", "acme//shop"]) {
		let refused = false;
		try {
			cloneTarget(bad, forge);
		} catch {
			refused = true;
		}
		ok(refused, bad);
	}
});

Deno.test("TARTAN_TOKEN is offered only to its own forge; a stored principal only with its own token", () => {
	const A = "https://a.example.test";
	const B = "https://b.example.test";
	const tokenA = `tagt_${"a".repeat(43)}`;
	const tokenB = `tagt_${"b".repeat(43)}`;
	const config = {
		default: B,
		forges: { [B]: { token: tokenB, principal: "a_b" } },
	};
	const vars: Record<string, string> = { TARTAN_URL: A, TARTAN_TOKEN: tokenA };
	const env = { get: (name: string) => vars[name] };
	const answer = (host: string) =>
		credentialAnswer({ protocol: "https", host }, config, env);
	equal(answer("b.example.test"), `username=agent\npassword=${tokenB}\n`);
	equal(answer("a.example.test"), `username=agent\npassword=${tokenA}\n`);
	equal(answer("c.example.test"), "");
	deepStrictEqual(resolveCredential(config, env, B), {
		origin: B,
		token: tokenB,
		principal: "a_b",
	});
	// The env token for the default forge does not carry the stored principal.
	const onB = {
		get: (name: string) => name === "TARTAN_TOKEN" ? tokenA : undefined,
	};
	deepStrictEqual(resolveCredential(config, onB), { origin: B, token: tokenA });
});

Deno.test("credentialAnswer: the token for a known forge (any path), nothing elsewhere", () => {
	const config = { forges: { "https://code.example.test": { token: TOKEN } } };
	const env = { get: () => undefined };
	equal(
		credentialAnswer(
			{
				protocol: "https",
				host: "code.example.test",
				path: `acme/shop/-/lanes/${LANE}.git`,
			},
			config,
			env,
		),
		`username=agent\npassword=${TOKEN}\n`,
	);
	equal(
		credentialAnswer({ protocol: "https", host: "github.com" }, config, env),
		"",
	);
	equal(
		credentialAnswer(
			{ protocol: "https", host: "code.example.test" },
			{
				forges: {
					"https://code.example.test": { token: `tpat_${"B".repeat(43)}` },
				},
			},
			env,
		).split("\n")[0],
		"username=tartan",
	);
});

Deno.test("help: tt --help, tt auth --help and tt repo clone --help", async () => {
	const box = await sandbox();
	try {
		const io = ioFor(box);
		equal(await run(io, ["--help"]), 0);
		match(io.lines[0], /^Work with a Tartan forge/);
		equal(await run(io, ["auth", "--help"]), 0);
		match(io.lines[1], /setup-git:/);
		equal(await run(io, ["repo", "clone", "-h"]), 0);
		match(io.lines[2], /tt repo clone <owner\/…\/repo \| URL>/);
		equal(await run(io, ["lane", "open"]), 2);
		match(io.errors[0], /unknown command "lane"/);
	} finally {
		await Deno.remove(box.dir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

Deno.test("auth login --with-token checks the token with whoami and stores it 0600; status, token and logout", async () => {
	await withForge(async (forge, box) => {
		const bad = ioFor(box, "nope\n");
		equal(
			await run(bad, [
				"auth",
				"login",
				"--hostname",
				forge.origin,
				"--with-token",
			]),
			1,
		);
		match(bad.errors[0], /not a Tartan token/);
		const io = await login(forge, box);
		match(io.lines[0], /Logged in to .* as claude-1/);
		equal(forge.toolCalls[0].name, "whoami");
		const stat = await Deno.stat(box.env.TARTAN_CONFIG);
		equal((stat.mode ?? 0) & 0o777, 0o600);
		const stored = JSON.parse(await Deno.readTextFile(box.env.TARTAN_CONFIG));
		equal(stored.default, forge.origin);
		equal(stored.forges[forge.origin].token, TOKEN);
		equal(stored.forges[forge.origin].principal, ME);

		const status = ioFor(box);
		equal(await run(status, ["auth", "status"]), 0);
		match(status.lines[0], /Logged in as claude-1/);
		ok(!status.lines[0].includes(TOKEN), "status masks the token");

		const token = ioFor(box);
		equal(await run(token, ["auth", "token"]), 0);
		deepStrictEqual(token.lines, [TOKEN]);

		const out = ioFor(box);
		equal(await run(out, ["auth", "logout"]), 0);
		const after = JSON.parse(await Deno.readTextFile(box.env.TARTAN_CONFIG));
		deepStrictEqual(after, { forges: {} });
		equal(await run(ioFor(box), ["auth", "status"]), 1);
		equal(await run(ioFor(box), ["auth", "token"]), 2);
	});
});

Deno.test("auth login without --with-token points at the forge's token page and reads the token", async () => {
	await withForge(async (forge, box) => {
		const io = ioFor(box, `${TOKEN}\n`);
		equal(await run(io, ["auth", "login", "--hostname", forge.origin]), 0);
		match(io.errors[0], new RegExp(`${forge.origin}/-/agents`));
		match(io.lines[0], /Logged in/);
	});
});

Deno.test("stock git runs tt auth git-credential get for the repo URL and a lane remote", async () => {
	await withForge(async (forge, box) => {
		await login(forge, box);
		const helper = [
			"-c",
			"credential.helper=",
			"-c",
			`credential.${forge.origin}.helper=${helperValue()}`,
		];
		for (const path of ["/acme/shop.git", `/acme/shop/-/lanes/${LANE}.git`]) {
			const out = await box.git([
				...helper,
				"ls-remote",
				`${forge.origin}${path}`,
			]);
			equal(out.code, 0, out.stderr);
			match(out.stdout, new RegExp(`${box.head}\trefs/heads/main`));
		}
		const authed = forge.requests.filter((r) =>
			r.authorization?.startsWith("Basic ")
		);
		ok(authed.length >= 2);
		ok(
			authed.every((r) =>
				r.authorization === `Basic ${btoa(`agent:${TOKEN}`)}`
			),
		);
		ok(
			forge.requests.some((r) =>
				r.authorization === null && r.path.endsWith("/info/refs")
			),
			"401 first",
		);
	});
});

Deno.test("auth setup-git sets the global helper for the forge only; another host gets nothing", async () => {
	await withForge(async (forge, box) => {
		await login(forge, box);
		const io = ioFor(box);
		equal(await run(io, ["auth", "setup-git"]), 0, io.errors.join("\n"));
		match(io.lines[0], /auth git-credential/);
		const key = `credential.${forge.origin}.helper`;
		deepStrictEqual(await helpers(box.git, "--global", key), [
			"",
			helperValue(),
		]);
		// Idempotent: a second run leaves one reset and one helper.
		equal(await run(io, ["auth", "setup-git"]), 0);
		equal((await helpers(box.git, "--global", key)).length, 2);
		const good = await box.git(["ls-remote", `${forge.origin}/acme/shop.git`]);
		equal(good.code, 0, good.stderr);
		// The same server under another host name is not a known forge.
		const other = forge.origin.replace("127.0.0.1", "localhost");
		const refused = await box.git(["ls-remote", `${other}/acme/shop.git`]);
		ok(refused.code !== 0);
	});
});

// ---------------------------------------------------------------------------
// repo clone
// ---------------------------------------------------------------------------

Deno.test("repo clone without setup-git: the clone gets the helper in its own config and can fetch", async () => {
	await withForge(async (forge, box) => {
		await login(forge, box);
		const io = ioFor(box);
		equal(await run(io, ["repo", "clone", "acme/shop"]), 0);
		const clone = `${box.dir}/work/shop`;
		equal(await Deno.readTextFile(`${clone}/README.md`), "# shop\n");
		const git = createGit(clone, box.env);
		equal(
			await gitOk(git, ["remote", "get-url", "origin"]),
			`${forge.origin}/acme/shop.git`,
		);
		equal(await gitOk(git, ["rev-parse", "HEAD"]), box.head);
		deepStrictEqual(
			await helpers(git, "--local", `credential.${forge.origin}.helper`),
			["", helperValue()],
		);
		const fetched = await git(["fetch", "origin"]);
		equal(fetched.code, 0, fetched.stderr);
		ok(
			forge.requests.some((r) =>
				r.path === "/acme/shop.git/git-upload-pack" &&
				r.authorization === `Basic ${btoa(`agent:${TOKEN}`)}`
			),
		);
	});
});

Deno.test("repo clone after setup-git: plain git clone, into <dir>, with -- flags", async () => {
	await withForge(async (forge, box) => {
		await login(forge, box);
		equal(await run(ioFor(box), ["auth", "setup-git"]), 0);
		const io = ioFor(box);
		equal(
			await run(io, [
				"repo",
				"clone",
				`${forge.origin}/acme/platform/router.git`,
				"router",
				"--",
				"--depth",
				"1",
			]),
			0,
			io.errors.join("\n"),
		);
		const git = createGit(`${box.dir}/work/router`, box.env);
		equal(await gitOk(git, ["rev-parse", "HEAD"]), box.head);
		equal(await gitOk(git, ["rev-parse", "--is-shallow-repository"]), "true");
		const local = await git([
			"config",
			"--local",
			"--get-all",
			`credential.${forge.origin}.helper`,
		]);
		equal(local.code, 1, "no helper in the clone's own config");
	});
});

Deno.test("repo clone fails when not logged in, without running git", async () => {
	const box = await sandbox();
	try {
		const io = ioFor(box);
		equal(await run(io, ["repo", "clone", "acme/shop"]), 2);
		match(io.errors[0], /not logged in/);
	} finally {
		await Deno.remove(box.dir, { recursive: true });
	}
});
