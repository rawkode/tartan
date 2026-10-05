<script setup lang="ts">
// `progress` (a native <progress>, values clamped) and `stat` (a number with an
// optional unit and signed delta).
import { computed, useId } from "vue";
import { formatNumber } from "../format.ts";

const props = defineProps<{
	kind: "progress" | "stat";
	value?: number;
	max?: number;
	label?: string;
	delta?: number;
	unit?: string;
}>();

const id = useId();
const max = computed(() =>
	props.max !== undefined && props.max > 0 ? props.max : 100
);
const value = computed(() =>
	Math.min(max.value, Math.max(0, props.value ?? 0))
);
const percent = computed(() => Math.round((value.value / max.value) * 100));
const deltaTone = computed(() =>
	props.delta === undefined || props.delta === 0
		? "muted"
		: props.delta > 0
		? "success"
		: "danger"
);
const deltaText = computed(() =>
	props.delta === undefined
		? ""
		: `${props.delta > 0 ? "+" : props.delta < 0 ? "−" : "±"}${
			formatNumber(Math.abs(props.delta))
		}`
);
</script>

<template>
	<div v-if="kind === 'progress'" class="ui-progress">
		<label v-if="label" :for="id" class="ui-progress__label">
			<span>{{ label }}</span>
			<span class="ui-progress__pct">{{ percent }}%</span>
		</label>
		<progress
			:id="id"
			class="ui-progress__bar"
			:value="value"
			:max="max"
			:aria-label="label ? undefined : `${percent}%`"
		>{{ percent }}%</progress>
	</div>
	<div v-else class="ui-stat">
		<span v-if="label" class="ui-stat__label">{{ label }}</span>
		<span class="ui-stat__value">
			{{ props.value === undefined ? "—" : formatNumber(props.value) }}<span
				v-if="unit"
				class="ui-stat__unit"
			>{{ unit }}</span>
		</span>
		<span v-if="delta !== undefined" class="chip" :class="`chip--${deltaTone}`">{{ deltaText }}</span>
	</div>
</template>

<style scoped>
.ui-progress {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-1);
}

.ui-progress__label {
	display: flex;
	justify-content: space-between;
	font-size: var(--tt-text-sm);
	color: var(--tt-text-muted);
}

.ui-progress__bar {
	width: 100%;
	height: 0.5rem;
	accent-color: var(--tt-accent);
}

.ui-stat {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--tt-space-1);
	min-width: 0;
}

.ui-stat__label {
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}

.ui-stat__value {
	font-size: var(--tt-text-xl);
	font-weight: 650;
	font-variant-numeric: tabular-nums;
	line-height: 1.1;
}

.ui-stat__unit {
	font-size: var(--tt-text-md);
	font-weight: 400;
	color: var(--tt-text-muted);
	margin-inline-start: 0.15em;
}
</style>
