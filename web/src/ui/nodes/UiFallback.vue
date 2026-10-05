<script setup lang="ts">
// The chip shown instead of a node: the host-only error chip (`<ext>: render
// failed`) or an unsupported/invalid node. The reason is a tooltip only.
defineProps<{
	text: string;
	kind: "error" | "unsupported";
	reason?: string;
}>();
</script>

<template>
	<span
		class="chip ui-fallback"
		:class="kind === 'error' ? 'chip--danger' : 'chip--warning'"
		:data-ui-fallback="kind"
		:title="reason"
	>{{ text }}</span>
</template>

<style scoped>
.ui-fallback {
	align-self: flex-start;
}
</style>
