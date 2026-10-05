<script setup lang="ts">
// Repository settings → Extensions (`/<repo>/-/settings/extensions`; ADR repo
// config, "User interface"). Members (Reporter+) read it. It
// shows the config state, what applied it, the root `*.cue` files the forge
// sent (the CUE CLI chose package `tartan` among them), issues and denials,
// the effective extensions and where each comes from, the repo policy in
// force at the trunk tip (pipeline, owners, projects, global), the
// approvals that bind here, and the schema for writing config locally.
// Actions (apply, re-evaluate, keep last-good) show by role; the kernel
// re-checks each one. Repository-controlled text is interpolated only. The
// state follows the evaluator: an apply, a re-evaluation or a trunk move
// resolves in the background, so the page reloads on `repo.config.*`.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import type {
	RepoConfigEffectiveRow,
	RepoConfigSchemaDto,
} from "@tartan/contract/repoconfig.ts";
import { useApi, useLive } from "../../app/context.ts";
import { errorMessage } from "../../api/http.ts";
import AsyncState from "../../components/AsyncState.vue";
import CopyField from "../../components/CopyField.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import { useResource } from "../../composables/resource.ts";
import { type TimerHandle, useScheduler } from "../../live/scheduler.ts";
import { blobHref, nodeHref } from "../../router/params.ts";
import { useToasts } from "../../shell/toasts.ts";
import { formatTime, shortSha } from "../../ui/format.ts";
import { useNodeView } from "../repo/useNodeView.ts";
import ConfigIssues from "./ConfigIssues.vue";
import {
	jsonText,
	LEGACY_DIR_HINT,
	MANAGED_BY_TEXT,
	planLines,
	REPO_CONFIG_EXPORT_COMMAND,
	settingsActions,
	shortKey,
	STATUS_VIEW,
} from "./model.ts";

const api = useApi();
const toasts = useToasts();
const node = useNodeView(() => "settings/extensions");

const repoId = computed(() => node.data.value?.repo?.id ?? null);
const repoPath = computed(() => node.data.value?.node.path ?? node.nodePath.value);
const role = computed(() => node.data.value?.viewer.role ?? 0);

const config = useResource(
	() => repoId.value,
	(rid) => (rid ? api.repoConfig.state(rid) : Promise.resolve(null)),
);
const state = computed(() => config.data.value);

// An apply answers at once with the evaluation pending; its outcome
// (`repo.config.applied`, `.failed`, `.needs-apply`, …) arrives on the live
// feed (e2e: the chip stayed "needs apply" after an apply until a reload).
const live = useLive();
let unsubscribe: (() => void) | null = null;
watch(
	repoId,
	(rid) => {
		unsubscribe?.();
		unsubscribe = rid === null ? null : live.subscribe(rid, {
			patterns: ["repo.config.*"],
			onEvents: () => void config.reload(),
			onResync: () => void config.reload(),
		});
	},
	{ immediate: true },
);
// The page also follows its own apply or re-evaluation by asking again
// every FOLLOW_MS until the state moves (or FOLLOW_MAX_MS pass): the live
// feed is the fast path, and this one does not depend on it (e2e: the API
// said current 3 s after the apply while the chip stayed "needs apply").
const FOLLOW_MS = 2_000;
const FOLLOW_MAX_MS = 120_000;
const scheduler = useScheduler();
let follow: TimerHandle | null = null;
const stopFollowing = (): void => {
	if (follow !== null) scheduler.clearTimeout(follow);
	follow = null;
};
const fingerprint = (): string => {
	const s = state.value;
	return s
		? JSON.stringify([s.status, s.appliedSha, s.pendingSha, s.trunkSha])
		: "";
};
/** The action's outcome shows: the state moved and no evaluation is pending. */
const settled = (before: string): boolean =>
	state.value !== null && state.value.pendingSha === undefined &&
	fingerprint() !== before;
