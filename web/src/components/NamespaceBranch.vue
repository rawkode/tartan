<script setup lang="ts">
// One level of the namespace browser: the children of `parent` (or the top
// level), loaded page by page; groups and users expand in place, so the tree
// is as deep as the hierarchy (disclosure buttons, nested lists).
import { onMounted, reactive, ref, shallowRef } from "vue";
import { RouterLink } from "vue-router";
import type { NodeDto } from "@tartan/contract/api.ts";
import { useApi } from "../app/context.ts";
import { errorMessage } from "../api/http.ts";
import { nodeHref } from "../router/params.ts";
import NamespaceBranch from "./NamespaceBranch.vue";
import TtIcon from "./TtIcon.vue";

const props = defineProps<{ parent: string | null; depth: number }>();

const MAX_DEPTH = 64;
const api = useApi();
const nodes = shallowRef<readonly NodeDto[]>([]);
const cursor = ref<string | undefined>(undefined);
const loading = ref(false);
const error = ref<string | null>(null);
const open = reactive<Record<string, boolean>>({});

const load = async (more: boolean): Promise<void> => {
	loading.value = true;
	error.value = null;
	try {
		const page = await api.nodes.children(props.parent, more ? cursor.value : undefined);
		nodes.value = more ? [...nodes.value, ...page.nodes] : page.nodes;
		cursor.value = page.cursor;
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		loading.value = false;
	}
};

onMounted(() => void load(false));

const toggle = (node: NodeDto): void => {
	open[node.id] = !open[node.id];
};
</script>

<template>
	<div class="ns-branch">
		<ul class="ns-branch__list" :class="{ 'ns-branch__list--nested': depth > 0 }">
			<li v-for="node in nodes" :key="node.id" class="ns-branch__item">
				<div class="ns-branch__row">
					<button
						v-if="node.kind !== 'repo' && depth < MAX_DEPTH"
						type="button"
						class="ns-branch__toggle"
						:aria-expanded="open[node.id] === true"
						:aria-label="`${open[node.id] ? 'Collapse' : 'Expand'} ${node.slug}`"
						@click="toggle(node)"
					>
						<span aria-hidden="true">{{ open[node.id] ? "▾" : "▸" }}</span>
					</button>
					<span v-else class="ns-branch__spacer" aria-hidden="true" />
					<TtIcon :name="node.kind === 'repo' ? 'branch' : node.kind === 'user' ? 'user' : 'users'" />
					<RouterLink :to="nodeHref(node.path)" class="ns-branch__name">{{ node.slug }}</RouterLink>
					<span v-if="node.visibility !== 'internal'" class="chip chip--muted">{{ node.visibility }}</span>
					<span v-if="node.archived" class="chip chip--warning">archived</span>
				</div>
				<NamespaceBranch v-if="open[node.id]" :parent="node.path" :depth="depth + 1" />
			</li>
		</ul>
		<p v-if="loading && nodes.length === 0" class="tt-muted ns-branch__note">Loading…</p>
		<p v-else-if="!loading && !error && nodes.length === 0" class="tt-muted ns-branch__note">Empty.</p>
		<p v-if="error" class="chip chip--danger ns-branch__note" role="alert">
			{{ error }}
			<button type="button" class="tt-button tt-button--sm" @click="load(false)">Retry</button>
		</p>
		<button
			v-if="cursor"
			type="button"
			class="tt-button tt-button--sm ns-branch__more"
			:disabled="loading"
			@click="load(true)"
		>{{ loading ? "Loading…" : "Show more" }}</button>
	</div>
</template>

<style scoped>
.ns-branch__list {
	margin: 0;
	padding: 0;
	list-style: none;
}

.ns-branch__list--nested {
	padding-inline-start: var(--tt-space-4);
	border-inline-start: 1px solid var(--tt-border);
	margin-inline-start: 1.3rem;
}

.ns-branch__row {
	display: flex;
	align-items: center;
	gap: var(--tt-space-2);
	min-height: 2.75rem;
	color: var(--tt-text-muted);
}

.ns-branch__toggle {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 2.75rem;
	height: 2.75rem;
	flex: none;
	border: 0;
	background: none;
	cursor: pointer;
	color: var(--tt-text-muted);
}

.ns-branch__spacer {
	width: 2.75rem;
	flex: none;
}

.ns-branch__name {
	font-weight: 600;
	min-width: 0;
	overflow-wrap: anywhere;
}

.ns-branch__note,
.ns-branch__more {
	margin-inline-start: 2.75rem;
}
</style>
