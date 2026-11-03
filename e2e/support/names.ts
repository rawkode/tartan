// Where a run's fixtures live (docs/testing/e2e.md, "Data"). The stable
// groups `e2e`, `e2e/swarm` and `e2e/classic` are provisioned once by the
// launcher. The two child groups are named after the extension packs they
// carried before this branch removed the first-party extensions; nothing is
// installed at them now, and the suites use them as two plain groups.
// Everything a run creates is named after its run id, so runs never collide
// and the launcher's teardown and janitor find what is left: repos
// `<group>/<runId>-<suite>`, agents and tokens `e2e-<runId>-<who>`.

export const PACK_GROUP = {
	swarm: "e2e/swarm",
	classic: "e2e/classic",
} as const;
export type Pack = keyof typeof PACK_GROUP;

const SUITE_RE = /^[a-z][a-z0-9-]{0,23}$/;

export const repoSlug = (runId: string, suite: string): string => {
	if (!SUITE_RE.test(suite)) throw new Error(`bad suite name ${suite}`);
	return `${runId}-${suite}`;
};

export const repoPathOf = (pack: Pack, runId: string, suite: string): string =>
	`${PACK_GROUP[pack]}/${repoSlug(runId, suite)}`;

export const agentNameOf = (runId: string, who: string): string =>
	`e2e-${runId}-${who}`;
