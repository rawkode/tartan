<script setup lang="ts">
// `/<repo>/-/p`: every project of the repo at the trunk tip (WP25 slice
// A′), grouped by the cuenv layer that holds it (or by top-level directory
// for workspace graphs), with what each depends on and what depends on it,
// the detector's warnings and what the scan skipped.
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import AsyncState from "../../components/AsyncState.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import { useResource } from "../../composables/resource.ts";
import { treeHref } from "../../router/params.ts";
import { provideSlotRegistry } from "../../slots/registry.ts";
import { useNodeView } from "../repo/useNodeView.ts";
import { graphSummary, projectHref, useProjects } from "./client.ts";
import { groupProjects, projectNotes } from "./model.ts";

provideSlotRegistry();
const node = useNodeView(() => "");
const client = useProjects();
const repoId = computed(() => node.data.value?.repo?.id ?? null);
const graph = useResource(
	() => repoId.value,
	(id) => id === null ? Promise.resolve(null) : client.list(id),
);
const filter = ref("");
const repoPath = computed(() => node.data.value?.node.path ?? node.nodePath.value);
const defaultBranch = computed(() =>
	node.data.value?.repo?.defaultBranch ?? node.data.value?.node.defaultBranch ?? "main"
);
const groups = computed(() => {
	const g = graph.data.value;
	if (!g) return [];
	const needle = filter.value.trim().toLowerCase();
	const shown = needle === ""
		? g.projects
		: g.projects.filter((p) =>
			p.name.toLowerCase().includes(needle) || p.root.toLowerCase().includes(needle)
		);
	return groupProjects(shown, g.layers.length > 0);
});
const bySlug = computed(() =>
	new Map((graph.data.value?.projects ?? []).map((p) => [p.name, p.slug]))
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
		<RepoFrame v-if="node.data.value" :view="node.data.value" :ctx="node.ctx.value" active="projects" wide>
			<AsyncState
				:loading="graph.loading.value"
				:error="graph.error.value"
				:status="graph.status.value"
				:ready="graph.data.value !== null"
				what="the projects"
				@retry="graph.reload"
			>
				<div v-if="graph.data.value" class="tt-stack projects">
					<div class="projects__head">
						<div>
							<h2 class="projects__title">Projects</h2>
							<p class="tt-hint" data-testid="projects-summary">{{ graphSummary(graph.data.value) }}</p>
						</div>
						<label class="tt-field projects__filter">
							<span class="visually-hidden">Filter projects</span>
							<input v-model="filter" class="tt-input" type="search" placeholder="Filter by name or path" />
						</label>
					</div>
					<p v-if="graph.data.value.truncated" class="chip chip--warning">
						The scan hit a limit: every change counts as touching every project.
					</p>
					<p v-if="graph.data.value.projects.length === 0" class="tt-muted">
						No projects were detected at the trunk tip.
					</p>
					<section v-for="group in groups" :key="group.key" class="tt-stack projects__group" :aria-label="group.label">
						<h3 class="projects__group-title">
							{{ group.label }}
							<span class="chip chip--muted">{{ group.projects.length }}</span>
						</h3>
						<div class="tt-scroll-x">
							<table class="tt-table">
								<thead>
									<tr>
										<th scope="col">Project</th>
										<th scope="col">Root</th>
										<th scope="col">Depends on</th>
										<th scope="col">Used by</th>
										<th scope="col"><span class="visually-hidden">Notes</span></th>
									</tr>
								</thead>
								<tbody>
									<tr v-for="p in group.projects" :key="p.key" :data-project="p.slug">
										<td><RouterLink :to="projectHref(repoPath, p.slug)">{{ p.name }}</RouterLink></td>
										<td><RouterLink class="projects__root" :to="treeHref(repoPath, defaultBranch, p.root)">{{ p.root }}</RouterLink></td>
										<td>
											<template v-for="(dep, i) in p.deps" :key="dep">
												<span v-if="i > 0">, </span>
												<RouterLink :to="projectHref(repoPath, bySlug.get(dep) ?? dep)">{{ dep }}</RouterLink>
											</template>
										</td>
										<td>
											<template v-for="(dep, i) in p.dependents" :key="dep">
												<span v-if="i > 0">, </span>
												<RouterLink :to="projectHref(repoPath, bySlug.get(dep) ?? dep)">{{ dep }}</RouterLink>
											</template>
										</td>
										<td>
											<span v-for="note in projectNotes(p)" :key="note.label" class="chip" :class="`chip--${note.tone}`" :title="note.title">{{ note.label }}</span>
										</td>
									</tr>
								</tbody>
							</table>
						</div>
					</section>
					<details v-if="graph.data.value.warnings.length > 0 || graph.data.value.skipped.length > 0" class="tt-panel projects__notes">
						<summary>Detection notes ({{ graph.data.value.warnings.length + graph.data.value.skipped.length }})</summary>
						<ul>
							<li v-for="s in graph.data.value.skipped" :key="`s:${s}`">
								<span class="chip chip--muted">skipped</span> <code>{{ s }}</code>
							</li>
							<li v-for="(w, i) in graph.data.value.warnings" :key="`w:${i}`">
								<span class="chip chip--muted">{{ w.code }}</span>
								<code v-if="w.path">{{ w.path }}</code> {{ w.message }}
							</li>
						</ul>
					</details>
				</div>
			</AsyncState>
		</RepoFrame>
	</AsyncState>
</template>

<style scoped>
.projects__head {
	display: flex;
	flex-wrap: wrap;
	align-items: flex-end;
	justify-content: space-between;
	gap: var(--tt-space-3);
}

.projects__title {
	font-size: var(--tt-text-lg);
}

.projects__filter {
	min-width: min(100%, 18rem);
}

.projects__group-title {
	display: flex;
	align-items: center;
	gap: var(--tt-space-2);
	font-size: var(--tt-text-md);
	font-family: var(--tt-font-mono);
}

.projects__root {
	font-family: var(--tt-font-mono);
	overflow-wrap: anywhere;
}

.projects__notes ul {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
	margin: var(--tt-space-3) 0 0;
	padding: 0;
	list-style: none;
}
</style>
