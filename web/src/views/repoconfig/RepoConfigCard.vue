<script setup lang="ts">
// Change card "Repo config" (ADR repo config, "User interface"; K13.3): a
// kernel component the change page renders beside its `change.sidebar`
// slots (`slots/hosts.ts` KERNEL_HOST_COMPONENTS). It shows only when the
// change's lane touches a root `*.cue` file: the route badge `human (K13)`,
// the sign-off state with "Approve policy change" for Maintainer+ viewers,
// the plan against trunk's applied set and policy, issues and denials at
// the lane head, and freshness, refreshed by `repo.config.previewed` and
// `repo.policy.*`. The sign-off is a person's act in a browser session,
// bound to the head and its root `*.cue` digest; the kernel checks both.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { RepoConfigPreviewDto } from "@tartan/contract/repoconfig.ts";
import { useApi, useLive } from "../../app/context.ts";
import { errorMessage, isApiError } from "../../api/http.ts";
import { nodeHref } from "../../router/params.ts";
import { useToasts } from "../../shell/toasts.ts";
import { formatTime, shortSha } from "../../ui/format.ts";
import ConfigIssues from "./ConfigIssues.vue";
import {
	activeSignoff,
	canMaintain,
	canSignOff,
	laneOfChange,
	planLines,
	PREVIEW_VIEW,
} from "./model.ts";

const props = defineProps<{
	repoId: string;
	repoPath: string;
	changeId: string;
	/** The viewer's role at the repo (from the view); the kernel re-checks. */
	role: number;
}>();

const api = useApi();
const live = useLive();
const toasts = useToasts();

/** Pages of `changes.*` events read to find the change's lane. */
const MAX_EVENT_PAGES = 10;
const PAGE = 500;

const laneId = ref<string | null>(null);
const preview = ref<RepoConfigPreviewDto | null>(null);
/** The root `*.cue` names the preview's evaluation was given (positions link only to those). */
const sent = ref<readonly string[]>([]);
const loadError = ref<string | null>(null);
let generation = 0;

const findLane = async (repoId: string, changeId: string): Promise<string | null> => {
	const seen: { type: string; data: unknown }[] = [];
	let since = 0;
	for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
		const res = await api.events.list(repoId, {
			since,
			limit: PAGE,
			types: ["changes.opened", "changes.submitted"],
		});
		seen.push(...res.events);
		if (res.events.length < PAGE) break;
		since = res.events[res.events.length - 1]!.seq;
	}
	return laneOfChange(seen, changeId);
};

const loadPreview = async (): Promise<void> => {
	const mine = ++generation;
	const lane = laneId.value;
	if (lane === null) {
		preview.value = null;
		return;
	}
	try {
		const answer = await api.repoConfig.lane(props.repoId, lane);
		const files = answer.inputKey === undefined ? [] : await api.repoConfig
			.evaluation(props.repoId, answer.inputKey)
			.then((e) => e.files.map((f) => f.name))
			.catch(() => []);
		if (mine === generation) {
			preview.value = answer;
			sent.value = files;
			loadError.value = null;
		}
	} catch (e) {
		if (mine !== generation) return;
		// 404: the lane touches no root .cue file (no preview); 403: not a member.
		preview.value = null;
		sent.value = [];
		loadError.value = isApiError(e) && (e.status === 404 || e.status === 403)
			? null
			: errorMessage(e);
	}
};

watch(
	() => [props.repoId, props.changeId] as const,
	async ([repoId, changeId]) => {
		laneId.value = null;
		preview.value = null;
		try {
			laneId.value = await findLane(repoId, changeId);
		} catch {
			laneId.value = null;
		}
		await loadPreview();
	},
	{ immediate: true },
);

const unsubscribe = live.subscribe(props.repoId, {
	patterns: ["repo.config.previewed", "repo.policy.*"],
	onEvents: (events) => {
		const lane = laneId.value;
		if (
			lane !== null &&
			events.some((e) => (e.data as { laneId?: unknown } | null)?.laneId === lane)
		) {
			void loadPreview();
		}
	},
	onResync: () => void loadPreview(),
});
onBeforeUnmount(unsubscribe);

const shown = computed(() =>
	preview.value !== null &&
	(preview.value.policyTouched || preview.value.status !== "clean")
);
const view = computed(() => preview.value ? PREVIEW_VIEW[preview.value.status] : null);
const signoff = computed(() => preview.value ? activeSignoff(preview.value) : undefined);
const mayApprove = computed(() =>
	preview.value !== null && canSignOff(preview.value, props.role)
);
const mayRevoke = computed(() => signoff.value !== undefined && canMaintain(props.role));
const schemaHref = computed(() => `${nodeHref(props.repoPath)}/-/settings/extensions#schema`);

