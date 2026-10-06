<script setup lang="ts">
// Node settings. For a repo, Owner only: lane settings — the lane
// mode override (or the forge default), the
// effective mode and any breaker degradation, `max_active_lanes`, attic
// retention (1–30 days, default 7), the trunk pack estimate and the forge's
// retained-lane-repo count against its ceiling. The kernel authorizes the
// PUT; the page only hides the form from non-owners.
import { computed, reactive, ref, useId, watch } from "vue";
import { RouterLink } from "vue-router";
import type { RepoLaneSettingsDto } from "@tartan/contract/api.ts";
import type { LaneMode } from "@tartan/contract/lanes.ts";
import { useApi } from "../../app/context.ts";
import { errorMessage } from "../../api/http.ts";
import AsyncState from "../../components/AsyncState.vue";
import NodeCrumbs from "../../components/NodeCrumbs.vue";
import PageHeader from "../../components/PageHeader.vue";
import { useResource } from "../../composables/resource.ts";
import { repoConfigHref } from "../../router/params.ts";
import { useToasts } from "../../shell/toasts.ts";
import { formatBytes, formatTime } from "../../ui/format.ts";
import { useNodeView } from "../repo/useNodeView.ts";

const api = useApi();
const toasts = useToasts();
const id = useId();
const node = useNodeView(() => "settings");

const isRepo = computed(() => node.data.value?.node.kind === "repo");
const isOwner = computed(() => (node.data.value?.viewer.role ?? 0) >= 50);
const repoId = computed(() => node.data.value?.repo?.id ?? null);

const lanes = useResource(
	() => (isRepo.value && isOwner.value ? repoId.value : null),
	(rid) => (rid ? api.lanes.settings(rid) : Promise.resolve(null)),
);

/**
 * The modes an Owner may choose for this repo (the kernel's
 * `OWNER_LANE_MODES`; it re-checks): per-agent lane repos created with
 * `import()` (the `repo` backend), or branch lanes.
 */
const MODES: readonly {
	value: LaneMode | "default";
	label: string;
}[] = [
	{ value: "default", label: "Forge default" },
	{ value: "import", label: "Own lane repo, created with import()" },
	{ value: "branch", label: "Branch lanes in this repo" },
];

const form = reactive({
	laneMode: "default" as LaneMode | "default",
	maxActiveLanes: 200,
	atticRetentionDays: 7,
});
const saving = ref(false);
const saveError = ref<string | null>(null);

const fill = (s: RepoLaneSettingsDto | null): void => {
	if (!s) return;
	form.laneMode = s.laneMode;
	form.maxActiveLanes = s.maxActiveLanes;
	form.atticRetentionDays = s.atticRetentionDays;
};
watch(() => lanes.data.value, fill, { immediate: true });

const valid = computed(() =>
	MODES.some((mode) => mode.value === form.laneMode) &&
	Number.isInteger(form.maxActiveLanes) && form.maxActiveLanes >= 1 &&
	form.maxActiveLanes <= 10_000 && Number.isInteger(form.atticRetentionDays) &&
	form.atticRetentionDays >= 1 && form.atticRetentionDays <= 30
);

const save = async (): Promise<void> => {
	if (!repoId.value || !valid.value) return;
	saving.value = true;
	saveError.value = null;
	try {
		const saved = await api.lanes.saveSettings(repoId.value, {
			laneMode: form.laneMode === "default" ? null : form.laneMode,
			maxActiveLanes: form.maxActiveLanes,
			atticRetentionDays: form.atticRetentionDays,
		});
		lanes.data.value = saved;
		toasts.push({ tone: "success", text: "Lane settings saved." });
	} catch (e) {
		saveError.value = errorMessage(e);
	} finally {
		saving.value = false;
	}
};

const ceilingPct = computed(() => {
	const s = lanes.data.value;
	return s && s.maxLaneReposForge > 0
		? Math.round((s.retainedLaneRepos / s.maxLaneReposForge) * 100)
		: 0;
});
</script>

