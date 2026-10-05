<script setup lang="ts">
// One installation: mode (enforce / shadow / disabled), approved grants and
// the extension's `contributes.settings` values. Every string stays text.
// Saving settings needs `PUT /-/api/installations/<id>/config`, which the
// kernel does not serve yet: the values are shown read-only and editing
// arrives with milestone M2. Repository config (WP23): an
// installation made from a repo's package `tartan` says so (its settings are
// managed there), and an Owner can allow repositories below to overlay a
// repo-scoped installation's overridable settings. A js/wasm installation
// shows its circuit breaker, which an Owner can reset; one with a
// `ref.advance` gate links to the replay and promote page.
import { computed, ref, useId } from "vue";
import type { BreakerResponse } from "../../api/client.ts";
import { RouterLink, useRoute } from "vue-router";
import type { InstallationMode } from "@tartan/contract/common.ts";
import { useApi } from "../../app/context.ts";
import { errorMessage } from "../../api/http.ts";
import AsyncState from "../../components/AsyncState.vue";
import PageHeader from "../../components/PageHeader.vue";
import { useResource } from "../../composables/resource.ts";
import { stringParam } from "../../router/params.ts";
import { useToasts } from "../../shell/toasts.ts";
import { formatTime } from "../../ui/format.ts";
import type { UiNode } from "../../ui/nodeTypes.ts";
import { settingsForm } from "../../ui/settingsForm.ts";
import { MANAGED_BY_TEXT } from "../repoconfig/model.ts";

const api = useApi();
const route = useRoute();
const toasts = useToasts();
const installationId = computed(() => stringParam(route.params, "installationId"));

const inst = useResource(installationId, (iid) => api.extensions.installation(iid));
const packages = useResource(() => inst.data.value?.extId ?? null, (extId) =>
	extId ? api.extensions.packages() : Promise.resolve(null));
const pkg = computed(() =>
	packages.data.value?.packages.find((p) =>
		p.extId === inst.data.value?.extId && p.version === inst.data.value?.version
	) ?? null
);
const settings = computed(() =>
	settingsForm(pkg.value?.manifest.contributes?.settings, inst.data.value?.config)
);
const grantLines = computed(() => {
	const g = inst.data.value?.grants;
	if (!g) return [];
	return [
		`Repository: ${g.repo}`,
		...(g.lanes?.length ? [`Lanes: ${g.lanes.join(", ")}`] : []),
		...(g.land?.length ? [`Land: ${g.land.join(", ")}`] : []),
		...(g.runs?.length ? [`Runs: ${g.runs.join(", ")}`] : []),
		...(g["events.read"]?.length ? [`Read events: ${g["events.read"].join(", ")}`] : []),
		...(g["interfaces.call"]?.length ? [`Call interfaces: ${g["interfaces.call"].join(", ")}`] : []),
		...(g.notes ? ["Write why notes"] : []),
		...(g.notify ? ["Send notices"] : []),
		...(g.ai ? ["Use Workers AI"] : []),
	];
});

const modeBusy = ref(false);
const setMode = async (mode: InstallationMode): Promise<void> => {
	if (!inst.data.value || inst.data.value.mode === mode) return;
	if (!globalThis.confirm?.(`Switch ${inst.data.value.extId} to ${mode}?`)) return;
	modeBusy.value = true;
	try {
		inst.data.value = await api.extensions.setMode(inst.data.value.id, mode);
		toasts.push({ tone: "success", text: `Mode set to ${mode}.` });
	} catch (e) {
		toasts.push({ tone: "danger", text: errorMessage(e) });
	} finally {
		modeBusy.value = false;
	}
};

/** A settings field's current value (or its schema default), as text. */
const shown = (value: unknown): string => {
	if (value === undefined || value === null || value === "") return "not set";
	if (typeof value === "boolean") return value ? "on" : "off";
	if (Array.isArray(value)) return value.join(", ");
	return String(value);
};
const settingRows = computed(() => {
	const form: UiNode | null = settings.value.form;
	if (form === null || form.t !== "form") return [];
	return form.fields.flatMap((field) =>
		"name" in field && typeof field.name === "string"
			? [{
				key: field.name,
				label: "label" in field && typeof field.label === "string"
					? field.label
					: field.name,
				value: shown("value" in field ? field.value : undefined),
			}]
			: []
	);
});

/** `MANAGED_BY_TEXT` (contract repoconfig.ts; pinned by contract-parity.spec.ts). */
const managedBy = MANAGED_BY_TEXT;
const overridesBusy = ref(false);
const setRepoOverrides = async (on: boolean): Promise<void> => {
	if (!inst.data.value) return;
	overridesBusy.value = true;
	try {
		inst.data.value = await api.extensions.setRepoOverrides(inst.data.value.id, on);
		toasts.push({
			tone: "success",
			text: on ? "Repositories below may override its settings." : "Repo overrides are off.",
		});
	} catch (e) {
		toasts.push({ tone: "danger", text: errorMessage(e) });
	} finally {
		overridesBusy.value = false;
	}
};

