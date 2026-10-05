// The public-content check (AGENTS.md rule 8).
//
// Fails on terms that belong only in the private design notes. The terms are
// private themselves, so no tracked file names them: they live in the main
// checkout's `.private/public-terms.json` (gitignored), found through git's
// common directory, so every worktree of the checkout reads the same list.
// Without that file (any clone of the public repository) the check has nothing
// to look for, says so and passes; `--require` makes a missing list an error.
// Matching is case-insensitive.
//
// Modes:
//   (default)  every publishable file of the working tree (git's tracked and
//              untracked, non-ignored files) plus the generated contract JSON,
//              except the reviewed `ALLOWED_PATHS`.
//   --history  every commit of the published lineage: the local `public`
//              branch that `scripts/publish.ts` writes, and `origin/main`.
//              No path is excepted there, messages are scanned too, and
//              every author and committer email must be a noreply address.
//              The private history (`main` and the work branches) is never
//              published, so it is not scanned.
//
// Usage: deno run -A scripts/check-public.ts [--history] [--require]

/** The private term list: plain terms, per-prefix patterns, allowed words. */
export type TermPolicy = {
	/** Terms no public file may contain. */
	readonly terms: readonly string[];
	/**
	 * Stricter patterns per path prefix: regular expression sources that both
	 * POSIX ERE (`git grep -E` finds the candidates) and JavaScript accept.
	 */
	readonly scoped: Readonly<Record<string, readonly string[]>>;
	/** Unrelated words that contain a term (regular expression sources). */
	readonly allowed: readonly string[];
};

/**
 * The only emails a published commit may carry (author and committer): a
 * GitHub noreply address or a `noreply@` one, never a personal address.
 */
export const isPublicEmail = (email: string): boolean =>
	/^[^\s@<>]+@users\.noreply\.github\.com$/i.test(email) ||
	/^noreply@[^\s@<>]+$/i.test(email);

/** Where the private term list lives, relative to the main checkout. */
export const TERMS_FILE = ".private/public-terms.json";

type AllowedPath = { readonly reason: string; readonly temporary: boolean };

/**
 * Files (or, with a trailing `/`, directories) of the working tree that are
 * not scanned, each reviewed. The `temporary` ones are reported on every run
 * and are never published: `scripts/publish.ts` leaves them out of every
 * snapshot.
 */
export const ALLOWED_PATHS: Readonly<Record<string, AllowedPath>> = {
	"docs/design/ARCHITECTURE.md": {
		reason: "not published; docs/design/README.md is the public summary",
		temporary: true,
	},
	"docs/design/PLAN.md": {
		reason: "not published",
		temporary: true,
	},
	"docs/GOALS.md": {
		reason: "not published",
		temporary: true,
	},
	"docs/STATUS.md": {
		reason: "not published",
		temporary: true,
	},
	"docs/status/": {
		reason: "not published",
		temporary: true,
	},
	"packages/contract/CHANGELOG.md": {
		reason: "not published",
		temporary: true,
	},
};

/** The reviewed entry that covers `file`, if any. */
export const allowedEntry = (file: string): AllowedPath | undefined =>
	ALLOWED_PATHS[file] ??
		Object.entries(ALLOWED_PATHS).find(([path]) =>
			path.endsWith("/") && file.startsWith(path)
		)?.[1];

/** Paths that no snapshot carries until they are rewritten for the public. */
export const UNPUBLISHED_PATHS: readonly string[] = Object.entries(
	ALLOWED_PATHS,
).filter(([, entry]) => entry.temporary).map(([path]) => path).sort();

/** Generated (gitignored) outputs that are published, so scanned too. */
const GENERATED_DIRS = [
	"packages/contract/interfaces",
	"packages/contract/schema",
];

const BINARY =
	/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|wasm|zip|gz|tgz|pdf|mp4|webm)$/i;

/**
 * A hit names the term by its place in the private list (`#3`, or
 * `packages/contract/#1` for a scoped pattern), never by its text, so a
 * pasted check output cannot carry the term into a tracked file.
 */
