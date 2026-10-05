<script setup lang="ts">
// `diff`: an inline `patch` renders as text; `repo`/`base`/`head` make the
// host fetch the comparison under the VIEWER's authz, optionally
// limited to `paths`. Without a host diff source the node says so.
import { inject, onMounted, ref } from "vue";
import type { FileDiff } from "@tartan/contract/git.ts";
import DiffFiles from "../../components/DiffFiles.vue";
import DiffPatch from "../../components/DiffPatch.vue";
import { UI_DIFF_SOURCE } from "../context.ts";

const props = defineProps<{
	repo?: string;
	base?: string;
	head?: string;
	source?: string;
	paths?: readonly string[];
	patch?: string;
}>();

const fetchDiff = inject(UI_DIFF_SOURCE, null);
const files = ref<readonly FileDiff[] | null>(null);
const error = ref<string | null>(null);
const remote = props.patch === undefined && props.repo !== undefined &&
	props.base !== undefined && props.head !== undefined;

onMounted(async () => {
	if (!remote || !fetchDiff || !props.repo || !props.base || !props.head) {
		return;
	}
	try {
		const all = await fetchDiff({
			repo: props.repo,
			base: props.base,
			head: props.head,
			paths: props.paths,
		});
		const wanted = props.paths ? new Set(props.paths) : null;
		files.value = wanted ? all.filter((f) => wanted.has(f.path)) : all;
	} catch (e) {
		error.value = e instanceof Error ? e.message : "could not load the diff";
	}
});
</script>

<template>
	<div class="ui-diff">
		<p v-if="source" class="ui-diff__source">{{ source }}</p>
		<DiffPatch v-if="patch !== undefined" :patch="patch" />
		<template v-else-if="remote">
			<p v-if="!fetchDiff" class="tt-muted">Diff unavailable here.</p>
			<p v-else-if="error" class="chip chip--danger">{{ error }}</p>
			<p v-else-if="files === null" class="tt-muted" aria-live="polite">Loading diff…</p>
			<DiffFiles v-else :files="files" />
		</template>
		<p v-else class="tt-muted">Empty diff.</p>
	</div>
</template>

<style scoped>
.ui-diff {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
	min-width: 0;
}

.ui-diff__source {
	margin: 0;
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}
</style>
