<script setup lang="ts">
// Policies are reviewed before they take effect: an
// installation runs in shadow mode, its `ref.advance` gate is replayed over
// a repository's last advances ("would have vetoed 2 of the last 41"), and
// an Owner promotes it to enforce. The live-versus-shadow comparison over
// the same window is not built yet (the kernel answers 501), so the page
// says so instead of offering it.
import { computed, reactive, ref, shallowRef, useId } from "vue";
import { RouterLink, useRoute } from "vue-router";
import type { GateReplayResponse } from "@tartan/contract/api.ts";
import { useApi } from "../../app/context.ts";
import { errorMessage } from "../../api/http.ts";
import AsyncState from "../../components/AsyncState.vue";
import PageHeader from "../../components/PageHeader.vue";
import { useResource } from "../../composables/resource.ts";
import { stringParam } from "../../router/params.ts";
import { useToasts } from "../../shell/toasts.ts";

const api = useApi();
const route = useRoute();
const toasts = useToasts();
const id = useId();
const installationId = computed(() => stringParam(route.params, "installationId"));

const inst = useResource(installationId, (iid) => api.extensions.installation(iid));
const packages = useResource(() => inst.data.value?.extId ?? null, (extId) =>
	extId ? api.extensions.packages() : Promise.resolve(null));
const pkg = computed(() =>
	packages.data.value?.packages.find((p) =>
		p.extId === inst.data.value?.extId && p.version === inst.data.value?.version
	) ?? null
);
const hasAdvanceGate = computed(() =>
	(pkg.value?.manifest.gates ?? []).some((g) => g.point === "ref.advance")
);

/** The replay form: a repo inside the installation's node, the last `n` advances. */
const REPLAY_MAX = 50;
const NODE_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
const replayForm = reactive({ repo: "", n: REPLAY_MAX });
const replay = shallowRef<GateReplayResponse | null>(null);
const replayBusy = ref(false);
const replayError = ref<string | null>(null);

const runReplay = async (): Promise<void> => {
	const repo = replayForm.repo.trim();
	const n = Math.floor(Number(replayForm.n));
	if (!NODE_RE.test(repo) || !(n >= 1 && n <= REPLAY_MAX)) {
		replayError.value = `Enter a repository inside ${inst.data.value?.nodePath ?? "the node"} and 1–${REPLAY_MAX} advances.`;
		return;
	}
	if (!inst.data.value) return;
	replayBusy.value = true;
	replayError.value = null;
	try {
		replay.value = await api.extensions.replay(inst.data.value.id, { repo, n });
	} catch (e) {
		replayError.value = errorMessage(e);
	} finally {
		replayBusy.value = false;
	}
};

const vetoes = computed(() =>
	(replay.value?.results ?? []).filter((r) => r.decision === "veto")
);

const promoteBusy = ref(false);
const promote = async (): Promise<void> => {
	const current = inst.data.value;
	if (!current || current.mode !== "shadow") return;
	if (
		!globalThis.confirm?.(
			`Promote ${current.extId} to enforce at ${current.nodePath}? Its gates will then block advances.`,
		)
	) return;
	promoteBusy.value = true;
	try {
		inst.data.value = await api.extensions.promote(current.id);
		toasts.push({
			tone: "success",
			text: `${current.extId} now enforces at ${current.nodePath}.`,
		});
	} catch (e) {
		toasts.push({ tone: "danger", text: errorMessage(e) });
	} finally {
		promoteBusy.value = false;
	}
};

const decisionTone = (d: "allow" | "advise" | "veto"): string =>
	d === "veto" ? "danger" : d === "advise" ? "warning" : "success";
</script>

