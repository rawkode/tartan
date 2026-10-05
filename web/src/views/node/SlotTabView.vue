<script setup lang="ts">
// A page contributed by an extension: a `repo.tab` or `node.tab` route
// (`/<node>/-/<tab>/<rest>`). The static contribution names the tab; the page
// itself is the dynamic slot instance with the same contribution id.
import { computed } from "vue";
import { useRoute } from "vue-router";
import AsyncState from "../../components/AsyncState.vue";
import NodeCrumbs from "../../components/NodeCrumbs.vue";
import PageHeader from "../../components/PageHeader.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import { stringParam } from "../../router/params.ts";
import { provideSlotRegistry } from "../../slots/registry.ts";
import { tabCtx } from "../../slots/ctx.ts";
import SlotOutlet from "../../slots/SlotOutlet.vue";
import { useNodeView } from "../repo/useNodeView.ts";

provideSlotRegistry();
const route = useRoute();
const tab = computed(() => stringParam(route.params, "tab"));
const rest = computed(() => stringParam(route.params, "rest"));
const node = useNodeView(
	() => `${tab.value}${rest.value ? `/${rest.value}` : ""}`,
	(path) => tabCtx(path, rest.value),
);

const isRepo = computed(() => node.data.value?.node.kind === "repo");
const contribution = computed(() =>
	node.data.value?.static.tabs.find((t) =>
		(t.slot === "repo.tab" || t.slot === "node.tab") &&
		(t.route ?? t.id).split("/")[0] === tab.value
	) ?? null
);
const slotId = computed(() => (isRepo.value ? "repo.tab" : "node.tab"));
</script>

<template>
	<AsyncState
		:loading="node.loading.value"
		:error="node.error.value"
		:status="node.status.value"
		:ready="node.data.value !== null"
		what="this page"
		@retry="node.reload"
	>
		<template v-if="node.data.value">
			<RepoFrame
				v-if="isRepo"
				:view="node.data.value"
				:ctx="node.ctx.value"
				:active="contribution?.id ?? tab"
			>
				<p v-if="!contribution" class="tt-muted">No extension provides “{{ tab }}” here.</p>
				<SlotOutlet
					v-else
					:slots="node.data.value.slots"
					:slot-id="slotId"
					:only="contribution.id"
					:ctx="node.ctx.value"
					:repo-id="node.repoId.value"
				/>
			</RepoFrame>
			<div v-else class="tt-stack">
				<NodeCrumbs :path="node.data.value.node.path" />
				<PageHeader :title="contribution?.label ?? tab" />
				<p v-if="!contribution" class="tt-muted">No extension provides “{{ tab }}” here.</p>
				<SlotOutlet
					v-else
					:slots="node.data.value.slots"
					:slot-id="slotId"
					:only="contribution.id"
					:ctx="node.ctx.value"
				/>
			</div>
		</template>
	</AsyncState>
</template>
