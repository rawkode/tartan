<script setup lang="ts">
// A unified patch as text lines with +/− colouring and line numbers.
import { computed } from "vue";
import { diffLines } from "../ui/diffLines.ts";

const LIMIT = 5000;
const props = defineProps<{ patch: string }>();
const lines = computed(() => diffLines(props.patch, LIMIT + 1));
const truncated = computed(() => lines.value.length > LIMIT);
const shown = computed(() => lines.value.slice(0, LIMIT));
</script>

<template>
	<div class="tt-scroll-x diff" tabindex="0" role="region" aria-label="Patch">
		<table class="diff__table">
			<tbody>
				<tr
					v-for="(line, index) in shown"
					:key="index"
					class="diff__line"
					:class="`diff__line--${line.kind}`"
				>
					<td class="diff__no" aria-hidden="true">{{ line.oldNo ?? "" }}</td>
					<td class="diff__no" aria-hidden="true">{{ line.newNo ?? "" }}</td>
					<td class="diff__text"><span v-if="line.kind === 'add'" class="visually-hidden">added: </span><span
						v-else-if="line.kind === 'del'"
						class="visually-hidden"
					>removed: </span>{{ line.text }}</td>
				</tr>
			</tbody>
		</table>
		<p v-if="truncated" class="diff__truncated">Patch truncated after {{ LIMIT }} lines.</p>
	</div>
</template>

<style scoped>
.diff {
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	background: var(--tt-surface);
}

.diff__table {
	border-collapse: collapse;
	font-family: var(--tt-font-mono);
	font-size: var(--tt-text-sm);
	width: 100%;
}

.diff__no {
	padding: 0 var(--tt-space-2);
	text-align: right;
	color: var(--tt-text-muted);
	user-select: none;
	width: 1%;
	white-space: nowrap;
	font-variant-numeric: tabular-nums;
}

.diff__text {
	padding: 0 var(--tt-space-2);
	white-space: pre;
}

.diff__line--add {
	background: var(--tt-diff-add-bg);
}

.diff__line--del {
	background: var(--tt-diff-del-bg);
}

.diff__line--hunk {
	background: var(--tt-tone-info-bg);
	color: var(--tt-tone-info);
}

.diff__line--meta {
	color: var(--tt-text-muted);
}

.diff__truncated {
	margin: 0;
	padding: var(--tt-space-2);
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}
</style>
