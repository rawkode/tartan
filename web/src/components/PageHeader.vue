<script setup lang="ts">
// Page title row: an h1, an optional subtitle, and a slot for actions.
defineProps<{ title: string; subtitle?: string }>();
</script>

<template>
	<header class="page-header">
		<div class="page-header__text">
			<slot name="eyebrow" />
			<h1 class="page-header__title">{{ title }}</h1>
			<p v-if="subtitle" class="page-header__subtitle">{{ subtitle }}</p>
		</div>
		<div v-if="$slots.actions" class="page-header__actions">
			<slot name="actions" />
		</div>
	</header>
</template>

<style scoped>
.page-header {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	justify-content: space-between;
	gap: var(--tt-space-3);
}

.page-header__text {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-1);
	min-width: 0;
}

.page-header__title {
	overflow-wrap: anywhere;
}

.page-header__subtitle {
	margin: 0;
	color: var(--tt-text-muted);
	max-width: 65ch;
}

.page-header__actions {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-2);
}
</style>