export type Hit = {
	readonly file: string;
	readonly line: number;
	readonly term: string;
};

const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((item) => typeof item === "string");

/** Validates the private term list; throws on any other shape. */
export const parsePolicy = (json: unknown): TermPolicy => {
	if (typeof json !== "object" || json === null) {
		throw new Error(`${TERMS_FILE}: expected an object`);
	}
	const { terms, scoped = {}, allowed = [] } = json as Record<string, unknown>;
	if (!isStringList(terms) || terms.length === 0) {
		throw new Error(`${TERMS_FILE}: "terms" must be a non-empty string list`);
	}
	if (terms.some((term) => term.length === 0)) {
		throw new Error(`${TERMS_FILE}: "terms" may not hold an empty string`);
	}
	if (typeof scoped !== "object" || scoped === null || Array.isArray(scoped)) {
		throw new Error(`${TERMS_FILE}: "scoped" must map prefixes to lists`);
	}
	const scopedEntries = Object.entries(scoped as Record<string, unknown>);
	if (!scopedEntries.every(([, list]) => isStringList(list))) {
		throw new Error(`${TERMS_FILE}: every "scoped" value must be a list`);
	}
	if (!isStringList(allowed)) {
		throw new Error(`${TERMS_FILE}: "allowed" must be a string list`);
	}
	// Every pattern must compile now, not on the first matching line.
	for (
		const source of [
			...scopedEntries.flatMap(([, l]) => l as string[]),
			...allowed,
		]
	) {
		new RegExp(source, "i");
	}
	return {
		terms: [...terms],
		scoped: Object.fromEntries(
			scopedEntries.map(([prefix, list]) => [prefix, [...(list as string[])]]),
		),
		allowed: [...allowed],
	};
};

const escapeRegExp = (text: string): string =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type Scanner = {
	/** Every term hit in `text`, at most one per term and line. */
	readonly scanText: (file: string, text: string) => Hit[];
	/** The labels of the terms one line of `file` names (allowed words removed first). */
	readonly lineTerms: (file: string, line: string) => string[];
};

export const createScanner = (policy: TermPolicy): Scanner => {
	const base = policy.terms.map((term, index) => ({
		term: `#${index + 1}`,
		re: new RegExp(escapeRegExp(term), "i"),
	}));
	const scoped = Object.entries(policy.scoped).map(([prefix, sources]) => ({
		prefix,
		rules: sources.map((source, index) => ({
			term: `${prefix}#${index + 1}`,
			re: new RegExp(source, "i"),
		})),
	}));
	const allowed = policy.allowed.map((source) => new RegExp(source, "gi"));
	const lineTerms = (file: string, raw: string): string[] => {
		const line = allowed.reduce((acc, re) => acc.replace(re, ""), raw);
		const rules = [
			...base,
			...scoped.flatMap((s) => file.startsWith(s.prefix) ? s.rules : []),
		];
		return rules.filter(({ re }) => re.test(line)).map(({ term }) => term);
	};
	const scanText = (file: string, text: string): Hit[] =>
		text.split("\n").flatMap((raw, index) =>
			lineTerms(file, raw).map((term) => ({ file, line: index + 1, term }))
		);
	return { scanText, lineTerms };
};

/** One `git grep -z -n` output line: `<rev>:<path>\0<line>\0<text>`. */
export type GrepLine = {
	readonly rev: string;
	readonly file: string;
	readonly line: number;
	readonly text: string;
};

export const parseGitGrep = (output: string): GrepLine[] =>
	output.split("\n").filter(Boolean).flatMap((raw) => {
		const [where, line, ...rest] = raw.split("\0");
		const colon = where.indexOf(":");
		if (colon < 0 || line === undefined) return [];
		return [{
			rev: where.slice(0, colon),
			file: where.slice(colon + 1),
			line: Number(line),
			text: rest.join("\0"),
		}];
	});

/** Hits in grepped lines of published revisions: no path is excepted. */
export const revisionHits = (
	scanner: Scanner,
	lines: readonly GrepLine[],
): (Hit & { readonly rev: string })[] =>
	lines.flatMap(({ rev, file, line, text }) =>
		scanner.lineTerms(file, text).map((term) => ({ rev, file, line, term }))
	);

