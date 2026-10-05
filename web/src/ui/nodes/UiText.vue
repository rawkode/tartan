<script setup lang="ts">
// `heading`, `text`, `label`, `badge`, `empty`: text only, tone as a class.
import { computed } from "vue";
import { toneOf } from "../nodeTypes.ts";

const props = defineProps<{
	kind: "heading" | "text" | "label" | "badge" | "empty";
	text: string;
	tone?: string;
	level?: 2 | 3 | 4;
	mono?: boolean;
	body?: string;
}>();

const tone = computed(() => toneOf(props.tone));
const headingTag = computed(() => `h${props.level ?? 2}`);
</script>

<template>
	<component
		:is="headingTag"
		v-if="kind === 'heading'"
		class="ui-heading"
		:class="{ 'ui-mono': mono }"
	>{{ text }}</component>
	<p
		v-else-if="kind === 'text'"
		class="ui-text"
		:class="[`ui-tone-${tone}`, { 'ui-mono': mono, 'ui-text--plain': !tone || tone === 'neutral' }]"
	>{{ text }}</p>
	<span
		v-else-if="kind === 'label'"
		class="ui-label"
		:class="{ 'ui-mono': mono }"
	>{{ text }}</span>
	<span
		v-else-if="kind === 'badge'"
		class="chip"
		:class="[`chip--${tone}`, { 'ui-mono': mono }]"
	>{{ text }}</span>
	<div v-else class="ui-empty">
		<p class="ui-empty__title">{{ text }}</p>
		<p v-if="body" class="ui-empty__body">{{ body }}</p>
	</div>
</template>

<style scoped>
.ui-heading {
	margin: 0;
	font-weight: 600;
	overflow-wrap: anywhere;
}

h2.ui-heading {
	font-size: var(--tt-text-lg);
}

h3.ui-heading,
h4.ui-heading {
	font-size: var(--tt-text-md);
}

.ui-text {
	margin: 0;
	overflow-wrap: anywhere;
	white-space: pre-line;
}

.ui-text--plain {
	color: var(--tt-text);
}

.ui-label {
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}

.ui-empty {
	padding: var(--tt-space-6) var(--tt-space-4);
	text-align: center;
	border: 1px dashed var(--tt-border);
	border-radius: var(--tt-radius);
	color: var(--tt-text-muted);
}

.ui-empty__title {
	margin: 0;
	font-weight: 600;
	color: var(--tt-text);
}

.ui-empty__body {
	margin: var(--tt-space-1) 0 0;
}
</style>
