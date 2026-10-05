<script setup lang="ts">
// Runs of a repository (WP19; WP9's `GET /-/api/runs/<repoId>`): CI runs
// started by `tartan.ci` and kernel git jobs, newest first, paged by the
// API cursor. `?subject=<kind>:<id>` narrows to one change or lane. Runs
// need a signed-in caller with `read` on the repo; the kernel decides.
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import type { RunDto } from "@tartan/contract/api.ts";
import { useApi } from "../../app/context.ts";
import AsyncState from "../../components/AsyncState.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import { usePaged } from "../../composables/paged.ts";
import { changeHref, commitHref } from "../../router/params.ts";
import { formatTime, isoTime, shortSha } from "../../ui/format.ts";
import { useNodeView } from "../repo/useNodeView.ts";
import { duration, runHref, runsHref, runTone } from "./landing.ts";

const api = useApi();
const route = useRoute();
const node = useNodeView(() => "runs");
const repoPath = computed(() => node.data.value?.node.path ?? node.nodePath.value);

const subject = computed(() => {
	const raw = route.query["subject"];
	const value = typeof raw === "string" ? raw : "";
	const at = value.indexOf(":");
	return at > 0 ? { kind: value.slice(0, at), id: value.slice(at + 1) } : null;
});

const runs = usePaged<RunDto, readonly [string, string]>(
	() => {
		const repoId = node.repoId.value;
		return repoId
			? [repoId, subject.value ? `${subject.value.kind}:${subject.value.id}` : ""] as const
			: null;
	},
	async ([repoId], cursor) => {
		const page = await api.runs.list(repoId, {
			...(subject.value ? { subject: subject.value } : {}),
			...(cursor ? { cursor } : {}),
			limit: 50,
		});
		return { items: page.runs, ...(page.cursor ? { cursor: page.cursor } : {}) };
	},
);

const now = (): number => Date.now();
const failedJobs = (run: RunDto): number =>
	run.jobs.filter((j) => j.state === "failure").length;
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
		<RepoFrame v-if="node.data.value" :view="node.data.value" :ctx="node.ctx.value" active="runs">
			<div class="tt-stack">
				<div class="tt-row runs__head">
					<h2 class="runs__title">Runs</h2>
					<template v-if="subject">
						<span class="chip chip--muted">{{ subject.kind }} {{ subject.id }}</span>
						<RouterLink class="tt-button tt-button--sm" :to="runsHref(repoPath)">All runs</RouterLink>
					</template>
				</div>
				<AsyncState
					:loading="runs.loading.value && !runs.loaded.value"
					:error="runs.error.value"
					:status="runs.status.value"
					:ready="runs.loaded.value && runs.error.value === null"
					what="the runs"
					@retry="runs.reload"
				>
					<p v-if="runs.items.value.length === 0" class="tt-muted">
						No runs yet. Runs appear here when a CI extension or a kernel git job starts one.
					</p>
					<div v-else class="tt-scroll-x">
						<table class="tt-table landing-table">
							<thead>
								<tr>
									<th scope="col">Run</th>
									<th scope="col">State</th>
									<th scope="col">Subject</th>
									<th scope="col">Commit</th>
									<th scope="col">Jobs</th>
									<th scope="col">Started</th>
									<th scope="col" class="tt-num">Took</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="run in runs.items.value" :key="run.runId" :data-run="run.runId">
									<td>
										<RouterLink :to="runHref(repoPath, run.runId)"><code>{{ run.runId.slice(-8) }}</code></RouterLink>
										<span class="chip chip--muted runs__kind">{{ run.kind }}</span>
									</td>
									<td><span class="chip" :class="`chip--${runTone(run.state)}`">{{ run.state }}</span></td>
									<td>
										<RouterLink
											v-if="run.subject?.kind === 'change'"
											:to="changeHref(repoPath, run.subject.id)"
										>change {{ run.subject.id.slice(0, 8) }}</RouterLink>
										<span v-else-if="run.subject">{{ run.subject.kind }} {{ run.subject.id }}</span>
										<span v-else class="tt-muted">—</span>
									</td>
									<td><RouterLink :to="commitHref(repoPath, run.sha)"><code>{{ shortSha(run.sha) }}</code></RouterLink></td>
									<td>
										{{ run.jobs.length }}
										<span v-if="failedJobs(run) > 0" class="chip chip--danger">{{ failedJobs(run) }} failed</span>
									</td>
									<td><time :datetime="isoTime(run.createdAt)">{{ formatTime(run.createdAt) }}</time></td>
									<td class="tt-num">{{ duration(run.createdAt, run.finishedAt, now()) }}</td>
								</tr>
							</tbody>
						</table>
					</div>
					<button
						v-if="runs.cursor.value"
						type="button"
						class="tt-button"
						:disabled="runs.loading.value"
						@click="runs.more"
					>{{ runs.loading.value ? "Loading…" : "Load more" }}</button>
				</AsyncState>
			</div>
		</RepoFrame>
	</AsyncState>
</template>

<style scoped>
.runs__head {
	justify-content: flex-start;
}

.runs__title {
	font-size: var(--tt-text-md);
	margin: 0;
}

.runs__kind {
	margin-inline-start: var(--tt-space-2);
}

/* Narrow screens scroll the table sideways instead of breaking ids and chips. */
.landing-table td {
	white-space: nowrap;
}
</style>
