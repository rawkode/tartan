// `tartan` CLI (WP11): the credential helper with stock git, the
// pre-push hook with stock git (a 32 MiB blob, the canonical `main` and
// another agent's lane remote are refused before any upload; the own lane
// goes through), and login / lane open against a local forge stand-in.

import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { createUlid } from "@tartan/contract";
import { type Args, credential, type Io, laneOpen, login } from "./commands.ts";
import { resolveCredential } from "./config.ts";
import { credentialAnswer, invocation } from "./credential.ts";
import { createGit, type Git, gitOk } from "./git.ts";
import { installGitHook } from "./hooks.ts";
import { readLanes, recordLane } from "./lanes.ts";
import { parseArgs } from "./main.ts";
import { startFakeForge } from "./testing/server.ts";

const ulid = createUlid();
const TOKEN = `tagt_${"A".repeat(43)}`;
const MINE = `ln_${ulid()}`;
const OTHERS = `ln_${ulid()}`;
const ME = `a_${ulid()}`;
const OTHER_AGENT = `a_${ulid()}`;

type Sandbox = {
	readonly dir: string;
	readonly env: Record<string, string>;
	readonly git: Git;
};

const sandbox = async (
	extra: Record<string, string> = {},
): Promise<Sandbox> => {
	const dir = await Deno.makeTempDir({ prefix: "tartan-cli-" });
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
	return { dir, env, git: createGit(`${dir}/work`, env) };
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

const args = (argv: string[]): Args => parseArgs(argv);

const helperCommand = () =>
	`!${invocation().map((a) => `'${a}'`).join(" ")} credential`;

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

Deno.test("parseArgs: values, repeats, bare flags and --", () => {
	const parsed = parseArgs([
		"open",
		"--repo",
		"acme/shop",
		"--prefix",
		"src/",
		"--prefix=docs/",
		"--json",
		"--",
		"--literal",
	]);
	deepStrictEqual(parsed.positional, ["open", "--literal"]);
	deepStrictEqual(parsed.flags.prefix, ["src/", "docs/"]);
	equal(parsed.flags.json, true);
	equal(parsed.flags.repo, "acme/shop");
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
				path: "acme/shop/-/lanes/x.git",
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

// ---------------------------------------------------------------------------
// The credential helper with stock git
// ---------------------------------------------------------------------------

Deno.test("credential helper: stock git authenticates to the repo URL and to a lane remote with the token", async () => {
	const forge = startFakeForge({ token: TOKEN });
	const box = await sandbox({ TARTAN_TOKEN: TOKEN, TARTAN_URL: forge.origin });
	try {
		forge.refs.set("refs/heads/main", "1".repeat(40));
		const helper = [
			"-c",
			"credential.helper=",
			"-c",
			`credential.${forge.origin}.helper=${helperCommand()}`,
		];
		for (const path of ["/acme/shop.git", `/acme/shop/-/lanes/${MINE}.git`]) {
			const out = await box.git([
				...helper,
				"ls-remote",
				`${forge.origin}${path}`,
			]);
			equal(out.code, 0, out.stderr);
			match(out.stdout, /1{40}\trefs\/heads\/main/);
		}
		const authed = forge.requests.filter((r) => r.authorization !== null);
		ok(authed.length >= 2);
		ok(
			authed.every((r) =>
				r.authorization === `Basic ${btoa(`agent:${TOKEN}`)}`
			),
		);
		ok(forge.requests.some((r) => r.authorization === null), "401 first");
	} finally {
		await forge.close();
		await Deno.remove(box.dir, { recursive: true });
	}
});

Deno.test("credential install: the helper is set for the forge only, and another host gets nothing", async () => {
	const forge = startFakeForge({ token: TOKEN });
	const box = await sandbox({ TARTAN_TOKEN: TOKEN });
	try {
		forge.refs.set("refs/heads/main", "2".repeat(40));
		await gitOk(box.git, ["init", "-q"]);
		const io = ioFor(box);
		await Deno.writeTextFile(
			box.env.TARTAN_CONFIG,
			JSON.stringify({
				default: forge.origin,
				forges: { [forge.origin]: { token: TOKEN } },
			}),
		);
		await credential(io, args(["install"]));
		match(io.lines[0], /credential/);
		const ok1 = await box.git(["ls-remote", `${forge.origin}/acme/shop.git`]);
		equal(ok1.code, 0, ok1.stderr);
		// The same server under another host name is not a known forge.
		const other = forge.origin.replace("127.0.0.1", "localhost");
		const refused = await box.git(["ls-remote", `${other}/acme/shop.git`]);
		notOk(refused.code === 0);
	} finally {
		await forge.close();
		await Deno.remove(box.dir, { recursive: true });
	}
});

const notOk = (value: boolean) => ok(!value);

// ---------------------------------------------------------------------------
// The pre-push hook with stock git
// ---------------------------------------------------------------------------

const pushFixture = async () => {
	const forge = startFakeForge({ token: TOKEN });
	const box = await sandbox({ TARTAN_TOKEN: TOKEN, TARTAN_URL: forge.origin });
	const git = box.git;
	await gitOk(git, ["init", "-q", "-b", "main"]);
	await Deno.writeTextFile(`${box.dir}/work/README.md`, "# shop\n");
	await gitOk(git, ["add", "README.md"]);
	await gitOk(git, ["commit", "-q", "-m", "trunk"]);
	const trunk = await gitOk(git, ["rev-parse", "HEAD"]);
	forge.refs.set("refs/heads/main", trunk);
	await gitOk(git, [
		"remote",
		"add",
		"origin",
		`${forge.origin}/acme/shop.git`,
	]);
	await gitOk(git, ["update-ref", "refs/remotes/origin/main", trunk]);
	await gitOk(git, [
		"symbolic-ref",
		"refs/remotes/origin/HEAD",
		"refs/remotes/origin/main",
	]);
	await gitOk(git, ["config", "credential.helper", ""]);
	await gitOk(git, ["config", "--add", "credential.helper", helperCommand()]);
	const installed = await installGitHook(git, { force: false });
	equal(installed.forge, forge.origin);
	equal(installed.defaultBranch, "main");
	equal(installed.maxPushBytes, 95_000_000);
	await recordLane(git, {
		laneId: MINE,
		repo: "acme/shop",
		mode: "branch",
		remote: `${forge.origin}/acme/shop.git`,
		ref: `refs/heads/lanes/${MINE}`,
		branch: `lanes/${MINE}`,
	});
	forge.setTools((name, a) => {
		if (name === "whoami") return { principal: { id: ME } };
		if (name === "lanes_get") {
			return {
				lane: {
					id: a.laneId,
					owner: a.laneId === MINE ? ME : OTHER_AGENT,
					delegates: [],
				},
			};
		}
		return { error: "not_found" };
	});
	const posts = () =>
		forge.requests.filter((r) =>
			r.method === "POST" && r.path.endsWith("git-receive-pack")
		).length;
	return { forge, box, git, trunk, posts };
};

Deno.test("pre-push: a 32 MiB blob, the canonical main and another agent's lane remote are refused before any upload; the own lane pushes", async () => {
	const { forge, box, git, posts } = await pushFixture();
	try {
		// A 32 MiB blob on the own lane.
		await gitOk(git, ["switch", "-q", "-c", `lanes/${MINE}`]);
		const big = await Deno.open(`${box.dir}/work/big.bin`, {
			write: true,
			create: true,
		});
		await big.truncate(32 * 1024 * 1024);
		big.close();
		await gitOk(git, ["add", "big.bin"]);
		await gitOk(git, ["commit", "-q", "-m", "big"]);
		const tooBig = await git([
			"push",
			"origin",
			`HEAD:refs/heads/lanes/${MINE}`,
		]);
		notOk(tooBig.code === 0);
		match(tooBig.stderr, /object-too-large: big\.bin is 32\.0 MiB/);
		equal(posts(), 0, "nothing uploaded");
		await gitOk(git, ["reset", "-q", "--hard", "HEAD~1"]);

		// A small change: main is refused, the other lane remote too.
		await Deno.writeTextFile(`${box.dir}/work/fix.txt`, "fix\n");
		await gitOk(git, ["add", "fix.txt"]);
		await gitOk(git, ["commit", "-q", "-m", "fix"]);
		const toMain = await git(["push", "origin", "HEAD:refs/heads/main"]);
		notOk(toMain.code === 0);
		match(toMain.stderr, /refs\/heads\/main: woven-by-tartan/);
		const other = await git([
			"push",
			`${forge.origin}/acme/shop/-/lanes/${OTHERS}.git`,
			"HEAD:refs/heads/main",
		]);
		notOk(other.code === 0);
		match(other.stderr, /not-your-lane/);
		const branch = await git(["push", "origin", "HEAD:refs/heads/feature"]);
		notOk(branch.code === 0);
		match(branch.stderr, /agents-lanes-only/);
		equal(posts(), 0, "still nothing uploaded");

		// The own lane goes through (and the forge receives the pack).
		const own = await git(["push", "origin", `HEAD:refs/heads/lanes/${MINE}`]);
		equal(own.code, 0, own.stderr);
		equal(posts(), 1);
	} finally {
		await forge.close();
		await Deno.remove(box.dir, { recursive: true });
	}
});

Deno.test("pre-push: the estimated pack is checked against the forge's push limit", async () => {
	const { forge, box, git, posts } = await pushFixture();
	try {
		await gitOk(git, ["config", "tartan.maxPushBytes", "2000"]);
		await gitOk(git, ["switch", "-q", "-c", `lanes/${MINE}`]);
		const random = new Uint8Array(8192);
		crypto.getRandomValues(random);
		await Deno.writeFile(`${box.dir}/work/noise.bin`, random);
		await gitOk(git, ["add", "noise.bin"]);
		await gitOk(git, ["commit", "-q", "-m", "noise"]);
		const out = await git(["push", "origin", `HEAD:refs/heads/lanes/${MINE}`]);
		notOk(out.code === 0);
		match(out.stderr, /push-too-large/);
		equal(posts(), 0);
	} finally {
		await forge.close();
		await Deno.remove(box.dir, { recursive: true });
	}
});

Deno.test("hooks install refuses to replace a foreign pre-push hook without --force", async () => {
	const box = await sandbox();
	try {
		await gitOk(box.git, ["init", "-q"]);
		const hooksDir = await gitOk(box.git, [
			"rev-parse",
			"--path-format=absolute",
			"--git-path",
			"hooks",
		]);
		await Deno.mkdir(hooksDir, { recursive: true });
		await Deno.writeTextFile(`${hooksDir}/pre-push`, "#!/bin/sh\nexit 0\n");
		let refused = false;
		try {
			await installGitHook(box.git, { force: false });
		} catch (error) {
			refused = String(error).includes("--force");
		}
		ok(refused);
		const forced = await installGitHook(box.git, { force: true });
		match(await Deno.readTextFile(forced.path), /tartan pre-push hook/);
	} finally {
		await Deno.remove(box.dir, { recursive: true });
	}
});

// ---------------------------------------------------------------------------
// login, lane open
// ---------------------------------------------------------------------------

Deno.test("login stores the token 0600 after whoami; lane open waits for an opening lane and adds lane-<n> for a repo lane", async () => {
	const forge = startFakeForge({ token: TOKEN });
	const box = await sandbox();
	try {
		let polls = 0;
		const remote = `${forge.origin}/acme/shop/-/lanes/${MINE}.git`;
		const handle = (state: string) => ({
			id: MINE,
			mode: "repo",
			state,
			remote,
			ref: "refs/heads/main",
			branch: `lanes/${MINE}`,
			base: "3".repeat(40),
			...(state === "open"
				? {
					git: {
						start:
							`git fetch ${remote} main && git switch -c lanes/${MINE} FETCH_HEAD`,
						push: `git push ${remote} HEAD:refs/heads/main`,
					},
				}
				: {}),
		});
		forge.setTools((name) => {
			if (name === "whoami") {
				return { principal: { id: ME, handle: "claude-1" } };
			}
			if (name === "lanes_open") return { lane: handle("opening") };
			if (name === "lanes_get") {
				polls += 1;
				return { lane: handle(polls < 2 ? "opening" : "open") };
			}
			return { error: "not_found" };
		});
		const io = ioFor(box, `${TOKEN}\n`);
		equal(
			await login(io, args([forge.origin, "--token-stdin"])).then(() => 0),
			0,
		);
		const stat = await Deno.stat(box.env.TARTAN_CONFIG);
		equal((stat.mode ?? 0) & 0o777, 0o600);
		match(io.lines[0], /logged in to .* as claude-1/);

		await gitOk(box.git, ["init", "-q"]);
		await laneOpen(
			io,
			args(["--repo", "acme/shop", "--purpose", "fix", "--prefix", "src/"]),
		);
		equal(polls, 2);
		const out = io.lines.at(-1)!;
		match(out, new RegExp(`start: git fetch ${remote} main`));
		match(out, /remote lane-1 added/);
		equal(await gitOk(box.git, ["remote", "get-url", "lane-1"]), remote);
		const [record] = await readLanes(box.git);
		equal(record.laneId, MINE);
		equal(record.remoteName, "lane-1");
		const open = forge.toolCalls.find((c) => c.name === "lanes_open")!;
		equal(open.scope, "acme/shop");
		deepStrictEqual(open.args, {
			repo: "acme/shop",
			purpose: "fix",
			footprint: { prefixes: ["src/"], projects: [] },
		});
		ok(
			io.errors.some((e) => e.startsWith("```tartan-notices")),
			"notices shown",
		);
	} finally {
		await forge.close();
		await Deno.remove(box.dir, { recursive: true });
	}
});
