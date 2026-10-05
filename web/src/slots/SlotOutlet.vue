<script setup lang="ts">
// Renders every dynamic instance of the given catalogue slot(s) from a
// `ViewResponse`, in contribution order. Exported for WP19's views.
import { computed } from "vue";
import type { SlotInstanceDto } from "@tartan/contract/api.ts";
import type { SlotCtxHint } from "../api/client.ts";
import SlotHost from "./SlotHost.vue";

const props = defineProps<{
	slots: readonly SlotInstanceDto[];
	/** Catalogue slot id(s) to render, e.g. `change.panel`. */
	slotId: string | readonly string[];
	ctx: SlotCtxHint;
	repoId?: string;
	/** Only this contribution id (e.g. the selected `change.tab`). */
	only?: string;
}>();

const wanted = computed(() =>
	new Set(typeof props.slotId === "string" ? [props.slotId] : props.slotId)
);
const instances = computed(() =>
	props.slots
		.filter((s) => wanted.value.has(s.slot))
		.filter((s) => props.only === undefined || s.id === props.only)
		.slice()
		.sort((a, b) => a.order - b.order)
);
</script>

<template>
	<div v-if="instances.length > 0" class="slot-outlet">
		<SlotHost
			v-for="instance in instances"
			:key="`${instance.installationId}/${instance.slot}/${instance.id}`"
			:instance="instance"
			:ctx="ctx"
			:repo-id="repoId"
			:bare="only !== undefined"
		/>
	</div>
	<slot v-else name="empty" />
</template>

<style scoped>
.slot-outlet {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-4);
	min-width: 0;
}
</style>
