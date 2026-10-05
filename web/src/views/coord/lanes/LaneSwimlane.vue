<script setup lang="ts">
// One swimlane of the Change Graph: who (agent, tool, model), what (work
// title, footprint chips), where (the lane's backend: its own repository or
// a branch of the canonical one, with the `opening → open` seed time) and how
// it is going (push ticks on the shared time axis, the CI dot, the radar
// badge, the state). Positions are SVG attributes, never style bindings
// (CSP); the row has a fixed height so the list can be windowed.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { changeHref, nodeHref } from "../../../router/params.ts";
import { relativeTime, shortSha } from "../../../ui/format.ts";
import {
	AXIS_WIDTH,
	axisX,
	type LaneRow,
	principalLabel,
} from "./model.ts";

const props = defineProps<{
	row: LaneRow;
	repoPath: string;
	axis: { readonly from: number; readonly to: number };
	now: number;
	selected?: boolean;
	/** 1-based position and list size (windowed lists keep them for AT). */
	position: number;
	size: number;
}>();

const MAX_CHIPS = 4;

const lane = computed(() => props.row.lane);
const laneHref = computed(() =>
	`${nodeHref(props.repoPath)}/-/lanes/${encodeURIComponent(lane.value.id)}`
);
const who = computed(() =>
	props.row.agent?.handle ?? principalLabel(lane.value.owner)
);
const toolLine = computed(() =>
	[props.row.agent?.tool, props.row.agent?.model].filter(Boolean).join(" · ")
);
const title = computed(() =>
	props.row.workTitle ?? props.row.workRef ?? "No work item"
);
const chips = computed(() => props.row.chips.slice(0, MAX_CHIPS));
const moreChips = computed(() => Math.max(0, props.row.chips.length - MAX_CHIPS));

const backend = computed(() =>
	lane.value.mode === "repo"
		? {
			label: "own repo",
			detail: lane.value.state === "opening"
				? `Own repository, seeding${lane.value.seed ? ` by ${lane.value.seed}` : ""}`
				: `Own repository${lane.value.seed ? ` (${lane.value.seed})` : ""}${
					lane.value.seedMs !== undefined
						? `, opened in ${(lane.value.seedMs / 1000).toFixed(1)} s`
						: ""
				}`,
		}
		: { label: "branch", detail: `Branch lane ${lane.value.ref}` }
);

const STATE_TONE: Readonly<Record<string, string>> = {
	opening: "chip--info",
	open: "chip--success",
	submitted: "chip--info",
	landing: "chip--warning",
	landed: "chip--muted",
	closed: "chip--muted",
	lost: "chip--danger",
	archived: "chip--muted",
	deleted: "chip--muted",
};

const SEVERITY_LABEL: Readonly<Record<string, string>> = {
	declared: "declared overlap",
	same_project: "same project",
	same_file: "same file",
	adjacent: "adjacent hunks",
	textual: "textual conflict",
	semantic: "semantic conflict",
	trunk_drift: "trunk drift",
};

const radarTone = computed(() => {
	const w = props.row.radar.worst;
	return w === "textual" || w === "semantic" || w === "trunk_drift"
		? "radar--danger"
		: w === "same_file" || w === "adjacent"
		? "radar--warning"
		: "radar--info";
});
const radarLabel = computed(() => {
	const r = props.row.radar;
	if (r.open === 0) return "No predicted conflicts";
	const worst = r.worst ? SEVERITY_LABEL[r.worst] ?? r.worst : "";
	return `${r.open} predicted conflict${r.open === 1 ? "" : "s"}${
		worst ? `, worst: ${worst}` : ""
	}${r.paths.length > 0 ? ` (${r.paths.slice(0, 3).join(", ")})` : ""}`;
});

