<script setup lang="ts">
// History at a ref (optionally for one path), paged by the API cursor.
import { computed, ref, shallowRef, watch } from "vue";
import { useRoute } from "vue-router";
import type { CommitMeta } from "@tartan/contract/git.ts";
import AsyncState from "../../components/AsyncState.vue";
import CommitList from "../../components/CommitList.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import { useApi } from "../../app/context.ts";
import { errorMessage } from "../../api/http.ts";
import { refAndPath } from "../../router/params.ts";
import { repoCtx } from "../../slots/ctx.ts";
import { useNodeView } from "./useNodeView.ts";

const route = useRoute();
const api = useApi();
const loc = computed(() => refAndPath(route.params, ""));
const node = useNodeView(
	() => `commits/${loc.value.ref}${loc.value.path ? `/${loc.value.path}` : ""}`,
	(path) => repoCtx(path, { ref: loc.value.ref }),
);
const repoPath = computed(() => node.data.value?.node.path ?? node.nodePath.value);
const refName = computed(() =>
	loc.value.ref || node.data.value?.repo?.defaultBranch || "main"
);

const commits = shallowRef<readonly CommitMeta[]>([]);
const cursor = ref<string | undefined>(undefined);
const loading = ref(false);
const error = ref<string | null>(null);
let generation = 0;

const load = async (reset: boolean): Promise<void> => {
	const mine = reset ? ++generation : generation;
	loading.value = true;
	error.value = null;
	try {
		const page = await api.browse.log(
			repoPath.value,
			refName.value,
			loc.value.path || undefined,
			reset ? undefined : cursor.value,
		);
		if (mine !== generation) return;
		commits.value = reset ? page.commits : [...commits.value, ...page.commits];
		cursor.value = page.cursor;
	} catch (e) {
		if (mine === generation) error.value = errorMessage(e);
	} finally {
		if (mine === generation) loading.value = false;
	}
};

watch(
	() => (node.data.value ? `${repoPath.value}@${refName.value}:${loc.value.path}` : null),
	(key) => {
		if (key !== null) void load(true);
	},
	{ immediate: true },
);
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
		<RepoFrame v-if="node.data.value" :view="node.data.value" :ctx="node.ctx.value" active="history">
			<h2 class="log-title">
				History of <code>{{ refName }}</code><template v-if="loc.path"> · <code>{{ loc.path }}</code></template>
			</h2>
			<CommitList v-if="commits.length > 0" :repo="repoPath" :commits="commits" />
			<p v-else-if="!loading && !error" class="tt-muted">No commits.</p>
			<p v-if="error" class="chip chip--danger" role="alert">{{ error }}</p>
			<button
				v-if="cursor"
				type="button"
				class="tt-button"
				:disabled="loading"
				@click="load(false)"
			>{{ loading ? "Loading…" : "Load more" }}</button>
		</RepoFrame>
	</AsyncState>
</template>

<style scoped>
.log-title {
	font-size: var(--tt-text-md);
	overflow-wrap: anywhere;
}
</style>
