<script setup lang="ts">
// One commit: message, people, parents, trailers, the why-note summary (when
// it landed through an Advance) and the file diffs.
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import AsyncState from "../../components/AsyncState.vue";
import DiffFiles from "../../components/DiffFiles.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import { useApi } from "../../app/context.ts";
import { useResource } from "../../composables/resource.ts";
import { commitHref, stringParam, treeHref } from "../../router/params.ts";
import { repoCtx } from "../../slots/ctx.ts";
import { formatTime, isoTime, shortSha } from "../../ui/format.ts";
import { useNodeView } from "./useNodeView.ts";

const route = useRoute();
const api = useApi();
const sha = computed(() => stringParam(route.params, "sha"));
const node = useNodeView(
	() => `commit/${sha.value}`,
	(path) => repoCtx(path, { ref: sha.value }),
);
const repoPath = computed(() => node.data.value?.node.path ?? node.nodePath.value);

const commit = useResource(
	() => (node.data.value ? [repoPath.value, sha.value] as const : null),
	(key) => key ? api.browse.commit(key[0], key[1], { patch: true }) : Promise.resolve(null),
);

const body = computed(() => {
	const c = commit.data.value?.commit;
	if (!c) return "";
	const withoutSubject = c.message.split("\n").slice(1).join("\n").trim();
	const trailerKeys = new Set(c.trailers.map((t) => t.key));
	return withoutSubject
		.split("\n")
		.filter((line) => !trailerKeys.has(line.split(":")[0] ?? ""))
		.join("\n")
		.trim();
});
const additions = computed(() =>
	commit.data.value?.files.reduce((n, f) => n + f.additions, 0) ?? 0
);
const deletions = computed(() =>
	commit.data.value?.files.reduce((n, f) => n + f.deletions, 0) ?? 0
);
const note = computed(() => commit.data.value?.note?.kernel ?? null);
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
			<AsyncState
				:loading="commit.loading.value"
				:error="commit.error.value"
				:status="commit.status.value"
				:ready="commit.data.value !== null"
				what="this commit"
				@retry="commit.reload"
			>
				<article v-if="commit.data.value" class="commit tt-stack">
					<header class="tt-panel commit__head">
						<h2 class="commit__subject">{{ commit.data.value.commit.subject }}</h2>
						<pre v-if="body" class="commit__body">{{ body }}</pre>
						<dl class="commit__meta">
							<dt>Author</dt>
							<dd>
								{{ commit.data.value.commit.author.name }} ·
								<time :datetime="isoTime(commit.data.value.commit.authoredAt * 1000)">{{ formatTime(commit.data.value.commit.authoredAt * 1000) }}</time>
							</dd>
							<dt>Committer</dt>
							<dd>{{ commit.data.value.commit.committer.name }}</dd>
							<dt>Commit</dt>
							<dd><code>{{ commit.data.value.commit.sha }}</code></dd>
							<dt>Parents</dt>
							<dd>
								<template v-if="commit.data.value.commit.parents.length === 0">none (root commit)</template>
								<RouterLink
									v-for="parent in commit.data.value.commit.parents"
									:key="parent"
									:to="commitHref(repoPath, parent)"
									class="commit__parent"
								><code>{{ shortSha(parent) }}</code></RouterLink>
							</dd>
							<template v-for="trailer in commit.data.value.commit.trailers" :key="`${trailer.key}:${trailer.value}`">
								<dt>{{ trailer.key }}</dt>
								<dd><code>{{ trailer.value }}</code></dd>
							</template>
						</dl>
						<div class="tt-row">
							<RouterLink class="tt-button tt-button--sm" :to="treeHref(repoPath, commit.data.value.commit.sha)">Browse files</RouterLink>
						</div>
					</header>
					<section v-if="note" class="tt-panel" aria-labelledby="why-title">
						<h2 id="why-title" class="commit__section-title">Why this landed</h2>
						<p class="commit__why">{{ note.reason.summary }}</p>
						<p class="tt-hint">
							Lane on the <strong>{{ note.laneMode }}</strong> backend · checks {{ note.checks.state }}
							<template v-if="note.checks.evidenceReused"> (evidence reused)</template>
							· chain #{{ note.chain.seq }}
							<template v-if="note.seeded"> · <span class="chip chip--warning">seeded history</span></template>
						</p>
					</section>
					<section aria-labelledby="files-title" class="tt-stack">
						<h2 id="files-title" class="commit__section-title">
							{{ commit.data.value.files.length }} files changed
							<span class="commit__add">+{{ additions }}</span>
							<span class="commit__del">−{{ deletions }}</span>
						</h2>
						<DiffFiles :files="commit.data.value.files" />
					</section>
				</article>
			</AsyncState>
		</RepoFrame>
	</AsyncState>
</template>

<style scoped>
.commit__head {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-3);
}

.commit__subject {
	font-size: var(--tt-text-lg);
	overflow-wrap: anywhere;
}

.commit__body {
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.commit__meta {
	display: grid;
	grid-template-columns: minmax(6rem, max-content) minmax(0, 1fr);
	gap: var(--tt-space-1) var(--tt-space-4);
	margin: 0;
	font-size: var(--tt-text-sm);
}

.commit__meta dt {
	color: var(--tt-text-muted);
}

.commit__meta dd {
	margin: 0;
	min-width: 0;
	overflow-wrap: anywhere;
}

.commit__parent + .commit__parent {
	margin-inline-start: var(--tt-space-2);
}

.commit__section-title {
	font-size: var(--tt-text-md);
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-2);
}

.commit__why {
	margin: 0 0 var(--tt-space-2);
}

.commit__add {
	color: var(--tt-tone-success);
}

.commit__del {
	color: var(--tt-tone-danger);
}
</style>