// The track: the lane's life on the shared axis, its opening phase and pushes.
const start = computed(() => axisX(lane.value.createdAt, props.axis));
const end = computed(() =>
	axisX(lane.value.closedAt ?? props.now, props.axis)
);
const openedAt = computed(() =>
	lane.value.mode === "repo" && lane.value.seedMs !== undefined
		? axisX(lane.value.createdAt + lane.value.seedMs, props.axis)
		: null
);
const ticks = computed(() =>
	props.row.pushes
		.filter((at) => at >= props.axis.from)
		.map((at) => axisX(at, props.axis))
);
const lastPush = computed(() =>
	props.row.pushes[props.row.pushes.length - 1] ?? lane.value.lastPushAt
);
const trackLabel = computed(() => {
	const n = lane.value.pushes;
	const pushes = n === 0
		? "no pushes yet"
		: `${n} push${n === 1 ? "" : "es"}${
			lastPush.value ? `, last ${relativeTime(lastPush.value, props.now)}` : ""
		}`;
	return `Opened ${relativeTime(lane.value.createdAt, props.now)}, ${pushes}`;
});
</script>

<template>
	<li
		class="lane"
		:class="{ 'lane--selected': selected, 'lane--inactive': !row.active }"
		:aria-posinset="position"
		:aria-setsize="size"
		:aria-current="selected ? 'true' : undefined"
	>
		<div class="lane__who">
			<img
				class="lane__avatar"
				:src="`/-/avatar/${lane.owner}`"
				alt=""
				width="28"
				height="28"
				loading="lazy"
			/>
			<div class="lane__text">
				<p class="lane__line">
					<RouterLink class="lane__agent" :to="laneHref">{{ who }}</RouterLink>
					<span v-if="row.sim" class="chip chip--warning" data-sim>simulated</span>
					<span v-if="toolLine" class="lane__tool">{{ toolLine }}</span>
				</p>
				<p class="lane__line lane__title" :title="title">{{ title }}</p>
				<p class="lane__line lane__chips">
					<span v-for="chip in chips" :key="chip" class="lane__chip">{{ chip }}</span>
					<span v-if="moreChips > 0" class="lane__chip lane__chip--more">+{{ moreChips }}</span>
					<span v-if="row.chips.length === 0" class="lane__chip lane__chip--none">no footprint</span>
				</p>
			</div>
		</div>
		<svg
			class="lane__track"
			:viewBox="`0 0 ${AXIS_WIDTH} 24`"
			preserveAspectRatio="none"
			role="img"
			:aria-label="trackLabel"
		>
			<line class="lane__life" :x1="start" :x2="end" y1="12" y2="12" />
			<line
				v-if="openedAt !== null"
				class="lane__opening"
				:x1="start"
				:x2="openedAt"
				y1="12"
				y2="12"
			/>
			<line
				v-if="lane.state === 'opening'"
				class="lane__opening"
				:x1="start"
				:x2="end"
				y1="12"
				y2="12"
			/>
			<rect
				v-for="(x, i) in ticks"
				:key="i"
				class="lane__tick"
				:x="Math.max(0, x - 2)"
				y="4"
				width="4"
				height="16"
			/>
		</svg>
		<div class="lane__status">
			<span class="chip" :class="STATE_TONE[lane.state] ?? 'chip--muted'">{{ lane.state }}</span>
			<span class="chip chip--muted lane__backend" :title="backend.detail">
				{{ backend.label }}<span class="visually-hidden">: {{ backend.detail }}</span>
			</span>
			<span
				class="ci-dot"
				:class="`ci-dot--${row.ci?.state ?? 'none'}`"
				role="img"
				:aria-label="row.ci?.label ?? 'No CI yet'"
				:title="row.ci?.label ?? 'No CI yet'"
			/>
			<span
				v-if="row.radar.open > 0"
				class="radar"
				:class="radarTone"
				role="img"
				:aria-label="radarLabel"
				:title="radarLabel"
			>{{ row.radar.open }}</span>
			<RouterLink
				v-if="row.changeId"
				class="lane__change"
				:to="changeHref(repoPath, row.changeId)"
				:aria-label="`Change ${row.changeId.slice(0, 8)}`"
			>change</RouterLink>
			<code v-else-if="lane.head" class="lane__head">{{ shortSha(lane.head) }}</code>
		</div>
		<p v-if="row.seedFailure" class="visually-hidden">
			Seeding failed ({{ row.seedFailure.code }}); trying {{ row.seedFailure.next }} next.
		</p>
	</li>
</template>

<style scoped>
.lane {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	grid-template-areas:
		"who"
		"status"
		"track";
	align-items: center;
	gap: var(--tt-space-1) var(--tt-space-3);
	block-size: 9rem;
	padding: var(--tt-space-2) var(--tt-space-3);
	border-bottom: 1px solid var(--tt-border);
	overflow: hidden;
	contain: layout paint;
}

