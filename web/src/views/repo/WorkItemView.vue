<script setup lang="ts">
// Work item page: `work.panel` and `work.sidebar` slot hosts.
import { computed } from "vue";
import { useRoute } from "vue-router";
import AsyncState from "../../components/AsyncState.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import { stringParam } from "../../router/params.ts";
import { provideSlotRegistry } from "../../slots/registry.ts";
import { entityCtx } from "../../slots/ctx.ts";
import SlotOutlet from "../../slots/SlotOutlet.vue";
import { useNodeView } from "./useNodeView.ts";

provideSlotRegistry();
const route = useRoute();
const workId = computed(() => stringParam(route.params, "workId"));
const node = useNodeView(
	() => `work/${workId.value}`,
	(path) => entityCtx(path, "work", workId.value),
);

</script>

<template>
	<AsyncState
		:loading="node.loading.value"
		:error="node.error.value"
		:status="node.status.value"
		:ready="node.data.value !== null"
		what="this work item"
		@retry="node.reload"
	>
		<RepoFrame v-if="node.data.value" :view="node.data.value" :ctx="node.ctx.value" active="work" wide>
			<div class="work">
				<div class="work__main">
					<p class="tt-muted">Work item <code>{{ workId }}</code></p>
					<SlotOutlet
						:slots="node.data.value.slots"
						slot-id="work.panel"
						:ctx="node.ctx.value"
						:repo-id="node.repoId.value"
					>
						<template #empty>
							<p class="tt-muted">No extension shows this work item.</p>
						</template>
					</SlotOutlet>
				</div>
				<aside class="work__side" aria-label="Work item sidebar">
					<SlotOutlet
						:slots="node.data.value.slots"
						slot-id="work.sidebar"
						:ctx="node.ctx.value"
						:repo-id="node.repoId.value"
					/>
				</aside>
			</div>
		</RepoFrame>
	</AsyncState>
</template>

<style scoped>
.work {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--tt-space-6);
}

@media (min-width: 64rem) {
	.work {
		grid-template-columns: minmax(0, 1fr) 20rem;
	}
}

.work__main,
.work__side {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-4);
	min-width: 0;
}
</style>
