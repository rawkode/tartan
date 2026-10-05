// The drift guard: the suites derive tab tests, pack versions, slot ids and
// names from this checkout's manifests and contract, so a run against a forge
// deployed from other code gives misleading failures. Before a run the
// launcher compares the commit the deploy record names with this checkout's
// working tree under the paths that shape the forge and the suites' tables;
// any difference stops the run (exit 2) unless `--allow-drift` is given, and
// then it is printed as a warning.

import type { Run } from "../preflight.ts";
import { GuardError } from "./guards.ts";

/** What the deployed forge and the suites' derived tables are built from. */
export const DRIFT_PATHS: readonly string[] = [
	"extensions",
	"packages/contract/src",
	"src",
	"web/src",
	"wrangler.jsonc",
];

export type Drift = {
	/** The deployed commit, or null when the record names none. */
	readonly commit: string | null;
	/** Paths under `DRIFT_PATHS` that differ (working tree vs the commit). */
	readonly paths: readonly string[];
};

/** The difference between the deployed commit and this checkout. */
export const driftOf = async (
	deps: { readonly run: Run; readonly root: string },
	commit: string | null,
): Promise<Drift> => {
	if (commit === null) {
		return { commit, paths: ["(the deploy record names no commit)"] };
	}
	const diff = await deps.run(
		"git",
		["diff", "--name-only", commit, "--", ...DRIFT_PATHS],
		{ cwd: deps.root },
	).catch(() => null);
	if (diff === null || diff.code !== 0) {
		return {
			commit,
			paths: [`(commit ${commit.slice(0, 12)} is not in this checkout)`],
		};
	}
	return {
		commit,
		paths: diff.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== ""),
	};
};

const MAX_LISTED = 8;

/** One line describing a drift (at most `MAX_LISTED` paths). */
export const driftLine = (drift: Drift): string => {
	const listed = drift.paths.slice(0, MAX_LISTED).join(", ");
	const more = drift.paths.length > MAX_LISTED
		? ` and ${drift.paths.length - MAX_LISTED} more`
		: "";
	return `the dev-e2e forge was deployed from ${
		drift.commit?.slice(0, 12) ?? "an unknown commit"
	}, which differs from this checkout: ${listed}${more}`;
};

/** Throws unless the forge runs this checkout's code (or `allow` is set). */
export const assertNoDrift = (
	drift: Drift,
	options: { readonly allow: boolean; readonly log: (line: string) => void },
): void => {
	if (drift.paths.length === 0) return;
	const line = driftLine(drift);
	if (options.allow) {
		options.log(`warning: ${line} (--allow-drift)`);
		return;
	}
	throw new GuardError(
		`${line}. Run \`deno task e2e -- stage up\` to redeploy, or pass --allow-drift`,
	);
};
