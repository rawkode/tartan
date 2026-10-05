<script setup lang="ts">
// `board`: columns of cards. A card link must be a same-origin path. With a
// `moveAction`, each card gets a "Move to" select (keyboard and touch
// friendly) that runs the action with `{...payload, card, from, to}`.
import { computed, inject } from "vue";
import { RouterLink } from "vue-router";
import type { UiAction } from "../nodeTypes.ts";
import { UI_ACTIONS } from "../context.ts";
import { boardMovePayload } from "../forms.ts";
import { sameOriginPath } from "../links.ts";

type Card = {
	readonly id: string;
	readonly col: string;
	readonly title: string;
	readonly href?: string;
	readonly badges?: readonly string[];
};

const props = defineProps<{
	columns: readonly { readonly id: string; readonly title: string; readonly wip?: number }[];
	cards: readonly Card[];
	moveAction?: UiAction;
}>();

const runner = inject(UI_ACTIONS, null);

const lanes = computed(() =>
	props.columns.map((column) => ({
		...column,
		cards: props.cards.filter((card) => card.col === column.id),
	}))
);

const move = (card: Card, event: Event): void => {
	const to = (event.target as HTMLSelectElement).value;
	if (!props.moveAction || !runner || to === card.col) return;
	void runner.run(
		props.moveAction,
		boardMovePayload(props.moveAction.payload, card, to),
	);
};
</script>

<template>
	<div class="ui-board tt-scroll-x" tabindex="0" role="region" aria-label="Board">
		<section v-for="lane in lanes" :key="lane.id" class="ui-board__col">
			<h3 class="ui-board__title">
				{{ lane.title }}
				<span
					class="chip"
					:class="lane.wip !== undefined && lane.cards.length > lane.wip ? 'chip--warning' : 'chip--muted'"
				>{{ lane.wip !== undefined ? `${lane.cards.length}/${lane.wip}` : lane.cards.length }}</span>
			</h3>
			<ul class="ui-board__cards">
				<li v-for="card in lane.cards" :key="card.id" class="ui-board__card">
					<RouterLink v-if="sameOriginPath(card.href)" :to="sameOriginPath(card.href) ?? '/'">{{ card.title }}</RouterLink>
					<span v-else>{{ card.title }}</span>
					<span v-if="card.badges?.length" class="ui-board__badges">
						<span v-for="(badge, index) in card.badges" :key="index" class="chip chip--muted">{{ badge }}</span>
					</span>
					<label v-if="moveAction" class="ui-board__move">
						<span class="visually-hidden">Move “{{ card.title }}” to</span>
						<select class="tt-input tt-input--sm" :value="card.col" :disabled="!runner" @change="move(card, $event)">
							<option v-for="column in columns" :key="column.id" :value="column.id">{{ column.title }}</option>
						</select>
					</label>
				</li>
			</ul>
		</section>
	</div>
</template>

<style scoped>
.ui-board {
	display: flex;
	gap: var(--tt-space-3);
	align-items: flex-start;
	padding-bottom: var(--tt-space-2);
}

.ui-board__col {
	flex: 0 0 min(16rem, 80vw);
	background: var(--tt-surface-sunken);
	border-radius: var(--tt-radius);
	padding: var(--tt-space-2);
}

.ui-board__title {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--tt-space-2);
	margin: 0 0 var(--tt-space-2);
	font-size: var(--tt-text-sm);
	font-weight: 600;
}

.ui-board__cards {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}

.ui-board__card {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-1);
	padding: var(--tt-space-2) var(--tt-space-3);
	background: var(--tt-surface);
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	overflow-wrap: anywhere;
}

.ui-board__badges {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-1);
}
</style>
