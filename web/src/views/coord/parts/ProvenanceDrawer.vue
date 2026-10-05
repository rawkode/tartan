<script setup lang="ts">
// The provenance drawer: the why answer for one commit
// (`GET /-/api/why?repo=&sha=`), or for the newest landing at a file or line
// (`?path=&line=`), as a side panel. A commit that did not land through an
// Advance has no note (404), and the drawer says so.
import { computed, onBeforeUnmount, onMounted } from "vue";
import type { WhyQuery } from "../../../api/client.ts";
import { useApi } from "../../../app/context.ts";
import AsyncState from "../../../components/AsyncState.vue";
import { useResource } from "../../../composables/resource.ts";
import { shortSha } from "../../../ui/format.ts";
import WhyNote from "./WhyNote.vue";

const props = defineProps<{
	repo: string;
	/** Exactly one of a commit or a file (with an optional line). */
	at: WhyQuery;
	closable?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const api = useApi();
const key = computed(() => JSON.stringify([props.repo, props.at]));
const why = useResource(key, () => api.land.why(props.repo, props.at));
const subject = computed(() =>
	"sha" in props.at && props.at.sha
		? `commit ${shortSha(props.at.sha)}`
		: "line" in props.at && props.at.line
		? `line ${props.at.line}`
		: "the newest landing"
);

const onKey = (event: KeyboardEvent) => {
	if (event.key === "Escape" && props.closable) emit("close");
};
onMounted(() => globalThis.addEventListener?.("keydown", onKey));
onBeforeUnmount(() => globalThis.removeEventListener?.("keydown", onKey));
</script>

<template>
	<aside class="drawer tt-stack" aria-label="Provenance" data-drawer>
		<header class="drawer__head">
			<h3 class="drawer__title">Provenance · {{ subject }}</h3>
			<button v-if="closable" type="button" class="tt-button tt-button--sm" @click="emit('close')">Close</button>
		</header>
		<AsyncState
			:loading="why.loading.value"
			:error="why.status.value === 404 ? null : why.error.value"
			:status="why.status.value"
			:ready="why.data.value !== null || why.status.value === 404"
			what="the why answer"
			@retry="why.reload"
		>
			<WhyNote v-if="why.data.value" :why="why.data.value" />
			<p v-else-if="'sha' in at" class="tt-muted">
				This commit has no why note: it did not land through an Advance.
			</p>
			<p v-else class="tt-muted">No landing through an Advance has touched this file yet.</p>
		</AsyncState>
	</aside>
</template>

<style scoped>
.drawer {
	min-width: 0;
}

.drawer__head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--tt-space-2);
}

.drawer__title {
	font-size: var(--tt-text-md);
	margin: 0;
}
</style>
