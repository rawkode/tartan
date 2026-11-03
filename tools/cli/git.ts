// Running stock git from `tt`. Every call passes its
// arguments as an argv array (no shell) and never puts a credential in a URL
// or an argument.

export type GitResult = {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
};

export type Git = (
	args: readonly string[],
	options?: {
		readonly stdin?: string;
		readonly cwd?: string;
		/** Hand git the terminal (progress, prompts); stdout and stderr stay empty. */
		readonly inherit?: boolean;
	},
) => Promise<GitResult>;

const decoder = new TextDecoder();

export const createGit = (
	cwd?: string,
	env?: Record<string, string>,
): Git =>
async (args, options = {}) => {
	const io = options.inherit ? "inherit" : "piped";
	const child = new Deno.Command("git", {
		args: [...args],
		cwd: options.cwd ?? cwd,
		...(env ? { env } : {}),
		stdin: options.inherit
			? "inherit"
			: options.stdin === undefined
			? "null"
			: "piped",
		stdout: io,
		stderr: io,
	}).spawn();
	if (options.stdin !== undefined && !options.inherit) {
		const writer = child.stdin.getWriter();
		await writer.write(new TextEncoder().encode(options.stdin));
		await writer.close();
	}
	const out = await child.output();
	if (options.inherit) return { code: out.code, stdout: "", stderr: "" };
	return {
		code: out.code,
		stdout: decoder.decode(out.stdout),
		stderr: decoder.decode(out.stderr),
	};
};

/** `git <args>` that must succeed; its trimmed stdout. */
export const gitOk = async (
	git: Git,
	args: readonly string[],
	options?: { readonly stdin?: string },
): Promise<string> => {
	const result = await git(args, options);
	if (result.code !== 0) {
		throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
};
