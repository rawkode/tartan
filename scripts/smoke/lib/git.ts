// Stock git for the smoke drivers. Credentials never go into remote URLs (a
// clone from such a URL keeps the credential in `.git/config`): they are
// passed per command as `http.extraHeader`, so nothing is persisted.

export type GitAuth =
	| { readonly bearer: string }
	| { readonly basic: { readonly user: string; readonly password: string } };

export type GitRun = {
	readonly code: number;
	readonly ms: number;
	readonly stdout: string;
	readonly stderr: string;
};

export const authConfig = (auth: GitAuth | undefined): string[] =>
	auth === undefined ? [] : [
		"-c",
		`http.extraHeader=Authorization: ${
			"bearer" in auth
				? `Bearer ${auth.bearer}`
				: `Basic ${btoa(`${auth.basic.user}:${auth.basic.password}`)}`
		}`,
	];

export type GitEnv = Readonly<Record<string, string>>;

/** A hermetic environment: no system or user config, no prompts, fixed identity. */
export const gitEnv = (home: string, extra: GitEnv = {}): GitEnv => ({
	HOME: home,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
	GIT_AUTHOR_NAME: "Tartan Smoke",
	GIT_AUTHOR_EMAIL: "smoke@example.invalid",
	GIT_COMMITTER_NAME: "Tartan Smoke",
	GIT_COMMITTER_EMAIL: "smoke@example.invalid",
	PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
	...extra,
});

export const git = async (
	args: readonly string[],
	options: {
		readonly cwd?: string;
		readonly env: GitEnv;
		readonly auth?: GitAuth;
		readonly stdin?: string;
	},
): Promise<GitRun> => {
	const t0 = performance.now();
	const child = new Deno.Command("git", {
		args: [...authConfig(options.auth), ...args],
		cwd: options.cwd,
		env: options.env,
		clearEnv: true,
		stdin: options.stdin === undefined ? "null" : "piped",
		stdout: "piped",
		stderr: "piped",
	}).spawn();
	if (options.stdin !== undefined) {
		const w = child.stdin.getWriter();
		await w.write(new TextEncoder().encode(options.stdin));
		await w.close();
	}
	const out = await child.output();
	return {
		code: out.code,
		ms: Math.round(performance.now() - t0),
		stdout: new TextDecoder().decode(out.stdout).trim(),
		stderr: new TextDecoder().decode(out.stderr).trim(),
	};
};

/** Like `git` but throws on a non-zero exit. */
export const gitOk = async (
	args: readonly string[],
	options: Parameters<typeof git>[1],
): Promise<string> => {
	const r = await git(args, options);
	if (r.code !== 0) {
		throw new Error(`git ${args[0]} failed (${r.code}): ${r.stderr}`);
	}
	return r.stdout;
};

/** A fresh repo with a few files and one commit on `main`. */
export const seedWorkdir = async (
	dir: string,
	env: GitEnv,
	tag: string,
): Promise<string> => {
	await Deno.mkdir(`${dir}/src`, { recursive: true });
	await Deno.mkdir(`${dir}/docs`, { recursive: true });
	await Deno.writeTextFile(`${dir}/README.md`, `# tartan smoke ${tag}\n`);
	await Deno.writeTextFile(`${dir}/src/hello.txt`, "hello from tartan\n");
	await Deno.writeTextFile(`${dir}/docs/a.md`, "doc\n");
	await gitOk(["init", "-q", "-b", "main", dir], { env });
	await gitOk(["add", "-A"], { cwd: dir, env });
	await gitOk(["commit", "-qm", `initial commit (${tag})`], { cwd: dir, env });
	return await gitOk(["rev-parse", "HEAD"], { cwd: dir, env });
};

/** Random, incompressible bytes for size tests. */
export const randomFile = async (
	path: string,
	bytes: number,
): Promise<void> => {
	const file = await Deno.open(path, {
		write: true,
		create: true,
		truncate: true,
	});
	try {
		const chunk = new Uint8Array(65536);
		for (let left = bytes; left > 0; left -= chunk.length) {
			crypto.getRandomValues(chunk);
			await file.write(chunk.subarray(0, Math.min(left, chunk.length)));
		}
	} finally {
		file.close();
	}
};
