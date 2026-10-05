<script setup lang="ts">
// `button` and `menu`. Clicking hands the action to the host's runner (which
// asks for `confirm` text and POSTs to the slot's action endpoint); without a
// runner or an action the control renders disabled.
import { computed, inject } from "vue";
import type { UiAction } from "../nodeTypes.ts";
import { toneOf } from "../nodeTypes.ts";
import { UI_ACTIONS } from "../context.ts";

const props = defineProps<{
	kind: "button" | "menu";
	text: string;
	action?: UiAction;
	tone?: string;
	items?: readonly { readonly text: string; readonly action: UiAction }[];
}>();

const runner = inject(UI_ACTIONS, null);
const busy = computed(() => runner?.busy.value ?? false);
const tone = computed(() => toneOf(props.tone));

const run = (action: UiAction | undefined): void => {
	if (action && runner) void runner.run(action);
};
</script>

<template>
	<button
		v-if="kind === 'button'"
		type="button"
		class="tt-button"
		:class="`tt-button--${tone}`"
		:disabled="!action || !runner || busy"
		@click="run(action)"
	>{{ text }}</button>
	<details v-else class="ui-menu">
		<summary class="tt-button" :class="`tt-button--${tone}`">{{ text }}</summary>
		<ul class="ui-menu__list">
			<li v-for="(item, index) in items ?? []" :key="index">
				<button
					type="button"
					class="ui-menu__item"
					:disabled="!runner || busy"
					@click="run(item.action)"
				>{{ item.text }}</button>
			</li>
		</ul>
	</details>
</template>

<style scoped>
.ui-menu {
	position: relative;
	display: inline-block;
}

.ui-menu > summary {
	list-style: none;
}

.ui-menu > summary::-webkit-details-marker {
	display: none;
}

.ui-menu__list {
	position: absolute;
	z-index: 5;
	min-width: 12rem;
	max-width: min(20rem, 90vw);
	margin: var(--tt-space-1) 0 0;
	padding: var(--tt-space-1);
	list-style: none;
	background: var(--tt-surface);
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	box-shadow: var(--tt-shadow);
}

.ui-menu__item {
	display: block;
	width: 100%;
	padding: var(--tt-space-2) var(--tt-space-3);
	border: 0;
	background: none;
	text-align: start;
	cursor: pointer;
	border-radius: var(--tt-radius);
	min-height: 2.75rem;
}

.ui-menu__item:hover:not(:disabled) {
	background: var(--tt-surface-sunken);
}
</style>
