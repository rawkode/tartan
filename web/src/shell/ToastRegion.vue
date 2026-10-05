<script setup lang="ts">
// Polite live region for toasts (action results, copy confirmations, errors).
import { useToasts } from "./toasts.ts";

const toasts = useToasts();
</script>

<template>
	<div class="toasts" role="status" aria-live="polite">
		<div
			v-for="toast in toasts.items"
			:key="toast.id"
			class="toast"
			:class="`toast--${toast.tone}`"
		>
			<span class="toast__text">{{ toast.text }}</span>
			<button
				type="button"
				class="toast__close"
				aria-label="Dismiss"
				@click="toasts.dismiss(toast.id)"
			>×</button>
		</div>
	</div>
</template>

<style scoped>
.toasts {
	position: fixed;
	inset-inline: var(--tt-gutter);
	bottom: var(--tt-space-4);
	z-index: 40;
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: var(--tt-space-2);
	pointer-events: none;
}

.toast {
	display: flex;
	align-items: center;
	gap: var(--tt-space-3);
	max-width: min(32rem, 100%);
	padding: var(--tt-space-2) var(--tt-space-2) var(--tt-space-2) var(--tt-space-4);
	border-radius: var(--tt-radius);
	background: var(--tt-surface);
	border: 1px solid var(--tt-border);
	border-inline-start: 4px solid var(--tt-tone-neutral);
	box-shadow: var(--tt-shadow);
	pointer-events: auto;
}

.toast__text {
	overflow-wrap: anywhere;
}

.toast--info {
	border-inline-start-color: var(--tt-tone-info);
}
.toast--success {
	border-inline-start-color: var(--tt-tone-success);
}
.toast--warning {
	border-inline-start-color: var(--tt-tone-warning);
}
.toast--danger {
	border-inline-start-color: var(--tt-tone-danger);
}

.toast__close {
	width: 2.75rem;
	height: 2.75rem;
	border: 0;
	background: none;
	font-size: 1.25rem;
	cursor: pointer;
	color: var(--tt-text-muted);
}
</style>
