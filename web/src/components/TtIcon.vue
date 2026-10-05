<script setup lang="ts">
// A host icon (decorative unless `label` is given).
import { computed } from "vue";
import { iconPath } from "../ui/icons.ts";

const props = defineProps<{ name?: string; label?: string }>();
const d = computed(() => iconPath(props.name));
</script>

<template>
	<svg
		class="tt-icon"
		viewBox="0 0 16 16"
		width="16"
		height="16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		:role="label ? 'img' : undefined"
		:aria-label="label"
		:aria-hidden="label ? undefined : 'true'"
		focusable="false"
	>
		<path :d="d" />
	</svg>
</template>

<style scoped>
.tt-icon {
	flex: none;
	vertical-align: -0.125em;
}
</style>
