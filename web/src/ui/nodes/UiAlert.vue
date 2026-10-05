<script setup lang="ts">
// `alert`: a toned callout with an optional nested body node.
import { computed } from "vue";
import TtIcon from "../../components/TtIcon.vue";
import { toneOf } from "../nodeTypes.ts";
import UiNode from "../UiNode.vue";

const props = defineProps<{
	tone: string;
	title: string;
	body?: unknown;
	depth: number;
}>();

const tone = computed(() => toneOf(props.tone));
const icon = computed(() =>
	tone.value === "success"
		? "check"
		: tone.value === "danger" || tone.value === "warning"
		? "alert"
		: "info"
);
</script>

<template>
	<div class="ui-alert" :class="`ui-alert--${tone}`" :role="tone === 'danger' ? 'alert' : 'status'">
		<TtIcon :name="icon" />
		<div class="ui-alert__content">
			<p class="ui-alert__title">{{ title }}</p>
			<UiNode v-if="body !== undefined" :node="body" :depth="depth + 1" />
		</div>
	</div>
</template>

<style scoped>
.ui-alert {
	display: flex;
	gap: var(--tt-space-2);
	padding: var(--tt-space-3);
	border-radius: var(--tt-radius);
	border: 1px solid currentColor;
}

.ui-alert__content {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-1);
	min-width: 0;
	color: var(--tt-text);
}

.ui-alert__title {
	margin: 0;
	font-weight: 600;
}

.ui-alert--neutral {
	color: var(--tt-tone-neutral);
	background: var(--tt-tone-neutral-bg);
}
.ui-alert--info {
	color: var(--tt-tone-info);
	background: var(--tt-tone-info-bg);
}
.ui-alert--success {
	color: var(--tt-tone-success);
	background: var(--tt-tone-success-bg);
}
.ui-alert--warning {
	color: var(--tt-tone-warning);
	background: var(--tt-tone-warning-bg);
}
.ui-alert--danger {
	color: var(--tt-tone-danger);
	background: var(--tt-tone-danger-bg);
}
.ui-alert--muted {
	color: var(--tt-tone-muted);
	background: var(--tt-tone-muted-bg);
}
</style>
