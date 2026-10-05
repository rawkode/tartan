<script setup lang="ts">
// Repo page frame: crumbs, repo header (visibility, default branch, landing
// state, header actions), the tab bar (kernel views + static `repo.tab`
// contributions, which render without invoking any extension)
// and the `repo.sidebar` slots next to the page content.
//
// Header actions (`repo.header.action`, static+action) are buttons that post
// `{action: <contribution id>, ctx}` and apply the result like a slot host
// (toast, navigate, refresh; `slots/actions.ts`). The sidebar column shows
// only when the view lists `repo.sidebar` instances, so a page whose view has
// none gives its content the full width. Runs need a signed-in caller, so
// the Runs tab is shown to signed-in viewers only.
import { computed, inject, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import type {
	StaticContributionDto,
	ViewResponse,
} from "@tartan/contract/api.ts";
import type { SlotCtxHint } from "../api/client.ts";
import { API } from "../app/context.ts";
import {
	nodeHref,
	repoConfigHref,
	settingsHref,
	treeHref,
} from "../router/params.ts";
import { useToasts } from "../shell/toasts.ts";
import { postStaticAction } from "../slots/actions.ts";
import { useSlotRegistry } from "../slots/registry.ts";
import SlotOutlet from "../slots/SlotOutlet.vue";
import NodeCrumbs from "./NodeCrumbs.vue";
import TtIcon from "./TtIcon.vue";

const props = defineProps<{
	view: ViewResponse;
	ctx: SlotCtxHint;
	/** Active tab key: `code`, `history`, `lanes`, `runs`, `advances`, `config` or a contribution id. */
	active: string;
	/** Hide the sidebar (wide pages such as diffs). */
	wide?: boolean;
}>();

const api = inject(API, null);
const router = useRouter();
const toasts = useToasts();
const registry = useSlotRegistry();

const repoPath = computed(() => props.view.node.path);
const defaultBranch = computed(() =>
	props.view.repo?.defaultBranch ?? props.view.node.defaultBranch ?? "main"
);
const base = computed(() => nodeHref(repoPath.value));
const signedIn = computed(() => props.view.viewer.principal !== undefined);

const tabs = computed(() => [
	{ key: "code", label: "Code", to: treeHref(repoPath.value, defaultBranch.value) },
	{ key: "history", label: "History", to: `${base.value}/-/commits/${encodeURIComponent(defaultBranch.value)}` },
	{ key: "lanes", label: "Lanes", to: `${base.value}/-/lanes` },
	...(signedIn.value
		? [{ key: "runs", label: "Runs", to: `${base.value}/-/runs` }]
		: []),
	{ key: "advances", label: "Advances", to: `${base.value}/-/advances` },
	...props.view.static.tabs
		.filter((t) => t.slot === "repo.tab" && t.route)
		.slice()
		.sort((a, b) => a.order - b.order)
		.map((t) => ({
			key: t.id,
			label: t.label ?? t.id,
			to: `${base.value}/-/${(t.route ?? t.id).replace(/\*.*$/, "").replace(/\/$/, "")}`,
		})),
	// Repository config (WP23): members (Reporter+) read it.
	...(props.view.viewer.role >= 20
		? [{ key: "config", label: "Config", to: repoConfigHref(repoPath.value) }]
		: []),
	...(props.view.viewer.role >= 50
		? [{ key: "settings", label: "Settings", to: settingsHref(repoPath.value) }]
		: []),
]);

const headerActions = computed(() =>
	props.view.static.actions.filter((a) => a.slot === "repo.header.action")
);

const pending = ref<string | null>(null);
const actionKey = (a: StaticContributionDto): string =>
	`${a.installationId}/${a.id}`;

const runAction = async (action: StaticContributionDto): Promise<void> => {
	if (pending.value !== null) return;
	if (!api) {
		toasts.push({ tone: "danger", text: "The API is not available." });
		return;
	}
	pending.value = actionKey(action);
	try {
		await postStaticAction(
			{
				api,
				navigate: (path) => void router.push(path),
				toast: (toast) => toasts.push(toast),
				refreshSlots: (ids) => registry?.refresh(ids),
			},
			action,
			props.ctx,
		);
	} finally {
		pending.value = null;
	}
};

const showSidebar = computed(() =>
	!props.wide && props.view.slots.some((s) => s.slot === "repo.sidebar")
);
</script>

<template>
	<div class="repo">
		<header class="repo__header">
			<NodeCrumbs :path="repoPath" />
			<div class="repo__title-row">
				<h1 class="repo__title">{{ view.node.slug }}</h1>
				<span class="chip chip--muted">{{ view.node.visibility }}</span>
				<span v-if="view.node.archived" class="chip chip--warning">archived</span>
				<span v-if="view.repo?.landingPaused" class="chip chip--warning">landing paused</span>
				<span v-if="headerActions.length > 0" class="repo__actions">
					<button
						v-for="action in headerActions"
						:key="actionKey(action)"
						type="button"
						class="tt-button tt-button--sm"
						:title="action.title"
						:disabled="pending !== null"
						:aria-busy="pending === actionKey(action)"
						:data-action="action.id"
						@click="runAction(action)"
					>
						<TtIcon v-if="action.icon" :name="action.icon" />
						<span>{{ action.label ?? action.id }}</span>
					</button>
				</span>
			</div>
			<p v-if="view.node.description" class="repo__description">{{ view.node.description }}</p>
			<ul v-if="view.banners.length > 0" class="repo__banners">
				<li v-for="(banner, index) in view.banners" :key="index" class="chip" :class="`chip--${banner.tone}`">{{ banner.text }}</li>
			</ul>
			<nav class="repo__tabs tt-scroll-x" aria-label="Repository">
				<RouterLink
					v-for="tab in tabs"
					:key="tab.key"
					:to="tab.to"
					class="repo__tab"
					:aria-current="tab.key === active ? 'page' : undefined"
				>{{ tab.label }}</RouterLink>
			</nav>
		</header>
		<div class="repo__body" :class="{ 'repo__body--wide': !showSidebar }">
			<div class="repo__main">
				<slot />
			</div>
			<aside v-if="showSidebar" class="repo__side" aria-label="Repository sidebar">
				<SlotOutlet
					:slots="view.slots"
					slot-id="repo.sidebar"
					:ctx="ctx"
					:repo-id="view.repo?.id"
				/>
			</aside>
		</div>
	</div>
</template>

<style scoped>
.repo {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-4);
}

.repo__header {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
}

.repo__title-row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-2);
}

.repo__title {
	overflow-wrap: anywhere;
}

.repo__actions {
	display: inline-flex;
	flex-wrap: wrap;
	gap: var(--tt-space-2);
	margin-inline-start: auto;
}

.repo__description {
	margin: 0;
	color: var(--tt-text-muted);
}

.repo__banners {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}

.repo__tabs {
	display: flex;
	gap: var(--tt-space-4);
	border-bottom: 1px solid var(--tt-border);
	white-space: nowrap;
}

.repo__tab {
	display: inline-flex;
	align-items: center;
	min-height: 2.75rem;
	color: var(--tt-text-muted);
	text-decoration: none;
}

.repo__tab[aria-current="page"] {
	color: var(--tt-text);
	box-shadow: inset 0 -2px 0 var(--tt-accent);
}

.repo__body {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--tt-space-6);
}

@media (min-width: 64rem) {
	.repo__body:not(.repo__body--wide) {
		grid-template-columns: minmax(0, 1fr) 18rem;
	}
}

.repo__main,
.repo__side {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-4);
	min-width: 0;
}
</style>
