// `deno task e2e -- evidence <runId>`: copies the latest run's summary into
// the private evidence directory (`.private/e2e/evidence/<runId>/`, never
// committed): `summary.md`, `skipped.md` (what the run did not check, and
// why), `junit.xml` and `failures/*.md`, after a strict leak scan of exactly
// those files. Traces, screenshots, `report.json` and sessions are never
// copied. The launcher records which run the output directory holds in
// `e2e/.e2e/launcher-run.json`; files are written 0600 in 0700 directories.

import * as path from "node:path";
import { type Finding, scanText } from "./leakscan.ts";
import { RUN_ID_RE } from "./provision.ts";
import { SKIPPED_FILE } from "./report.ts";

export const LAUNCHER_RUN_FILE = "launcher-run.json";

export type LauncherRun = {
	readonly runId: string;
	readonly exitCode: number;
	readonly finishedAt: string;
	readonly leaks: number;
	readonly skipped?: number;
};

export type EvidenceFs = {
	readText(file: string): Promise<string | null>;
	list(dir: string): Promise<string[]>;
	write(file: string, text: string): Promise<void>;
};

export const evidenceFiles = async (
	fs: EvidenceFs,
	output: string,
): Promise<string[]> => [
	path.join(output, "summary.md"),
	path.join(output, SKIPPED_FILE),
	path.join(output, "junit.xml"),
	...(await fs.list(path.join(output, "failures"))).filter((f) =>
		f.endsWith(".md")
	),
];

export const copyEvidence = async (
	fs: EvidenceFs,
	input: {
		readonly output: string;
		readonly evidenceRoot: string;
		readonly runId: string;
	},
): Promise<{ copied: number; leaks: readonly Finding[] }> => {
	if (!RUN_ID_RE.test(input.runId)) {
		throw new Error(`not a run id: ${JSON.stringify(input.runId)}`);
	}
	const marker = await fs.readText(path.join(input.output, LAUNCHER_RUN_FILE));
	const last = marker === null ? null : JSON.parse(marker) as LauncherRun;
	if (last?.runId !== input.runId) {
		throw new Error(
			`the output directory holds run ${
				last?.runId ?? "none"
			}, not ${input.runId}`,
		);
	}
	const files: { from: string; text: string }[] = [];
	const leaks: Finding[] = [];
	for (const from of await evidenceFiles(fs, input.output)) {
		const text = await fs.readText(from);
		if (text === null) continue;
		leaks.push(
			...scanText(from, text, "report", { secrets: [], revoked: new Set() })
				.leaks,
		);
		files.push({ from, text });
	}
	if (leaks.length > 0) return { copied: 0, leaks };
	const target = path.join(input.evidenceRoot, input.runId);
	for (const { from, text } of files) {
		await fs.write(path.join(target, path.relative(input.output, from)), text);
	}
	return { copied: files.length, leaks };
};
