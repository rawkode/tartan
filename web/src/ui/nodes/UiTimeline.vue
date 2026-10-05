<script setup lang="ts">
// `timeline`: events in the order given; `at` is epoch milliseconds.
import { formatTime, isoTime } from "../format.ts";
import { toneOf } from "../nodeTypes.ts";

defineProps<{
	items: readonly {
		readonly at: number;
		readonly text: string;
		readonly actor?: string;
		readonly tone?: string;
	}[];
}>();
</script>

<template>
	<ol class="ui-timeline">
		<li v-for="(item, index) in items" :key="index" class="ui-timeline__item">
			<span class="ui-timeline__dot" :class="`ui-dot--${toneOf(item.tone, 'muted')}`" aria-hidden="true" />
			<div class="ui-timeline__body">
				<p class="ui-timeline__text">{{ item.text }}</p>
				<p class="ui-timeline__meta">
					<span v-if="item.actor">{{ item.actor }} · </span>
					<time :datetime="isoTime(item.at)">{{ formatTime(item.at) }}</time>
				</p>
			</div>
		</li>
	</ol>
</template>

<style scoped>
.ui-timeline {
	margin: 0;
	padding: 0;
	list-style: none;
}

.ui-timeline__item {
	display: flex;
	gap: var(--tt-space-3);
	padding-bottom: var(--tt-space-3);
	position: relative;
}

.ui-timeline__item::before {
	content: "";
	position: absolute;
	left: 0.3125rem;
	top: 1rem;
	bottom: 0;
	width: 1px;
	background: var(--tt-border);
}

.ui-timeline__item:last-child::before {
	display: none;
}

.ui-timeline__dot {
	flex: none;
	width: 0.6875rem;
	height: 0.6875rem;
	margin-top: 0.35rem;
	border-radius: 50%;
}

.ui-timeline__body {
	min-width: 0;
}

.ui-timeline__text {
	margin: 0;
	overflow-wrap: anywhere;
}

.ui-timeline__meta {
	margin: 0;
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}
</style>
