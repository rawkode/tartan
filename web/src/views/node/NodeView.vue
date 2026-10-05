<script setup lang="ts">
// `/<path>`: a repo's home (its code at the default branch) or a user/group
// page (static `node.tab` links, `node.section` slots, children, and create
// forms for Maintainers and above).
import { computed, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import type { NodeDto } from "@tartan/contract/api.ts";
import AsyncState from "../../components/AsyncState.vue";
import CreateNodeForm from "../../components/CreateNodeForm.vue";
import NodeChildren from "../../components/NodeChildren.vue";
import NodeCrumbs from "../../components/NodeCrumbs.vue";
import PageHeader from "../../components/PageHeader.vue";
import { nodeHref, settingsHref } from "../../router/params.ts";
import { provideSlotRegistry } from "../../slots/registry.ts";
import SlotOutlet from "../../slots/SlotOutlet.vue";
import RepoCode from "../repo/parts/RepoCode.vue";
import { useNodeView } from "../repo/useNodeView.ts";

provideSlotRegistry();
const router = useRouter();
const node = useNodeView(() => "");

const creating = ref<"group" | "repo" | null>(null);
const refreshKey = ref(0);
const canCreate = computed(() =>
	(node.data.value?.viewer.role ?? 0) >= 40 && node.data.value?.node.kind !== "repo"
);
const tabs = computed(() =>
	(node.data.value?.static.tabs ?? [])
		.filter((t) => t.slot === "node.tab")
		.slice()
		.sort((a, b) => a.order - b.order)
);

const onCreated = (created: NodeDto): void => {
	creating.value = null;
	refreshKey.value += 1;
	if (created.kind === "repo") void router.push(nodeHref(created.path));
};
</script>

<template>
	<AsyncState
		:loading="node.loading.value"
		:error="node.error.value"
		:status="node.status.value"
		:ready="node.data.value !== null"
		what="this namespace"
		@retry="node.reload"
	>
		<template v-if="node.data.value">
			<RepoCode
				v-if="node.data.value.node.kind === 'repo'"
				:view="node.data.value"
				:ctx="node.ctx.value"
				ref-name=""
				path=""
			/>
			<div v-else class="tt-stack">
				<NodeCrumbs :path="node.data.value.node.path" />
				<PageHeader
					:title="node.data.value.node.slug"
					:subtitle="node.data.value.node.description"
				>
					<template #actions>
						<span class="chip chip--muted">{{ node.data.value.node.kind }}</span>
						<span class="chip chip--muted">{{ node.data.value.node.visibility }}</span>
						<RouterLink
							v-if="node.data.value.viewer.role >= 50"
							class="tt-button tt-button--sm"
							:to="settingsHref(node.data.value.node.path)"
						>Settings</RouterLink>
					</template>
				</PageHeader>
				<ul v-if="node.data.value.banners.length > 0" class="tt-row">
					<li v-for="(banner, i) in node.data.value.banners" :key="i" class="chip" :class="`chip--${banner.tone}`">{{ banner.text }}</li>
				</ul>
				<nav v-if="tabs.length > 0" class="node-tabs" aria-label="Pages">
					<RouterLink
						v-for="tab in tabs"
						:key="tab.id"
						class="tt-button tt-button--sm"
						:to="`${nodeHref(node.data.value.node.path)}/-/${(tab.route ?? tab.id).replace(/\*.*$/, '').replace(/\/$/, '')}`"
					>{{ tab.label ?? tab.id }}</RouterLink>
				</nav>
				<SlotOutlet :slots="node.data.value.slots" slot-id="node.section" :ctx="node.ctx.value" />
				<section class="tt-stack" aria-labelledby="children-title">
					<div class="node-children-head">
						<h2 id="children-title" class="node-children-title">Groups and repositories</h2>
						<div v-if="canCreate" class="tt-row">
							<button type="button" class="tt-button tt-button--sm" @click="creating = 'group'">New group</button>
							<button type="button" class="tt-button tt-button--sm tt-button--primary" @click="creating = 'repo'">New repository</button>
						</div>
					</div>
					<CreateNodeForm
						v-if="creating"
						:kind="creating"
						:parent="node.data.value.node.path"
						@created="onCreated"
						@cancel="creating = null"
					/>
					<NodeChildren :parent="node.data.value.node.path" :refresh-key="refreshKey" />
				</section>
			</div>
		</template>
	</AsyncState>
</template>

<style scoped>
.node-tabs {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-2);
}

.node-children-head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--tt-space-2);
}

.node-children-title {
	font-size: var(--tt-text-md);
}
</style>
