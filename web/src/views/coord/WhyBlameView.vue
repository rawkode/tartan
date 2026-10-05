<script setup lang="ts">
// Why-blame, file level (WP19; the file-level changes that touched this
// file): every commit that touched the file
// (`GET /-/api/log?path=`), its gutter coloured by work item (`Tartan-Work`
// trailer), each with its agent and advance; selecting one opens the
// provenance drawer with its why note (`GET /-/api/why?sha=`): the work
// item's why and acceptance, agent and on-behalf-of, the review route, gates,
// the reason events and the chain head. With no selection the drawer shows
// the newest landing at the file, or at `?line=n`. Line-by-line blame
// (`GET /-/api/blame`) is not served yet (501), so there is no line gutter.
import { computed } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import type { WhyQuery } from "../../api/client.ts";
import { useApi } from "../../app/context.ts";
import AsyncState from "../../components/AsyncState.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import { usePaged } from "../../composables/paged.ts";
import { blobHref, commitHref, logHref, refAndPath } from "../../router/params.ts";
import { repoCtx } from "../../slots/ctx.ts";
import { formatTime, isoTime, shortSha } from "../../ui/format.ts";
import { useNodeView } from "../repo/useNodeView.ts";
import ProvenanceDrawer from "./parts/ProvenanceDrawer.vue";
import { blameRows, workLegend } from "./why/model.ts";
import type { CommitMeta } from "@tartan/contract/git.ts";

const api = useApi();
const route = useRoute();
const router = useRouter();
const loc = computed(() => refAndPath(route.params, ""));
const line = computed(() => {
	const raw = route.query["line"];
	return typeof raw === "string" && /^\d{1,7}$/.test(raw) ? Number(raw) : undefined;
});
const selectedSha = computed(() => {
	const raw = route.query["sha"];
	return typeof raw === "string" && /^[0-9a-f]{7,40}$/.test(raw) ? raw : null;
});
const node = useNodeView(
	() => `blame/${loc.value.ref}${loc.value.path ? `/${loc.value.path}` : ""}`,
	(path) => repoCtx(path, { ref: loc.value.ref, path: loc.value.path }),
);
const repoPath = computed(() => node.data.value?.node.path ?? node.nodePath.value);
const refName = computed(() =>
	loc.value.ref || node.data.value?.repo?.defaultBranch || "main"
);

const history = usePaged<CommitMeta, string>(
	() =>
		node.data.value && loc.value.path
			? JSON.stringify([repoPath.value, refName.value, loc.value.path])
			: null,
	async (key, cursor) => {
		const [repo, ref, path] = JSON.parse(key) as [string, string, string];
		const page = await api.browse.log(repo, ref, path, cursor);
		return {
			items: page.commits,
			...(page.cursor ? { cursor: page.cursor } : {}),
		};
	},
);
const rows = computed(() => blameRows(history.items.value));
const legend = computed(() => workLegend(rows.value));

const drawerAt = computed((): WhyQuery | null => {
	if (selectedSha.value) return { sha: selectedSha.value };
	if (!loc.value.path) return null;
	return { path: loc.value.path, ...(line.value ? { line: line.value } : {}) };
});