export const git = async (
	args: string[],
	options: { readonly env?: Record<string, string>; readonly stdin?: string } =
		{},
): Promise<{ code: number; out: string; err: string }> => {
	const child = new Deno.Command("git", {
		args,
		env: options.env,
		stdin: options.stdin === undefined ? "null" : "piped",
		stdout: "piped",
		stderr: "piped",
	}).spawn();
	if (options.stdin !== undefined) {
		const writer = child.stdin.getWriter();
		await writer.write(new TextEncoder().encode(options.stdin));
		await writer.close();
	}
	const out = await child.output();
	return {
		code: out.code,
		out: new TextDecoder().decode(out.stdout),
		err: new TextDecoder().decode(out.stderr),
	};
};

/** The main checkout's directory, shared by every worktree. */
export const mainCheckout = async (): Promise<string> => {
	const { code, out, err } = await git([
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]);
	if (code !== 0) throw new Error(`git rev-parse failed: ${err.trim()}`);
	return out.trim().replace(/\/\.git\/?$/, "");
};

/** The private term list, or null when this checkout has none. */
export const loadPolicy = async (): Promise<TermPolicy | null> => {
	const path = `${await mainCheckout()}/${TERMS_FILE}`;
	try {
		return parsePolicy(JSON.parse(await Deno.readTextFile(path)));
	} catch (e) {
		if (e instanceof Deno.errors.NotFound) return null;
		throw e;
	}
};

/**
 * Every hit in the given revisions (commits or trees), through `git grep`:
 * the plain terms everywhere, the scoped patterns under their prefixes.
 */
