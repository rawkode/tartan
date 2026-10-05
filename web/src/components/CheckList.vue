<script setup lang="ts">
// ✓/✗ list of environment checks, each with its message and fix hint.
import type { EnvironmentCheck } from "@tartan/contract/api.ts";
import TtIcon from "./TtIcon.vue";

defineProps<{ checks: readonly EnvironmentCheck[]; pending?: readonly string[] }>();

const NAMES: Readonly<Record<EnvironmentCheck["id"], string>> = {
	artifacts: "Artifacts (git storage)",
	loader: "Dynamic Workers",
	containers: "Containers (CI and git jobs)",
	ai: "Workers AI",
	r2: "R2 bucket",
	origin: "Forge address",
	"lane-repos": "Per-agent lane repos",
};
</script>

<template>
	<ul class="checks">
		<li
			v-for="check in checks"
			:key="check.id"
			class="checks__item"
			:class="check.ok ? 'checks__item--ok' : check.optional ? 'checks__item--warn' : 'checks__item--fail'"
		>
			<TtIcon
				:name="check.ok ? 'check' : pending?.includes(check.id) ? 'clock' : check.optional ? 'alert' : 'x'"
				:label="check.ok ? 'passed' : pending?.includes(check.id) ? 'retrying' : check.optional ? 'warning' : 'failed'"
			/>
			<div class="checks__text">
				<p class="checks__name">
					{{ NAMES[check.id] ?? check.id }}
					<span v-if="check.optional" class="chip chip--muted">optional</span>
				</p>
				<p class="checks__message">{{ check.message }}</p>
				<p v-if="check.hint && !check.ok" class="checks__hint">{{ check.hint }}</p>
			</div>
		</li>
	</ul>
</template>

<style scoped>
.checks {
	margin: 0;
	padding: 0;
	list-style: none;
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
}

.checks__item {
	display: flex;
	gap: var(--tt-space-3);
	padding: var(--tt-space-3);
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	background: var(--tt-surface);
}

.checks__item--ok {
	color: var(--tt-tone-success);
}

.checks__item--warn {
	color: var(--tt-tone-warning);
}

.checks__item--fail {
	color: var(--tt-tone-danger);
}

.checks__text {
	color: var(--tt-text);
	min-width: 0;
}

.checks__name {
	margin: 0;
	font-weight: 600;
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-2);
}

.checks__message,
.checks__hint {
	margin: 0;
	overflow-wrap: anywhere;
}

.checks__hint {
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}
</style>
