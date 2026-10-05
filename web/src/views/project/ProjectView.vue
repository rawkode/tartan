<script setup lang="ts">
// `/<repo>/-/p/<slug>[/issues|/changes]`: one project of the repo (WP25
// slice A′). Overview: root, manifest, layers, what it
// depends on and what depends on it, the nearest agent instructions and the
// root's README. Issues: the repo's work items whose footprint names the
// project or holds a path in its root. Pull requests: the changes whose
// latest revision affects it. Both lists are the providers' own tools read
// as the viewer, so they need a signed-in viewer with the tools' role.
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { loginHref } from "../../api/client.ts";
import AsyncState from "../../components/AsyncState.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import TtIcon from "../../components/TtIcon.vue";
import { useResource } from "../../composables/resource.ts";
import {
	blobHref,
	changeHref,
	stringParam,
	treeHref,
} from "../../router/params.ts";
import { provideSlotRegistry } from "../../slots/registry.ts";
import UiMarkdown from "../../ui/nodes/UiMarkdown.ts";
import { useNodeView } from "../repo/useNodeView.ts";
import {
	projectHref,
	type ProjectTab,
	useProjects,
	workHref,
} from "./client.ts";
import {
	affectsLabel,
	matchLabel,
	projectNotes,
	sourceLabel,
} from "./model.ts";

provideSlotRegistry();
const route = useRoute();
const node = useNodeView(() => "");
const client = useProjects();

const slug = computed(() => stringParam(route.params, "project"));
const tab = computed<ProjectTab>(() => {
	const t = stringParam(route.params, "tab");
	return t === "issues" || t === "changes" ? t : "overview";
});
const repoId = computed(() => node.data.value?.repo?.id ?? null);
const repoPath = computed(() => node.data.value?.node.path ?? node.nodePath.value);
const defaultBranch = computed(() =>
	node.data.value?.repo?.defaultBranch ?? node.data.value?.node.defaultBranch ?? "main"
);
const signedIn = computed(() => node.data.value?.viewer.principal !== undefined);

const detail = useResource(
	() => [repoId.value, slug.value] as const,
	([id, s]) => id === null ? Promise.resolve(null) : client.detail(id, s),
);
const issues = useResource(
	() => [repoId.value, slug.value, tab.value === "issues" && signedIn.value] as const,
	([id, s, wanted]) =>
		id === null || !wanted ? Promise.resolve(null) : client.issues(id, s),
);
const changes = useResource(
	() => [repoId.value, slug.value, tab.value === "changes" && signedIn.value] as const,
	([id, s, wanted]) =>
		id === null || !wanted ? Promise.resolve(null) : client.changes(id, s),
);

