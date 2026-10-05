<script setup lang="ts">
// `sparkline`: an inline SVG trend line; the summary is the accessible name.
import { computed } from "vue";
import { formatNumber } from "../format.ts";
import { sparkline } from "../sparkline.ts";

const props = defineProps<{ values: readonly number[] }>();
const line = computed(() => sparkline(props.values));
const summary = computed(() =>
	line.value.count === 0
		? "no data"
		: `trend of ${line.value.count}: min ${formatNumber(line.value.min)}, max ${
			formatNumber(line.value.max)
		}, last ${formatNumber(line.value.last ?? 0)}`
);
</script>

<template>
	<svg
		class="ui-sparkline"
		viewBox="0 0 120 28"
		width="120"
		height="28"
		role="img"
		:aria-label="summary"
		preserveAspectRatio="none"
	>
		<polyline
			v-if="line.count > 1"
			:points="line.points"
			fill="none"
			stroke="currentColor"
			stroke-width="1.5"
			stroke-linejoin="round"
			stroke-linecap="round"
			vector-effect="non-scaling-stroke"
		/>
		<circle v-else-if="line.count === 1" cx="60" cy="14" r="2" fill="currentColor" />
	</svg>
</template>

<style scoped>
.ui-sparkline {
	color: var(--tt-accent);
	max-width: 100%;
}
</style>