const followFrom = (before: string, waited = 0): void => {
	stopFollowing();
	if (waited >= FOLLOW_MAX_MS) return;
	follow = scheduler.setTimeout(async () => {
		follow = null;
		await config.reload();
		if (!settled(before)) followFrom(before, waited + FOLLOW_MS);
	}, FOLLOW_MS);
};
onBeforeUnmount(() => {
	unsubscribe?.();
	stopFollowing();
});
const status = computed(() => state.value ? STATUS_VIEW[state.value.status] : null);
const actions = computed(() =>
	state.value
		? settingsActions(state.value, role.value)
		: { apply: false, reevaluate: false, keepLastGood: false }
);
const trunkRef = computed(() =>
	state.value?.trunkSha ?? node.data.value?.repo?.defaultBranch ?? "main"
);
const sent = computed(() => (state.value?.rootFiles ?? []).map((f) => f.name));
const schemaHref = computed(() => `${nodeHref(repoPath.value)}/-/settings/extensions#schema`);

const SOURCE_TEXT = (row: RepoConfigEffectiveRow): string => {
	switch (row.source) {
		case "repo-config":
			return `repo config${row.sourceSha ? ` @ ${shortSha(row.sourceSha)}` : ""}`;
		case "overlay":
			return `overlay on /${row.nodePath}`;
		case "inherited":
			return `inherited from /${row.nodePath}`;
		default:
			return "manual";
	}
};

const policyRows = computed(() => {
	const p = state.value?.policy;
	if (!p) return [];
	return [
		{ key: "pipeline", label: "Pipeline (tartan.ci)", value: p.pipeline },
		{ key: "owners", label: "Owners (tartan.review)", value: p.owners },
		{ key: "projects", label: "Projects", value: p.projects },
		{ key: "global", label: "Global files", value: p.global },
	].filter((r) => r.value !== undefined);
});

const busy = ref<string | null>(null);
const actionError = ref<string | null>(null);
const act = async (
	name: string,
	work: () => Promise<unknown>,
	done: string,
): Promise<void> => {
	if (busy.value !== null) return;
	busy.value = name;
	actionError.value = null;
	const before = fingerprint();
	try {
		await work();
		toasts.push({ tone: "success", text: done });
		await config.reload();
		if ((name === "apply" || name === "reevaluate") && !settled(before)) {
			followFrom(before);
		}
	} catch (e) {
		actionError.value = errorMessage(e);
	} finally {
		busy.value = null;
	}
};
const apply = () => {
	const rid = repoId.value;
	const sha = state.value?.trunkSha;
	if (!rid || !sha) return;
	void act("apply", () => api.repoConfig.apply(rid, sha), "Applying trunk config.");
};
const reevaluate = () => {
	const rid = repoId.value;
	if (!rid) return;
	void act("reevaluate", () => api.repoConfig.reevaluate(rid), "Re-evaluating trunk config.");
};
const override = (action: "keep-last-good" | "clear") => {
	const rid = repoId.value;
	if (!rid) return;
	void act(
		action,
		() => api.repoConfig.override(rid, action),
		action === "clear" ? "Lands wait for the config again." : "Kept the last good config.",
	);
};