const project = computed(() => detail.data.value?.project ?? null);
const tabs = computed(() => [
	{ key: "overview" as const, label: "Overview" },
	{ key: "issues" as const, label: "Issues" },
	{ key: "changes" as const, label: "Pull requests" },
]);
const signInHref = computed(() => loginHref(route.fullPath));
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
		<RepoFrame v-if="node.data.value" :view="node.data.value" :ctx="node.ctx.value" active="projects" wide>
			<AsyncState
				:loading="detail.loading.value"
				:error="detail.error.value"
				:status="detail.status.value"
				:ready="project !== null"
				what="this project"
				@retry="detail.reload"
			>
				<article v-if="project && detail.data.value" class="tt-stack project" :data-project="project.slug">
					<header class="project__header">
						<RouterLink class="project__back" :to="projectHref(repoPath)">
							<TtIcon name="folder" /> Projects
						</RouterLink>
						<div class="project__title-row">
							<h2 class="project__title">{{ project.name }}</h2>
							<span class="chip chip--info">{{ sourceLabel(project) }}</span>
							<span v-for="note in projectNotes(project)" :key="note.label" class="chip" :class="`chip--${note.tone}`" :title="note.title">{{ note.label }}</span>
						</div>
						<p class="tt-muted project__root">
							<RouterLink :to="treeHref(repoPath, defaultBranch, project.root)">{{ project.root }}</RouterLink>
							<span v-if="project.cuenvName"> · cuenv name {{ project.cuenvName }}</span>
						</p>
						<nav class="project__tabs" aria-label="Project">
							<RouterLink
								v-for="t in tabs"
								:key="t.key"
								class="project__tab"
								:to="projectHref(repoPath, project.slug, t.key)"
								:aria-current="t.key === tab ? 'page' : undefined"
							>{{ t.label }}</RouterLink>
						</nav>
					</header>

					<template v-if="tab === 'overview'">
						<dl class="project__facts tt-panel">
							<div>
								<dt>Root</dt>
								<dd><RouterLink :to="treeHref(repoPath, defaultBranch, project.root)"><code>{{ project.root }}</code></RouterLink></dd>
							</div>
							<div v-if="project.manifestPath">
								<dt>Manifest</dt>
								<dd><RouterLink :to="blobHref(repoPath, defaultBranch, project.manifestPath)"><code>{{ project.manifestPath }}</code></RouterLink></dd>
							</div>
							<div v-if="detail.data.value.layers.length > 0">
								<dt>Layers</dt>
								<dd>
									<ul class="project__inline">
										<li v-for="layer in detail.data.value.layers" :key="layer.root">
											<RouterLink :to="treeHref(repoPath, defaultBranch, layer.root)"><code>{{ layer.root === "" ? "/" : layer.root }}</code></RouterLink>
										</li>
									</ul>
								</dd>
							</div>
							<div>
								<dt>Depends on</dt>
								<dd>
									<ul v-if="detail.data.value.deps.length > 0" class="project__inline">
										<li v-for="dep in detail.data.value.deps" :key="dep.name">
											<RouterLink :to="projectHref(repoPath, dep.slug)">{{ dep.name }}</RouterLink>
										</li>
									</ul>
									<span v-else class="tt-muted">nothing in this repo</span>
								</dd>
							</div>
							<div>
								<dt>Used by</dt>
								<dd>
									<ul v-if="detail.data.value.dependents.length > 0" class="project__inline">
										<li v-for="dep in detail.data.value.dependents" :key="dep.name">
											<RouterLink :to="projectHref(repoPath, dep.slug)">{{ dep.name }}</RouterLink>
										</li>
									</ul>
									<span v-else class="tt-muted">no other project</span>
								</dd>
							</div>
							<div v-if="detail.data.value.agentsDoc">
								<dt>Agent instructions</dt>
								<dd><RouterLink :to="blobHref(repoPath, defaultBranch, detail.data.value.agentsDoc.path)"><code>{{ detail.data.value.agentsDoc.path }}</code></RouterLink></dd>
							</div>
						</dl>
						<ul v-if="project.issues.length > 0" class="project__issues">
							<li v-for="(issue, i) in project.issues" :key="i" class="chip chip--warning" :title="issue.path">{{ issue.code }}: {{ issue.message }}</li>
						</ul>
						<section v-if="detail.data.value.readme" class="tt-panel" aria-labelledby="project-readme">
							<h3 id="project-readme" class="project__readme-title">
								<TtIcon name="file" /> {{ detail.data.value.readme.path }}
							</h3>
							<UiMarkdown :md="detail.data.value.readme.text" />
							<p v-if="detail.data.value.readme.truncated" class="tt-hint">Truncated; open the file for the rest.</p>
						</section>
					</template>

					<template v-else-if="!signedIn">
						<p class="tt-panel" data-testid="sign-in">
							<a :href="signInHref">Sign in</a> to see this project's
							{{ tab === "issues" ? "issues" : "pull requests" }}.
						</p>
					</template>

					<template v-else-if="tab === 'issues'">
						<AsyncState
							:loading="issues.loading.value"
							:error="issues.error.value"
							:status="issues.status.value"
							:ready="issues.data.value !== null"
							what="the issues"
							@retry="issues.reload"
						>
							<div v-if="issues.data.value" class="tt-stack">
								<p v-if="issues.data.value.provider === null" class="tt-muted">No work tracker is installed for this repository.</p>
								<p v-else-if="issues.data.value.items.length === 0" class="tt-muted">No work items name this project.</p>
								<ul v-else class="project__list" aria-label="Issues">
									<li v-for="item in issues.data.value.items" :key="item.ref" class="project__row" :data-ref="item.ref">
										<RouterLink :to="workHref(repoPath, item.ref)" class="project__row-title">{{ item.title }}</RouterLink>
										<span class="tt-muted"><code>{{ item.ref }}</code></span>
										<span class="chip" :class="item.state === 'done' ? 'chip--success' : 'chip--muted'">{{ item.state }}</span>
										<span v-if="item.claims > 0" class="chip chip--info"><TtIcon name="agent" /> {{ item.claims }} working</span>
										<span class="chip chip--muted">{{ matchLabel(item) }}</span>
									</li>
								</ul>
								<p class="tt-hint">
									{{ issues.data.value.scanned }} work items read{{ issues.data.value.complete ? "" : " (the first pages only)" }}; filtered to footprints set on the item.
								</p>
							</div>
						</AsyncState>
					</template>

					<template v-else>
						<AsyncState
							:loading="changes.loading.value"
							:error="changes.error.value"
							:status="changes.status.value"
							:ready="changes.data.value !== null"
							what="the pull requests"
							@retry="changes.reload"
						>
							<div v-if="changes.data.value" class="tt-stack">
								<p v-if="changes.data.value.provider === null" class="tt-muted">No change tracker is installed for this repository.</p>
								<p v-else-if="changes.data.value.changes.length === 0" class="tt-muted">No changes affect this project.</p>
								<ul v-else class="project__list" aria-label="Pull requests">
									<li v-for="c in changes.data.value.changes" :key="c.changeId" class="project__row" :data-change="c.changeId">
										<RouterLink :to="changeHref(repoPath, c.changeId)" class="project__row-title">{{ c.title }}</RouterLink>
										<span class="chip chip--muted">{{ c.state }}</span>
										<span class="chip" :class="c.global ? 'chip--warning' : 'chip--info'" :title="c.affected.join(', ')">{{ affectsLabel(c, detail.data.value.total) }}</span>
										<span v-if="c.workRef" class="tt-muted"><code>{{ c.workRef }}</code></span>
									</li>
								</ul>
								<p class="tt-hint">
									{{ changes.data.value.scanned }} changes read{{ changes.data.value.complete ? "" : " (the first pages only)" }}; filtered by each change's latest revision.
								</p>
							</div>
						</AsyncState>
					</template>
				</article>
			</AsyncState>
		</RepoFrame>
	</AsyncState>