const hasAdvanceGate = computed(() =>
	(pkg.value?.manifest.gates ?? []).some((g) => g.point === "ref.advance")
);

// -- Circuit breaker (js/wasm only) ------------------------------------

const breakerId = useId();
const isolated = computed(() =>
	pkg.value !== null && pkg.value.runtime !== "builtin"
);
const breakerRepo = ref("");
const breaker = ref<BreakerResponse | null>(null);
const breakerError = ref<string | null>(null);
const breakerBusy = ref(false);
const repoHint = (): string | undefined => {
	const repo = breakerRepo.value.trim();
	return repo === "" ? undefined : repo;
};
const readBreaker = async (): Promise<void> => {
	if (!inst.data.value) return;
	breakerBusy.value = true;
	breakerError.value = null;
	try {
		breaker.value = await api.extensions.breaker(inst.data.value.id, repoHint());
	} catch (e) {
		breakerError.value = errorMessage(e);
	} finally {
		breakerBusy.value = false;
	}
};
const resetBreaker = async (): Promise<void> => {
	if (!inst.data.value) return;
	if (!globalThis.confirm?.(`Reset the circuit breaker of ${inst.data.value.extId}?`)) return;
	breakerBusy.value = true;
	breakerError.value = null;
	try {
		breaker.value = await api.extensions.resetBreaker(inst.data.value.id, repoHint());
		toasts.push({ tone: "success", text: "Circuit breaker reset." });
	} catch (e) {
		breakerError.value = errorMessage(e);
	} finally {
		breakerBusy.value = false;
	}
};
const breakerTone = (state: string): string =>
	state === "open" ? "danger" : state === "half-open" ? "warning" : "success";

