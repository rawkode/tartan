<script setup lang="ts">
import { computed } from "vue";
import { line } from "../../styled-system/recipes";
import { age, type PlacedIssue, rel, urlFor } from "./data/index.ts";

const props = defineProps<
	{
		issue: PlacedIssue;
		scope: string;
		grouped?: boolean;
		width?: number;
		stacked?: boolean;
	}
>();

const where = computed(
	() => (props.grouped ? "" : rel(props.scope, props.issue.where)),
);

// Rows in a list share one id column, as wide as its longest id.
const idWidth = computed(() => `${(props.width ?? 0) + 1}ch`);

const closed = computed(() => props.issue.state === "closed");

const styles = line();
</script>

<template>
	<a :href="urlFor(issue.where, `issues/${issue.number}`)" :class="styles.root">
		<svg v-if="!stacked" :class="styles.icon"
			:data-closed="closed ? '' : undefined" width="12" height="12"
			viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
			:aria-label="closed ? 'Closed' : 'Open'" role="img">
			<circle cx="8" cy="8" r="6.2" />
		</svg>
		<span :class="styles.id" :data-full="stacked ? '' : undefined"
			:data-sized="stacked ? undefined : ''"><span :class="styles.where">{{ where }}</span>#{{ issue.number }}</span>
		<span :class="styles.title">{{ issue.title }}</span>
		<span :class="styles.age">{{ age(issue.updatedAt) }}</span>
	</a>
</template>

<style scoped>
[data-sized] {
	flex: 0 0 v-bind(idWidth);
}
</style>
