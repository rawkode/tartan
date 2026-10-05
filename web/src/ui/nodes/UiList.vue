<script setup lang="ts">
// `list`: one nested node per item.
import UiNode from "../UiNode.vue";

defineProps<{ items: readonly unknown[]; depth: number }>();
</script>

<template>
	<ul class="ui-list">
		<li v-for="(item, index) in items" :key="index">
			<UiNode :node="item" :depth="depth + 1" />
		</li>
	</ul>
</template>

<style scoped>
.ui-list {
	display: flex;
	flex-direction: column;
	margin: 0;
	padding: 0;
	list-style: none;
}

.ui-list > li {
	padding: var(--tt-space-2) 0;
	border-bottom: 1px solid var(--tt-border);
	min-width: 0;
}

.ui-list > li:last-child {
	border-bottom: 0;
}
</style>
