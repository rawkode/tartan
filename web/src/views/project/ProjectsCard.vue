<script setup lang="ts">
// The repo overview's Projects card (WP25 slice A′):
// "38 cuenv projects found (textual scan) · 3 layers · 1 nested module
// skipped", the first projects as links, and a link to the full list. It
// renders nothing while projects are off on the forge (404), when the repo
// has no projects, or when the request fails: the overview never breaks
// for it.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import TtIcon from "../../components/TtIcon.vue";
import { useResource } from "../../composables/resource.ts";
import { graphSummary, projectHref, useProjects } from "./client.ts";

const props = defineProps<{
	repoId: string;
	repoPath: string;
}>();

/** Projects named on the card (the rest are one click away). */
const PREVIEW = 6;

const client = useProjects();
const graph = useResource(() => props.repoId, (id) => client.list(id));

const data = computed(() => {
	const g = graph.data.value;
	return g !== null && g.projects.length > 0 ? g : null;
});
/** Projects with dependents first (where a change reaches furthest), then by name. */
const preview = computed(() =>
	[...(data.value?.projects ?? [])]
		.sort((a, b) =>
			b.dependents.length - a.dependents.length || a.name.localeCompare(b.name)
		)
		.slice(0, PREVIEW)
);
const more = computed(() =>
	Math.max(0, (data.value?.projects.length ?? 0) - preview.value.length)
);
</script>

<template>
	<section v-if="data" class="tt-panel projects-card" aria-labelledby="projects-card-title" data-testid="projects-card">
		<div class="projects-card__head">
			<h2 id="projects-card-title" class="projects-card__title">
				<TtIcon name="folder" /> Projects
			</h2>
			<RouterLink class="tt-button tt-button--sm" :to="projectHref(repoPath)">All projects</RouterLink>
		</div>
		<p class="tt-hint" data-testid="projects-summary">{{ graphSummary(data) }}</p>
		<p v-if="data.truncated" class="chip chip--warning">
			The scan hit a limit: every change counts as touching every project.
		</p>
		<ul class="projects-card__list">
			<li v-for="p in preview" :key="p.key" class="projects-card__item">
				<RouterLink :to="projectHref(repoPath, p.slug)">{{ p.name }}</RouterLink>
				<span class="tt-muted projects-card__root">{{ p.root }}</span>
				<span v-if="p.dependents.length > 0" class="chip chip--muted" :title="p.dependents.join(', ')">
					{{ p.dependents.length }} {{ p.dependents.length === 1 ? "dependent" : "dependents" }}
				</span>
			</li>
		</ul>
		<RouterLink v-if="more > 0" class="projects-card__more" :to="projectHref(repoPath)">
			and {{ more }} more
		</RouterLink>
	</section>
</template>

<style scoped>
.projects-card {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-3);
}

.projects-card__head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--tt-space-2);
}

.projects-card__title {
	display: flex;
	align-items: center;
	gap: var(--tt-space-2);
	font-size: var(--tt-text-md);
}

.projects-card__list {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
	gap: var(--tt-space-2) var(--tt-space-4);
	margin: 0;
	padding: 0;
	list-style: none;
}

.projects-card__item {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: var(--tt-space-1) var(--tt-space-2);
	min-width: 0;
	overflow-wrap: anywhere;
}

.projects-card__root {
	font-size: var(--tt-text-sm);
	font-family: var(--tt-font-mono);
}

.projects-card__more {
	font-size: var(--tt-text-sm);
}
</style>
