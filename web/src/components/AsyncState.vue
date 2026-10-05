<script setup lang="ts">
// Loading / error / not-found wrapper for a resource; renders the default
// slot once data is there.
defineProps<{
	loading: boolean;
	error: string | null;
	status?: number | null;
	ready: boolean;
	what?: string;
}>();
defineEmits<{ retry: [] }>();
</script>

<template>
	<slot v-if="ready" />
	<div v-else-if="error" class="async-state async-state--error" role="alert">
		<p class="async-state__title">
			{{ status === 404 ? `${what ?? "This page"} was not found.` : status === 401 || status === 403 ? `You do not have access to ${what ?? "this page"}.` : error }}
		</p>
		<p v-if="status === 401" class="tt-hint">Sign in and try again.</p>
		<button type="button" class="tt-button tt-button--sm" @click="$emit('retry')">Try again</button>
	</div>
	<div v-else-if="loading" class="async-state" aria-live="polite">
		<span class="async-state__spinner" aria-hidden="true" />
		<span>Loading {{ what ?? "" }}…</span>
	</div>
</template>

<style scoped>
.async-state {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-3);
	padding: var(--tt-space-4);
	color: var(--tt-text-muted);
}

.async-state--error {
	flex-direction: column;
	align-items: flex-start;
	border: 1px solid var(--tt-tone-danger);
	border-radius: var(--tt-radius);
	background: var(--tt-tone-danger-bg);
	color: var(--tt-text);
}

.async-state__title {
	margin: 0;
	font-weight: 600;
}

.async-state__spinner {
	width: 1rem;
	height: 1rem;
	border: 2px solid var(--tt-border);
	border-top-color: var(--tt-accent);
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
}

@keyframes spin {
	to {
		transform: rotate(360deg);
	}
}
</style>
