// Publishes a checked snapshot of a ref (default `main`) to the public
// repository.
//
// The private history (`main` and the work branches) is never pushed. Each run
// builds the ref's tree without the unpublished paths (the private term list
// names them), checks every file of that tree with the private term list
// (required: a missing list is an error), and commits it on the local `public`
// branch under a public identity with a noreply address (`--identity`, else
// `TARTAN_PUBLISH_IDENTITY`, else `git config tartan.publishIdentity`; none is
// an error, so the local git identity never reaches the public history). The
// message is neutral; the private source commit is recorded only in the local
// reflog of `public`. Each snapshot is parented on the remote's `main`, so a
// run replaces any snapshot that was not pushed: the next push sends one
// commit, never the trees of earlier runs as history. With `--push` it then
// pushes `public` to `<remote> main`, never forced: a remote `main` that the
// local `public` does not contain stops the push, and so does any commit to
// send whose tree has no recorded leak review (`REVIEWED_DIR`; exit code 2).
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
	unpublishedPaths,
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

/** A commit and its tree. */
export type Snapshot = { readonly commit: string; readonly tree: string };

/**
 * What a run does with the snapshot `tree` of the ref:
 * - `current`: `public` already is the one snapshot of `tree` on `base`;
 * - `reset`: `base` already carries `tree`, so `public` moves back to it and
 *   the unpushed snapshots are dropped;
 * - `commit`: a new snapshot of `tree` on `base` replaces the unpushed ones.
 */
export type SnapshotPlan = "current" | "reset" | "commit";

export const planSnapshot = (state: {
	/** The remote's `main`, else the local tip (no remote, nothing pushed). */
	readonly base: Snapshot | null;
	/** The local `public` branch. */
	readonly tip: Snapshot | null;
	/** How many commits `base..tip` holds. */
	readonly pending: number;
	readonly tree: string;
}): SnapshotPlan => {
	const { base, tip, pending, tree } = state;
	if (base !== null && base.tree === tree) {
		return tip?.commit === base.commit ? "current" : "reset";
	}
	return tip !== null && tip.tree === tree && pending === 1
		? "current"
		: "commit";
};

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
const publicTree = async (
	source: string,
	unpublished: readonly string[],
): Promise<string> => {
	const dir = await Deno.makeTempDir({ prefix: "tartan-publish-" });
	const env = { GIT_INDEX_FILE: `${dir}/index` };
	try {
		await must(["read-tree", source], { env });
		// `git rm` with no pathspec is an error, not a no-op.
		if (unpublished.length > 0) {
			await must([
				"rm",
				"-r",
				"--cached",
				"--quiet",
				"--ignore-unmatch",
				"--",
				...unpublished,
			], { env });
		}
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
	let remoteMain: string | null = null;
	const hasRemote = (await git(["remote", "get-url", args.remote])).code === 0;
	if (hasRemote) {
		const fetched = await git(["fetch", "--quiet", args.remote, "main"]);
		remoteMain = fetched.code === 0
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

	const unpublished = unpublishedPaths(policy);
	const tree = await publicTree(source, unpublished);
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

	const snapshotOf = async (commit: string | null) =>
		commit === null
			? null
			: { commit, tree: await must(["rev-parse", `${commit}^{tree}`]) };
	// Without a remote `main` nothing is pushed yet: build on the local tip.
	const base = await snapshotOf(remoteMain ?? tip);
	const pending = base === null || tip === null ? 0 : Number(
		await must(["rev-list", "--count", `${base.commit}..${tip}`]),
	);
	const plan = planSnapshot({
		base,
		tip: await snapshotOf(tip),
		pending,
		tree,
	});
	if (plan === "current") {
		console.log(`publish: the public tree already matches ${args.ref}`);
	} else if (plan === "reset" && base !== null) {
		await must([
			"update-ref",
			"-m",
			`publish: ${args.ref} ${source}`,
			PUBLIC_BRANCH,
			base.commit,
			tip ?? "",
		]);
		console.log(
			`publish: ${args.remote} main already matches ${args.ref}; dropped ${pending} unpushed snapshot(s)`,
		);
		tip = base.commit;
	} else {
		const commit = await must(
			[
				"commit-tree",
				tree,
				...(base === null ? [] : ["-p", base.commit]),
				"-F",
				"-",
			],
			{ stdin: snapshotMessage(base === null), env: identityEnv(identity) },
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
			} without ${unpublished.length} unpublished path(s)${
				pending > 0 ? `, replacing ${pending} unpushed snapshot(s)` : ""
			}`,
		);
		tip = commit;
	}

	if (!args.push) return 0;
	if (tip === null) return 0;
	// Every commit the push sends is published with its tree, so each tree
	// needs a review; the marker is named after the tree.
	const range = remoteMain === null ? [tip] : [`${remoteMain}..${tip}`];
	const toSend = (await must(["log", "--format=%H %T", ...range]))
		.split("\n").filter(Boolean).map((line) => {
			const [commit, tree] = line.split(" ");
			return { commit, tree };
		});
	if (toSend.length === 0) {
		console.log(`publish: ${args.remote} main is already ${tip.slice(0, 12)}`);
		return 0;
	}
	const checkout = await mainCheckout();
	const unreviewed = [];
	for (const snapshot of toSend) {
		if (!(await exists(`${checkout}/${REVIEWED_DIR}/${snapshot.tree}`))) {
			unreviewed.push(snapshot);
		}
	}
	if (unreviewed.length > 0) {
		for (const snapshot of unreviewed) {
			console.error(
				`publish: snapshot ${snapshot.commit.slice(0, 12)} (tree ${
					snapshot.tree.slice(0, 12)
				}) has no leak review (${REVIEWED_DIR}/<tree>)`,
			);
		}
		console.error(
			`publish: ${toSend.length} commit(s) to send, ${unreviewed.length} unreviewed; committed locally, not pushed. Review: git diff ${
				remoteMain ? remoteMain.slice(0, 12) : "--root"
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
