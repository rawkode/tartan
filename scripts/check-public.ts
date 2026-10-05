// The public-content check (AGENTS.md rule 8).
//
// Fails on terms that belong only in the private design notes. The terms are
// private themselves, so no tracked file names them: they live in the main
// checkout's `.private/public-terms.json` (gitignored), found through git's
// common directory, so every worktree of the checkout reads the same list.
// The same file lists the unpublished paths, each with a reason: no snapshot
// carries them (`scripts/publish.ts`).
// Without that file (any clone of the public repository) the check has nothing
// to look for, says so and passes; `--require` makes a missing list an error.
// Matching is case-insensitive.
//
// Modes:
//   (default)  every publishable file of the working tree (git's tracked and
//              untracked, non-ignored files) plus the generated contract JSON,
//              except the unpublished paths.
//   --history  every commit of the public lineage: `origin/main` and the
//              local `public` branch that `scripts/publish.ts` writes. The
//              commits not on `origin/main` yet (what the next push sends)
//              get the full policy, snapshot rules included; the commits on
//              `origin/main` get the policy without them. No path is excepted
//              there, messages are scanned too, and every author and
//              committer email must be a noreply address. The private history
//              (`main` and the work branches) is never published, so it is not
//              scanned.
//
// Usage: deno run -A scripts/check-public.ts [--history] [--require]

/**
 * A pattern for new content: the working tree, every new snapshot
 * (`scripts/publish.ts`) and, under `--history`, every commit the next push
 * sends.
 */
export type SnapshotRule = {
	/** A regular expression source, like the scoped patterns. */
	readonly pattern: string;
	/** Path prefixes it applies under; `""` is every file. */
	readonly paths: readonly string[];
	/** Path prefixes left out, even under `paths`. */
	readonly except: readonly string[];
};

/** The private term list: plain terms, per-prefix patterns, allowed words. */
export type TermPolicy = {
	/** Terms no public file may contain. */
	readonly terms: readonly string[];
	/**
	 * Stricter patterns per path prefix: regular expression sources that both
	 * POSIX ERE (`git grep -E` finds the candidates) and JavaScript accept.
	 */
	readonly scoped: Readonly<Record<string, readonly string[]>>;
	/** Patterns that new content may not add (`SnapshotRule`). */
	readonly snapshot: readonly SnapshotRule[];
	/** Unrelated words that contain a term (regular expression sources). */
	readonly allowed: readonly string[];
	/**
	 * Paths (a trailing `/` covers a directory) that no snapshot carries and the
	 * working-tree check skips, each with its reason.
	 */
	readonly unpublished: Readonly<Record<string, string>>;
};

/**
 * The policy `--history` applies to the commits on `origin/main`: no snapshot
 * rules.
 */
export const historyPolicy = (policy: TermPolicy): TermPolicy => ({
	...policy,
	snapshot: [],
});

/**
 * The only emails a published commit may carry (author and committer): a
 * GitHub noreply address or a `noreply@` one, never a personal address.
 */
export const isPublicEmail = (email: string): boolean =>
	/^[^\s@<>]+@users\.noreply\.github\.com$/i.test(email) ||
	/^noreply@[^\s@<>]+$/i.test(email);

/** Where the private term list lives, relative to the main checkout. */
export const TERMS_FILE = ".private/public-terms.json";

/** The unpublished entry (its path) that covers `file`, if any. */
export const unpublishedEntry = (
	policy: TermPolicy,
	file: string,
): string | undefined =>
	Object.hasOwn(policy.unpublished, file)
		? file
		: Object.keys(policy.unpublished).find((path) =>
			path.endsWith("/") && file.startsWith(path)
		);

/** The paths no snapshot carries, sorted. */
export const unpublishedPaths = (policy: TermPolicy): string[] =>
	Object.keys(policy.unpublished).sort();

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
	const { terms, scoped = {}, snapshot = [], allowed = [], unpublished } =
		json as Record<string, unknown>;
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
	const rules = parseSnapshot(snapshot);
	const paths = parseUnpublished(unpublished);
	// Every pattern must compile now, not on the first matching line.
	for (
		const source of [
			...scopedEntries.flatMap(([, l]) => l as string[]),
			...rules.map((rule) => rule.pattern),
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
		snapshot: rules,
		allowed: [...allowed],
		unpublished: paths,
	};
};

/** Every entry a non-empty path to a non-empty reason; required, may be empty. */
const parseUnpublished = (json: unknown): Record<string, string> => {
	const shape = `${TERMS_FILE}: "unpublished" must map paths to reasons`;
	if (typeof json !== "object" || json === null || Array.isArray(json)) {
		throw new Error(shape);
	}
	const entries = Object.entries(json as Record<string, unknown>);
	if (
		!entries.every(([path, reason]) =>
			path.length > 0 && !path.startsWith("/") &&
			typeof reason === "string" && reason.length > 0
		)
	) {
		throw new Error(shape);
	}
	return Object.fromEntries(entries) as Record<string, string>;
};

