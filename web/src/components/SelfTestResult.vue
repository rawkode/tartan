<script setup lang="ts">
// The post-claim lane-repo self-test result: ✓ with the
// seed and its time, or a warning with the fix hint. A failure never changes
// a setting: new lanes fall back to branch lanes on their own.
import type { LaneSelfTestResult } from "@tartan/contract/api.ts";
import { formatTime } from "../ui/format.ts";
import TtIcon from "./TtIcon.vue";

defineProps<{ result: LaneSelfTestResult }>();

const HINTS: Readonly<Record<string, string>> = {
	"importer-unreachable":
		"The importer never reached this forge. Your zone's security features (WAF, Bot Fight Mode, Access) may block /-/cap/*; allow that path.",
};
</script>

<template>
	<div class="selftest" :class="result.ok ? 'selftest--ok' : 'selftest--warn'" role="status">
		<TtIcon :name="result.ok ? 'check' : 'alert'" :label="result.ok ? 'passed' : 'warning'" />
		<div class="selftest__text">
			<p class="selftest__title">
				<template v-if="result.ok">
					Per-agent lane repos work<template v-if="result.seed"> (seeded with {{ result.seed }}<template v-if="result.seedMs !== undefined"> in {{ (result.seedMs / 1000).toFixed(1) }} s</template>)</template>.
				</template>
				<template v-else>
					Per-agent lane repos are not working<template v-if="result.code"> (<code>{{ result.code }}</code>)</template>.
				</template>
			</p>
			<p v-if="!result.ok" class="selftest__hint">
				{{ result.hint ?? (result.code ? HINTS[result.code] : undefined) ?? "See the forge's logs for details." }}
			</p>
			<p v-if="!result.ok" class="tt-hint">Nothing was changed: agents get branch lanes until this passes.</p>
			<p class="tt-hint">Last run {{ formatTime(result.at) }}</p>
		</div>
	</div>
</template>

<style scoped>
.selftest {
	display: flex;
	gap: var(--tt-space-3);
	padding: var(--tt-space-3);
	border-radius: var(--tt-radius);
	border: 1px solid currentColor;
}

.selftest--ok {
	color: var(--tt-tone-success);
	background: var(--tt-tone-success-bg);
}

.selftest--warn {
	color: var(--tt-tone-warning);
	background: var(--tt-tone-warning-bg);
}

.selftest__text {
	color: var(--tt-text);
	min-width: 0;
}

.selftest__title,
.selftest__hint {
	margin: 0;
	overflow-wrap: anywhere;
}

.selftest__title {
	font-weight: 600;
}
</style>
