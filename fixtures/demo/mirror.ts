// The demo mirror (WP20): a local, git-only build of a monorepo as one small
// commit for the demo. From a local clone it writes one commit holding the
// clone's HEAD tree with
//
// - binaries replaced by tiny placeholders of the same extension (paths and
//   builds keep working; images become a 1×1 image),
// - Terraform state (`*.tfstate*` files and directories) dropped,
// - optionally `content/` dropped (`--drop-content`),
//
// and no other history. Only the stock `git` CLI is used (no
// git-filter-repo needed), in a scratch clone the caller names; the source
// clone is never modified.

export type LsTreeEntry = {
	readonly mode: string;
	readonly type: "blob" | "tree" | "commit";
	readonly sha: string;
	/** Bytes (`-` for submodules). */
	readonly size: number | null;
	readonly path: string;
};

export type MirrorPlan = {
	readonly keep: readonly LsTreeEntry[];
	readonly placeholders: readonly {
		readonly path: string;
		readonly ext: string;
	}[];
	readonly dropped: readonly string[];
	readonly keptBytes: number;
	readonly droppedBytes: number;
};

/** Extensions treated as binary (lowercase, without the dot). */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"avif",
	"ico",
	"bmp",
	"tif",
	"tiff",
	"heic",
	"psd",
	"ai",
	"sketch",
	"fig",
	"mp4",
	"mov",
	"webm",
	"mkv",
	"mp3",
	"wav",
	"ogg",
	"flac",
	"woff",
	"woff2",
	"ttf",
	"otf",
	"eot",
	"pdf",
	"zip",
	"gz",
	"tgz",
	"bz2",
	"xz",
	"7z",
	"rar",
	"wasm",
	"jar",
	"bin",
	"exe",
	"dll",
	"so",
	"dylib",
	"pack",
	"idx",
	"sqlite",
	"db",
]);

/** Files larger than this are placeholders whatever their extension. */
export const MAX_KEPT_BYTES = 1024 * 1024;

/** Paths that never enter the mirror: Terraform state, as a file or a directory. */
export const isDroppedPath = (path: string): boolean =>
	path.split("/").some((segment) => /\.tfstate(?:\.|$)/.test(segment));

/** The smallest valid PNG and GIF (1×1). */
const PNG_1X1 = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	),
	(c) => c.charCodeAt(0),
);
const GIF_1X1 = Uint8Array.from(
	atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
	(c) => c.charCodeAt(0),
);

export const placeholderFor = (ext: string): Uint8Array =>
	ext === "png" ? PNG_1X1 : ext === "gif" ? GIF_1X1 : new TextEncoder().encode(
		`Tartan demo mirror placeholder for a .${ext} file.\n`,
	);

