<script setup lang="ts">
// The global log tile (the forge Owner only): the K2 stream
// this forge relays its events into, how far the relay and the `workloads`
// consumer are, which transport CI runs use, how runs were dispatched in the
// last hour and the parked records (dead letters). Read from `GET
// /-/api/log/status` and `GET /-/api/log/dead`, which answer ids, counts,
// states and codes only.
import { computed } from "vue";
import { useApi } from "../app/context.ts";
import { useResource } from "../composables/resource.ts";
import { formatTime } from "../ui/format.ts";
import AsyncState from "./AsyncState.vue";

const api = useApi();
const status = useResource(() => 0, () => api.admin.logStatus());
const dead = useResource(
	() => status.data.value?.consumer !== null && status.data.value !== null,
	async (on) => (on ? await api.admin.logDead() : null),
);

const tone = (health: string): string =>
	health === "ok"
		? "chip--success"
		: health === "off" || health === "produce-only"
		? "chip--muted"
		: health === "degraded"
		? "chip--warning"
		: "chip--danger";

const transportText = computed(() =>
	status.data.value?.transport === "k2"
		? "CI runs are dispatched from the global log (K2), with an inline backstop"
		: "CI runs are dispatched inline"
);

const reload = async (): Promise<void> => {
	await status.reload();
	await dead.reload();
};
</script>

<template>
	<section class="tt-panel tt-stack" aria-labelledby="global-log-title" data-tile="global-log">
		<header class="glog__head">
			<h2 id="global-log-title" class="glog__title">Global log</h2>
			<button type="button" class="tt-button tt-button--sm" @click="reload">Refresh</button>
		</header>
		<AsyncState
			:loading="status.loading.value"
			:error="status.error.value"
			:status="status.status.value"
			:ready="status.data.value !== null"
			what="the global log"
			@retry="reload"
		>
			<template v-if="status.data.value">
				<p class="tt-row">
					<span class="chip" :class="tone(status.data.value.health)" :data-status="status.data.value.health">
						{{ status.data.value.health }}
					</span>
					<span class="tt-muted">{{ status.data.value.label }}</span>
				</p>
				<p v-if="status.data.value.health === 'off'" class="tt-hint">
					No global log on this forge: deploy with <code>--k2</code> to relay its events into a K2 stream.
				</p>
				<dl class="glog__kv">
					<dt>Stream</dt>
					<dd><code>{{ status.data.value.stream.name }}</code><template v-if="!status.data.value.stream.configured"> (not bound)</template></dd>
					<dt>Workload transport</dt>
					<dd :data-transport="status.data.value.transport">{{ transportText }}</dd>
					<template v-if="status.data.value.relay.forge">
						<dt>Relay</dt>
						<dd data-part="relay">
							{{ status.data.value.relay.forge.state }}: {{ status.data.value.relay.forge.relayedSeq }} of {{ status.data.value.relay.forge.head }} forge events relayed (lag {{ status.data.value.relay.forge.lag }})<template v-if="status.data.value.relay.forge.lastError">, last error <code>{{ status.data.value.relay.forge.lastError }}</code></template>
						</dd>
					</template>
					<template v-if="status.data.value.consumer">
						<dt>Consumer</dt>
						<dd data-part="consumer">
							{{ status.data.value.consumer.consume }}: {{ status.data.value.consumer.records }} records, {{ status.data.value.consumer.retry }} retrying, {{ status.data.value.consumer.dead }} dead<template v-if="status.data.value.consumer.consumerLagMs !== null">, lag {{ (status.data.value.consumer.consumerLagMs / 1000).toFixed(1) }} s</template>
						</dd>
					</template>
					<dt>Dispatched in the last hour</dt>
					<dd data-part="dispatched">
						{{ status.data.value.lastHour.k2 }} via K2, {{ status.data.value.lastHour.backstop }} by the backstop, {{ status.data.value.lastHour.local }} inline
					</dd>
				</dl>
				<template v-if="status.data.value.consumer">
					<h3 class="glog__subtitle">Dead letters</h3>
					<p v-if="dead.error.value" class="chip chip--warning" role="alert">{{ dead.error.value }}</p>
					<p v-else-if="dead.data.value && dead.data.value.dead.length === 0" data-part="dead-empty">No dead letters.</p>
					<ul v-else-if="dead.data.value" class="glog__dead" aria-label="Dead letters">
						<li v-for="d in dead.data.value.dead" :key="d.id">
							<code>{{ d.id }}</code> {{ d.type ?? "unknown type" }}: <code>{{ d.error }}</code>, {{ formatTime(d.at) }}
						</li>
					</ul>
				</template>
			</template>
		</AsyncState>
	</section>
</template>

<style scoped>
.glog__head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--tt-space-2);
}

.glog__title {
	font-size: var(--tt-text-md);
}

.glog__subtitle {
	font-size: var(--tt-text-sm);
	font-weight: 600;
}

.glog__kv {
	display: grid;
	grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr);
	gap: var(--tt-space-1) var(--tt-space-4);
	margin: 0;
}

.glog__kv dt {
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}

.glog__kv dd {
	margin: 0;
	min-width: 0;
	overflow-wrap: anywhere;
}

.glog__dead {
	margin: 0;
	padding-left: var(--tt-space-4);
}
</style>