const select = (sha: string | null) => {
	const query = { ...route.query };
	if (sha === null) delete query["sha"];
	else query["sha"] = sha;
	void router.replace({ query });
};
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
		<RepoFrame v-if="node.data.value" :view="node.data.value" :ctx="node.ctx.value" active="code" wide>
			<div class="tt-stack">
				<div class="tt-row">
					<h2 class="why-blame__title">
						Why <code>{{ loc.path || "(no file)" }}</code><template v-if="line"> line {{ line }}</template>
					</h2>
					<template v-if="loc.path">
						<RouterLink class="tt-button tt-button--sm" :to="blobHref(repoPath, refName, loc.path)">File</RouterLink>
						<RouterLink class="tt-button tt-button--sm" :to="logHref(repoPath, refName, loc.path)">History</RouterLink>
					</template>
				</div>
				<p class="tt-hint">
					File-level why-blame: every commit that touched this file, coloured by its work item. Line-by-line why-blame is not available on this forge yet.
				</p>
				<p v-if="!loc.path" class="tt-muted">Name a file after the ref: <code>/-/blame/&lt;ref&gt;/&lt;path&gt;</code>.</p>
				<div v-else class="why-blame">
					<section class="why-blame__history tt-stack" aria-labelledby="why-history">
						<h3 id="why-history" class="why-blame__subtitle">Changes that touched this file</h3>
						<ul v-if="legend.length > 0" class="why-blame__legend" aria-label="Work items">
							<li v-for="item in legend" :key="item.work" :class="`why-row--w${item.gutter}`" class="why-blame__key">
								<code>{{ item.work }}</code> <span class="tt-hint">{{ item.commits }} {{ item.commits === 1 ? "commit" : "commits" }}</span>
							</li>
						</ul>
						<AsyncState
							:loading="history.loading.value && !history.loaded.value"
							:error="history.error.value"
							:status="history.status.value"
							:ready="history.loaded.value && history.error.value === null"
							what="the file's history"
							@retry="history.reload"
						>
							<p v-if="rows.length === 0" class="tt-muted">No commit has touched this file on {{ refName }}.</p>
							<ol v-else class="why-blame__rows">
								<li
									v-for="row in rows"
									:key="row.commit.sha"
									class="why-row"
									:class="[
										row.gutter === null ? 'why-row--none' : `why-row--w${row.gutter}`,
										{ 'why-row--band': row.bandStart, 'why-row--selected': selectedSha !== null && row.commit.sha.startsWith(selectedSha) },
									]"
									:data-why-row="row.commit.sha"
									:data-work="row.work ?? ''"
								>
									<button
										type="button"
										class="why-row__select"
										:aria-pressed="selectedSha !== null && row.commit.sha.startsWith(selectedSha)"
										@click="select(row.commit.sha)"
									>
										<code>{{ shortSha(row.commit.sha) }}</code>
										<span class="why-row__subject">{{ row.commit.subject }}</span>
									</button>
									<span class="why-row__meta">
										<span v-if="row.work" class="chip chip--muted">{{ row.work }}</span>
										<span v-if="row.agent" class="chip chip--info">
											{{ row.agent.agent }}<template v-if="row.agent.model"> · {{ row.agent.model }}</template>
										</span>
										<span v-if="row.advance" class="chip chip--muted">{{ row.advance }}</span>
										<span v-else class="tt-hint">not landed by an Advance</span>
										<time class="tt-hint" :datetime="isoTime(row.commit.committedAt * 1000)">{{ formatTime(row.commit.committedAt * 1000) }}</time>
										<RouterLink :to="commitHref(repoPath, row.commit.sha)" class="tt-hint">commit</RouterLink>
									</span>
								</li>
							</ol>
							<button
								v-if="history.cursor.value"
								type="button"
								class="tt-button"
								:disabled="history.loading.value"
								@click="history.more"
							>{{ history.loading.value ? "Loading…" : "Load more" }}</button>
						</AsyncState>
					</section>
					<ProvenanceDrawer
						v-if="drawerAt"
						class="why-blame__drawer"
						:repo="repoPath"
						:at="drawerAt"
						:closable="selectedSha !== null"
						@close="select(null)"
					/>
				</div>
			</div>
		</RepoFrame>
	</AsyncState>
</template>

<style scoped>
.why-blame__title {
	font-size: var(--tt-text-md);
	margin: 0;
	overflow-wrap: anywhere;
}

.why-blame__subtitle {
	font-size: var(--tt-text-sm);
	margin: 0;
}

.why-blame {
	display: grid;
	grid-template-columns: minmax(0, 1fr);
	gap: var(--tt-space-4);
}

@media (min-width: 960px) {
	.why-blame {
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		align-items: start;
	}
}

.why-blame__legend,
.why-blame__rows {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-1);
	margin: 0;
	padding: 0;
	list-style: none;
}

.why-blame__legend {
	flex-direction: row;
	flex-wrap: wrap;
	gap: var(--tt-space-2);
}

.why-blame__key {
	border-left: 4px solid var(--why-colour);
	padding-left: var(--tt-space-2);
}

.why-row {
	--why-colour: var(--tt-border);
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-1);
	border-left: 4px solid var(--why-colour);
	padding: var(--tt-space-1) var(--tt-space-2);
	min-width: 0;
}

.why-row--band {
	margin-top: var(--tt-space-2);
}

.why-row--selected {
	background: var(--tt-surface-sunken);
}

.why-row--none {
	--why-colour: var(--tt-border);
}

.why-row--w0 {
	--why-colour: var(--tt-tone-info);
}

.why-row--w1 {
	--why-colour: var(--tt-tone-success);
}

.why-row--w2 {
	--why-colour: var(--tt-tone-warning);
}

.why-row--w3 {
	--why-colour: var(--tt-tone-danger);
}

.why-row--w4 {
	--why-colour: var(--tt-accent);
}

.why-row--w5 {
	--why-colour: var(--tt-tone-neutral);
}

.why-row__select {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-2);
	align-items: baseline;
	text-align: left;
	background: none;
	border: 0;
	padding: 0;
	color: inherit;
	font: inherit;
	cursor: pointer;
	min-width: 0;
}

.why-row__subject {
	overflow-wrap: anywhere;
}

.why-row__meta {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-1);
	align-items: center;
}
</style>
