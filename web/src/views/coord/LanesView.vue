<script setup lang="ts">
// Lanes / Change Graph: a
// live swimlane per lane of this repo — agent, model, work title, footprint
// chips, push ticks on a shared time axis, the CI dot, the radar badge and
// the lane's backend ("own repo" or "branch") with its `opening → open` seed
// time. `/<repo>/-/lanes/<laneId>` adds the lane's detail and its
// `lane.badge`/`lane.sidebar` slots. Data: WP5a's lanes API, WP6's event log
// and `/-/live` (`lanes/useChangeGraph.ts`); the list is windowed so a
// thousand lanes stay cheap to render.
import {
	computed,
	nextTick,
	onBeforeUnmount,
	onMounted,
	ref,
	watch,
} from "vue";
import { useRoute } from "vue-router";
import { useApi, useLive } from "../../app/context.ts";
import AsyncState from "../../components/AsyncState.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import { useScheduler } from "../../live/scheduler.ts";
import { stringParam } from "../../router/params.ts";
import { entityCtx, nodeCtx } from "../../slots/ctx.ts";
import { provideSlotRegistry } from "../../slots/registry.ts";
import { useNodeView } from "../repo/useNodeView.ts";
import LaneDetail from "./lanes/LaneDetail.vue";
import LaneSwimlane from "./lanes/LaneSwimlane.vue";
import { timeAxis, windowRange } from "./lanes/model.ts";
import { useChangeGraph } from "./lanes/useChangeGraph.ts";

provideSlotRegistry();
const route = useRoute();
const laneId = computed(() => stringParam(route.params, "laneId"));
const node = useNodeView(
	() => (laneId.value ? `lanes/${laneId.value}` : "lanes"),
	(path) => (laneId.value ? entityCtx(path, "lane", laneId.value) : nodeCtx(path)),
);

const repo = computed(() => {
	const view = node.data.value;
	return view?.repo ? { path: view.node.path, id: view.repo.id } : null;
});
const graph = useChangeGraph({
	api: useApi(),
	live: useLive(),
	scheduler: useScheduler(),
	repo: () => repo.value,
});

watch(
	[laneId, repo],
	([id, r]) => {
		if (id && r) void graph.ensureLane(id).catch(() => {});
	},
	{ immediate: true },
);

const rows = graph.rows;
const axis = computed(() => timeAxis(rows.value, graph.now.value));
const selected = computed(() =>
	laneId.value ? rows.value.find((r) => r.lane.id === laneId.value) ?? null : null
);

const stats = computed(() => {
	const active = rows.value.filter((r) => r.active);
	const owners = new Set(active.map((r) => r.lane.owner));
	const pushes = rows.value.reduce(
		(n, r) => n + r.pushes.filter((at) => at >= axis.value.from).length,
		0,
	);
	const conflicts = [...graph.graph.value.conflicts.values()].filter((c) =>
		c.state === "open"
	).length;
	const ownRepo = active.filter((r) => r.lane.mode === "repo").length;
	return {
		active: active.length,
		owners: owners.size,
		pushes,
		conflicts,
		ownRepo,
		branch: active.length - ownRepo,
	};
});

const LIVE_LABEL = {
	open: "Live",
	connecting: "Connecting…",
	reconnecting: "Reconnecting…",
	closed: "Not live",
} as const;

// Windowing: rows have a fixed height (CSS); the page scrolls, so the
// visible range comes from the list's position in the viewport.
const listEl = ref<HTMLElement | null>(null);
const rowHeight = ref(80);
const scrollTop = ref(0);
const viewport = ref(900);

const measure = (): void => {
	const el = listEl.value;
	if (!el || typeof globalThis.innerHeight !== "number") return;
	const rect = el.getBoundingClientRect();
	scrollTop.value = Math.max(0, -rect.top);
	viewport.value = globalThis.innerHeight;
	const first = el.querySelector(".lane");
	const height = first?.getBoundingClientRect().height ?? 0;
	if (height > 0) rowHeight.value = height;
};

onMounted(() => {
	if (typeof globalThis.addEventListener !== "function") return;
	globalThis.addEventListener("scroll", measure, { passive: true });
	globalThis.addEventListener("resize", measure, { passive: true });
});
onBeforeUnmount(() => {
	if (typeof globalThis.removeEventListener !== "function") return;
	globalThis.removeEventListener("scroll", measure);
	globalThis.removeEventListener("resize", measure);
});
watch(() => rows.value.length, () => void nextTick(measure));

