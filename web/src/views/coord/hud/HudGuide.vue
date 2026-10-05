<script setup lang="ts">
// "Where to look" (every judge question has a screen
// reachable in ≤ 2 clicks from the HUD). For the repositories under the
// nodes on screen (a bounded walk, `model.ts`), one link per question: the
// Lanes view (Q1), the radar or Weave tab (Q2), the changes list (Q3), the
// advances and their why notes (Q4), and the policies on trial (Q5).
import { ref, shallowRef, watch } from "vue";
import { RouterLink } from "vue-router";
import type { NodeDto, StaticContributionDto } from "@tartan/contract/api.ts";
import { useApi } from "../../../app/context.ts";
import { nodeHref } from "../../../router/params.ts";
import {
	hudHref,
	JUDGE_QUESTIONS,
	type QuestionLink,
	questionLinks,
	walkRepos,
} from "./model.ts";

const props = defineProps<{
	roots: readonly NodeDto[];
	/** The node whose HUD is on screen: its rows link no HUD. */
	here?: string | null;
}>();

type Row = {
	readonly repo: NodeDto;
	readonly links: readonly QuestionLink[];
};

const api = useApi();
const rows = shallowRef<readonly Row[]>([]);
const truncated = ref(false);
const simGroups = shallowRef<readonly string[]>([]);
const loading = ref(false);
let generation = 0;

const tabsOf = async (repo: string): Promise<readonly StaticContributionDto[]> => {
	try {
		return (await api.view(repo, "")).static.tabs;
	} catch {
		return [];
	}
};

const load = async (): Promise<void> => {
	const mine = ++generation;
	loading.value = true;
	try {
		const walked = await walkRepos(props.roots, (parent, cursor) => api.nodes.children(parent, cursor));
		const out = await Promise.all(
			walked.repos.map(async (repo) => ({
				repo,
				links: questionLinks(repo.path, await tabsOf(repo.path)),
			})),
		);
		if (mine !== generation) return;
		rows.value = out;
		truncated.value = walked.truncated;
		simGroups.value = walked.simGroups;
	} finally {
		if (mine === generation) loading.value = false;
	}
};

watch(() => props.roots.map((r) => r.path).join("\n"), () => void load(), { immediate: true });
</script>

<template>
	<section class="hud-guide tt-panel tt-stack" aria-labelledby="hud-guide">
		<h2 id="hud-guide" class="hud-guide__title">Where to look</h2>
		<ol class="hud-guide__questions">
			<li v-for="q in JUDGE_QUESTIONS" :key="q.id" :data-question="q.id">
				<strong>{{ q.id.toUpperCase() }}</strong> {{ q.question }}
				<span class="tt-muted">→ {{ q.answer }}</span>
			</li>
		</ol>
		<p v-if="loading && rows.length === 0" class="tt-muted" aria-live="polite">Finding repositories…</p>
		<p v-else-if="rows.length === 0" class="tt-muted">No repositories here yet.</p>
		<ul v-else class="hud-guide__repos">
			<li v-for="row in rows" :key="row.repo.id" class="hud-guide__repo" :data-guide-repo="row.repo.path">
				<RouterLink :to="nodeHref(row.repo.path)" class="hud-guide__name">{{ row.repo.path }}</RouterLink>
				<span class="hud-guide__links">
					<RouterLink
						v-for="link in row.links"
						:key="link.id"
						:to="link.href"
						class="chip"
						:data-question-link="link.id"
					>{{ link.id.toUpperCase() }} {{ link.text }}</RouterLink>
					<RouterLink v-if="row.repo.path !== here" :to="hudHref(row.repo.path)" class="chip chip--muted">HUD</RouterLink>
				</span>
			</li>
		</ul>
		<p v-if="truncated" class="tt-hint">Showing the first repositories found; browse a namespace for the rest.</p>
		<p v-if="simGroups.length > 0" class="tt-hint">
			Simulated swarm repositories under {{ simGroups.join(", ") }} are counted by the HUD but not listed here.
		</p>
	</section>
</template>

<style scoped>
.hud-guide__title {
	font-size: var(--tt-text-md);
	margin: 0;
}

.hud-guide__questions,
.hud-guide__repos {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}

.hud-guide__repo {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-2);
}

.hud-guide__name {
	overflow-wrap: anywhere;
}

.hud-guide__links {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-1);
}
</style>
