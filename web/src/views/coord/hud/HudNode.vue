<script setup lang="ts">
// One node's HUD (WP19, hosting WP20's tartan.hud and any other `hud.metric`
// or `home.section` contributor): the node's `hud` view (metrics, in a grid)
// and its `home` view (sections), both from `GET /-/api/view`. A
// namespace shows what is installed on it (tartan.hud counts every repo
// below); a repository also shows its own repo-scoped contributions (radar's
// conflicts avoided, the Weave's landed per hour, review's attention inbox).
import { computed } from "vue";
import { RouterLink } from "vue-router";
import type { ViewResponse } from "@tartan/contract/api.ts";
import { nodeHref } from "../../../router/params.ts";
import { nodeCtx } from "../../../slots/ctx.ts";
import SlotOutlet from "../../../slots/SlotOutlet.vue";
import { hudHref } from "./model.ts";

const props = defineProps<{
	hud: ViewResponse;
	home: ViewResponse;
	/** The page shows only this node: no "open" link, an empty state instead of nothing. */
	alone?: boolean;
}>();

const path = computed(() => props.hud.node.path);
const ctx = computed(() => nodeCtx(path.value));
const repoId = computed(() => props.hud.repo?.id);
const metrics = computed(() => props.hud.slots.filter((s) => s.slot === "hud.metric"));
const sections = computed(() => props.home.slots.filter((s) => s.slot === "home.section"));
const empty = computed(() => metrics.value.length === 0 && sections.value.length === 0);
const headingId = computed(() => `hud-${path.value.replace(/[^a-z0-9]+/g, "-")}`);
</script>

<template>
	<section
		v-if="!empty || alone"
		class="hud-node tt-stack"
		:aria-labelledby="headingId"
		:data-hud-node="path"
	>
		<header class="hud-node__head">
			<h2 :id="headingId" class="hud-node__title">
				<RouterLink :to="nodeHref(path)">{{ path }}</RouterLink>
			</h2>
			<span class="chip chip--muted">{{ hud.node.kind }}</span>
			<RouterLink v-if="!alone" :to="hudHref(path)" class="tt-button tt-button--sm">Open this HUD</RouterLink>
		</header>
		<div v-if="metrics.length > 0" class="hud-node__metrics">
			<SlotOutlet :slots="metrics" slot-id="hud.metric" :ctx="ctx" :repo-id="repoId" />
		</div>
		<SlotOutlet v-if="sections.length > 0" :slots="sections" slot-id="home.section" :ctx="ctx" :repo-id="repoId" />
		<p v-if="empty" class="tt-muted">
			Nothing on {{ path }} contributes HUD metrics. Install the HUD extension (tartan.hud) on a namespace from
			<RouterLink to="/-/extensions">Extensions</RouterLink>
			to count lanes, conflicts and landings across every repository below it.
		</p>
	</section>
</template>

<style scoped>
.hud-node__head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-2);
}

.hud-node__title {
	font-size: var(--tt-text-md);
	margin: 0;
	overflow-wrap: anywhere;
}

.hud-node__metrics :deep(.slot-outlet) {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
	gap: var(--tt-space-3);
}
</style>
