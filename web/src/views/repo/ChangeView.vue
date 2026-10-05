<script setup lang="ts">
// Change page: a slot host. `change.gate` results on top, the
// `change.tab` tabs (static contributions; the selected one renders its
// dynamic page), `change.panel` sections and the `change.sidebar`. Every
// section is an extension's server-driven UI (the first-party ones: work,
// changes, radar, ci, review and weave); this page only arranges them, and
// each slot refreshes from `/-/live` on its own `refreshOn` patterns. The
// sidebar also holds one kernel component, the repository-config card
// (K13.3; `slots/hosts.ts` KERNEL_HOST_COMPONENTS), shown to members when
// the change touches a root `.cue` file.
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import AsyncState from "../../components/AsyncState.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import { changeHref, nodeHref, stringParam } from "../../router/params.ts";
import { provideSlotRegistry } from "../../slots/registry.ts";
import { entityCtx } from "../../slots/ctx.ts";
import SlotOutlet from "../../slots/SlotOutlet.vue";
import RepoConfigCard from "../repoconfig/RepoConfigCard.vue";
import { useNodeView } from "./useNodeView.ts";

provideSlotRegistry();
const route = useRoute();
const changeId = computed(() => stringParam(route.params, "changeId"));
const tabParam = computed(() => stringParam(route.params, "tab"));
// One hint for the page: the change and the selected tab's route. Each slot
// takes its part (`narrowCtx`): only `change.tab` keeps the route.
const node = useNodeView(
	() => `changes/${changeId.value}${tabParam.value ? `/${tabParam.value}` : ""}`,
	(path) =>
		entityCtx(path, "change", changeId.value, {
			route: activeTab.value ? (activeTab.value.route ?? activeTab.value.id) : undefined,
		}),
);

const tabs = computed(() =>
	(node.data.value?.static.tabs ?? [])
		.filter((t) => t.slot === "change.tab")
		.slice()
		.sort((a, b) => a.order - b.order)
);
const activeTab = computed(() =>
	tabs.value.find((t) => (t.route ?? t.id) === tabParam.value || t.id === tabParam.value) ??
		tabs.value[0] ?? null
);
const repoPath = computed(() => node.data.value?.node.path ?? node.nodePath.value);
/** Repository config is visible to members (Reporter+); the kernel re-checks. */
const configCard = computed(() =>
	node.repoId.value !== undefined && (node.data.value?.viewer.role ?? 0) >= 20
);
</script>

<template>
	<AsyncState
		:loading="node.loading.value"
		:error="node.error.value"
		:status="node.status.value"
		:ready="node.data.value !== null"
		what="this change"
		@retry="node.reload"
	>
		<RepoFrame v-if="node.data.value" :view="node.data.value" :ctx="node.ctx.value" active="changes" wide>
			<div class="change">
				<div class="change__head">
					<p class="change__id">Change <code>{{ changeId }}</code></p>
					<RouterLink class="tt-button tt-button--sm" :to="`${nodeHref(repoPath)}/-/lanes`">Lanes</RouterLink>
					<SlotOutlet
						:slots="node.data.value.slots"
						slot-id="change.gate"
						:ctx="node.ctx.value"
						:repo-id="node.repoId.value"
					/>
				</div>
				<div class="change__layout">
					<div class="change__main">
						<nav v-if="tabs.length > 0" class="change__tabs tt-scroll-x" aria-label="Change">
							<RouterLink
								v-for="tab in tabs"
								:key="tab.id"
								:to="changeHref(repoPath, changeId, tab.route ?? tab.id)"
								class="change__tab"
								:aria-current="activeTab?.id === tab.id ? 'page' : undefined"
							>{{ tab.label ?? tab.id }}</RouterLink>
						</nav>
						<SlotOutlet
							v-if="activeTab"
							:key="activeTab.id"
							:slots="node.data.value.slots"
							slot-id="change.tab"
							:only="activeTab.id"
							:ctx="node.ctx.value"
							:repo-id="node.repoId.value"
						>
							<template #empty>
								<p class="tt-muted">{{ activeTab.label ?? activeTab.id }} has nothing to show here.</p>
							</template>
						</SlotOutlet>
						<SlotOutlet
							:slots="node.data.value.slots"
							slot-id="change.panel"
							:ctx="node.ctx.value"
							:repo-id="node.repoId.value"
						>
							<template #empty>
								<p v-if="tabs.length === 0" class="tt-muted">No extension shows this change here yet.</p>
							</template>
						</SlotOutlet>
					</div>
					<aside class="change__side" aria-label="Change sidebar">
						<RepoConfigCard
							v-if="configCard && node.repoId.value"
							:key="`${node.repoId.value}/${changeId}`"
							:repo-id="node.repoId.value"
							:repo-path="repoPath"
							:change-id="changeId"
							:role="node.data.value.viewer.role"
						/>
						<SlotOutlet
							:slots="node.data.value.slots"
							slot-id="change.sidebar"
							:ctx="node.ctx.value"
							:repo-id="node.repoId.value"
						/>
					</aside>
				</div>
			</div>
		</RepoFrame>
	</AsyncState>
</template>

<style scoped>
.change {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-4);
}

.change__head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-3);
}

.change__id {
	margin: 0;
	color: var(--tt-text-muted);
	overflow-wrap: anywhere;
}

.change__layout {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--tt-space-6);
}

@media (min-width: 64rem) {
	.change__layout {
		grid-template-columns: minmax(0, 1fr) 20rem;
	}
}

.change__main,
.change__side {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-4);
	min-width: 0;
}

.change__tabs {
	display: flex;
	gap: var(--tt-space-4);
	border-bottom: 1px solid var(--tt-border);
	white-space: nowrap;
}

.change__tab {
	display: inline-flex;
	align-items: center;
	min-height: 2.75rem;
	color: var(--tt-text-muted);
	text-decoration: none;
}

.change__tab[aria-current="page"] {
	color: var(--tt-text);
	box-shadow: inset 0 -2px 0 var(--tt-accent);
}
</style>
