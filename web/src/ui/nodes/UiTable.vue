<script setup lang="ts">
// `table`: header from `columns`; a cell is text, a number or a nested node.
// Wide tables scroll inside their own box (375 px layout).
import UiNode from "../UiNode.vue";
import { formatNumber } from "../format.ts";

defineProps<{
	columns: readonly string[];
	rows: readonly (readonly unknown[])[];
	depth: number;
}>();
</script>

<template>
	<div class="tt-scroll-x" tabindex="0" role="region" aria-label="Table">
		<table class="tt-table">
			<thead>
				<tr>
					<th v-for="(column, index) in columns" :key="index" scope="col">{{ column }}</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="(row, r) in rows" :key="r">
					<td v-for="(cell, c) in row" :key="c" :class="{ 'tt-num': typeof cell === 'number' }">
						<template v-if="typeof cell === 'string'">{{ cell }}</template>
						<template v-else-if="typeof cell === 'number'">{{ formatNumber(cell) }}</template>
						<UiNode v-else :node="cell" :depth="depth + 1" />
					</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