export const grepRevisions = async (
	policy: TermPolicy,
	revs: readonly string[],
): Promise<(Hit & { readonly rev: string })[]> => {
	const scanner = createScanner(policy);
	const lines: GrepLine[] = [];
	const run = async (args: string[]): Promise<void> => {
		const { code, out, err } = await git(args);
		// 1 = no match in this batch; anything above is a git error.
		if (code > 1) throw new Error(`git grep failed (${code}): ${err.trim()}`);
		lines.push(...parseGitGrep(out));
	};
	const plain = policy.terms.flatMap((term) => ["-e", term]);
	for (let i = 0; i < revs.length; i += 100) {
		const batch = revs.slice(i, i + 100);
		await run(["grep", "-I", "-i", "-n", "-z", "-F", ...plain, ...batch]);
		for (const [prefix, sources] of Object.entries(policy.scoped)) {
			if (sources.length === 0) continue;
			const patterns = sources.flatMap((source) => ["-e", source]);
			await run([
				"grep",
				"-I",
				"-i",
				"-n",
				"-z",
				"-E",
				...patterns,
				...batch,
				"--",
				prefix,
			]);
		}
	}
	const seen = new Set<string>();
	return revisionHits(scanner, lines).filter((hit) => {
		const key = `${hit.rev}\0${hit.file}\0${hit.line}\0${hit.term}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};

/** The published lineage: the local `public` branch and `origin/main`. */
export const PUBLISHED_REFS = ["refs/heads/public", "refs/remotes/origin/main"];

const listPublishable = async (): Promise<string[]> => {
	const { code, out, err } = await git([
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
	]);
	if (code !== 0) throw new Error(`git ls-files failed: ${err}`);
	return out.split("\0").filter(Boolean);
};

const walk = async (dir: string): Promise<string[]> => {
	const found: string[] = [];
	try {
		for await (const entry of Deno.readDir(dir)) {
			const path = `${dir}/${entry.name}`;
			if (entry.isDirectory) found.push(...(await walk(path)));
			else if (entry.isFile) found.push(path);
		}
	} catch (e) {
		if (!(e instanceof Deno.errors.NotFound)) throw e;
	}
	return found;
};

const readText = async (file: string): Promise<string | null> => {
	try {
		const bytes = await Deno.readFile(file);
		return bytes.subarray(0, 8192).includes(0)
			? null
			: new TextDecoder().decode(bytes);
	} catch (e) {
		// Deleted from the working tree but still in the index.
		if (e instanceof Deno.errors.NotFound) return null;
		throw e;
	}
};

const scanHistory = async (policy: TermPolicy): Promise<number> => {
	const refs: string[] = [];
	for (const ref of PUBLISHED_REFS) {
		const { code } = await git(["rev-parse", "--verify", "--quiet", ref]);
		if (code === 0) refs.push(ref);
	}
	if (refs.length === 0) {
		console.log("check-public --history: nothing published yet");
		return 0;
	}
	const revs = (await git(["rev-list", ...refs])).out.split("\n").filter(
		Boolean,
	);
	const hits = await grepRevisions(policy, revs);
	// Commit messages are published too.
	const scanner = createScanner(policy);
	const messageHits = [];
	for (const rev of revs) {
		const message = (await git(["log", "-1", "--format=%B", rev])).out;
		messageHits.push(
			...scanner.scanText("<message>", message).map((hit) => ({ ...hit, rev })),
		);
	}
	// Identities are published too: noreply addresses only.
	const identityHits: string[] = [];
	for (const rev of revs) {
		const [author = "", committer = ""] =
			(await git(["log", "-1", "--format=%ae%x00%ce", rev])).out.trim()
				.split("\0");
		for (
			const [field, email] of [["author", author], ["committer", committer]]
		) {
			if (!isPublicEmail(email)) {
				identityHits.push(
					`${rev.slice(0, 7)}: the ${field} email is not a noreply address`,
				);
			}
		}
	}
	const all = [...hits, ...messageHits];
	if (all.length > 0 || identityHits.length > 0) {
		for (const hit of all) {
			console.error(
				`${
					hit.rev.slice(0, 7)
				}:${hit.file}:${hit.line}: private term ${hit.term}`,
			);
		}
		for (const line of identityHits) console.error(line);
		console.error(
			`check-public --history: ${
				all.length + identityHits.length
			} hit(s) in the published lineage (${refs.join(", ")})`,
		);
		return 1;
	}
	console.log(
		`check-public --history: ${revs.length} published commit(s) clean (${
			refs.join(", ")
		})`,
	);
	return 0;
};

const scanTree = async (policy: TermPolicy): Promise<number> => {
	const scanner = createScanner(policy);
	const generated = (await Promise.all(GENERATED_DIRS.map(walk))).flat();
	const files = [...new Set([...(await listPublishable()), ...generated])]
		.filter((file) => !BINARY.test(file))
		.sort();
	const hits: Hit[] = [];
	let scanned = 0;
	for (const file of files) {
		if (allowedEntry(file)) continue;
		const text = await readText(file);
		if (text === null) continue;
		scanned++;
		hits.push(...scanner.scanText(file, text));
	}
	for (const [path, { reason, temporary }] of Object.entries(ALLOWED_PATHS)) {
		if (
			temporary && files.some((file) =>
				allowedEntry(file) &&
				(file === path || (path.endsWith("/") && file.startsWith(path)))
			)
		) {
			console.warn(
				`check-public: not scanned (temporary, never published): ${path} — ${reason}`,
			);
		}
	}
	if (hits.length > 0) {
		// The term itself stays private: name the place only.
		for (const hit of hits) {
			console.error(`${hit.file}:${hit.line}: private term ${hit.term}`);
		}
		console.error(
			`check-public: ${hits.length} hit(s); reword neutrally (the list is ${TERMS_FILE})`,
		);
		return 1;
	}
	console.log(`check-public: ${scanned} file(s) clean`);
	return 0;
};

const main = async (): Promise<number> => {
	const policy = await loadPolicy();
	if (policy === null) {
		if (Deno.args.includes("--require")) {
			console.error(`check-public: no private term list (${TERMS_FILE})`);
			return 1;
		}
		console.log(
			`check-public: no private term list (${TERMS_FILE}); nothing to check`,
		);
		return 0;
	}
	return Deno.args.includes("--history")
		? await scanHistory(policy)
		: await scanTree(policy);
};

if (import.meta.main) Deno.exit(await main());
