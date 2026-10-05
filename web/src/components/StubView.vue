<script setup lang="ts">
// Placeholder page used by every view until its owning WP replaces it. Shows
// the view title, the owner, and the route params (as text) so routing can be
// checked by hand.
import { computed } from "vue";
import { useRoute } from "vue-router";

defineProps<{
	title: string;
	owner: "WP18" | "WP19";
	summary?: string;
}>();

const route = useRoute();

const params = computed(() =>
	Object.entries(route.params).map(([name, value]) => ({
		name,
		value: Array.isArray(value) ? value.join("/") : value,
	}))
);
</script>

<template>
	<section class="stub">
		<header class="stub__header">
			<h1>{{ title }}</h1>
			<span class="chip chip--muted">stub · {{ owner }}</span>
		</header>
		<p v-if="summary" class="stub__summary">{{ summary }}</p>
		<dl v-if="params.length > 0" class="stub__params">
			<template v-for="param in params" :key="param.name">
				<dt>{{ param.name }}</dt>
				<dd><code>{{ param.value }}</code></dd>
			</template>
		</dl>
		<slot />
	</section>
</template>

<style scoped>
.stub {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-4);
}

.stub__header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-3);
}

.stub__summary {
	margin: 0;
	color: var(--tt-text-muted);
	max-width: 60ch;
}

.stub__params {
	display: grid;
	grid-template-columns: max-content minmax(0, 1fr);
	gap: var(--tt-space-1) var(--tt-space-4);
	margin: 0;
	padding: var(--tt-space-3) var(--tt-space-4);
	background: var(--tt-surface);
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
}

.stub__params dt {
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}

.stub__params dd {
	margin: 0;
	min-width: 0;
}
</style>
