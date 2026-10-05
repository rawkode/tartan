<script setup lang="ts">
// Advances of a repository (WP19; WP10's `GET /-/api/advances?repo=<path>`):
// every trunk move attempt, newest first, with its batch, step, the trunk
// it expected and moved to, reused evidence, the chain position and the
// gate decisions (shadow-mode decisions are labelled and never block). A
// summary counts what is loaded (landed, stale, failed, vetoed, and what
// policies on trial in shadow would have vetoed); filters narrow the list
// to gated, vetoed or shadow-decided advances. Paged by cursor.
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import type { AdvanceDto } from "@tartan/contract/api.ts";
import { useApi } from "../../app/context.ts";
import AsyncState from "../../components/AsyncState.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import { usePaged } from "../../composables/paged.ts";
import { commitHref } from "../../router/params.ts";
import { formatTime, isoTime, shortSha } from "../../ui/format.ts";
import { useNodeView } from "../repo/useNodeView.ts";
import {
	GATE_FILTER_LABELS,
	GATE_FILTERS,
	type GateFilter,
	matchesFilter,
	summarize,
} from "./advances/model.ts";
import { advanceTone, batchHref, gateTone } from "./landing.ts";

const api = useApi();
const node = useNodeView(() => "advances");
const repoPath = computed(() => node.data.value?.node.path ?? node.nodePath.value);

const advances = usePaged<AdvanceDto, string>(
	() => (node.data.value ? repoPath.value : null),
	async (repo, cursor) => {
		const page = await api.land.advances(repo, {
			...(cursor ? { cursor } : {}),
			limit: 50,
		});
		return {
			items: page.advances,
			...(page.cursor ? { cursor: page.cursor } : {}),
		};
	},
);

const branch = (name: string): string => name.replace(/^refs\/heads\//, "");
const filter = ref<GateFilter>("all");
const summary = computed(() => summarize(advances.items.value));
const shown = computed(() =>
	advances.items.value.filter((a) => matchesFilter(a, filter.value))
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
				<h2 class="advances__title">Advances</h2>
				<AsyncState
					:loading="advances.loading.value && !advances.loaded.value"
					:error="advances.error.value"
					:status="advances.status.value"
					:ready="advances.loaded.value && advances.error.value === null"
					what="the advances"
					@retry="advances.reload"
				>
					<p v-if="advances.items.value.length === 0" class="tt-muted">
						Nothing has advanced trunk through Tartan yet. Each landing attempt appears here once a queue submits a batch.
					</p>
					<template v-else>
					<section class="advances__summary tt-panel" aria-label="Summary" data-advances-summary>
						<p class="tt-row advances__counts">
							<span class="chip chip--success">{{ summary.landed }} landed</span>
							<span v-if="summary.inFlight > 0" class="chip chip--info">{{ summary.inFlight }} in flight</span>
							<span v-if="summary.stale > 0" class="chip chip--warning">{{ summary.stale }} stale</span>
							<span v-if="summary.failed > 0" class="chip chip--danger">{{ summary.failed }} failed</span>
							<span v-if="summary.vetoed > 0" class="chip chip--danger">{{ summary.vetoed }} vetoed</span>
							<span v-if="summary.evidenceReused > 0" class="chip chip--info">{{ summary.evidenceReused }} reused evidence</span>
							<span v-if="summary.seeded > 0" class="chip chip--muted">{{ summary.seeded }} seeded</span>
							<span class="tt-hint">of the {{ summary.total }} loaded</span>
						</p>
						<p v-for="s in summary.shadowByExt" :key="s.ext" class="advances__shadow" data-shadow-ext>
							In shadow, <code>{{ s.ext }}</code> would have vetoed {{ s.vetoes }} of the last {{ summary.total }} advances.
						</p>
					</section>
					<div class="advances__filters" role="group" aria-label="Filter by gate">
						<button
							v-for="f in GATE_FILTERS"
							:key="f"
							type="button"
							class="tt-button tt-button--sm"
							:aria-pressed="filter === f"
							:data-filter="f"
							@click="filter = f"
						>{{ GATE_FILTER_LABELS[f] }}</button>
					</div>
					<p v-if="shown.length === 0" class="tt-muted">No loaded advance matches this filter.</p>
					<ol v-else class="advances">
						<li
							v-for="advance in shown"
							:key="advance.id"
							class="advances__item tt-panel"
							:data-advance="advance.id"
						>
							<div class="tt-row">
								<RouterLink :to="batchHref(repoPath, advance.batchId)" class="advances__batch">
									<code>{{ advance.batchId }}</code>
								</RouterLink>
								<span class="chip chip--muted">attempt {{ advance.attempt }}</span>
								<span class="chip" :class="`chip--${advanceTone(advance.state)}`">{{ advance.state }}</span>
								<span class="chip chip--muted">{{ advance.step }}</span>
								<span v-if="advance.evidenceReused" class="chip chip--info">evidence reused</span>
								<span v-if="advance.seeded" class="chip chip--muted" title="Written by the dev-only history seeding for the gate replay, not by a real land">seeded</span>
								<span v-if="advance.chainSeq !== undefined" class="chip chip--muted" :title="advance.chainHead">chain #{{ advance.chainSeq }}</span>
							</div>
							<p class="advances__move">
								<code>{{ branch(advance.ref) }}</code>:
								<RouterLink :to="commitHref(repoPath, advance.expectOld)"><code>{{ shortSha(advance.expectOld) }}</code></RouterLink>
								<template v-if="advance.newSha">
									→ <RouterLink :to="commitHref(repoPath, advance.newSha)"><code>{{ shortSha(advance.newSha) }}</code></RouterLink>
								</template>
								<span v-else class="tt-muted"> (trunk not moved)</span>
								·
								<time :datetime="isoTime(advance.createdAt)">{{ formatTime(advance.createdAt) }}</time>
							</p>
							<ul v-if="advance.gateResults && advance.gateResults.length > 0" class="advances__gates" aria-label="Gate decisions">
								<li v-for="gate in advance.gateResults" :key="`${gate.ext}:${gate.mode}`">
									<span class="chip" :class="`chip--${gateTone(gate.decision)}`">
										{{ gate.ext }}: {{ gate.decision }}<template v-if="gate.mode === 'shadow'"> (shadow)</template>
									</span>
									<span v-if="gate.message" class="tt-hint"> {{ gate.message }}</span>
								</li>
							</ul>
						</li>
					</ol>
					</template>
					<button
						v-if="advances.cursor.value"
						type="button"
						class="tt-button"
						:disabled="advances.loading.value"
						@click="advances.more"
					>{{ advances.loading.value ? "Loading…" : "Load more" }}</button>
				</AsyncState>
			</div>
		</RepoFrame>
	</AsyncState>
</template>

<style scoped>
.advances__title {
	font-size: var(--tt-text-md);
	margin: 0;
}

.advances {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-3);
	margin: 0;
	padding: 0;
	list-style: none;
}

.advances__item {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
}

.advances__summary {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
}

.advances__counts,
.advances__shadow {
	margin: 0;
	overflow-wrap: anywhere;
}

.advances__filters {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-2);
}

.advances__batch {
	overflow-wrap: anywhere;
}

.advances__move {
	margin: 0;
	overflow-wrap: anywhere;
}

.advances__gates {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-1);
	margin: 0;
	padding: 0;
	list-style: none;
}
</style>
