<script setup lang="ts">
// `matrix`: rows × columns heat map (level 0–5, a class per level). A cell
// with an action is a button.
import { computed, inject } from "vue";
import type { UiAction } from "../nodeTypes.ts";
import { UI_ACTIONS } from "../context.ts";

type Cell = {
	readonly r: string;
	readonly c: string;
	readonly level: number;
	readonly label?: string;
	readonly action?: UiAction;
};

const props = defineProps<{
	rows: readonly { readonly id: string; readonly label: string }[];
	cols: readonly { readonly id: string; readonly label: string }[];
	cells: readonly Cell[];
}>();

const runner = inject(UI_ACTIONS, null);

const byKey = computed(() => {
	const map = new Map<string, Cell>();
	for (const cell of props.cells) map.set(`${cell.r}\u0000${cell.c}`, cell);
	return map;
});

const cellAt = (r: string, c: string): Cell | undefined =>
	byKey.value.get(`${r}\u0000${c}`);

const level = (cell: Cell | undefined): number =>
	Math.min(5, Math.max(0, Math.trunc(cell?.level ?? 0)));

const run = (action: UiAction | undefined): void => {
	if (action && runner) void runner.run(action);
};
</script>

<template>
	<div class="tt-scroll-x" tabindex="0" role="region" aria-label="Matrix">
		<table class="ui-matrix">
			<thead>
				<tr>
					<td />
					<th v-for="col in cols" :key="col.id" scope="col" class="ui-matrix__col">
						<span>{{ col.label }}</span>
					</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="row in rows" :key="row.id">
					<th scope="row" class="ui-matrix__row">{{ row.label }}</th>
					<td
						v-for="col in cols"
						:key="col.id"
						class="ui-matrix__cell"
						:class="`ui-heat-${level(cellAt(row.id, col.id))}`"
					>
						<button
							v-if="cellAt(row.id, col.id)?.action"
							type="button"
							class="ui-matrix__btn"
							:disabled="!runner"
							:aria-label="`${row.label} × ${col.label}: ${cellAt(row.id, col.id)?.label ?? level(cellAt(row.id, col.id))}`"
							@click="run(cellAt(row.id, col.id)?.action)"
						>{{ cellAt(row.id, col.id)?.label ?? "" }}</button>
						<span v-else>
							{{ cellAt(row.id, col.id)?.label ?? "" }}<span class="visually-hidden">level {{ level(cellAt(row.id, col.id)) }}</span>
						</span>
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>

<style scoped>
.ui-matrix {
	border-collapse: separate;
	border-spacing: 2px;
	font-size: var(--tt-text-sm);
}

.ui-matrix__col {
	font-weight: 500;
	color: var(--tt-text-muted);
	white-space: nowrap;
	max-width: 8rem;
	overflow: hidden;
	text-overflow: ellipsis;
}

.ui-matrix__row {
	text-align: start;
	font-weight: 500;
	white-space: nowrap;
	padding-inline-end: var(--tt-space-2);
}

.ui-matrix__cell {
	min-width: 2.25rem;
	height: 2.25rem;
	text-align: center;
	border-radius: 4px;
}

.ui-matrix__btn {
	width: 100%;
	height: 100%;
	min-height: 2.25rem;
	border: 0;
	background: transparent;
	cursor: pointer;
	color: inherit;
}

.ui-heat-0 {
	background: var(--tt-heat-0);
}
.ui-heat-1 {
	background: var(--tt-heat-1);
}
.ui-heat-2 {
	background: var(--tt-heat-2);
}
.ui-heat-3 {
	background: var(--tt-heat-3);
}
.ui-heat-4 {
	background: var(--tt-heat-4);
	color: var(--tt-on-heat);
}
.ui-heat-5 {
	background: var(--tt-heat-5);
	color: var(--tt-on-heat);
}
</style>
