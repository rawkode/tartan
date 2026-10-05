<script setup lang="ts">
// Host for one dynamic slot instance: renders its `tartan-ui@1` document and
// runs its actions (see `controller.ts`). Each instance is its own request
// (its own I/O context server-side). The page's ctx hint is
// narrowed to what this instance's slot takes (`narrowCtx`) before every
// render and action.
import { computed, inject, onBeforeUnmount, onMounted, provide, watch } from "vue";
import { useRouter } from "vue-router";
import type { SlotInstanceDto } from "@tartan/contract/api.ts";
import { API, LIVE } from "../app/context.ts";
import type { SlotCtxHint } from "../api/client.ts";
import { useScheduler } from "../live/scheduler.ts";
import { useToasts } from "../shell/toasts.ts";
import { UI_ACTIONS, UI_DIFF_SOURCE, type UiActionRunner } from "../ui/context.ts";
import UiDocument from "../ui/UiDocument.vue";
import { createSlotController } from "./controller.ts";
import { ctxKey, narrowCtx } from "./ctx.ts";
import { useSlotRegistry } from "./registry.ts";

const props = defineProps<{
	instance: SlotInstanceDto;
	ctx: SlotCtxHint;
	repoId?: string;
	/** Hide the instance title (e.g. inside a tab that already names it). */
	bare?: boolean;
}>();

const api = inject(API, null);
const live = inject(LIVE, null);
const router = useRouter();
const toasts = useToasts();
const registry = useSlotRegistry();

const noApi = {
	slots: {
		render: () => Promise.reject(new Error("no API")),
		action: () => Promise.reject(new Error("no API")),
	},
};

const narrowed = computed(() => narrowCtx(props.instance.slot, props.ctx));
const controller = createSlotController({
	api: api ?? noApi,
	live,
	scheduler: useScheduler(),
	instance: props.instance,
	ctx: () => narrowed.value,
	repoId: () => props.repoId,
	navigate: (path) => void router.push(path),
	toast: (toast) => toasts.push(toast),
	refreshSlots: (ids) => registry?.refresh(ids),
	confirm: (text) => globalThis.confirm?.(text) ?? false,
});

const runner: UiActionRunner = {
	run: controller.runAction,
	busy: computed(() => controller.state.busy),
};
provide(UI_ACTIONS, runner);
if (api) {
	provide(UI_DIFF_SOURCE, async (request) => {
		const compare = await api.browse.compare(request.repo, request.base, request.head, {
			patch: true,
		});
		return compare.files;
	});
}

// In-view navigation (another change, lane, file or work item) keeps this
// host mounted: re-render with the new hint.
watch(
	() => `${props.repoId ?? ""}|${ctxKey(narrowed.value)}`,
	() => controller.reload(),
);

let unregister: (() => void) | null = null;
onMounted(() => {
	unregister = registry?.register(props.instance.id, controller.refresh) ?? null;
	controller.start();
});
onBeforeUnmount(() => {
	unregister?.();
	controller.stop();
});

const state = controller.state;
</script>

<template>
	<section
		class="slot-host"
		:data-slot="instance.slot"
		:data-ext="instance.ext"
		:aria-busy="state.loading || state.busy"
	>
		<h2 v-if="instance.title && !bare" class="slot-host__title">{{ instance.title }}</h2>
		<UiDocument v-if="state.doc" :doc="state.doc" />
		<p v-else-if="state.error" class="chip chip--danger">
			{{ instance.ext }}: {{ state.error }}
		</p>
		<div v-else class="slot-host__loading" aria-live="polite">
			<span class="visually-hidden">Loading {{ instance.title ?? instance.ext }}…</span>
		</div>
	</section>
</template>

<style scoped>
.slot-host {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
	min-width: 0;
}

.slot-host__title {
	font-size: var(--tt-text-sm);
	text-transform: uppercase;
	letter-spacing: 0.04em;
	color: var(--tt-text-muted);
	font-weight: 600;
}

.slot-host__loading {
	height: 3rem;
	border-radius: var(--tt-radius);
	background: linear-gradient(
		90deg,
		var(--tt-surface-sunken),
		var(--tt-surface),
		var(--tt-surface-sunken)
	);
	background-size: 200% 100%;
	animation: slot-shimmer 1.4s ease-in-out infinite;
}

@keyframes slot-shimmer {
	from {
		background-position: 100% 0;
	}
	to {
		background-position: -100% 0;
	}
}
</style>
