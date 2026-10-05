<script setup lang="ts">
// The selected lane (`/<repo>/-/lanes/<laneId>`): what the kernel knows of it
// (backend and seed, refs, remote, base and head, pushes, lease) and the
// extensions' `lane.badge` and `lane.sidebar` slots for it (the view API's
// `lanes/<id>` view).
import { computed } from "vue";
import { RouterLink } from "vue-router";
import type { SlotInstanceDto } from "@tartan/contract/api.ts";
import type { SlotCtxHint } from "../../../api/client.ts";
import { changeHref, commitHref, nodeHref } from "../../../router/params.ts";
import SlotOutlet from "../../../slots/SlotOutlet.vue";
import { formatTime, isoTime, relativeTime, shortSha } from "../../../ui/format.ts";
import { type LaneRow, principalLabel } from "./model.ts";

const props = defineProps<{
	row: LaneRow;
	repoPath: string;
	repoId?: string;
	slots: readonly SlotInstanceDto[];
	ctx: SlotCtxHint;
	now: number;
}>();

const lane = computed(() => props.row.lane);
const owner = computed(() =>
	props.row.agent
		? `${props.row.agent.display} (${props.row.agent.handle})`
		: principalLabel(lane.value.owner)
);
const backend = computed(() =>
	lane.value.mode === "repo"
		? `Its own repository${lane.value.seed ? `, seeded by ${lane.value.seed}` : ""}${
			lane.value.seedMs !== undefined
				? ` in ${(lane.value.seedMs / 1000).toFixed(1)} s`
				: lane.value.state === "opening"
				? " (seeding now)"
				: ""
		}`
		: lane.value.kind === "adopted"
		? "An adopted branch of the canonical repository"
		: "A branch of the canonical repository"
);
const closeHref = computed(() => `${nodeHref(props.repoPath)}/-/lanes`);
</script>

<template>
	<section class="lane-detail tt-panel" aria-labelledby="lane-detail-title">
		<header class="lane-detail__head">
			<h2 id="lane-detail-title" class="lane-detail__title">
				<code>{{ lane.id }}</code>
			</h2>
			<RouterLink class="tt-button tt-button--sm" :to="closeHref">All lanes</RouterLink>
		</header>
		<SlotOutlet :slots="slots" slot-id="lane.badge" :ctx="ctx" :repo-id="repoId" />
		<dl class="lane-detail__facts">
			<dt>Owner</dt>
			<dd>{{ owner }}<template v-if="lane.onBehalfOf"> for {{ principalLabel(lane.onBehalfOf) }}</template></dd>
			<dt>Work</dt>
			<dd>{{ row.workTitle ?? row.workRef ?? "None" }}</dd>
			<dt>State</dt>
			<dd>
				{{ lane.state }}<template v-if="lane.quarantined"> · <strong>quarantined</strong> (an unexplained head change)</template>
			</dd>
			<dt>Backend</dt>
			<dd>{{ backend }}</dd>
			<template v-if="row.seedFailure">
				<dt>Seeding</dt>
				<dd>failed with <code>{{ row.seedFailure.code }}</code>; trying {{ row.seedFailure.next }} next</dd>
			</template>
			<dt>Ref</dt>
			<dd><code>{{ lane.ref }}</code> (local branch <code>{{ lane.branch }}</code>)</dd>
			<dt>Remote</dt>
			<dd><code>{{ lane.remote }}</code></dd>
			<dt>Base</dt>
			<dd><RouterLink :to="commitHref(repoPath, lane.base)"><code>{{ shortSha(lane.base) }}</code></RouterLink></dd>
			<dt>Head</dt>
			<dd>
				<code v-if="lane.head">{{ shortSha(lane.head) }}</code>
				<span v-else class="tt-muted">no push yet</span>
			</dd>
			<dt>Pushes</dt>
			<dd>
				{{ lane.pushes }}<template v-if="lane.lastPushAt">, last {{ relativeTime(lane.lastPushAt, now) }}</template>
			</dd>
			<dt>Footprint</dt>
			<dd>{{ row.chips.length > 0 ? row.chips.join(", ") : "none declared" }}</dd>
			<dt>Change</dt>
			<dd>
				<RouterLink v-if="row.changeId" :to="changeHref(repoPath, row.changeId)"><code>{{ row.changeId.slice(0, 12) }}</code></RouterLink>
				<span v-else class="tt-muted">not submitted</span>
			</dd>
			<dt>Opened</dt>
			<dd><time :datetime="isoTime(lane.createdAt)">{{ formatTime(lane.createdAt) }}</time></dd>
			<template v-if="lane.state === 'open' || lane.state === 'opening'">
				<dt>Lease</dt>
				<dd>until {{ formatTime(lane.leaseExpiresAt) }}</dd>
			</template>
			<template v-if="lane.delegates.length > 0">
				<dt>Delegates</dt>
				<dd>{{ lane.delegates.map(principalLabel).join(", ") }}</dd>
			</template>
		</dl>
		<SlotOutlet :slots="slots" slot-id="lane.sidebar" :ctx="ctx" :repo-id="repoId" />
	</section>
</template>

<style scoped>
.lane-detail {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-3);
}

.lane-detail__head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--tt-space-2);
}

.lane-detail__title {
	font-size: var(--tt-text-md);
	min-width: 0;
	overflow-wrap: anywhere;
}

.lane-detail__facts {
	display: grid;
	grid-template-columns: max-content minmax(0, 1fr);
	gap: var(--tt-space-1) var(--tt-space-3);
	margin: 0;
	font-size: var(--tt-text-sm);
}

.lane-detail__facts dt {
	color: var(--tt-text-muted);
}

.lane-detail__facts dd {
	margin: 0;
	min-width: 0;
	overflow-wrap: anywhere;
}
</style>
