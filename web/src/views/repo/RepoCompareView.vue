<script setup lang="ts">
// Compare two revisions (`base...head`): commits on head since the merge base
// and the file diffs. The form edits the range in the URL.
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AsyncState from "../../components/AsyncState.vue";
import CommitList from "../../components/CommitList.vue";
import DiffFiles from "../../components/DiffFiles.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import { useApi } from "../../app/context.ts";
import { useResource } from "../../composables/resource.ts";
import { compareHref, parseRange, stringParam } from "../../router/params.ts";
import { shortSha } from "../../ui/format.ts";
import { useNodeView } from "./useNodeView.ts";

const route = useRoute();
const router = useRouter();
const api = useApi();
const rangeText = computed(() => stringParam(route.params, "range"));
const range = computed(() => parseRange(rangeText.value));
const node = useNodeView(() => `compare/${rangeText.value}`);
const repoPath = computed(() => node.data.value?.node.path ?? node.nodePath.value);

const compare = useResource(
	() => (node.data.value && range.value ? [repoPath.value, range.value.base, range.value.head] as const : null),
	(key) =>
		key ? api.browse.compare(key[0], key[1], key[2], { patch: true }) : Promise.resolve(null),
);

const base = ref("");
const head = ref("");
watch(range, (r) => {
	base.value = r?.base ?? node.data.value?.repo?.defaultBranch ?? "main";
	head.value = r?.head ?? "";
}, { immediate: true });

const submit = (): void => {
	if (base.value.trim() === "" || head.value.trim() === "") return;
	void router.push(compareHref(repoPath.value, base.value.trim(), head.value.trim()));
};
</script>

<template>
	<AsyncState
		:loading="node.loading.value"
		:error="node.error.value"
		:status="node.status.value"
		:ready="node.data.value !== null"
		what="this repository"
		@retry="node.reload"
	>
		<RepoFrame v-if="node.data.value" :view="node.data.value" :ctx="node.ctx.value" active="history" wide>
			<form class="compare-form tt-panel" @submit.prevent="submit">
				<label class="tt-field">
					<span>Base</span>
					<input v-model="base" class="tt-input" name="base" autocomplete="off" spellcheck="false" />
				</label>
				<span class="compare-form__dots" aria-hidden="true">…</span>
				<label class="tt-field">
					<span>Head</span>
					<input v-model="head" class="tt-input" name="head" autocomplete="off" spellcheck="false" />
				</label>
				<button type="submit" class="tt-button tt-button--primary">Compare</button>
			</form>
			<p v-if="!range" class="tt-muted">Enter a base and a head revision to compare.</p>
			<AsyncState
				v-else
				:loading="compare.loading.value"
				:error="compare.error.value"
				:status="compare.status.value"
				:ready="compare.data.value !== null"
				what="this comparison"
				@retry="compare.reload"
			>
				<div v-if="compare.data.value" class="tt-stack">
					<p class="tt-hint">
						<template v-if="compare.data.value.mergeBase">Merge base <code>{{ shortSha(compare.data.value.mergeBase) }}</code> · </template>
						{{ compare.data.value.commits.length }} commits · {{ compare.data.value.files.length }} files
					</p>
					<p v-if="compare.data.value.truncated" class="chip chip--warning">This comparison is truncated.</p>
					<CommitList v-if="compare.data.value.commits.length > 0" :repo="repoPath" :commits="compare.data.value.commits" />
					<DiffFiles :files="compare.data.value.files" />
				</div>
			</AsyncState>
		</RepoFrame>
	</AsyncState>
</template>

<style scoped>
.compare-form {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	gap: var(--tt-space-3);
}

.compare-form .tt-field {
	flex: 1 1 10rem;
}

.compare-form__dots {
	padding-bottom: var(--tt-space-3);
	color: var(--tt-text-muted);
}
</style>
