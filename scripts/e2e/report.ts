// After a run: what was skipped and why, and the output directory's modes.
//
// - `skippedOf` reads e2e's `report.json` (`report-1`) and lists every
//   skipped test with its cause and reason (a pending feature, a stage
//   without containers, a failed serial predecessor, an excluded tag). The
//   launcher prints them grouped by reason and writes `skipped.md` next to
//   `summary.md`, so a run's summary always says what it did not check.
// - `tightenOutput` makes `e2e/.e2e/` private: directories 0700, files 0600
//   (e2e writes them 0755/0644; traces hold ended session cookies, reports
//   hold run names).

import * as path from "node:path";

export type SkippedTest = {
	readonly file: string;
	readonly title: string;
	/** e2e's skip cause: `explicit`, `filtered`, `serial-predecessor-failed`, … */
	readonly cause: string;
	readonly reason: string;
};

type ReportResult = {
	readonly status?: unknown;
	readonly file?: unknown;
	readonly titlePath?: unknown;
	readonly skip?: { readonly cause?: unknown; readonly reason?: unknown };
};

const oneLine = (value: unknown, max = 300): string =>
	typeof value === "string"
		? value.replace(/\s+/g, " ").trim().slice(0, max)
		: "";

/** Every skipped test of a `report.json`, in report order; [] for anything else. */
export const skippedOf = (report: unknown): SkippedTest[] => {
	const results = (report as { run?: { results?: unknown } } | null)?.run
		?.results;
	if (!Array.isArray(results)) return [];
	return (results as ReportResult[])
		.filter((r) => r.status === "skipped")
		.map((r) => ({
			file: oneLine(r.file),
			title: Array.isArray(r.titlePath)
				? r.titlePath.map((t) => oneLine(t)).join(" › ")
				: "",
			cause: oneLine(r.skip?.cause) || "unknown",
			reason: oneLine(r.skip?.reason) || "(no reason given)",
		}));
};

/** Skipped tests grouped by reason, largest group first, then by reason. */
export const groupSkipped = (
	skipped: readonly SkippedTest[],
): { reason: string; cause: string; tests: SkippedTest[] }[] => {
	const groups = new Map<
		string,
		{ reason: string; cause: string; tests: SkippedTest[] }
	>();
	for (const s of skipped) {
		const key = `${s.cause}\u0000${s.reason}`;
		const group = groups.get(key) ??
			{ reason: s.reason, cause: s.cause, tests: [] };
		group.tests.push(s);
		groups.set(key, group);
	}
	return [...groups.values()].sort((a, b) =>
		b.tests.length - a.tests.length || a.reason.localeCompare(b.reason)
	);
};

/** Terminal lines: one per reason, with the count and the cause. */
export const skippedLines = (skipped: readonly SkippedTest[]): string[] =>
	skipped.length === 0 ? ["skipped: none"] : [
		`skipped: ${skipped.length} test(s)`,
		...groupSkipped(skipped).map((g) =>
			`  ${g.tests.length} × ${g.reason} [${g.cause}]`
		),
	];

const cell = (text: string): string => text.replace(/\|/g, "\\|");

/** `skipped.md`: the reasons, then every skipped test under its reason. */
export const skippedMarkdown = (
	runId: string,
	skipped: readonly SkippedTest[],
): string => {
	const lines = [`### Skipped in ${runId}: ${skipped.length}`, ""];
	if (skipped.length === 0) {
		lines.push("Nothing was skipped.", "");
		return lines.join("\n");
	}
	for (const g of groupSkipped(skipped)) {
		lines.push(`**${cell(g.reason)}** (${g.cause}, ${g.tests.length})`, "");
		for (const t of g.tests) lines.push(`- \`${t.file}\` ${cell(t.title)}`);
		lines.push("");
	}
	return lines.join("\n");
};

export const SKIPPED_FILE = "skipped.md";

/** Directories 0700 and files 0600 under `dir` (and `dir` itself); missing is fine. */
export const tightenOutput = async (dir: string): Promise<number> => {
	let changed = 0;
	const visit = async (at: string, isDir: boolean): Promise<void> => {
		const info = await Deno.lstat(at);
		if (info.isSymlink) return;
		const want = isDir ? 0o700 : 0o600;
		if (((info.mode ?? 0) & 0o777) !== want) {
			await Deno.chmod(at, want);
			changed++;
		}
		if (!isDir) return;
		for await (const entry of Deno.readDir(at)) {
			if (entry.isSymlink) continue;
			await visit(path.join(at, entry.name), entry.isDirectory);
		}
	};
	try {
		await visit(dir, true);
	} catch (error) {
		if (!(error instanceof Deno.errors.NotFound)) throw error;
	}
	return changed;
};
