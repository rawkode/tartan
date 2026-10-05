<script setup lang="ts">
// One land batch (WP19; WP10's `GET /-/api/advances/<batchId>?repo=<path>`):
// state, attempt, the trunk it composed on, the candidate, and each change
// with its lane, outcome and landed commit. A landed commit's why answer
// (`GET /-/api/why?sha=`) is shown below it.
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useApi } from "../../app/context.ts";
import AsyncState from "../../components/AsyncState.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import { useResource } from "../../composables/resource.ts";
import { changeHref, commitHref, stringParam } from "../../router/params.ts";
import { formatTime, isoTime, shortSha } from "../../ui/format.ts";
import { useNodeView } from "../repo/useNodeView.ts";
import { advancesHref, batchTone, laneHref } from "./landing.ts";
import WhyNote from "./parts/WhyNote.vue";

const api = useApi();
const route = useRoute();
const batchId = computed(() => stringParam(route.params, "batchId"));
const node = useNodeView(() => "advances");
const repoPath = computed(() => node.data.value?.node.path ?? node.nodePath.value);

const NONE = Symbol("none");
const batch = useResource(
	() => (node.data.value ? [repoPath.value, batchId.value] as const : NONE),
	(key) =>
		key === NONE ? Promise.resolve(null) : api.land.batch(key[0], key[1]),
);

const branch = (ref: string): string => ref.replace(/^refs\/heads\//, "");

const landedCommit = computed(() =>
	batch.data.value?.changes.find((c) => c.outcome === "landed" && c.commit)
		?.commit ?? null
);
const why = useResource(
	() => (landedCommit.value ? [repoPath.value, landedCommit.value] as const : NONE),
	(key) =>
		key === NONE
			? Promise.resolve(null)
			: api.land.why(key[0], { sha: key[1] }),
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
		<RepoFrame v-if="node.data.value" :view="node.data.value" :ctx="node.ctx.value" active="advances" wide>
			<div class="tt-stack">
				<p class="tt-row">
					<RouterLink :to="advancesHref(repoPath)">All advances</RouterLink>
				</p>
				<AsyncState
					:loading="batch.loading.value"
					:error="batch.error.value"
					:status="batch.status.value"
					:ready="batch.data.value !== null"
					what="this batch"
					@retry="batch.reload"
				>
					<template v-if="batch.data.value">
						<header class="tt-row">
							<h2 class="batch__title">Batch <code>{{ batch.data.value.batchId }}</code></h2>
							<span class="chip" :class="`chip--${batchTone(batch.data.value.state)}`">{{ batch.data.value.state }}</span>
							<span class="chip chip--muted">attempt {{ batch.data.value.attempt }}</span>
						</header>
						<dl class="batch__facts">
							<dt>Target</dt>
							<dd><code>{{ branch(batch.data.value.ref) }}</code></dd>
							<dt>Base</dt>
							<dd><RouterLink :to="commitHref(repoPath, batch.data.value.baseSha)"><code>{{ shortSha(batch.data.value.baseSha) }}</code></RouterLink></dd>
							<template v-if="batch.data.value.candidateSha">
								<dt>Candidate</dt>
								<dd><code>{{ shortSha(batch.data.value.candidateSha) }}</code></dd>
							</template>
							<template v-if="batch.data.value.advanceId">
								<dt>Advance</dt>
								<dd><code>{{ batch.data.value.advanceId }}</code></dd>
							</template>
							<dt>Submitted</dt>
							<dd><time :datetime="isoTime(batch.data.value.createdAt)">{{ formatTime(batch.data.value.createdAt) }}</time></dd>
							<template v-if="batch.data.value.finishedAt">
								<dt>Finished</dt>
								<dd><time :datetime="isoTime(batch.data.value.finishedAt)">{{ formatTime(batch.data.value.finishedAt) }}</time></dd>
							</template>
						</dl>
						<h3 class="batch__subtitle">Changes</h3>
						<div class="tt-scroll-x">
							<table class="tt-table landing-table">
								<thead>
									<tr>
										<th scope="col">Change</th>
										<th scope="col">Lane</th>
										<th scope="col">Outcome</th>
										<th scope="col">Commit</th>
									</tr>
								</thead>
								<tbody>
									<tr v-for="change in batch.data.value.changes" :key="change.changeId">
										<td><RouterLink :to="changeHref(repoPath, change.changeId)"><code>{{ change.changeId.slice(0, 12) }}</code></RouterLink></td>
										<td><RouterLink :to="laneHref(repoPath, change.laneId)"><code>{{ change.laneId }}</code></RouterLink></td>
										<td>{{ change.outcome ?? "pending" }}</td>
										<td>
											<RouterLink v-if="change.commit" :to="commitHref(repoPath, change.commit)"><code>{{ shortSha(change.commit) }}</code></RouterLink>
											<span v-else class="tt-muted">—</span>
										</td>
									</tr>
								</tbody>
							</table>
						</div>
						<WhyNote v-if="why.data.value" :why="why.data.value" />
						<p v-else-if="why.error.value && why.status.value !== 404" class="chip chip--danger" role="alert">{{ why.error.value }}</p>
					</template>
				</AsyncState>
			</div>
		</RepoFrame>
	</AsyncState>
</template>

<style scoped>
.batch__title,
.batch__subtitle {
	font-size: var(--tt-text-md);
	margin: 0;
	overflow-wrap: anywhere;
}

.batch__facts {
	display: grid;
	grid-template-columns: max-content minmax(0, 1fr);
	gap: var(--tt-space-1) var(--tt-space-4);
	margin: 0;
}

.batch__facts dt {
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}

.batch__facts dd {
	margin: 0;
	min-width: 0;
	overflow-wrap: anywhere;
}

/* Narrow screens scroll the table sideways instead of breaking ids and chips. */
.landing-table td {
	white-space: nowrap;
}
</style>
