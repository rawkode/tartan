<script setup lang="ts">
// A why answer (`WhyResponse`, WP10 `GET /-/api/why`): the landed commit,
// the reason the queue gave, who landed which change from which lane, the
// gate decisions, the checks and the hash-chain position, then the
// sections extensions wrote into the note (the work item's why and
// acceptance, the change, the review route) and the reason events in log
// order. Text only.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import type { WhyResponse } from "@tartan/contract/api.ts";
import { changeHref, commitHref } from "../../../router/params.ts";
import { formatTime, isoTime, shortSha } from "../../../ui/format.ts";
import { batchHref, gateTone, laneHref, runHref, runTone } from "../landing.ts";
import { provenanceOf, reasonEvents } from "../why/model.ts";

const props = defineProps<{ why: WhyResponse }>();

const kernel = computed(() => props.why.note?.kernel ?? null);
const provenance = computed(() => (props.why.note ? provenanceOf(props.why.note) : null));
const reasons = computed(() =>
	props.why.note ? reasonEvents(props.why.note, props.why.events) : []
);
</script>

<template>
	<article class="why tt-panel" :data-commit="why.commit">
		<header class="tt-row">
			<h3 class="why__title">
				Why <RouterLink :to="commitHref(why.repo, why.commit)"><code>{{ shortSha(why.commit) }}</code></RouterLink>
			</h3>
			<span v-if="kernel?.seeded" class="chip chip--warning">seeded history</span>
			<span v-if="kernel?.provenance === 'partial'" class="chip chip--muted">partial provenance</span>
		</header>
		<p v-if="!kernel" class="tt-muted">This commit has no why note: it did not land through an Advance.</p>
		<template v-else>
			<p class="why__reason">{{ kernel.reason.summary }}</p>
			<dl class="why__facts">
				<dt>Change</dt>
				<dd><RouterLink :to="changeHref(why.repo, kernel.change)"><code>{{ kernel.change }}</code></RouterLink></dd>
				<dt>Lane</dt>
				<dd>
					<RouterLink :to="laneHref(why.repo, kernel.lane)"><code>{{ kernel.lane }}</code></RouterLink>
					<span class="chip chip--muted">{{ kernel.laneMode }}</span>
				</dd>
				<dt>Landed by</dt>
				<dd>
					<code>{{ kernel.actor }}</code>
					<template v-if="kernel.onBehalfOf"> on behalf of <code>{{ kernel.onBehalfOf }}</code></template>
				</dd>
				<dt>Batch</dt>
				<dd><RouterLink :to="batchHref(why.repo, kernel.batch)"><code>{{ kernel.batch }}</code></RouterLink></dd>
				<dt>Checks</dt>
				<dd class="tt-row">
					<span class="chip" :class="`chip--${kernel.checks.state === 'skipped' ? 'muted' : runTone(kernel.checks.state)}`">{{ kernel.checks.state }}</span>
					<span v-if="kernel.checks.evidenceReused" class="chip chip--info">evidence reused</span>
					<RouterLink v-for="run in kernel.checks.runs" :key="run" :to="runHref(why.repo, run)"><code>{{ run.slice(-8) }}</code></RouterLink>
				</dd>
				<dt>Chain</dt>
				<dd>
					#{{ kernel.chain.seq }} · <code>{{ kernel.chain.head.slice(0, 12) }}</code>
					<span v-if="why.chainVerified === true" class="chip chip--success">verified</span>
					<span v-else-if="why.chainVerified === false" class="chip chip--danger">chain mismatch</span>
				</dd>
			</dl>
			<section v-if="provenance?.work" class="why__section" data-why-section="work">
				<h4 class="why__subtitle">
					Work item <code v-if="provenance.work.ref">{{ provenance.work.ref }}</code>
					<template v-if="provenance.work.title"> · {{ provenance.work.title }}</template>
				</h4>
				<p v-if="provenance.work.why" class="why__reason">{{ provenance.work.why }}</p>
				<ul v-if="provenance.work.acceptance.length > 0" class="why__list" aria-label="Acceptance">
					<li v-for="a in provenance.work.acceptance" :key="a">{{ a }}</li>
				</ul>
				<p v-if="provenance.work.plan" class="tt-hint">Plan: {{ provenance.work.plan }}</p>
				<p v-if="provenance.work.agent" class="tt-hint">Claimed by <code>{{ provenance.work.agent }}</code></p>
			</section>
			<section v-if="provenance?.change" class="why__section" data-why-section="change">
				<h4 class="why__subtitle">
					Change<template v-if="provenance.change.title"> · {{ provenance.change.title }}</template>
					<span v-if="provenance.change.revision" class="chip chip--muted">r{{ provenance.change.revision }}</span>
				</h4>
				<p v-if="provenance.change.summary" class="why__reason">{{ provenance.change.summary }}</p>
			</section>
			<section v-if="provenance?.review" class="why__section" data-why-section="review">
				<h4 class="why__subtitle">Review</h4>
				<p class="tt-row why__line">
					<span class="chip" :class="provenance.review.route === 'human' ? 'chip--warning' : 'chip--info'">
						{{ provenance.review.route === "human" ? "routed to a human" : `${provenance.review.route ?? "auto"} review` }}
					</span>
					<span v-if="provenance.review.risk !== undefined" class="chip chip--muted">risk {{ provenance.review.risk.toFixed(2) }}</span>
					<span v-if="provenance.review.decidedBy" class="tt-hint">approved by <code>{{ provenance.review.decidedBy }}</code></span>
				</p>
			</section>
			<p v-if="provenance && provenance.others.length > 0" class="tt-hint">
				Also in the note: {{ provenance.others.join(", ") }}
			</p>
			<section class="why__section" data-why-section="reasons">
				<h4 class="why__subtitle">Reasons ({{ reasons.length }} {{ reasons.length === 1 ? "event" : "events" }})</h4>
				<ol class="why__list">
					<li v-for="r in reasons" :key="r.id" :data-reason="r.id">
						<template v-if="r.event">
							<code>{{ r.event.type }}</code>
							<span class="tt-hint"> by <code>{{ r.event.actor.id }}</code> · #{{ r.event.seq }} ·
								<time :datetime="isoTime(r.event.at)">{{ formatTime(r.event.at) }}</time></span>
						</template>
						<template v-else><code>{{ r.id }}</code> <span class="tt-hint">(not in this answer)</span></template>
					</li>
				</ol>
			</section>
			<ul v-if="kernel.gates.length > 0" class="why__gates" aria-label="Gate decisions">
				<li v-for="gate in kernel.gates" :key="`${gate.ext}:${gate.mode}`">
					<span class="chip" :class="`chip--${gateTone(gate.decision)}`">
						{{ gate.ext }}: {{ gate.decision }}<template v-if="gate.mode === 'shadow'"> (shadow)</template>
					</span>
					<span v-if="gate.message" class="tt-hint"> {{ gate.message }}</span>
				</li>
			</ul>
		</template>
	</article>
</template>

<style scoped>
.why {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-3);
}

.why__title {
	font-size: var(--tt-text-md);
	margin: 0;
}

.why__reason {
	margin: 0;
	overflow-wrap: anywhere;
}

.why__facts {
	display: grid;
	grid-template-columns: max-content minmax(0, 1fr);
	gap: var(--tt-space-1) var(--tt-space-4);
	margin: 0;
}

.why__facts dt {
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}

.why__facts dd {
	margin: 0;
	min-width: 0;
	overflow-wrap: anywhere;
}

.why__section {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-1);
}

.why__subtitle {
	font-size: var(--tt-text-sm);
	margin: 0;
	overflow-wrap: anywhere;
}

.why__line {
	margin: 0;
}

.why__list {
	margin: 0;
	padding-left: var(--tt-space-4);
	overflow-wrap: anywhere;
}

.why__gates {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-1);
	margin: 0;
	padding: 0;
	list-style: none;
}
</style>
