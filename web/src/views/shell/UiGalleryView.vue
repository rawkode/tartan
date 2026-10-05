<script setup lang="ts">
// `/-/ui`: every `tartan-ui@1` node type through the real renderer, plus the
// host error chip and an invalid node, so the renderer can be checked by eye
// (light/dark, 375 px). Actions here only show a toast.
import { provide, ref } from "vue";
import PageHeader from "../../components/PageHeader.vue";
import { useToasts } from "../../shell/toasts.ts";
import { UI_ACTIONS, type UiActionRunner } from "../../ui/context.ts";
import { NODE_SAMPLES } from "../../ui/samples.ts";
import UiNode from "../../ui/UiNode.vue";
import { UI_NODE_TYPES } from "../../ui/nodeTypes.ts";

const toasts = useToasts();
const busy = ref(false);
const runner: UiActionRunner = {
	busy,
	run: (action, payload) => {
		toasts.push({
			tone: "info",
			text: `Action ${action.id}${payload === undefined ? "" : " with payload"}`,
		});
		return Promise.resolve();
	},
};
provide(UI_ACTIONS, runner);

const extras: { label: string; node: unknown }[] = [
	{ label: "error-chip (host only)", node: { t: "error-chip", text: "acme.radar: render failed" } },
	{ label: "invalid node", node: { t: "text", text: "x", innerHTML: "<img src=x>" } },
	{ label: "unknown type", node: { t: "iframe", src: "https://evil.example" } },
];
</script>

<template>
	<div class="tt-stack">
		<PageHeader title="UI nodes" subtitle="Every tartan-ui@1 node type, rendered by the host components." />
		<section v-for="t in UI_NODE_TYPES" :key="t" class="gallery__item tt-panel">
			<h2 class="gallery__name"><code>{{ t }}</code></h2>
			<UiNode :node="NODE_SAMPLES[t]" />
		</section>
		<section v-for="extra in extras" :key="extra.label" class="gallery__item tt-panel">
			<h2 class="gallery__name">{{ extra.label }}</h2>
			<UiNode :node="extra.node" />
		</section>
	</div>
</template>

<style scoped>
.gallery__item {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-3);
}

.gallery__name {
	font-size: var(--tt-text-sm);
	color: var(--tt-text-muted);
	font-weight: 600;
}
</style>
