<script setup lang="ts">
// `stack`, `row`, `grid`, `section`, `card`. Spacing and columns are classes
// chosen from closed sets; nothing from the node reaches `style`.
import { computed } from "vue";
import UiNode from "../UiNode.vue";

const props = defineProps<{
	kind: "stack" | "row" | "grid" | "section" | "card";
	items: readonly unknown[];
	gap?: 0 | 1 | 2 | 3;
	cols?: number;
	title?: string;
	depth: number;
}>();

const classes = computed(() => [
	"ui-box",
	`ui-box--${props.kind}`,
	`ui-gap-${props.gap ?? 2}`,
	props.kind === "grid"
		? `ui-cols-${Math.min(6, Math.max(1, Math.trunc(props.cols ?? 2)))}`
		: "",
]);

const tag = computed(() =>
	props.kind === "section" ? "section" : props.kind === "card" ? "article" : "div"
);
</script>

<template>
	<component :is="tag" :class="classes">
		<h3 v-if="title && (kind === 'section' || kind === 'card')" class="ui-box__title">
			{{ title }}
		</h3>
		<UiNode
			v-for="(child, index) in items"
			:key="index"
			:node="child"
			:depth="depth + 1"
		/>
	</component>
</template>

<style scoped>
.ui-box {
	display: flex;
	flex-direction: column;
	min-width: 0;
}

.ui-box--row {
	flex-direction: row;
	flex-wrap: wrap;
	align-items: center;
}

.ui-box--grid {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
}

@media (min-width: 40rem) {
	.ui-cols-2 {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
	.ui-cols-3,
	.ui-cols-4,
	.ui-cols-5,
	.ui-cols-6 {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}
}

@media (min-width: 64rem) {
	.ui-cols-4 {
		grid-template-columns: repeat(4, minmax(0, 1fr));
	}
	.ui-cols-5 {
		grid-template-columns: repeat(5, minmax(0, 1fr));
	}
	.ui-cols-6 {
		grid-template-columns: repeat(6, minmax(0, 1fr));
	}
}

.ui-box--card {
	padding: var(--tt-space-4);
	background: var(--tt-surface);
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
}

.ui-box--section {
	padding-block: var(--tt-space-2);
}

.ui-box__title {
	font-size: var(--tt-text-md);
	font-weight: 600;
	margin: 0;
}

.ui-gap-0 {
	gap: 0;
}
.ui-gap-1 {
	gap: var(--tt-space-1);
}
.ui-gap-2 {
	gap: var(--tt-space-2);
}
.ui-gap-3 {
	gap: var(--tt-space-4);
}
</style>
