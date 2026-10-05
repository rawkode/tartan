<script setup lang="ts">
// `tabs`: a WAI-ARIA tab list; only the selected tab's body renders.
import { computed, ref, useId } from "vue";
import UiNode from "../UiNode.vue";

const props = defineProps<{
	tabs: readonly { readonly label: string; readonly body: unknown }[];
	depth: number;
}>();

const base = useId();
const selected = ref(0);
const current = computed(() => props.tabs[selected.value] ?? props.tabs[0]);

const select = (index: number): void => {
	selected.value = index;
};

const onKey = (event: KeyboardEvent): void => {
	const count = props.tabs.length;
	if (count === 0) return;
	if (event.key === "ArrowRight") select((selected.value + 1) % count);
	else if (event.key === "ArrowLeft") select((selected.value - 1 + count) % count);
	else if (event.key === "Home") select(0);
	else if (event.key === "End") select(count - 1);
	else return;
	event.preventDefault();
};
</script>

<template>
	<div class="ui-tabs">
		<div class="ui-tabs__list" role="tablist" @keydown="onKey">
			<button
				v-for="(tab, index) in tabs"
				:id="`${base}-tab-${index}`"
				:key="index"
				type="button"
				role="tab"
				class="ui-tabs__tab"
				:aria-selected="index === selected"
				:aria-controls="`${base}-panel`"
				:tabindex="index === selected ? 0 : -1"
				@click="select(index)"
			>{{ tab.label }}</button>
		</div>
		<div
			v-if="current"
			:id="`${base}-panel`"
			class="ui-tabs__panel"
			role="tabpanel"
			:aria-labelledby="`${base}-tab-${selected}`"
		>
			<UiNode :node="current.body" :depth="depth + 1" />
		</div>
	</div>
</template>

<style scoped>
.ui-tabs__list {
	display: flex;
	gap: var(--tt-space-1);
	overflow-x: auto;
	border-bottom: 1px solid var(--tt-border);
}

.ui-tabs__tab {
	padding: var(--tt-space-2) var(--tt-space-3);
	border: 0;
	background: none;
	color: var(--tt-text-muted);
	cursor: pointer;
	white-space: nowrap;
	min-height: 2.75rem;
}

.ui-tabs__tab[aria-selected="true"] {
	color: var(--tt-text);
	box-shadow: inset 0 -2px 0 var(--tt-accent);
}

.ui-tabs__panel {
	padding-top: var(--tt-space-3);
}
</style>
