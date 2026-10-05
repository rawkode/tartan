// Resetting the demo (WP20), so a reset and the seed of one beat take under
// three minutes, through the public API only: every swarm stops; the demo repo,
// the docs repo and the sim group move into `<namespace>/attic` under a stamped
// slug and are archived (a moved node frees its path for the next seed; the
// move leaves a redirect only until a new node claims the path); the seeded
// actors are disabled. The forge has no repo delete yet, so the moved repos'
// Artifacts storage stays until one exists. The groups and their installations
// (HUD, packs) stay and are reused.

import type { DemoFixture } from "./beats.ts";
import type { ForgeClient } from "./client.ts";

export type ResetReport = {
	readonly stoppedSwarms: readonly string[];
	readonly moved: readonly { readonly from: string; readonly to: string }[];
	readonly disabledAgents: readonly string[];
};

export const ATTIC = "attic";

/** `router` → `router-<stamp>`: at most 40 characters, slug grammar. */
export const atticSlug = (slug: string, stamp: string): string =>
	`${slug.slice(0, 40 - stamp.length - 1)}-${stamp}`;

export const resetDemo = async (
	deps: {
		readonly client: ForgeClient;
		readonly log: (line: string) => void;
		readonly now: () => number;
	},
	fixture: DemoFixture,
): Promise<ResetReport> => {
	const { client } = deps;
	const stopped = (await client.stopSwarms()).stopped;
	const stamp = deps.now().toString(36);
	const atticPath = `${fixture.namespace}/${ATTIC}`;
	const moved: { from: string; to: string }[] = [];
	const targets = [
		fixture.repo,
		fixture.docsRepo,
		`${fixture.namespace}/sim`,
	];
	for (const path of targets) {
		const node = await client.resolve(path);
		if (!node || node.archived) continue;
		if (!(await client.resolve(atticPath))) {
			await client.createGroup(
				fixture.namespace,
				ATTIC,
				"Demo state moved aside by a reset (archived)",
			);
		}
		const slug = atticSlug(path.split("/").at(-1)!, stamp);
		await client.move(path, atticPath, slug);
		await client.archive(`${atticPath}/${slug}`);
		moved.push({ from: path, to: `${atticPath}/${slug}` });
	}
	const disabled: string[] = [];
	for (const agent of (await client.agents()).agents) {
		if (agent.disabled || !agent.handle.startsWith("seeded-")) continue;
		await client.disableAgent(agent.id);
		disabled.push(agent.handle);
	}
	deps.log(
		`reset: ${stopped.length} swarms stopped, ${moved.length} nodes moved to ${atticPath}, ${disabled.length} seeded agents disabled`,
	);
	return { stoppedSwarms: stopped, moved, disabledAgents: disabled };
};
