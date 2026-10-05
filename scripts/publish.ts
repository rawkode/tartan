// Publishes a checked snapshot of a ref (default `main`) to the public
// repository.
//
// The private history (`main` and the work branches) is never pushed. Each run
// builds the ref's tree without `UNPUBLISHED_PATHS` (check-public's temporary
// exceptions), checks every file of that tree with the private term list
// (required: a missing list is an error), and commits it on the local `public`
// branch under a public identity with a noreply address (`--identity`, else
// `TARTAN_PUBLISH_IDENTITY`, else `git config tartan.publishIdentity`; none is
// an error, so the local git identity never reaches the public history). The
// message is neutral; the private source commit is recorded only in the local
// reflog of `public`. With `--push` it then pushes `public` to `<remote> main`,
// never forced: a remote `main` that the local `public` does not contain stops
// the push, and so does a snapshot tree with no recorded leak review
// (`REVIEWED_DIR`; exit code 2).
//
// Usage: deno run -A scripts/publish.ts [--ref main] [--remote origin]
//   [--identity "Name <user@users.noreply.github.com>"] [--push]

import {
	git,
	grepRevisions,
	isPublicEmail,
	loadPolicy,
	mainCheckout,
	TERMS_FILE,
	UNPUBLISHED_PATHS,
} from "./check-public.ts";

export const PUBLIC_BRANCH = "refs/heads/public";
/**
 * A push needs a leak review of the snapshot: the term check finds listed
 * terms, not meaning. The reviewer records each reviewed snapshot tree as an
 * empty file named after the tree id here (main checkout, gitignored).
 */
export const REVIEWED_DIR = ".private/publish/reviewed";
export const IDENTITY_ENV = "TARTAN_PUBLISH_IDENTITY";
export const IDENTITY_CONFIG = "tartan.publishIdentity";
const ATTRIBUTION = "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>";

export type PublishArgs = {
	readonly ref: string;
	readonly remote: string;
	readonly push: boolean;
	readonly identity: string | null;
};

const VALUE_FLAGS = new Set(["--ref", "--remote", "--identity"]);

export const parsePublishArgs = (args: readonly string[]): PublishArgs => {
	// `deno task publish -- …` forwards the separator.
	if (args[0] === "--") return parsePublishArgs(args.slice(1));
	const value = (flag: string): string | null => {
		const index = args.indexOf(flag);
		if (index < 0) return null;
		const next = args[index + 1];
		if (next === undefined || next.startsWith("--")) {
			throw new Error(`${flag} needs a value`);
		}
		return next;
	};
	args.forEach((arg, index) => {
		const isValue = index > 0 && VALUE_FLAGS.has(args[index - 1]);
		if (!isValue && !VALUE_FLAGS.has(arg) && arg !== "--push") {
			throw new Error(`unknown argument ${arg}`);
		}
	});
	return {
		ref: value("--ref") ?? "main",
		remote: value("--remote") ?? "origin",
		push: args.includes("--push"),
		identity: value("--identity"),
	};
};

export type Identity = { readonly name: string; readonly email: string };

/** `Name <email>` whose email is a noreply address; throws otherwise. */
export const parseIdentity = (text: string): Identity => {
	const match = /^\s*([^<>]*[^<>\s])\s*<([^<>\s]+)>\s*$/.exec(text);
	if (!match) throw new Error('a publish identity is "Name <email>"');
	const [, name, email] = match;
	if (!isPublicEmail(email)) {
		throw new Error(
			"a publish identity needs a noreply address (for example <user>@users.noreply.github.com)",
		);
	}
	return { name, email };
};

/** The git environment that commits as `identity` (author and committer). */
export const identityEnv = (identity: Identity): Record<string, string> => ({
	GIT_AUTHOR_NAME: identity.name,
	GIT_AUTHOR_EMAIL: identity.email,
	GIT_COMMITTER_NAME: identity.name,
	GIT_COMMITTER_EMAIL: identity.email,
});

/** A snapshot's message: neutral, so no private subject is published. */
export const snapshotMessage = (initial: boolean): string =>
	[
		initial ? "Tartan: initial public snapshot" : "Tartan: public snapshot",
		"",
		ATTRIBUTION,
		"",
	].join("\n");

const must = async (
	args: string[],
	options?: Parameters<typeof git>[1],
): Promise<string> => {
	const { code, out, err } = await git(args, options);
	if (code !== 0) {
		throw new Error(`git ${args[0]} failed (${code}): ${err.trim()}`);
	}
	return out.trim();
};

const revParse = async (ref: string): Promise<string | null> => {
	const { code, out } = await git(["rev-parse", "--verify", "--quiet", ref]);
	return code === 0 ? out.trim() : null;
};

const exists = async (path: string): Promise<boolean> => {
	try {
		await Deno.stat(path);
		return true;
	} catch (e) {
		if (e instanceof Deno.errors.NotFound) return false;
		throw e;
	}
};

const isAncestor = async (a: string, b: string): Promise<boolean> =>
	(await git(["merge-base", "--is-ancestor", a, b])).code === 0;