const busy = ref(false);
const actionError = ref<string | null>(null);
const run = async (work: () => Promise<unknown>, done: string): Promise<void> => {
	if (busy.value) return;
	busy.value = true;
	actionError.value = null;
	try {
		await work();
		toasts.push({ tone: "success", text: done });
		await loadPreview();
	} catch (e) {
		actionError.value = errorMessage(e);
	} finally {
		busy.value = false;
	}
};

const approve = () => {
	const p = preview.value;
	const lane = laneId.value;
	if (!p || !lane || p.policyDigest === undefined) return;
	void run(
		() =>
			api.repoConfig.signOff(props.repoId, lane, {
				head: p.head,
				policyDigest: p.policyDigest ?? null,
			}),
		`Policy change approved at ${shortSha(p.head)}.`,
	);
};
const revoke = () => {
	const s = signoff.value;
	const lane = laneId.value;
	if (!s || !lane) return;
	void run(() => api.repoConfig.revokeSignOff(props.repoId, lane, s.head), "Sign-off revoked.");
};
const refresh = () => {
	const lane = laneId.value;
	if (!lane) return;
	void run(() => api.repoConfig.preview(props.repoId, lane), "Preview requested.");
};
</script>

<template>
	<section v-if="shown && preview && view" class="tt-panel config-card" aria-labelledby="config-card-title" data-kernel="repo-config">
		<header class="config-card__head">
			<h2 id="config-card-title" class="config-card__title">Repo config</h2>
			<span class="chip chip--warning" title="A change to a root .cue file needs a person's sign-off (K13)">human (K13)</span>
		</header>

		<p class="config-card__signoff">
			<template v-if="signoff">
				<span class="chip chip--success">approved</span>
				by {{ signoff.signedBy }} at <code>{{ shortSha(signoff.head) }}</code>
			</template>
			<template v-else>
				<span class="chip chip--muted">sign-off pending</span>
				<span class="tt-muted">a Maintainer approves this head</span>
			</template>
		</p>

		<p class="config-card__state">
			<span :class="`chip chip--${view.tone}`" data-preview-status>{{ view.label }}</span>
			<span class="tt-muted">
				<template v-if="preview.status === 'evaluating'">evaluating…</template>
				<template v-else>evaluated at head <code>{{ shortSha(preview.head) }}</code><template v-if="preview.evaluatedAt"> · {{ formatTime(preview.evaluatedAt) }}</template></template>
			</span>
		</p>

		<div v-if="preview.status !== 'evaluating'">
			<h3 class="config-card__sub">Plan</h3>
			<ul class="config-card__plan">
				<li v-for="(line, i) in planLines(preview.plan)" :key="i">{{ line }}</li>
			</ul>
		</div>

		<p v-if="preview.message" class="config-card__message">{{ preview.message }}</p>
		<ConfigIssues
			:issues="preview.issues"
			:denials="preview.denials"
			:repo-path="repoPath"
			:commit="preview.head"
			:sent="sent"
			:schema-href="schemaHref"
		/>

		<p v-if="actionError" class="chip chip--danger" role="alert">{{ actionError }}</p>
		<p v-if="loadError" class="chip chip--danger" role="alert">{{ loadError }}</p>
		<div class="tt-row config-card__actions">
			<button v-if="mayApprove" type="button" class="tt-button tt-button--primary tt-button--sm" :disabled="busy" @click="approve">
				Approve policy change
			</button>
			<button v-if="mayRevoke" type="button" class="tt-button tt-button--sm" :disabled="busy" @click="revoke">
				Revoke sign-off
			</button>
			<button type="button" class="tt-button tt-button--sm" :disabled="busy" @click="refresh">Preview again</button>
		</div>
	</section>
</template>

<style scoped>
.config-card {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-3);
	min-width: 0;
}

.config-card__head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--tt-space-2);
}

.config-card__title {
	font-size: var(--tt-text-md);
	margin: 0;
}

.config-card__sub {
	font-size: var(--tt-text-sm);
	color: var(--tt-text-muted);
	margin: 0 0 var(--tt-space-1);
}

.config-card__signoff,
.config-card__state {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-2);
	margin: 0;
}

.config-card__plan {
	margin: 0;
	padding-inline-start: var(--tt-space-4);
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-1);
	overflow-wrap: anywhere;
}

.config-card__message {
	margin: 0;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.config-card__actions {
	flex-wrap: wrap;
}
</style>
