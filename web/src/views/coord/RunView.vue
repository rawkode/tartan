<script setup lang="ts">
// One run (WP19; WP9's `GET /-/api/runs/<repoId>/<runId>`): state, subject,
// commit and the job list; `/-/runs/<runId>/jobs/<jobId>` adds that job's
// redacted log tail (`…/jobs/<jobId>/log`). Live tail (`runs/useRunTail.ts`):
// the run is re-read when its `run.*`/`job.*` events arrive on `/-/live`,
// and a live log is re-read every 2 s while "Following" (pausable), scrolled
// to its end.
import { computed, inject, nextTick, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { LIVE, useApi } from "../../app/context.ts";
import AsyncState from "../../components/AsyncState.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import { useResource } from "../../composables/resource.ts";
import { changeHref, commitHref, stringParam } from "../../router/params.ts";
import { formatTime, isoTime, shortSha } from "../../ui/format.ts";
import { useScheduler } from "../../live/scheduler.ts";
import { useNodeView } from "../repo/useNodeView.ts";
import { duration, jobHref, runHref, runsHref, runTone } from "./landing.ts";
import { useRunTail } from "./runs/useRunTail.ts";

const api = useApi();
const route = useRoute();
const runId = computed(() => stringParam(route.params, "runId"));
const jobId = computed(() => stringParam(route.params, "jobId"));
const node = useNodeView(() => "runs");
const repoPath = computed(() => node.data.value?.node.path ?? node.nodePath.value);

const NONE = Symbol("none");
const run = useResource(
	() => (node.repoId.value ? [node.repoId.value, runId.value] as const : NONE),
	(key) =>
		key === NONE
			? Promise.resolve(null)
			: api.runs.get(key[0], key[1]),
);
const log = useResource(
	() =>
		node.repoId.value && jobId.value
			? [node.repoId.value, runId.value, jobId.value] as const
			: NONE,
	(key) =>
		key === NONE
			? Promise.resolve(null)
			: api.runs.log(key[0], key[1], key[2]),
);

const job = computed(() =>
	run.data.value?.jobs.find((j) => j.jobId === jobId.value) ?? null
);
/**
 * How the run reached its Workflow (WP26): its recorded transport (`k2`: the
 * global log's consumer; `local`: inline) and, once dispatched, by whom
 * (`k2`, the `backstop` timer, or `local`): `RunStatus.transport` and `via`.
 */
const dispatch = computed(() => {
	const r = run.data.value ?? null;
	if (r === null || r.transport === undefined) return null;
	const how = r.transport === "k2"
		? "through the global log (K2)"
		: "inline";
	const by = r.via === undefined
		? "not dispatched yet"
		: r.via === "k2"
		? "dispatched by the K2 consumer"
		: r.via === "backstop"
		? "dispatched by the inline backstop"
		: "dispatched inline";
	return {
		transport: r.transport,
		via: r.via,
		text: `Requested ${how}; ${by}`,
	};
});
const live = computed(() =>
	run.data.value?.state === "running" || run.data.value?.state === "queued" ||
	log.data.value?.live === true
);
const refresh = (): void => {
	void run.reload();
	if (jobId.value) void log.reload();
};
const scheduler = useScheduler();
const now = (): number => Date.now();
const tail = useRunTail({
	live: inject(LIVE, null),
	scheduler,
	repoId: () => node.repoId.value,
	runId: () => runId.value,
	logLive: () => jobId.value !== "" && log.data.value?.live === true,
	reloadRun: () => run.reload(),
	reloadLog: () => (jobId.value ? log.reload() : Promise.resolve()),
});
const logEl = ref<HTMLElement | null>(null);
watch(
	() => log.data.value?.text,
	async () => {
		if (!tail.following.value) return;
		await nextTick();
		const el = logEl.value;
		if (el && typeof el.scrollHeight === "number") el.scrollTop = el.scrollHeight;
	},
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
		<RepoFrame v-if="node.data.value" :view="node.data.value" :ctx="node.ctx.value" active="runs" wide>
			<div class="tt-stack">
				<p class="tt-row">
					<RouterLink :to="runsHref(repoPath)">All runs</RouterLink>
				</p>
				<AsyncState
					:loading="run.loading.value"
					:error="run.error.value"
					:status="run.status.value"
					:ready="run.data.value !== null"
					what="this run"
					@retry="run.reload"
				>
					<template v-if="run.data.value">
						<header class="tt-row run__head">
							<h2 class="run__title">Run <code>{{ run.data.value.runId }}</code></h2>
							<span class="chip" :class="`chip--${runTone(run.data.value.state)}`">{{ run.data.value.state }}</span>
							<span class="chip chip--muted">{{ run.data.value.kind }}</span>
							<button v-if="live" type="button" class="tt-button tt-button--sm" @click="refresh">Refresh</button>
						</header>
						<dl class="run__facts">
							<dt>Commit</dt>
							<dd><RouterLink :to="commitHref(repoPath, run.data.value.sha)"><code>{{ shortSha(run.data.value.sha) }}</code></RouterLink></dd>
							<template v-if="run.data.value.subject">
								<dt>Subject</dt>
								<dd>
									<RouterLink
										v-if="run.data.value.subject.kind === 'change'"
										:to="changeHref(repoPath, run.data.value.subject.id)"
									>change {{ run.data.value.subject.id }}</RouterLink>
									<span v-else>{{ run.data.value.subject.kind }} {{ run.data.value.subject.id }}</span>
								</dd>
							</template>
							<dt>Requested by</dt>
							<dd><code>{{ run.data.value.requestedBy }}</code></dd>
							<dt>Started</dt>
							<dd><time :datetime="isoTime(run.data.value.createdAt)">{{ formatTime(run.data.value.createdAt) }}</time></dd>
							<dt>Took</dt>
							<dd>{{ duration(run.data.value.createdAt, run.data.value.finishedAt, now()) }}</dd>
							<template v-if="dispatch">
								<dt>Dispatch</dt>
								<dd :data-transport="dispatch.transport" :data-via="dispatch.via ?? ''">{{ dispatch.text }}</dd>
							</template>
						</dl>
						<h3 class="run__subtitle">Jobs</h3>
						<p v-if="run.data.value.jobs.length === 0" class="tt-muted">This run has no jobs.</p>
						<div v-else class="tt-scroll-x">
							<table class="tt-table landing-table">
								<thead>
									<tr>
										<th scope="col">Job</th>
										<th scope="col">Project</th>
										<th scope="col">State</th>
										<th scope="col" class="tt-num">Exit</th>
										<th scope="col" class="tt-num">Took</th>
									</tr>
								</thead>
								<tbody>
									<tr
										v-for="j in run.data.value.jobs"
										:key="j.jobId"
										:aria-current="j.jobId === jobId ? 'true' : undefined"
									>
										<td><RouterLink :to="jobHref(repoPath, runId, j.jobId)"><code>{{ j.jobId }}</code></RouterLink></td>
										<td>{{ j.project ?? "—" }}</td>
										<td>
											<span class="chip" :class="`chip--${runTone(j.state)}`">{{ j.state }}</span>
											<span v-if="j.cached" class="chip chip--muted">cached</span>
										</td>
										<td class="tt-num">{{ j.exitCode ?? "—" }}</td>
										<td class="tt-num">{{ duration(j.startedAt, j.finishedAt, now()) }}</td>
									</tr>
								</tbody>
							</table>
						</div>
						<section v-if="jobId" class="tt-stack" aria-label="Job log">
							<div class="tt-row">
								<h3 class="run__subtitle">Log of <code>{{ jobId }}</code></h3>
								<span v-if="log.data.value?.live" class="chip chip--info">live</span>
								<button
									v-if="log.data.value?.live"
									type="button"
									class="tt-button tt-button--sm"
									:aria-pressed="tail.following.value"
									data-follow
									@click="tail.toggle"
								>{{ tail.following.value ? "Following" : "Paused" }}</button>
								<span v-if="log.data.value?.truncated" class="chip chip--muted">last part only</span>
								<RouterLink class="tt-button tt-button--sm" :to="runHref(repoPath, runId)">Close</RouterLink>
							</div>
							<p v-if="!job" class="tt-muted">This run has no job <code>{{ jobId }}</code>.</p>
							<AsyncState
								v-else
								:loading="log.loading.value"
								:error="log.error.value"
								:status="log.status.value"
								:ready="log.data.value !== null"
								what="this log"
								@retry="log.reload"
							>
								<pre v-if="log.data.value && log.data.value.text !== ''" ref="logEl" class="run__log" aria-live="polite">{{ log.data.value.text }}</pre>
								<p v-else class="tt-muted">No output yet.</p>
							</AsyncState>
						</section>
					</template>
				</AsyncState>
			</div>
		</RepoFrame>
	</AsyncState>
</template>

<style scoped>
.run__head {
	gap: var(--tt-space-3);
}

.run__title,
.run__subtitle {
	font-size: var(--tt-text-md);
	margin: 0;
	overflow-wrap: anywhere;
}

.run__facts {
	display: grid;
	grid-template-columns: max-content minmax(0, 1fr);
	gap: var(--tt-space-1) var(--tt-space-4);
	margin: 0;
}

.run__facts dt {
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}

.run__facts dd {
	margin: 0;
	min-width: 0;
	overflow-wrap: anywhere;
}

.run__log {
	max-height: 32rem;
	overflow: auto;
	font-family: var(--tt-font-mono);
	font-size: var(--tt-text-sm);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

/* Narrow screens scroll the table sideways instead of breaking ids and chips. */
.landing-table td {
	white-space: nowrap;
}
</style>
