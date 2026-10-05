<script setup lang="ts">
// `kv`: a description list; a value is text or a nested node.
import UiNode from "../UiNode.vue";

defineProps<{
	items: readonly { readonly k: string; readonly v: unknown }[];
	depth: number;
}>();
</script>

<template>
	<dl class="ui-kv">
		<template v-for="(item, index) in items" :key="index">
			<dt>{{ item.k }}</dt>
			<dd>
				<template v-if="typeof item.v === 'string'">{{ item.v }}</template>
				<UiNode v-else :node="item.v" :depth="depth + 1" />
			</dd>
		</template>
	</dl>
</template>

<style scoped>
.ui-kv {
	display: grid;
	grid-template-columns: minmax(6rem, max-content) minmax(0, 1fr);
	gap: var(--tt-space-1) var(--tt-space-4);
	margin: 0;
}

.ui-kv dt {
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
	overflow-wrap: anywhere;
}

.ui-kv dd {
	margin: 0;
	min-width: 0;
	overflow-wrap: anywhere;
}
</style>
