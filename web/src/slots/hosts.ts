// Where the SPA renders each catalogue slot: the page
// components that mount a `SlotOutlet` for it. Slots no page renders are
// listed with the reason, never silently missing. `test/slot-hosts.spec.ts`
// checks this table against the components and the manifests; the slot
// conformance workers test renders every hosted contribution through the
// real routes (src/kernel/exthost/api/slot-conformance.workers.test.ts).

import type { SlotId } from "@tartan/contract/slots.ts";

export const SLOT_HOSTS: Readonly<Partial<Record<SlotId, readonly string[]>>> =
	{
		"node.tab": ["views/node/SlotTabView.vue"],
		"node.section": ["views/node/NodeView.vue"],
		"repo.tab": ["views/node/SlotTabView.vue"],
		"repo.sidebar": ["components/RepoFrame.vue"],
		"file.banner": ["views/repo/RepoFileView.vue"],
		"lane.badge": ["views/coord/lanes/LaneDetail.vue"],
		"lane.sidebar": ["views/coord/lanes/LaneDetail.vue"],
		"work.panel": ["views/repo/WorkItemView.vue"],
		"work.sidebar": ["views/repo/WorkItemView.vue"],
		"change.tab": ["views/repo/ChangeView.vue"],
		"change.panel": ["views/repo/ChangeView.vue"],
		"change.sidebar": ["views/repo/ChangeView.vue"],
		"change.gate": ["views/repo/ChangeView.vue"],
		// The HUD page (`/`, `/-/hud?node=<path>`): each node's `hud` and `home` views.
		"hud.metric": ["views/coord/hud/HudNode.vue"],
		"home.section": ["views/coord/hud/HudNode.vue"],
	};

/** Catalogue slots no SPA page renders a document for, and why. */
export const SLOTS_NOT_RENDERED: Readonly<Partial<Record<SlotId, string>>> = {
	"nav.global":
		"static: a nav entry, no document; no forge-level view lists it yet (`/-/api/view` needs a node path)",
	"repo.header.action":
		"static+action: RepoFrame posts it as a header button (`slots/actions.ts`), never rendered",
	"blame.annotation":
		"annotates why-blame ranges, and `/-/api/blame` is M2 (501); WhyBlameView shows the file's why instead",
	"settings.page":
		"rendered by the admin installation page from contributes.settings",
	"agent.context": "markdown for agents (context@1), not a page slot",
};

/**
 * Kernel components a page renders beside its slots: kernel acts and facts,
 * never an extension's contribution, so they are not in the slot catalogue.
 * `test/slot-hosts.spec.ts` checks that each page mounts its component.
 */
export const KERNEL_HOST_COMPONENTS: readonly {
	readonly component: string;
	readonly page: string;
	readonly beside: SlotId;
	readonly why: string;
}[] = [
	{
		component: "views/repoconfig/RepoConfigCard.vue",
		page: "views/repo/ChangeView.vue",
		beside: "change.sidebar",
		why:
			"repository config (K13.3): the policy sign-off is a kernel act by a person, never a provider's decision",
	},
];