const extOf = (path: string): string => {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/** Parses `git ls-tree -r -l -z HEAD` output. */
export const parseLsTree = (out: string): LsTreeEntry[] =>
	out.split("\0").filter((l) => l !== "").map((line) => {
		const tab = line.indexOf("\t");
		const [mode, type, sha, size] = line.slice(0, tab).trim().split(/\s+/);
		return {
			mode: mode!,
			type: type as LsTreeEntry["type"],
			sha: sha!,
			size: size === "-" || size === undefined ? null : Number(size),
			path: line.slice(tab + 1),
		};
	});

export const planMirror = (
	entries: readonly LsTreeEntry[],
	options: { readonly dropContent?: boolean } = {},
): MirrorPlan => {
	const keep: LsTreeEntry[] = [];
	const placeholders: { path: string; ext: string }[] = [];
	const dropped: string[] = [];
	let keptBytes = 0;
	let droppedBytes = 0;
	const drops = options.dropContent ? ["content/"] : [];
	for (const e of entries) {
		const size = e.size ?? 0;
		if (
			e.type !== "blob" || isDroppedPath(e.path) ||
			drops.some((p) => e.path.startsWith(p))
		) {
			dropped.push(e.path);
			droppedBytes += size;
			continue;
		}
		const ext = extOf(e.path);
		if (BINARY_EXTENSIONS.has(ext) || size > MAX_KEPT_BYTES) {
			placeholders.push({ path: e.path, ext: ext || "bin" });
			droppedBytes += size;
			continue;
		}
		keep.push(e);
		keptBytes += size;
	}
	return { keep, placeholders, dropped, keptBytes, droppedBytes };
};

export type GitRun = (
	args: readonly string[],
	options?: { readonly cwd?: string; readonly stdin?: Uint8Array | string },
) => Promise<string>;

/** Runs the stock git CLI (no shell); rejects with git's stderr on failure. */
export const runGit: GitRun = async (args, options = {}) => {
	const command = new Deno.Command("git", {
		args: [...args],
		...(options.cwd ? { cwd: options.cwd } : {}),
		stdin: options.stdin !== undefined ? "piped" : "null",
		stdout: "piped",
		stderr: "piped",
		env: { GIT_TERMINAL_PROMPT: "0" },
	});
	const child = command.spawn();
	if (options.stdin !== undefined) {
		const writer = child.stdin.getWriter();
		await writer.write(
			typeof options.stdin === "string"
				? new TextEncoder().encode(options.stdin)
				: options.stdin,
		);
		await writer.close();
	}
	const out = await child.output();
	const text = new TextDecoder().decode(out.stdout);
	if (!out.success) {
		throw new Error(
			`git ${args[0]} failed: ${new TextDecoder().decode(out.stderr).trim()}`,
		);
	}
	return text;
};

export type MirrorResult = {
	readonly commit: string;
	readonly sourceSha: string;
	readonly files: number;
	readonly placeholders: number;
	readonly dropped: number;
	/** `git count-objects -v` size-pack, in KiB. */
	readonly packKiB: number;
};

/**
 * Builds the mirror in `out` (created; must not exist) from the clone at
 * `from`: `out` ends with a single `main` commit and nothing else.
 */
export const buildMirror = async (input: {
	readonly from: string;
	readonly out: string;
	readonly dropContent?: boolean;
	readonly git?: GitRun;
}): Promise<MirrorResult> => {
	const git = input.git ?? runGit;
	const sourceSha = (await git(["rev-parse", "HEAD"], { cwd: input.from }))
		.trim();
	const plan = planMirror(
		parseLsTree(
			await git(["ls-tree", "-r", "-l", "-z", "HEAD"], { cwd: input.from }),
		),
		{ dropContent: input.dropContent ?? false },
	);
	await git([
		"clone",
		"--quiet",
		"--no-checkout",
		"--single-branch",
		input.from,
		input.out,
	]);
	const cwd = input.out;
	await git(["read-tree", "--empty"], { cwd });
	const lines: string[] = plan.keep.map((e) => `${e.mode} ${e.sha}\t${e.path}`);
	const placeholderShas = new Map<string, string>();
	for (const p of plan.placeholders) {
		let sha = placeholderShas.get(p.ext);
		if (!sha) {
			sha = (await git(["hash-object", "-w", "--stdin"], {
				cwd,
				stdin: placeholderFor(p.ext),
			})).trim();
			placeholderShas.set(p.ext, sha);
		}
		lines.push(`100644 ${sha}\t${p.path}`);
	}
	await git(["update-index", "--index-info"], {
		cwd,
		stdin: `${lines.join("\n")}\n`,
	});
	const tree = (await git(["write-tree"], { cwd })).trim();
	const commit = (await git(
		[
			"-c",
			"user.name=Tartan demo mirror",
			"-c",
			"user.email=mirror@tartan.invalid",
			"commit-tree",
			tree,
			"-m",
			`Demo mirror of rawkode-academy/rawkode-academy at ${sourceSha}\n\nOne commit: binaries are placeholders of the same extension (${plan.placeholders.length}), ${plan.dropped.length} paths dropped.`,
		],
		{ cwd },
	)).trim();
	await git(["update-ref", "refs/heads/main", commit], { cwd });
	await git(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd });
	// Nothing else may keep the source's history alive.
	const refs = (await git(["for-each-ref", "--format=%(refname)"], { cwd }))
		.split("\n").filter((r) => r !== "" && r !== "refs/heads/main");
	for (const ref of refs) await git(["update-ref", "-d", ref], { cwd });
	await git(["remote", "remove", "origin"], { cwd }).catch(() => "");
	await git(["reflog", "expire", "--expire=now", "--all"], { cwd });
	await git(["gc", "--quiet", "--prune=now"], { cwd });
	await git(["reset", "--hard", "--quiet", "main"], { cwd });
	const counts = await git(["count-objects", "-v"], { cwd });
	const packKiB = Number(/size-pack: (\d+)/.exec(counts)?.[1] ?? "0");
	return {
		commit,
		sourceSha,
		files: plan.keep.length + plan.placeholders.length,
		placeholders: plan.placeholders.length,
		dropped: plan.dropped.length,
		packKiB,
	};
};