/** The identity from the flag, the environment or the checkout's git config. */
const resolveIdentity = async (
	flag: string | null,
): Promise<Identity | string> => {
	const configured = flag || Deno.env.get(IDENTITY_ENV) ||
		(await git(["config", "--get", IDENTITY_CONFIG])).out.trim();
	if (!configured) {
		return `publish: no public identity; pass --identity "Name <email>", set ${IDENTITY_ENV} or git config ${IDENTITY_CONFIG}`;
	}
	try {
		return parseIdentity(configured);
	} catch (e) {
		return `publish: ${(e as Error).message}`;
	}
};

/** The ref's tree without the unpublished paths, as a tree object id. */
const publicTree = async (source: string): Promise<string> => {
	const dir = await Deno.makeTempDir({ prefix: "tartan-publish-" });
	const env = { GIT_INDEX_FILE: `${dir}/index` };
	try {
		await must(["read-tree", source], { env });
		await must([
			"rm",
			"-r",
			"--cached",
			"--quiet",
			"--ignore-unmatch",
			"--",
			...UNPUBLISHED_PATHS,
		], { env });
		return await must(["write-tree"], { env });
	} finally {
		await Deno.remove(dir, { recursive: true });
	}
};

const main = async (): Promise<number> => {
	const args = parsePublishArgs(Deno.args);
	const policy = await loadPolicy();
	if (policy === null) {
		console.error(`publish: no private term list (${TERMS_FILE})`);
		return 1;
	}
	const identity = await resolveIdentity(args.identity);
	if (typeof identity === "string") {
		console.error(identity);
		return 1;
	}
	const source = await revParse(`${args.ref}^{commit}`);
	if (source === null) throw new Error(`publish: no commit ${args.ref}`);

	// Adopt or check the remote's main first, so a push never forces.
	let tip = await revParse(PUBLIC_BRANCH);
	const hasRemote = (await git(["remote", "get-url", args.remote])).code === 0;
	if (hasRemote) {
		const fetched = await git(["fetch", "--quiet", args.remote, "main"]);
		const remoteMain = fetched.code === 0
			? await revParse(`refs/remotes/${args.remote}/main`)
			: null;
		if (remoteMain !== null) {
			if (tip === null) {
				await must(["update-ref", PUBLIC_BRANCH, remoteMain]);
				tip = remoteMain;
			} else if (!(await isAncestor(remoteMain, tip))) {
				console.error(
					`publish: ${args.remote}/main has commits the local public branch lacks; reconcile by hand`,
				);
				return 1;
			}
		}
	} else if (args.push) {
		console.error(`publish: no remote ${args.remote}`);
		return 1;
	}

	const tree = await publicTree(source);
	const hits = await grepRevisions(policy, [tree]);
	if (hits.length > 0) {
		for (const hit of hits) {
			console.error(`${hit.file}:${hit.line}: private term ${hit.term}`);
		}
		console.error(
			`publish: ${hits.length} hit(s) in the snapshot of ${args.ref}; nothing committed`,
		);
		return 1;
	}

	const tipTree = tip === null
		? null
		: await must(["rev-parse", `${tip}^{tree}`]);
	if (tipTree === tree) {
		console.log(`publish: the public tree already matches ${args.ref}`);
	} else {
		const commit = await must(
			["commit-tree", tree, ...(tip === null ? [] : ["-p", tip]), "-F", "-"],
			{ stdin: snapshotMessage(tip === null), env: identityEnv(identity) },
		);
		// The source commit stays local: only this reflog entry names it.
		await must([
			"update-ref",
			"-m",
			`publish: ${args.ref} ${source}`,
			PUBLIC_BRANCH,
			commit,
			tip ?? "",
		]);
		console.log(
			`publish: ${PUBLIC_BRANCH} ${commit.slice(0, 12)} = ${args.ref} ${
				source.slice(0, 12)
			} without ${UNPUBLISHED_PATHS.length} unpublished path(s)`,
		);
		tip = commit;
	}

	if (!args.push) return 0;
	if (tip === null) return 0;
	// The review covers content: the marker is named after the snapshot's tree.
	const tipTreeNow = await must(["rev-parse", `${tip}^{tree}`]);
	const marker = `${await mainCheckout()}/${REVIEWED_DIR}/${tipTreeNow}`;
	if (!(await exists(marker))) {
		const base = (await revParse(`refs/remotes/${args.remote}/main`)) ?? null;
		console.error(
			`publish: snapshot tree ${
				tipTreeNow.slice(0, 12)
			} has no leak review (${REVIEWED_DIR}/<tree>); committed locally, not pushed. Review: git diff ${
				base ? base.slice(0, 12) : "--root"
			} ${tip.slice(0, 12)}`,
		);
		return 2;
	}
	await must([
		"push",
		"--quiet",
		args.remote,
		`${PUBLIC_BRANCH}:refs/heads/main`,
	]);
	console.log(`publish: pushed ${tip.slice(0, 12)} to ${args.remote} main`);
	return 0;
};

if (import.meta.main) Deno.exit(await main());
