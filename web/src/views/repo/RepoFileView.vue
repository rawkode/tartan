<script setup lang="ts">
// One file at a ref: `file.banner` slots (e.g. radar's "2 lanes are editing
// this file"), text with line numbers, or a binary/truncated notice. Raw
// content is only ever a link to `/-/raw/…`, which the kernel serves as
// `text/plain` under `CSP: sandbox`; repo HTML never renders here.
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import AsyncState from "../../components/AsyncState.vue";
import RepoFrame from "../../components/RepoFrame.vue";
import TtIcon from "../../components/TtIcon.vue";
import { useApi } from "../../app/context.ts";
import { useResource } from "../../composables/resource.ts";
import {
	blameHref,
	logHref,
	pathCrumbs,
	refAndPath,
	treeHref,
} from "../../router/params.ts";
import { repoCtx } from "../../slots/ctx.ts";
import SlotOutlet from "../../slots/SlotOutlet.vue";
import { formatBytes } from "../../ui/format.ts";
import { sameOriginPath } from "../../ui/links.ts";
import { useNodeView } from "./useNodeView.ts";

const MAX_LINES = 20_000;

const route = useRoute();
const api = useApi();
const loc = computed(() => refAndPath(route.params, "main"));
const node = useNodeView(
	() => `blob/${loc.value.ref}/${loc.value.path}`,
	(path) => repoCtx(path, { ref: loc.value.ref, path: loc.value.path }),
);

const repoPath = computed(() => node.data.value?.node.path ?? node.nodePath.value);
const blob = useResource(
	() => (node.data.value ? [repoPath.value, loc.value.ref, loc.value.path] as const : null),
	(key) => key ? api.browse.blob(key[0], key[1], key[2]) : Promise.resolve(null),
);

const lines = computed(() => {
	const text = blob.data.value?.text;
	if (text === undefined) return [];
	const all = text.replace(/\n$/, "").split("\n");
	return all.slice(0, MAX_LINES);
});
const crumbs = computed(() => pathCrumbs(loc.value.path));
const rawHref = computed(() => sameOriginPath(blob.data.value?.rawUrl));
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
		<RepoFrame v-if="node.data.value" :view="node.data.value" :ctx="node.ctx.value" active="code">
			<SlotOutlet
				:slots="node.data.value.slots"
				slot-id="file.banner"
				:ctx="node.ctx.value"
				:repo-id="node.repoId.value"
			/>
			<nav class="file-path" aria-label="Path">
				<span class="chip chip--muted"><TtIcon name="branch" /> {{ loc.ref }}</span>
				<RouterLink :to="treeHref(repoPath, loc.ref)">{{ node.data.value.node.slug }}</RouterLink>
				<template v-for="(crumb, i) in crumbs" :key="crumb.path">
					<span aria-hidden="true">/</span>
					<RouterLink
						v-if="i < crumbs.length - 1"
						:to="treeHref(repoPath, loc.ref, crumb.path)"
					>{{ crumb.name }}</RouterLink>
					<strong v-else>{{ crumb.name }}</strong>
				</template>
			</nav>
			<AsyncState
				:loading="blob.loading.value"
				:error="blob.error.value"
				:status="blob.status.value"
				:ready="blob.data.value !== null"
				what="this file"
				@retry="blob.reload"
			>
				<section v-if="blob.data.value" class="file">
					<header class="file__header">
						<span class="tt-muted">{{ formatBytes(blob.data.value.size) }}<template v-if="!blob.data.value.binary"> · {{ lines.length }} lines</template></span>
						<span class="file__links">
							<RouterLink class="tt-button tt-button--sm" :to="logHref(repoPath, loc.ref, loc.path)">History</RouterLink>
							<RouterLink class="tt-button tt-button--sm" :to="blameHref(repoPath, loc.ref, loc.path)">Why</RouterLink>
							<a v-if="rawHref" class="tt-button tt-button--sm" :href="rawHref" rel="noopener">Raw</a>
						</span>
					</header>
					<p v-if="blob.data.value.binary" class="file__notice">Binary file not shown.</p>
					<p v-else-if="blob.data.value.text === undefined" class="file__notice">
						This file is too large to show. Use the raw link.
					</p>
					<div v-else class="tt-scroll-x file__body" tabindex="0" role="region" :aria-label="`Contents of ${loc.path}`">
						<table class="file__code">
							<tbody>
								<tr v-for="(line, i) in lines" :id="`L${i + 1}`" :key="i">
									<td class="file__no"><a :href="`#L${i + 1}`" tabindex="-1">{{ i + 1 }}</a></td>
									<td class="file__line">{{ line }}</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p v-if="blob.data.value.truncated" class="file__notice">
						Showing the first part of this file. Use the raw link for the rest.
					</p>
				</section>
			</AsyncState>
		</RepoFrame>
	</AsyncState>
</template>

<style scoped>
.file-path {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-1);
	overflow-wrap: anywhere;
}

.file {
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	background: var(--tt-surface);
	min-width: 0;
}

.file__header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: var(--tt-space-2);
	padding: var(--tt-space-2) var(--tt-space-3);
	border-bottom: 1px solid var(--tt-border);
}

.file__links {
	display: inline-flex;
	gap: var(--tt-space-2);
}

.file__notice {
	margin: 0;
	padding: var(--tt-space-4);
	color: var(--tt-text-muted);
}

.file__code {
	border-collapse: collapse;
	font-family: var(--tt-font-mono);
	font-size: var(--tt-text-sm);
	width: 100%;
}

.file__no {
	width: 1%;
	padding: 0 var(--tt-space-3);
	text-align: right;
	user-select: none;
	vertical-align: top;
}

.file__no a {
	color: var(--tt-text-muted);
	text-decoration: none;
}

.file__line {
	padding: 0 var(--tt-space-3);
	white-space: pre;
	tab-size: 4;
}

tr:target {
	background: var(--tt-tone-warning-bg);
}
</style>