<template>
	<AsyncState
		:loading="node.loading.value"
		:error="node.error.value"
		:status="node.status.value"
		:ready="node.data.value !== null"
		what="these settings"
		@retry="node.reload"
	>
		<div v-if="node.data.value" class="tt-stack">
			<NodeCrumbs :path="node.data.value.node.path" />
			<PageHeader title="Settings" :subtitle="node.data.value.node.path" />
			<section class="tt-panel" aria-labelledby="about-title">
				<h2 id="about-title" class="settings-title">About</h2>
				<dl class="settings-kv">
					<dt>Kind</dt><dd>{{ node.data.value.node.kind }}</dd>
					<dt>Visibility</dt><dd>{{ node.data.value.node.visibility }}</dd>
					<template v-if="node.data.value.node.defaultBranch">
						<dt>Default branch</dt><dd><code>{{ node.data.value.node.defaultBranch }}</code></dd>
					</template>
					<dt>Created</dt><dd>{{ formatTime(node.data.value.node.createdAt) }}</dd>
				</dl>
			</section>

			<section v-if="isRepo" class="tt-panel tt-stack" aria-labelledby="extensions-title">
				<h2 id="extensions-title" class="settings-title">Extensions</h2>
				<p>
					This repository configures its extensions, CI pipeline and review owners in the CUE package
					<code>tartan</code> in its root.
					<RouterLink :to="repoConfigHref(node.data.value.node.path)">Open the extensions config</RouterLink>
				</p>
			</section>

			<section v-if="isRepo" class="tt-panel tt-stack" aria-labelledby="lanes-title">
				<h2 id="lanes-title" class="settings-title">Lanes</h2>
				<p v-if="!isOwner" class="tt-muted">Only an Owner of this repository can change lane settings.</p>
				<AsyncState
					v-else
					:loading="lanes.loading.value"
					:error="lanes.error.value"
					:status="lanes.status.value"
					:ready="lanes.data.value !== null"
					what="lane settings"
					@retry="lanes.reload"
				>
					<template v-if="lanes.data.value">
						<dl class="settings-kv">
							<dt>Effective mode</dt>
							<dd>
								<strong>{{ lanes.data.value.effectiveMode }}</strong>
								<span v-if="lanes.data.value.effectiveMode !== lanes.data.value.laneMode" class="chip chip--warning">degraded from {{ lanes.data.value.laneMode }}</span>
							</dd>
							<template v-if="lanes.data.value.degradedUntil">
								<dt>Breaker</dt>
								<dd>Holding new lanes on a later mode until {{ formatTime(lanes.data.value.degradedUntil) }}</dd>
							</template>
							<template v-if="lanes.data.value.importTooLargeUntil">
								<dt>Import</dt>
								<dd>Skipped for this repository until {{ formatTime(lanes.data.value.importTooLargeUntil) }}</dd>
							</template>
							<dt>Trunk pack estimate</dt>
							<dd>{{ lanes.data.value.trunkPackBytes === null ? "not measured yet" : formatBytes(lanes.data.value.trunkPackBytes) }}</dd>
							<dt>Retained lane repos</dt>
							<dd>
								{{ lanes.data.value.retainedLaneRepos }} here · forge ceiling {{ lanes.data.value.maxLaneReposForge }}
								<progress
									class="settings-meter"
									:value="lanes.data.value.retainedLaneRepos"
									:max="Math.max(1, lanes.data.value.maxLaneReposForge)"
									:aria-label="`${ceilingPct}% of the forge ceiling`"
								/>
							</dd>
						</dl>
						<form class="tt-stack" novalidate @submit.prevent="save">
							<div class="tt-field">
								<label :for="`${id}-mode`" class="tt-field__label">Lane mode</label>
								<select :id="`${id}-mode`" v-model="form.laneMode" class="tt-input" name="laneMode">
									<option v-for="mode in MODES" :key="mode.value" :value="mode.value">{{ mode.label }}</option>
								</select>
								<p class="tt-hint">
									New lanes try this first, then the forge's fallback order.
									Lanes in their own repository are per-agent Artifacts repositories created with import(), with branch lanes as the fallback.
								</p>
							</div>
							<div class="tt-field">
								<label :for="`${id}-max`" class="tt-field__label">Max active lanes</label>
								<input :id="`${id}-max`" v-model.number="form.maxActiveLanes" class="tt-input" type="number" min="1" max="10000" step="1" name="maxActiveLanes" />
							</div>
							<div class="tt-field">
								<label :for="`${id}-attic`" class="tt-field__label">Attic retention (days)</label>
								<input :id="`${id}-attic`" v-model.number="form.atticRetentionDays" class="tt-input" type="number" min="1" max="30" step="1" name="atticRetentionDays" />
								<p class="tt-hint">How long archived lanes stay fetchable: 1 to 30 days (default 7).</p>
							</div>
							<p v-if="saveError" class="chip chip--danger" role="alert">{{ saveError }}</p>
							<div class="tt-row">
								<button type="submit" class="tt-button tt-button--primary" :disabled="saving || !valid">
									{{ saving ? "Saving…" : "Save lane settings" }}
								</button>
							</div>
						</form>
					</template>
				</AsyncState>
			</section>
		</div>
	</AsyncState>
</template>

<style scoped>
.settings-title {
	font-size: var(--tt-text-md);
	margin-bottom: var(--tt-space-3);
}

.settings-kv {
	display: grid;
	grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr);
	gap: var(--tt-space-2) var(--tt-space-4);
	margin: 0;
}

.settings-kv dt {
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}

.settings-kv dd {
	margin: 0;
	min-width: 0;
	overflow-wrap: anywhere;
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-2);
}

.settings-meter {
	width: 100%;
	max-width: 16rem;
	accent-color: var(--tt-accent);
}

@media (max-width: 30rem) {
	.settings-kv {
		grid-template-columns: minmax(0, 1fr);
	}

	.settings-kv dd {
		margin-bottom: var(--tt-space-2);
	}
}
</style>