</template>

<style scoped>
.project__header {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
}

.project__back {
	display: inline-flex;
	align-items: center;
	gap: var(--tt-space-1);
	font-size: var(--tt-text-sm);
}

.project__title-row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-2);
}

.project__title {
	font-size: var(--tt-text-lg);
	overflow-wrap: anywhere;
}

.project__root {
	font-family: var(--tt-font-mono);
	font-size: var(--tt-text-sm);
	overflow-wrap: anywhere;
}

.project__tabs {
	display: flex;
	gap: var(--tt-space-4);
	border-bottom: 1px solid var(--tt-border);
}

.project__tab {
	display: inline-flex;
	align-items: center;
	min-height: 2.75rem;
	color: var(--tt-text-muted);
	text-decoration: none;
}

.project__tab[aria-current="page"] {
	color: var(--tt-text);
	box-shadow: inset 0 -2px 0 var(--tt-accent);
}

.project__facts {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 1fr));
	gap: var(--tt-space-3) var(--tt-space-6);
	margin: 0;
}

.project__facts dt {
	font-size: var(--tt-text-sm);
	color: var(--tt-text-muted);
}

.project__facts dd {
	margin: 0;
	overflow-wrap: anywhere;
}

.project__inline {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-1) var(--tt-space-3);
	margin: 0;
	padding: 0;
	list-style: none;
}

.project__issues {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-2);
	margin: 0;
	padding: 0;
	list-style: none;
}

.project__readme-title {
	display: flex;
	align-items: center;
	gap: var(--tt-space-2);
	font-size: var(--tt-text-sm);
	color: var(--tt-text-muted);
	margin-bottom: var(--tt-space-3);
}

.project__list {
	display: flex;
	flex-direction: column;
	margin: 0;
	padding: 0;
	list-style: none;
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	background: var(--tt-surface);
}

.project__row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-2);
	padding: var(--tt-space-3);
	border-bottom: 1px solid var(--tt-border);
	min-width: 0;
}

.project__row:last-child {
	border-bottom: 0;
}

.project__row-title {
	font-weight: 600;
	overflow-wrap: anywhere;
}
</style>