const parseSnapshot = (json: unknown): SnapshotRule[] => {
	const shape = `${TERMS_FILE}: "snapshot" must be a list of ` +
		`{pattern, paths, except?}`;
	if (!Array.isArray(json)) throw new Error(shape);
	return json.map((item: unknown) => {
		if (typeof item !== "object" || item === null) throw new Error(shape);
		const { pattern, paths, except = [] } = item as Record<string, unknown>;
		if (
			typeof pattern !== "string" || pattern.length === 0 ||
			!isStringList(paths) || paths.length === 0 || !isStringList(except)
		) {
			throw new Error(shape);
		}
		return { pattern, paths: [...paths], except: [...except] };
	});
};

/** Whether `rule` applies to `file`. */
const snapshotApplies = (rule: SnapshotRule, file: string): boolean =>
	rule.paths.some((prefix) => file.startsWith(prefix)) &&
	!rule.except.some((prefix) => file.startsWith(prefix));

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
	const snapshot = policy.snapshot.map((rule, index) => ({
		rule,
		term: `snapshot#${index + 1}`,
		re: new RegExp(rule.pattern, "i"),
	}));
	const allowed = policy.allowed.map((source) => new RegExp(source, "gi"));
	const lineTerms = (file: string, raw: string): string[] => {
		const line = allowed.reduce((acc, re) => acc.replace(re, ""), raw);
		const rules = [
			...base,
			...scoped.flatMap((s) => file.startsWith(s.prefix) ? s.rules : []),
			...snapshot.filter((s) => snapshotApplies(s.rule, file)),
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
		// Snapshot rules: every path is a candidate; the scanner applies
		// each rule's paths and exceptions.
		if (policy.snapshot.length > 0) {
			const patterns = policy.snapshot.flatMap((rule) => ["-e", rule.pattern]);
			await run(["grep", "-I", "-i", "-n", "-z", "-E", ...patterns, ...batch]);
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

/** The local branch `scripts/publish.ts` writes: the next push sends it. */
export const PENDING_REF = "refs/heads/public";
/** The public repository's `main`, as last fetched. */
export const PUSHED_REF = "refs/remotes/origin/main";

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

const verified = async (ref: string): Promise<boolean> =>
	(await git(["rev-parse", "--verify", "--quiet", ref])).code === 0;

const revList = async (args: string[]): Promise<string[]> => {
	const { code, out, err } = await git(["rev-list", ...args]);
	if (code !== 0) throw new Error(`git rev-list failed: ${err.trim()}`);
	return out.split("\n").filter(Boolean);
};

const scanHistory = async (full: TermPolicy): Promise<number> => {
	const hasPending = await verified(PENDING_REF);
	const hasPushed = await verified(PUSHED_REF);
	if (!hasPending && !hasPushed) {
		console.log("check-public --history: nothing published yet");
		return 0;
	}
	// The commits on origin/main, and the ones the next push adds to them.
	const pushed = hasPushed ? await revList([PUSHED_REF]) : [];
	const pending = hasPending
		? await revList([PENDING_REF, ...(hasPushed ? ["--not", PUSHED_REF] : [])])
		: [];
	const revs = [...pushed, ...pending];
	const pushedPolicy = historyPolicy(full);
	const hits = [
		...(await grepRevisions(pushedPolicy, pushed)),
		...(await grepRevisions(full, pending)),
	];
	// Commit messages are published too.
	const scanners = {
		pushed: createScanner(pushedPolicy),
		pending: createScanner(full),
	};
	const pendingSet = new Set(pending);
	const messageHits = [];
	for (const rev of revs) {
		const message = (await git(["log", "-1", "--format=%B", rev])).out;
		const scanner = pendingSet.has(rev) ? scanners.pending : scanners.pushed;
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
	const refs = [
		...(hasPending ? [PENDING_REF] : []),
		...(hasPushed ? [PUSHED_REF] : []),
	].join(", ");
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
			} hit(s) in the public lineage (${refs})`,
		);
		return 1;
	}
	console.log(
		`check-public --history: ${pushed.length} pushed and ${pending.length} pending commit(s) clean (${refs})`,
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
	const skipped = new Set<string>();
	for (const file of files) {
		const entry = unpublishedEntry(policy, file);
		if (entry !== undefined) {
			skipped.add(entry);
			continue;
		}
		const text = await readText(file);
		if (text === null) continue;
		scanned++;
		hits.push(...scanner.scanText(file, text));
	}
	for (const path of [...skipped].sort()) {
		console.warn(
			`check-public: not scanned (never published): ${path} — ${
				policy.unpublished[path]
			}`,
		);
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