const MODES: readonly { value: InstallationMode; label: string; hint: string }[] = [
	{ value: "enforce", label: "Enforce", hint: "Its gates and actions take effect." },
	{ value: "shadow", label: "Shadow", hint: "It runs, but decisions are only recorded." },
	{ value: "disabled", label: "Disabled", hint: "It does not run (kill switch)." },
];
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
			<RouterLink to="/-/extensions" class="back-link">← Extensions</RouterLink>
			<PageHeader :title="pkg?.manifest.name ?? inst.data.value.extId" :subtitle="pkg?.manifest.description">
				<template #actions>
					<code>{{ inst.data.value.extId }}@{{ inst.data.value.version }}</code>
				</template>
			</PageHeader>

			<section class="tt-panel tt-stack" aria-labelledby="mode-title">
				<h2 id="mode-title" class="inst-title">Mode</h2>
				<div class="modes" role="radiogroup" aria-labelledby="mode-title">
					<button
						v-for="m in MODES"
						:key="m.value"
						type="button"
						role="radio"
						class="mode"
						:aria-checked="inst.data.value.mode === m.value"
						:disabled="modeBusy || inst.data.value.locked"
						@click="setMode(m.value)"
					>
						<strong>{{ m.label }}</strong>
						<span class="mode__hint">{{ m.hint }}</span>
					</button>
				</div>
				<p v-if="inst.data.value.locked" class="tt-hint">Locked by an Owner: only an Owner can change it.</p>
				<p v-if="inst.data.value.modeChangedAt" class="tt-hint">Changed {{ formatTime(inst.data.value.modeChangedAt) }}</p>
				<p v-if="hasAdvanceGate">
					<RouterLink :to="`/-/extensions/${encodeURIComponent(inst.data.value.id)}/compare`">
						Replay its gate over history and promote →
					</RouterLink>
				</p>
			</section>

			<section v-if="isolated" class="tt-panel tt-stack" aria-labelledby="breaker-title">
				<h2 id="breaker-title" class="inst-title">Circuit breaker</h2>
				<p class="tt-muted">
					Three timeouts or CPU kills within 10 minutes open it: calls then short-circuit until it half-opens.
				</p>
				<form class="tt-row breaker-form" novalidate @submit.prevent="readBreaker">
					<template v-if="inst.data.value.storageScope === 'repo'">
						<label :for="`${breakerId}-repo`" class="tt-field__label">Repository</label>
						<input
							:id="`${breakerId}-repo`"
							v-model="breakerRepo"
							class="tt-input breaker-form__repo"
							name="breaker-repo"
							:placeholder="`${inst.data.value.nodePath}/…`"
							spellcheck="false"
						/>
					</template>
					<button type="submit" class="tt-button tt-button--sm" :disabled="breakerBusy">Show breaker</button>
				</form>
				<p v-if="breakerError" class="chip chip--danger" role="alert">{{ breakerError }}</p>
				<div v-if="breaker" class="tt-stack" data-breaker>
					<p>
						<span class="chip" :class="`chip--${breakerTone(breaker.breaker.state)}`">{{ breaker.breaker.state }}</span>
						{{ breaker.breaker.recentStrikes }} strike(s) in the last 10 minutes<template v-if="breaker.breaker.until">,
							half-open at {{ formatTime(breaker.breaker.until) }}</template>.
					</p>
					<ul v-if="breaker.breaker.strikes.length > 0" class="grants">
						<li v-for="s in breaker.breaker.strikes" :key="s.seq">
							{{ formatTime(s.at) }}: {{ s.kind }} in {{ s.method }}
						</li>
					</ul>
					<div class="tt-row">
						<button type="button" class="tt-button tt-button--sm" :disabled="breakerBusy" @click="resetBreaker">Reset breaker</button>
						<span class="tt-hint">An Owner's act.</span>
					</div>
				</div>
			</section>

			<section class="tt-panel" aria-labelledby="details-title">
				<h2 id="details-title" class="inst-title">Details</h2>
				<dl class="inst-kv">
					<dt>Installed at</dt><dd><code>{{ inst.data.value.nodePath }}</code></dd>
					<dt>Storage</dt><dd>{{ inst.data.value.storageScope }}</dd>
					<dt>Background role</dt><dd>{{ inst.data.value.backgroundRole }}</dd>
					<dt>Backfill</dt><dd>{{ inst.data.value.backfill }}</dd>
					<dt>Installed</dt><dd>{{ formatTime(inst.data.value.installedAt) }}</dd>
				</dl>
			</section>

			<section
				v-if="inst.data.value.source === 'repo-config' || inst.data.value.storageScope === 'repo'"
				class="tt-panel tt-stack"
				aria-labelledby="repoconfig-title"
			>
				<h2 id="repoconfig-title" class="inst-title">Repository config</h2>
				<template v-if="inst.data.value.source === 'repo-config'">
					<p>
						{{ managedBy }}<template v-if="inst.data.value.sourceSha"> at <code>{{ inst.data.value.sourceSha.slice(0, 7) }}</code></template>.
					</p>
					<p v-if="inst.data.value.ownerDisabled" class="chip chip--warning">Disabled by an Owner: repository config keeps it disabled.</p>
				</template>
				<template v-else>
					<p>
						Repo overrides: <strong data-repo-overrides>{{ inst.data.value.repoOverrides ? "on" : "off" }}</strong>.
						With them on, repositories below may set its overridable settings in their package <code>tartan</code>.
					</p>
					<div class="tt-row">
						<button type="button" class="tt-button tt-button--sm" :disabled="overridesBusy" @click="setRepoOverrides(!inst.data.value.repoOverrides)">
							{{ inst.data.value.repoOverrides ? "Stop repo overrides" : "Allow repo overrides" }}
						</button>
					</div>
					<p class="tt-hint">Only an Owner at {{ inst.data.value.nodePath }} can change this.</p>
				</template>
			</section>

			<section class="tt-panel" aria-labelledby="grants-title">
				<h2 id="grants-title" class="inst-title">Approved permissions</h2>
				<ul class="grants">
					<li v-for="(line, i) in grantLines" :key="i">{{ line }}</li>
				</ul>
			</section>

			<section v-if="settingRows.length > 0 || settings.unsupported.length > 0" class="tt-panel tt-stack" aria-labelledby="settings-title">
				<h2 id="settings-title" class="inst-title">Settings</h2>
				<dl v-if="settingRows.length > 0" class="inst-kv">
					<template v-for="row in settingRows" :key="row.key">
						<dt>{{ row.label }}</dt><dd>{{ row.value }}</dd>
					</template>
				</dl>
				<p v-if="settings.unsupported.length > 0" class="tt-hint">
					Not shown here: {{ settings.unsupported.join(", ") }}
				</p>
				<p class="tt-hint">Changing an extension's settings arrives with milestone M2.</p>
			</section>
		</div>
	</AsyncState>
</template>

<style scoped>
.back-link {
	font-size: var(--tt-text-sm);
}

.breaker-form {
	align-items: center;
}

.breaker-form__repo {
	flex: 1 1 12rem;
	min-width: 0;
	max-width: 24rem;
}

.inst-title {
	font-size: var(--tt-text-md);
	margin-bottom: var(--tt-space-2);
}

.modes {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--tt-space-2);
}

@media (min-width: 40rem) {
	.modes {
		grid-template-columns: repeat(3, minmax(0, 1fr));
	}
}

.mode {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: var(--tt-space-1);
	padding: var(--tt-space-3);
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	background: var(--tt-surface);
	text-align: start;
	cursor: pointer;
}

.mode[aria-checked="true"] {
	border-color: var(--tt-accent);
	box-shadow: 0 0 0 1px var(--tt-accent);
}

.mode:disabled {
	cursor: not-allowed;
}

.mode__hint {
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}

.inst-kv {
	display: grid;
	grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr);
	gap: var(--tt-space-1) var(--tt-space-4);
	margin: 0;
}

.inst-kv dt {
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}

.inst-kv dd {
	margin: 0;
	overflow-wrap: anywhere;
}

.grants {
	margin: 0;
	padding-inline-start: 1.25rem;
}
</style>