<template>
	<AsyncState
		:loading="inst.loading.value"
		:error="inst.error.value"
		:status="inst.status.value"
		:ready="inst.data.value !== null"
		what="this installation"
		@retry="inst.reload"
	>
		<div v-if="inst.data.value" class="tt-stack">
			<RouterLink :to="`/-/extensions/${encodeURIComponent(inst.data.value.id)}`" class="back-link">
				← {{ inst.data.value.extId }}
			</RouterLink>
			<PageHeader
				title="Policy compare"
				subtitle="Run a policy in shadow mode, replay it over real history, then promote it."
			>
				<template #actions>
					<span
						class="chip"
						:class="inst.data.value.mode === 'enforce' ? 'chip--success' : inst.data.value.mode === 'shadow' ? 'chip--warning' : 'chip--muted'"
						data-mode
					>{{ inst.data.value.mode }}</span>
				</template>
			</PageHeader>

			<section class="tt-panel tt-stack" aria-labelledby="replay-title">
				<h2 id="replay-title" class="cmp-title">Replay history</h2>
				<p v-if="!hasAdvanceGate" class="tt-muted">
					{{ inst.data.value.extId }} declares no <code>ref.advance</code> gate, so there is nothing to replay.
				</p>
				<form v-else class="tt-stack" novalidate aria-label="Replay" @submit.prevent="runReplay">
					<div class="cmp-grid">
						<div class="tt-field">
							<label :for="`${id}-repo`" class="tt-field__label">Repository</label>
							<input
								:id="`${id}-repo`"
								v-model="replayForm.repo"
								class="tt-input"
								name="replay-repo"
								:placeholder="`${inst.data.value.nodePath}/…`"
								spellcheck="false"
							/>
						</div>
						<div class="tt-field">
							<label :for="`${id}-n`" class="tt-field__label">Last advances</label>
							<input :id="`${id}-n`" v-model.number="replayForm.n" class="tt-input" name="replay-n" type="number" min="1" :max="REPLAY_MAX" />
						</div>
					</div>
					<p class="tt-hint">The gate sees each advance's changes again, advisory only: nothing is blocked or written to trunk.</p>
					<p v-if="replayError" class="chip chip--danger" role="alert">{{ replayError }}</p>
					<div class="tt-row">
						<button type="submit" class="tt-button tt-button--primary" :disabled="replayBusy">
							{{ replayBusy ? "Replaying…" : "Replay" }}
						</button>
					</div>
				</form>
				<div v-if="replay" class="tt-stack" role="region" aria-label="Replay result" data-replay>
					<p class="cmp-summary">
						<template v-if="replay.summary">
							{{ inst.data.value.extId }} would have vetoed
							<strong>{{ replay.summary.vetoed }} of the last {{ replay.summary.of }}</strong> advances.
						</template>
						<template v-else>Replay {{ replay.state }}.</template>
					</p>
					<ul v-if="vetoes.length > 0" class="cmp-vetoes">
						<li v-for="r in vetoes" :key="r.advanceId">
							<span class="chip" :class="`chip--${decisionTone(r.decision)}`">{{ r.decision }}</span>
							<code>{{ r.advanceId }}</code>
							<span class="tt-hint"> {{ r.message }}</span>
						</li>
					</ul>
				</div>
			</section>

			<section class="tt-panel tt-stack" aria-labelledby="promote-title">
				<h2 id="promote-title" class="cmp-title">Promote</h2>
				<template v-if="inst.data.value.mode === 'shadow'">
					<p class="tt-muted">
						Promoting makes this installation enforce at <code>{{ inst.data.value.nodePath }}</code>; an enforcing
						installation of the same extension there is disabled in the same step.
					</p>
					<div class="tt-row">
						<button type="button" class="tt-button tt-button--primary" :disabled="promoteBusy" @click="promote">
							{{ promoteBusy ? "Promoting…" : "Promote to enforce" }}
						</button>
					</div>
				</template>
				<p v-else class="tt-muted">Only an installation in shadow mode can be promoted; this one is {{ inst.data.value.mode }}.</p>
			</section>

			<section class="tt-panel tt-stack" aria-labelledby="compare-title">
				<h2 id="compare-title" class="cmp-title">Live versus shadow</h2>
				<p class="tt-muted">
					A side-by-side of live and shadow decisions over the same window is not built yet. Replay shows what the
					policy would have decided.
				</p>
			</section>
		</div>
	</AsyncState>
</template>

<style scoped>
.cmp-title {
	font-size: var(--tt-text-md);
}

.cmp-grid {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--tt-space-3);
	max-width: 40rem;
}

@media (min-width: 48rem) {
	.cmp-grid {
		grid-template-columns: minmax(0, 3fr) minmax(0, 1fr);
	}
}

.cmp-summary {
	margin: 0;
	font-size: var(--tt-text-md);
}

.cmp-vetoes {
	display: grid;
	gap: var(--tt-space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}
</style>
