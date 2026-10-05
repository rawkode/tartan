<script setup lang="ts">
// A whole `tartan-ui@1` document (`{v:1, root}`) or the host error chip
// document. Anything that is not a version-1 document renders the fallback.
import { computed } from "vue";
import UiFallback from "./nodes/UiFallback.vue";
import UiNode from "./UiNode.vue";

const props = defineProps<{ doc: unknown }>();

const root = computed((): { ok: true; node: unknown } | { ok: false } => {
	const doc = props.doc;
	if (
		typeof doc === "object" && doc !== null && !Array.isArray(doc) &&
		(doc as { v?: unknown }).v === 1 && "root" in doc
	) {
		return { ok: true, node: (doc as { root: unknown }).root };
	}
	return { ok: false };
});
</script>

<template>
	<div class="ui-doc">
		<UiNode v-if="root.ok" :node="root.node" />
		<UiFallback v-else kind="unsupported" text="unsupported document" />
	</div>
</template>

<style scoped>
.ui-doc {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
	min-width: 0;
}
</style>
