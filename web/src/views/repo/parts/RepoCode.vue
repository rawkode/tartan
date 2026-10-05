<script setup lang="ts">
// Repo code: the tree at a ref and path, the clone URL and the README of the
// directory (repo markdown renders through the same safe renderer as
// `markdown` nodes: no raw HTML, links checked). Used by the tree route and
// by the repo's home page.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import type { ViewResponse } from "@tartan/contract/api.ts";
import type { SlotCtxHint } from "../../../api/client.ts";
import AsyncState from "../../../components/AsyncState.vue";
import CopyField from "../../../components/CopyField.vue";
import RepoFrame from "../../../components/RepoFrame.vue";
import TtIcon from "../../../components/TtIcon.vue";
import { useApi } from "../../../app/context.ts";
import { useResource } from "../../../composables/resource.ts";
import { blobHref, logHref, pathCrumbs, treeHref } from "../../../router/params.ts";
import UiMarkdown from "../../../ui/nodes/UiMarkdown.ts";
import ProjectsCard from "../../project/ProjectsCard.vue";

const props = defineProps<{
	view: ViewResponse;
	ctx: SlotCtxHint;
	/** Empty means the default branch. */
	refName: string;
	path: string;
}>();

const api = useApi();
const loc = computed(() => ({ path: props.path }));
const repoPath = computed(() => props.view.node.path);
const ref = computed(() =>
	props.refName || props.view.repo?.defaultBranch || props.view.node.defaultBranch || "main"
);

const tree = useResource(
	() => [repoPath.value, ref.value, props.path] as const,
	(key) => api.browse.tree(key[0], key[1], key[2]),
);

const readmeEntry = computed(() =>
	tree.data.value?.entries.find((e) => e.type === "blob" && /^readme(\.md)?$/i.test(e.name)) ?? null
);
const readme = useResource(
	() => (readmeEntry.value ? readmeEntry.value.path : null),
	(path) => path ? api.browse.blob(repoPath.value, ref.value, path) : Promise.resolve(null),
);

const cloneUrl = computed(() =>
	typeof globalThis.location === "undefined"
		? `/${repoPath.value}.git`
		: `${globalThis.location.origin}/${repoPath.value}.git`
);

const crumbs = computed(() => pathCrumbs(loc.value.path));
/** The repo's home (default branch, root): where the Projects card lives (WP25). */
const isHome = computed(() => props.refName === "" && props.path === "");
const parent = computed(() => {
	const parts = loc.value.path.split("/").filter((p) => p !== "");
	return parts.length === 0 ? null : parts.slice(0, -1).join("/");
});
</script>

<template>
	<RepoFrame :view="view" :ctx="ctx" active="code">
			<div class="tree-toolbar">
				<span class="chip chip--muted" title="Ref"><TtIcon name="branch" /> {{ ref }}</span>
				<nav class="tree-path" aria-label="Path">
					<RouterLink :to="treeHref(repoPath, ref)">{{ view.node.slug }}</RouterLink>
					<template v-for="crumb in crumbs" :key="crumb.path">
						<span aria-hidden="true">/</span>
						<RouterLink :to="treeHref(repoPath, ref, crumb.path)">{{ crumb.name }}</RouterLink>
					</template>
				</nav>
				<RouterLink class="tt-button tt-button--sm" :to="logHref(repoPath, ref, loc.path)">History</RouterLink>
			</div>
			<AsyncState
				:loading="tree.loading.value"
				:error="tree.error.value"
				:status="tree.status.value"
				:ready="tree.data.value !== null"
				what="this path"
				@retry="tree.reload"
			>
				<div v-if="tree.data.value" class="tt-scroll-x tree-box">
					<table class="tt-table tree-table">
						<caption class="visually-hidden">Files in {{ loc.path || "the repository root" }}</caption>
						<tbody>
							<tr v-if="parent !== null">
								<td colspan="2">
									<RouterLink :to="treeHref(repoPath, ref, parent)" aria-label="Parent directory">..</RouterLink>
								</td>
							</tr>
							<tr v-for="entry in tree.data.value.entries" :key="entry.path">
								<td class="tree-table__icon">
									<TtIcon :name="entry.type === 'tree' ? 'folder' : 'file'" />
								</td>
								<td>
									<RouterLink
										v-if="entry.type === 'tree'"
										:to="treeHref(repoPath, ref, entry.path)"
									>{{ entry.name }}</RouterLink>
									<RouterLink
										v-else-if="entry.type === 'blob' || entry.type === 'exec'"
										:to="blobHref(repoPath, ref, entry.path)"
									>{{ entry.name }}</RouterLink>
									<span v-else>{{ entry.name }} <span class="chip chip--muted">{{ entry.type }}</span></span>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			</AsyncState>
			<CopyField label="Clone over HTTPS" :value="cloneUrl" />
			<ProjectsCard
				v-if="isHome && view.repo?.id"
				:repo-id="view.repo.id"
				:repo-path="repoPath"
			/>
			<section v-if="readme.data.value?.text" class="tt-panel readme" aria-labelledby="readme-title">
				<h2 id="readme-title" class="readme__title">
					<TtIcon name="file" /> {{ readme.data.value.path }}
				</h2>
				<UiMarkdown :md="readme.data.value.text" />
			</section>
	</RepoFrame>
</template>

<style scoped>
.tree-toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-2) var(--tt-space-3);
}

.tree-path {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-1);
	flex: 1 1 auto;
	min-width: 0;
	overflow-wrap: anywhere;
}

.tree-box {
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	background: var(--tt-surface);
}

.tree-table td {
	padding-block: var(--tt-space-2);
}

.tree-table tr:last-child td {
	border-bottom: 0;
}

.tree-table__icon {
	width: 1.5rem;
	color: var(--tt-text-muted);
}

.readme__title {
	display: flex;
	align-items: center;
	gap: var(--tt-space-2);
	font-size: var(--tt-text-sm);
	color: var(--tt-text-muted);
	margin-bottom: var(--tt-space-3);
}
</style>