@media (min-width: 48rem) {
	.lane {
		/* Fixed side columns: every track spans the same x range (one axis). */
		grid-template-columns: 18rem minmax(0, 1fr) 15rem;
		grid-template-areas: "who track status";
		block-size: 5rem;
	}
}

.lane--selected {
	background: var(--tt-surface-sunken);
	box-shadow: inset 3px 0 0 var(--tt-accent);
}

.lane--inactive {
	opacity: 0.7;
}

.lane__who {
	grid-area: who;
	display: flex;
	gap: var(--tt-space-2);
	min-width: 0;
}

.lane__avatar {
	flex: none;
	border-radius: 50%;
	background: var(--tt-surface-sunken);
}

.lane__text {
	display: flex;
	flex-direction: column;
	min-width: 0;
}

.lane__line {
	margin: 0;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
	line-height: 1.4;
}

.lane__agent {
	font-weight: 600;
}

.lane__tool {
	margin-left: var(--tt-space-2);
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}

.lane__title {
	font-size: var(--tt-text-sm);
}

.lane__chips {
	display: flex;
	gap: var(--tt-space-1);
}

.lane__chip {
	flex: none;
	max-width: 12rem;
	overflow: hidden;
	text-overflow: ellipsis;
	padding: 0 var(--tt-space-1);
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	font-family: var(--tt-font-mono);
	font-size: 0.75rem;
	color: var(--tt-text-muted);
}

.lane__chip--none {
	font-family: var(--tt-font-sans);
	border-style: dashed;
}

.lane__track {
	grid-area: track;
	inline-size: 100%;
	block-size: 1.5rem;
	min-width: 0;
}

.lane__life {
	stroke: var(--tt-heat-2);
	stroke-width: 4;
}

.lane__opening {
	stroke: var(--tt-tone-info);
	stroke-width: 4;
	stroke-dasharray: 8 6;
}

.lane__tick {
	fill: var(--tt-accent);
}

.lane__status {
	grid-area: status;
	display: flex;
	flex-wrap: nowrap;
	justify-content: flex-start;
	align-items: center;
	gap: var(--tt-space-1) var(--tt-space-2);
	min-width: 0;
	overflow: hidden;
}

@media (min-width: 48rem) {
	.lane__status {
		flex-wrap: wrap;
		justify-content: flex-end;
		max-inline-size: 15rem;
	}
}

.lane__head,
.lane__change {
	font-size: var(--tt-text-sm);
}

.ci-dot {
	display: inline-block;
	inline-size: 0.75rem;
	block-size: 0.75rem;
	border-radius: 50%;
	border: 2px solid var(--tt-border);
	background: transparent;
}

.ci-dot--success,
.ci-dot--cached,
.ci-dot--skipped {
	background: var(--tt-tone-success);
	border-color: var(--tt-tone-success);
}

.ci-dot--failure {
	background: var(--tt-tone-danger);
	border-color: var(--tt-tone-danger);
}

.ci-dot--running,
.ci-dot--pending {
	background: var(--tt-tone-warning);
	border-color: var(--tt-tone-warning);
}

.ci-dot--running {
	animation: ci-pulse 1.4s ease-in-out infinite;
}

.ci-dot--cancelled {
	border-color: var(--tt-tone-muted);
}

@media (prefers-reduced-motion: reduce) {
	.ci-dot--running {
		animation: none;
	}
}

@keyframes ci-pulse {
	50% {
		opacity: 0.35;
	}
}

.radar {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-inline-size: 1.5rem;
	block-size: 1.5rem;
	padding: 0 var(--tt-space-1);
	border-radius: var(--tt-radius-pill);
	font-size: var(--tt-text-sm);
	font-weight: 600;
}

.radar::before {
	content: "◎";
	margin-right: 0.15rem;
	font-weight: 400;
}

.radar--info {
	background: var(--tt-tone-info-bg);
	color: var(--tt-tone-info);
}

.radar--warning {
	background: var(--tt-tone-warning-bg);
	color: var(--tt-tone-warning);
}

.radar--danger {
	background: var(--tt-tone-danger-bg);
	color: var(--tt-tone-danger);
}
</style>