const schema = ref<RepoConfigSchemaDto | null>(null);
const schemaError = ref<string | null>(null);
const loadSchema = async (): Promise<void> => {
	const rid = repoId.value;
	if (!rid) return;
	schemaError.value = null;
	try {
		schema.value = await api.repoConfig.schema(rid);
	} catch (e) {
		schemaError.value = errorMessage(e);
	}
};
const schemaFiles = computed(() =>
	Object.entries(schema.value?.files ?? {}).sort(([a], [b]) => a.localeCompare(b))
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
		<RepoFrame v-if="node.data.value" :view="node.data.value" :ctx="node.ctx.value" active="config" wide>
			<div class="tt-stack">
				<header class="config-head">
					<h2 class="config-title">Extensions config</h2>
					<p class="tt-muted">
						Tartan config is the CUE package <code>tartan</code> in the repository root: any root
						<code>.cue</code> file with <code>package tartan</code>, named and split as you like.
						The forge applies it from trunk only.
					</p>
				</header>

				<AsyncState
					:loading="config.loading.value && config.data.value === null"
					:error="config.error.value"
					:status="config.status.value"
					:ready="config.data.value !== null"
					what="the repository config"
					@retry="config.reload"
				>
					<template v-if="state && status">
						<p v-if="!state.enabled" class="chip chip--warning" role="status">
							Repository config is off on this forge: nothing is evaluated, CI runs zero-config and review has no owners rules.
							Installations it made earlier stay until an Owner removes them.
						</p>
						<p v-if="state.legacyDir" class="chip chip--info" role="note">{{ LEGACY_DIR_HINT }}</p>

						<section class="tt-panel tt-stack" aria-labelledby="config-state">
							<h3 id="config-state" class="config-sub">State</h3>
							<div class="tt-row config-chips">
								<span :class="`chip chip--${status.tone}`" data-status>{{ status.label }}</span>
								<span v-if="state.held" class="chip chip--warning">lands held{{ state.holdReason === "gate-missing" ? ": a gate lost its approval" : "" }}</span>
								<span v-if="state.keptLastGoodBy" class="chip chip--info">kept last good by {{ state.keptLastGoodBy }}</span>
							</div>
							<p class="tt-muted">{{ status.detail }}</p>
							<dl class="config-kv">
								<template v-if="state.appliedSha">
									<dt>Applied</dt>
									<dd>
										package <code>tartan</code> @
										<RouterLink :to="`${nodeHref(repoPath)}/-/commit/${state.appliedSha}`"><code>{{ shortSha(state.appliedSha) }}</code></RouterLink>
										<span v-if="state.appliedBy.length > 0">, signed off by {{ state.appliedBy.join(", ") }}</span>
										<span v-if="state.appliedAt" class="tt-muted">· {{ formatTime(state.appliedAt) }}</span>
									</dd>
								</template>
								<template v-if="state.pendingSha">
									<dt>Pending</dt>
									<dd><code>{{ shortSha(state.pendingSha) }}</code></dd>
								</template>
								<dt>Evaluator</dt>
								<dd>
									<template v-if="state.cueVersion">cue {{ state.cueVersion }}</template>
									<template v-else>not evaluated yet</template>
									<span class="tt-muted">({{ state.evaluator }})</span>
								</dd>
								<template v-if="state.appliedKey || state.pendingKey">
									<dt>Input key</dt>
									<dd><code>{{ shortKey(state.pendingKey ?? state.appliedKey) }}</code></dd>
								</template>
								<template v-if="state.lastEvaluatedAt">
									<dt>Last evaluated</dt>
									<dd>{{ formatTime(state.lastEvaluatedAt) }}</dd>
								</template>
							</dl>

							<div v-if="state.rootFiles.length > 0">
								<h4 class="config-sub config-sub--small">Root .cue files sent</h4>
								<ul class="config-files">
									<li v-for="file in state.rootFiles" :key="file.name">
										<RouterLink :to="blobHref(repoPath, trunkRef, file.name)"><code>{{ file.name }}</code></RouterLink>
									</li>
								</ul>
								<p class="tt-hint">
									The forge sends every root <code>.cue</code> file; <code>cue export .:tartan</code> selects package
									<code>tartan</code> from them. Files of other packages (cuenv's <code>env.cue</code>, say) are left alone,
									but a change to any root <code>.cue</code> file needs a human sign-off.
								</p>
							</div>
							<p v-else class="tt-muted">Trunk has no root .cue file.</p>

							<div v-if="state.failure" class="tt-stack" role="alert">
								<p class="config-failure"><strong>{{ state.failure.code }}</strong> {{ state.failure.message }}</p>
								<ConfigIssues
									:issues="state.failure.issues"
									:denials="state.failure.denials"
									:repo-path="repoPath"
									:commit="state.pendingSha ?? trunkRef"
									:sent="sent"
									:schema-href="schemaHref"
								/>
							</div>

							<div v-if="state.plan.length > 0">
								<h4 class="config-sub config-sub--small">Plan against what is applied</h4>
								<ul class="config-plan">
									<li v-for="(line, i) in planLines(state.plan)" :key="i">{{ line }}</li>
								</ul>
							</div>

							<p v-if="actionError" class="chip chip--danger" role="alert">{{ actionError }}</p>
							<div v-if="actions.apply || actions.reevaluate || actions.keepLastGood || state.keptLastGoodBy" class="tt-row">
								<button v-if="actions.apply" type="button" class="tt-button tt-button--primary" :disabled="busy !== null" @click="apply">
									{{ busy === "apply" ? "Applying…" : "Apply trunk config" }}
								</button>
								<button v-if="actions.reevaluate" type="button" class="tt-button" :disabled="busy !== null" @click="reevaluate">
									{{ busy === "reevaluate" ? "Re-evaluating…" : "Re-evaluate" }}
								</button>
								<button v-if="actions.keepLastGood" type="button" class="tt-button tt-button--warning" :disabled="busy !== null" @click="override('keep-last-good')">
									Keep last good
								</button>
								<button v-if="state.keptLastGoodBy && role >= 50" type="button" class="tt-button" :disabled="busy !== null" @click="override('clear')">
									Hold lands again
								</button>
							</div>
						</section>

						<section class="tt-panel tt-stack" aria-labelledby="config-effective">
							<h3 id="config-effective" class="config-sub">Effective extensions</h3>
							<div v-if="state.effective.length > 0" class="tt-scroll-x">
								<table class="tt-table">
									<thead>
										<tr><th>Extension</th><th>Version</th><th>Mode</th><th>Source</th><th>Repo keys</th></tr>
									</thead>
									<tbody>
										<tr v-for="row in state.effective" :key="row.installationId">
											<td>
												<code>{{ row.extId }}</code>
												<span v-if="row.hasGates" class="chip chip--muted">gate</span>
												<span v-if="row.ownerDisabled" class="chip chip--warning">disabled by an Owner</span>
											</td>
											<td><code>{{ row.version }}</code></td>
											<td>{{ row.mode }}</td>
											<td>{{ SOURCE_TEXT(row) }}</td>
											<td>
												<span v-if="row.repoPolicy.length > 0">policy: <code>{{ row.repoPolicy.join(", ") }}</code></span>
												<span v-if="row.overridable.length > 0">overridable: <code>{{ row.overridable.join(", ") }}</code></span>
												<details v-if="row.managed || row.source === 'overlay'">
													<summary>{{ MANAGED_BY_TEXT }}</summary>
													<pre class="config-json">{{ jsonText(row.settings) }}</pre>
												</details>
											</td>
										</tr>
									</tbody>
								</table>
							</div>
							<p v-else class="tt-muted">No extension is in force here.</p>
						</section>

						<section class="tt-panel tt-stack" aria-labelledby="config-policy">
							<h3 id="config-policy" class="config-sub">Repo policy</h3>
							<p class="tt-muted">
								Read at each change's base on trunk:
								<code>extensions: "tartan.ci": settings: pipeline</code>,
								<code>extensions: "tartan.review": settings: owners</code>, and the top-level
								<code>projects</code> and <code>global</code>.
							</p>
							<template v-if="state.policy.inForce">
								<p>
									From <code>{{ shortSha(state.policy.inForce.sha) }}</code>
									<span v-if="!state.policy.exact" class="chip chip--warning">last good: the newest config does not evaluate</span>
									<span v-if="state.policy.pending" class="chip chip--info">evaluating the newest config</span>
								</p>
								<div v-for="row in policyRows" :key="row.key">
									<h4 class="config-sub config-sub--small">{{ row.label }}</h4>
									<pre class="config-json">{{ jsonText(row.value) }}</pre>
								</div>
								<p v-if="policyRows.length === 0" class="tt-muted">Package tartan sets no repo policy: CI runs zero-config and review has no owners rules.</p>
							</template>
							<p v-else class="tt-muted">No trunk config recorded yet.</p>
						</section>

						<section class="tt-panel tt-stack" aria-labelledby="config-approved">
							<h3 id="config-approved" class="config-sub">Approved for this repo</h3>
							<ul v-if="state.approvals.length > 0" class="config-approvals">
								<li v-for="a in state.approvals" :key="`${a.nodeId}/${a.extId}`">
									<code>{{ a.extId }}</code> {{ a.version }}
									<span class="tt-muted">at /{{ a.nodePath }}, by {{ a.approvedBy }}, sha256 <code>{{ shortKey(a.packageSha256) }}</code></span>
									<span v-if="a.needsReapproval" class="chip chip--warning">needs re-approval</span>
								</li>
							</ul>
							<p v-else class="tt-muted">No package is approved for repo config here; an Owner approves packages on a group or repo.</p>
						</section>

						<section id="schema" class="tt-panel tt-stack" aria-labelledby="config-schema">
							<h3 id="config-schema" class="config-sub">Schema</h3>
							<p class="tt-muted">
								<code>tartan config schema --out &lt;dir&gt;</code> writes these files; copy the root
								<code>.cue</code> files beside them and run the command below to get the forge's exact output.
							</p>
							<CopyField label="Local evaluation" :value="REPO_CONFIG_EXPORT_COMMAND" />
							<div class="tt-row">
								<button type="button" class="tt-button tt-button--sm" @click="loadSchema">
									{{ schema ? "Reload schema" : "Show schema" }}
								</button>
								<span v-if="schema" class="tt-muted">schema key <code>{{ shortKey(schema.schemaKey) }}</code>, epoch {{ schema.epoch }}</span>
							</div>
							<p v-if="schemaError" class="chip chip--danger" role="alert">{{ schemaError }}</p>
							<details v-for="[path, text] in schemaFiles" :key="path">
								<summary><code>{{ path }}</code></summary>
								<pre class="config-json">{{ text }}</pre>
							</details>
						</section>
					</template>
				</AsyncState>
			</div>
		</RepoFrame>
	</AsyncState>
</template>

<style scoped>
.config-head {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
}

.config-title {
	font-size: var(--tt-text-lg);
	margin: 0;
}

.config-sub {
	font-size: var(--tt-text-md);
	margin: 0;
}

.config-sub--small {
	font-size: var(--tt-text-sm);
	color: var(--tt-text-muted);
	margin-bottom: var(--tt-space-2);
}

.config-chips {
	flex-wrap: wrap;
}

.config-kv {
	display: grid;
	grid-template-columns: minmax(8rem, max-content) minmax(0, 1fr);
	gap: var(--tt-space-2) var(--tt-space-4);
	margin: 0;
}

.config-kv dt {
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}

.config-kv dd {
	margin: 0;
	min-width: 0;
	overflow-wrap: anywhere;
}

.config-files,
.config-plan,
.config-approvals {
	margin: 0;
	padding-inline-start: var(--tt-space-4);
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-1);
	overflow-wrap: anywhere;
}

.config-failure {
	margin: 0;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.config-json {
	margin: 0;
	padding: var(--tt-space-2) var(--tt-space-3);
	background: var(--tt-surface-sunken);
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	font-family: var(--tt-font-mono);
	font-size: var(--tt-text-sm);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	max-height: 24rem;
	overflow: auto;
}

@media (max-width: 30rem) {
	.config-kv {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