const range = computed(() =>
	windowRange(rows.value.length, rowHeight.value, scrollTop.value, viewport.value)
);
const visible = computed(() =>
	rows.value.slice(range.value.start, range.value.end).map((row, i) => ({
		row,
		position: range.value.start + i + 1,
	}))
);
const padTop = computed(() => range.value.start * rowHeight.value);
const padBottom = computed(() =>
	Math.max(0, rows.value.length - range.value.end) * rowHeight.value
);
const repoPath = computed(() => node.data.value?.node.path ?? node.nodePath.value);
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
		<RepoFrame v-if="node.data.value" :view="node.data.value" :ctx="node.ctx.value" active="lanes" wide>
			<div class="graph">
				<header class="graph__head">
					<div class="graph__stats" aria-label="Lane summary">
						<p class="graph__stat"><strong>{{ stats.active }}</strong> active lanes</p>
						<p class="graph__stat"><strong>{{ stats.owners }}</strong> agents and people</p>
						<p class="graph__stat"><strong>{{ stats.pushes }}</strong> pushes shown</p>
						<p class="graph__stat"><strong>{{ stats.conflicts }}</strong> predicted conflicts</p>
						<p class="graph__stat">
							<strong>{{ stats.ownRepo }}</strong> own repo · <strong>{{ stats.branch }}</strong> branch
						</p>
					</div>
					<p class="graph__live" :class="`graph__live--${graph.live.value}`" role="status">
						<span class="graph__live-dot" aria-hidden="true" />{{ LIVE_LABEL[graph.live.value] }}
					</p>
				</header>

				<LaneDetail
					v-if="laneId && selected"
					:row="selected"
					:repo-path="repoPath"
					:repo-id="node.repoId.value"
					:slots="node.data.value.slots"
					:ctx="node.ctx.value"
					:now="graph.now.value"
				/>

				<p v-if="graph.error.value" class="chip chip--danger" role="alert">
					Lanes could not be loaded: {{ graph.error.value }}
					<button type="button" class="tt-button tt-button--sm" @click="graph.reload">Try again</button>
				</p>
				<p v-else-if="graph.loading.value && rows.length === 0" aria-live="polite">Loading lanes…</p>
				<div v-else-if="rows.length === 0" class="tt-panel graph__empty">
					<p>No lanes yet.</p>
					<p class="tt-muted">
						An agent gets its own lane when it claims work over MCP; each lane shows up here with its pushes,
						CI and predicted conflicts as they happen.
					</p>
				</div>
				<template v-else>
					<p v-if="graph.truncated.value" class="chip chip--warning">
						Showing the first {{ rows.length }} active lanes.
					</p>
					<div class="graph__legend tt-hint" aria-hidden="true">
						<span><span class="legend-tick" /> push</span>
						<span><span class="legend-opening" /> seeding its own repo</span>
						<span><span class="legend-dot" /> CI</span>
						<span><span class="legend-radar">◎</span> predicted conflicts</span>
					</div>
					<ol ref="listEl" class="graph__lanes" aria-label="Lanes">
						<li v-if="padTop > 0" class="graph__pad" aria-hidden="true">
							<svg width="1" :height="padTop" focusable="false" />
						</li>
						<LaneSwimlane
							v-for="item in visible"
							:key="item.row.lane.id"
							:row="item.row"
							:repo-path="repoPath"
							:axis="axis"
							:now="graph.now.value"
							:selected="item.row.lane.id === laneId"
							:position="item.position"
							:size="rows.length"
						/>
						<li v-if="padBottom > 0" class="graph__pad" aria-hidden="true">
							<svg width="1" :height="padBottom" focusable="false" />
						</li>
					</ol>
				</template>
			</div>
		</RepoFrame>
	</AsyncState>
</template>

<style scoped>
.graph {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-4);
	min-width: 0;
}

.graph__head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--tt-space-3);
}

.graph__stats {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-1) var(--tt-space-4);
}

.graph__stat {
	margin: 0;
	font-size: var(--tt-text-sm);
	color: var(--tt-text-muted);
}

.graph__stat strong {
	color: var(--tt-text);
	font-variant-numeric: tabular-nums;
}

.graph__live {
	display: inline-flex;
	align-items: center;
	gap: var(--tt-space-1);
	margin: 0;
	font-size: var(--tt-text-sm);
	color: var(--tt-text-muted);
}

.graph__live-dot {
	inline-size: 0.5rem;
	block-size: 0.5rem;
	border-radius: 50%;
	background: var(--tt-tone-muted);
}

.graph__live--open .graph__live-dot {
	background: var(--tt-tone-success);
}

.graph__live--connecting .graph__live-dot,
.graph__live--reconnecting .graph__live-dot {
	background: var(--tt-tone-warning);
}

.graph__legend {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-1) var(--tt-space-4);
	margin: 0;
}

.legend-tick {
	display: inline-block;
	inline-size: 0.25rem;
	block-size: 0.75rem;
	background: var(--tt-accent);
	vertical-align: middle;
}

.legend-opening {
	display: inline-block;
	inline-size: 1.25rem;
	block-size: 0;
	border-top: 3px dashed var(--tt-tone-info);
	vertical-align: middle;
}

.legend-dot {
	display: inline-block;
	inline-size: 0.6rem;
	block-size: 0.6rem;
	border-radius: 50%;
	background: var(--tt-tone-success);
	vertical-align: middle;
}

.legend-radar {
	color: var(--tt-tone-warning);
}

.graph__lanes {
	margin: 0;
	padding: 0;
	list-style: none;
	background: var(--tt-surface);
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	overflow: hidden;
}

.graph__pad {
	display: block;
	line-height: 0;
}

.graph__pad svg {
	display: block;
}

.graph__empty p {
	margin: 0;
}
</style>
