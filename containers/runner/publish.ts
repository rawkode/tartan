// Publishes the runner image for dev/demo stages (the `registry` image
// variant): builds `containers/runner/Dockerfile` from a
// clean checkout of HEAD (never the working tree), pushes it to ttl.sh under
// an unguessable name (`ttl.sh/tartan-runner-<gitsha>-<random 64-bit>:24h`),
// and records the pushed DIGEST reference for `scripts/render-config.ts
// --image registry` in `.wrangler/deploy/runner-image.json` as
// `{"ref": "ttl.sh/…@sha256:<digest>", …}`. A tag reference is never
// recorded: anyone can push any name to ttl.sh, so only a digest pins what
// was built. The image holds no secrets; ttl.sh images expire within 24 h and
// Cloudflare copies the image at deploy time (U43, S7d).
//
// Usage: deno run -A containers/runner/publish.ts [--record <path>] [--dry-run]
// `--dry-run` builds and prints what it would push and record, without
// pushing. Deploy tooling only: runtime code never imports this file.

const TTL_HOST = "ttl.sh";
export const DEFAULT_RECORD = ".wrangler/deploy/runner-image.json";

/** `host/path@sha256:<64 hex>`, and nothing else (no tag, no digest-plus-tag). */
export const DIGEST_REF_RE =
	/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;

export class PublishError extends Error {
	override name = "PublishError";
}

/** Refuses anything but a digest-only reference: a tag can be re-pushed by anyone. */
export const requireDigestRef = (ref: string): string => {
	if (!DIGEST_REF_RE.test(ref)) {
		throw new PublishError(
			`refusing to record ${ref}: only a digest reference (…@sha256:<64 hex>) may be rendered`,
		);
	}
	return ref;
};

/** `ttl.sh/tartan-runner-<sha12>-<16 hex>:24h` (the push name; never recorded). */
export const pushName = (commit: string, random: Uint8Array): string => {
	if (!/^[0-9a-f]{40}$/.test(commit)) throw new PublishError("bad commit");
	if (random.length !== 8) throw new PublishError("need 64 random bits");
	const nonce = [...random].map((b) => b.toString(16).padStart(2, "0")).join(
		"",
	);
	return `${TTL_HOST}/tartan-runner-${commit.slice(0, 12)}-${nonce}:24h`;
};

/** The digest reference of a pushed name: the repository plus the digest. */
export const digestRef = (name: string, digest: string): string => {
	if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
		throw new PublishError(`bad digest ${digest}`);
	}
	const repository = name.replace(/:[^/:]+$/, "");
	return requireDigestRef(`${repository}@${digest}`);
};

export type RunnerImageRecord = {
	readonly ref: string;
	readonly commit: string;
	readonly builtAt: string;
};

export const recordJson = (record: RunnerImageRecord): string =>
	`${
		JSON.stringify(
			{ ...record, ref: requireDigestRef(record.ref) },
			null,
			"\t",
		)
	}\n`;

const run = async (
	cmd: string,
	args: string[],
	options: { cwd?: string; stdin?: Uint8Array } = {},
): Promise<string> => {
	const child = new Deno.Command(cmd, {
		args,
		cwd: options.cwd,
		stdin: options.stdin ? "piped" : "null",
		stdout: "piped",
		stderr: "inherit",
	}).spawn();
	if (options.stdin) {
		const writer = child.stdin.getWriter();
		await writer.write(options.stdin);
		await writer.close();
	}
	const out = await child.output();
	if (!out.success) {
		throw new PublishError(`${cmd} ${args[0]} failed (${out.code})`);
	}
	return new TextDecoder().decode(out.stdout).trim();
};

const main = async (): Promise<void> => {
	const args = [...Deno.args];
	const dryRun = args.includes("--dry-run");
	const at = args.indexOf("--record");
	const recordPath = at === -1 ? DEFAULT_RECORD : args[at + 1];
	const commit = await run("git", ["rev-parse", "HEAD"]);
	const dirty = await run("git", [
		"status",
		"--porcelain",
		"--",
		"containers/runner",
	]);
	if (dirty !== "") {
		throw new PublishError("containers/runner has uncommitted changes");
	}
	const scratch = await Deno.makeTempDir({ prefix: "tartan-runner-" });
	try {
		const archive = new Deno.Command("git", {
			args: ["archive", "--format=tar", commit, "containers/runner"],
			stdout: "piped",
		});
		const tar = await archive.output();
		if (!tar.success) throw new PublishError("git archive failed");
		await run("tar", ["-x", "-C", scratch], { stdin: tar.stdout });
		const name = pushName(commit, crypto.getRandomValues(new Uint8Array(8)));
		await run("docker", [
			"build",
			"--platform",
			"linux/amd64",
			"--pull",
			"-t",
			name,
			`${scratch}/containers/runner`,
		]);
		if (dryRun) {
			console.log(`dry run: built ${name}; not pushed, nothing recorded`);
			return;
		}
		await run("docker", ["push", name]);
		const repoDigest = await run("docker", [
			"image",
			"inspect",
			"--format",
			"{{range .RepoDigests}}{{println .}}{{end}}",
			name,
		]);
		const repository = name.replace(/:[^/:]+$/, "");
		const pushed = repoDigest.split("\n").find((d) =>
			d.startsWith(`${repository}@`)
		);
		if (pushed === undefined) throw new PublishError("no pushed digest");
		const ref = digestRef(name, pushed.slice(repository.length + 1));
		await Deno.mkdir(recordPath.replace(/\/[^/]+$/, ""), { recursive: true });
		await Deno.writeTextFile(
			recordPath,
			recordJson({ ref, commit, builtAt: new Date().toISOString() }),
		);
		console.log(ref);
	} finally {
		await Deno.remove(scratch, { recursive: true });
	}
};

if (import.meta.main) await main();
