// A throwaway git repository for the publishing tests (`check-public.ts`,
// `publish.ts`). Git and the scripts under test run with a cleared environment
// and their own git configuration (no global or system settings, no signing,
// no inherited `GIT_DIR`), so nothing they do reaches the checkout the tests
// run from.

export type RunResult = {
	readonly code: number;
	readonly out: string;
	readonly err: string;
};

export type TempRepo = {
	/** The work tree (branch `main`); `.private/` is excluded from commits. */
	readonly work: string;
	/** A scratch directory beside the work tree, for bare remotes. */
	readonly dir: string;
	/** Runs git in `cwd` (default: the work tree); throws on a non-zero exit. */
	readonly git: (args: readonly string[], cwd?: string) => Promise<string>;
	/** Writes the files (`null` deletes one) and commits them on `main`. */
	readonly commit: (
		files: Readonly<Record<string, string | null>>,
		message: string,
	) => Promise<string>;
	/** Writes `.private/<path>` in the work tree. */
	readonly writePrivate: (path: string, text: string) => Promise<void>;
	/** Runs a Deno script with the work tree as its working directory. */
	readonly script: (
		path: string,
		args: readonly string[],
		env?: Readonly<Record<string, string>>,
	) => Promise<RunResult>;
	readonly remove: () => Promise<void>;
};

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const run = async (
	command: string,
	args: readonly string[],
	cwd: string,
	env: Record<string, string>,
): Promise<RunResult> => {
	const out = await new Deno.Command(command, {
		args: [...args],
		cwd,
		env,
		clearEnv: true,
		stdin: "null",
		stdout: "piped",
		stderr: "piped",
	}).output();
	return { code: out.code, out: decode(out.stdout), err: decode(out.stderr) };
};

const parentDir = (path: string): string =>
	path.slice(0, path.lastIndexOf("/"));

export const createTempRepo = async (): Promise<TempRepo> => {
	const dir = await Deno.realPath(
		await Deno.makeTempDir({ prefix: "tartan-git-repo-" }),
	);
	const work = `${dir}/work`;
	const config = `${dir}/gitconfig`;
	await Deno.writeTextFile(
		config,
		[
			"[user]",
			"\tname = Tartan Test",
			"\temail = noreply@example.org",
			"[commit]",
			"\tgpgsign = false",
			"[init]",
			"\tdefaultBranch = main",
			"",
		].join("\n"),
	);
	const passed = ["PATH", "HOME", "TMPDIR", "DENO_DIR"].flatMap((name) => {
		const value = Deno.env.get(name);
		return value === undefined ? [] : [[name, value] as const];
	});
	const env: Record<string, string> = {
		...Object.fromEntries(passed),
		GIT_CONFIG_GLOBAL: config,
		GIT_CONFIG_NOSYSTEM: "1",
		NO_COLOR: "1",
	};
	const git = async (args: readonly string[], cwd = work): Promise<string> => {
		const result = await run("git", args, cwd, env);
		if (result.code !== 0) {
			throw new Error(`git ${args.join(" ")}: ${result.err.trim()}`);
		}
		return result.out.trim();
	};
	await Deno.mkdir(work);
	await git(["init", "--quiet", "-b", "main", work], dir);
	await Deno.writeTextFile(`${work}/.git/info/exclude`, ".private/\n");

	const commit = async (
		files: Readonly<Record<string, string | null>>,
		message: string,
	): Promise<string> => {
		for (const [path, text] of Object.entries(files)) {
			const file = `${work}/${path}`;
			if (text === null) {
				await Deno.remove(file);
				continue;
			}
			await Deno.mkdir(parentDir(file), { recursive: true });
			await Deno.writeTextFile(file, text);
		}
		await git(["add", "-A"]);
		await git(["commit", "--quiet", "--allow-empty", "-m", message]);
		return await git(["rev-parse", "HEAD"]);
	};
	const writePrivate = async (path: string, text: string): Promise<void> => {
		const file = `${work}/.private/${path}`;
		await Deno.mkdir(parentDir(file), { recursive: true });
		await Deno.writeTextFile(file, text);
	};
	const script = (
		path: string,
		args: readonly string[],
		extra: Readonly<Record<string, string>> = {},
	): Promise<RunResult> =>
		run(
			Deno.execPath(),
			["run", "--no-config", "-A", path, ...args],
			work,
			{ ...env, ...extra },
		);
	const remove = () => Deno.remove(dir, { recursive: true });
	return { work, dir, git, commit, writePrivate, script, remove };
};
