// Seeds FakeArtifacts with the fixture monorepo and with conflict scenarios
// on the `branch` lane backend (lanes as `refs/heads/lanes/<laneId>` in the
// canonical repo, M1). Commits use the fixture clock, so SHAs are stable.

import { laneBranchRef, laneId as toLaneId } from "@tartan/contract";
import type { FakeArtifacts } from "../artifacts/fake.ts";
import { FIXTURE_EPOCH } from "../git/store.ts";
import { MONOREPO_FILES, MONOREPO_TARTAN_FILES } from "./monorepo.ts";
import type { ConflictScenario } from "./scenarios.ts";

/** Fixed lane ids for scenario lanes `a` and `b`. */
export const SCENARIO_LANE_IDS = {
	a: toLaneId("01k6aaaaaaaaaaaaaaaaaaaaaa"),
	b: toLaneId("01k6bbbbbbbbbbbbbbbbbbbbbb"),
} as const;

export type SeededMonorepo = {
	readonly name: string;
	readonly defaultBranch: string;
	readonly head: string;
	readonly token: string;
};

/**
 * Creates `name` holding the fixture monorepo on its default branch
 * (`master` for the master-branch variant); `tartanConfig` adds the demo's
 * root package `tartan` (`MONOREPO_TARTAN_FILES`).
 */
export const seedMonorepo = async (
	fake: FakeArtifacts,
	name: string,
	options: {
		readonly defaultBranch?: string;
		readonly tartanConfig?: boolean;
	} = {},
): Promise<SeededMonorepo> => {
	const defaultBranch = options.defaultBranch ?? "main";
	const seeded = await fake.seed(name, {
		files: options.tartanConfig
			? { ...MONOREPO_FILES, ...MONOREPO_TARTAN_FILES }
			: MONOREPO_FILES,
		defaultBranch,
		message: "acme: initial import",
	});
	return { name, defaultBranch, head: seeded.head!, token: seeded.token };
};

export type SeededScenario = SeededMonorepo & {
	/** Trunk at the lanes' base (after the scenario's `base` script). */
	readonly base: string;
	readonly lanes: {
		readonly a: {
			readonly laneId: string;
			readonly ref: string;
			readonly head: string;
		};
		readonly b: {
			readonly laneId: string;
			readonly ref: string;
			readonly head: string;
		};
	};
};

/** Seeds the fixture, applies the scenario's base, and pushes both lanes as branch lanes. */
export const seedScenario = async (
	fake: FakeArtifacts,
	name: string,
	s: ConflictScenario,
	options: { readonly defaultBranch?: string; readonly quiet?: boolean } = {},
): Promise<SeededScenario> => {
	const repo = await seedMonorepo(fake, name, options);
	const trunk = `refs/heads/${repo.defaultBranch}`;
	const base = s.base
		? fake.commit(name, trunk, s.base.changes, {
			message: s.base.message,
			at: FIXTURE_EPOCH + 1,
			quiet: options.quiet,
		})
		: repo.head;
	const lane = (key: "a" | "b", offset: number) => {
		const laneId = SCENARIO_LANE_IDS[key];
		const ref = laneBranchRef(laneId);
		fake.setRef(name, ref, base, { quiet: true });
		const head = fake.commit(name, ref, s.lanes[key].changes, {
			message: s.lanes[key].message,
			at: FIXTURE_EPOCH + offset,
			quiet: options.quiet,
		});
		return { laneId, ref, head };
	};
	return {
		...repo,
		head: base,
		base,
		lanes: { a: lane("a", 10), b: lane("b", 20) },
	};
};
