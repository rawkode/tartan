<script setup lang="ts">
// Children of a node (or the top level), paged by the API cursor.
import { onMounted, ref, shallowRef, watch } from "vue";
import { RouterLink } from "vue-router";
import type { NodeDto } from "@tartan/contract/api.ts";
import { useApi } from "../app/context.ts";
import { errorMessage } from "../api/http.ts";
import { nodeHref } from "../router/params.ts";
import TtIcon from "./TtIcon.vue";

const props = defineProps<{ parent: string | null; refreshKey?: number }>();

const api = useApi();
const nodes = shallowRef<readonly NodeDto[]>([]);
const cursor = ref<string | undefined>(undefined);
const loading = ref(false);
const error = ref<string | null>(null);

const load = async (reset: boolean): Promise<void> => {
	loading.value = true;
	error.value = null;
	try {
		const page = await api.nodes.children(props.parent, reset ? undefined : cursor.value);
		nodes.value = reset ? page.nodes : [...nodes.value, ...page.nodes];
		cursor.value = page.cursor;
	} catch (e) {
		error.value = errorMessage(e);
	} finally {
		loading.value = false;
	}
};

onMounted(() => void load(true));
watch(() => [props.parent, props.refreshKey], () => void load(true));

const ICON: Record<NodeDto["kind"], string> = { user: "user", group: "users", repo: "branch" };
</script>

<template>
	<div class="children">
		<ul v-if="nodes.length > 0" class="children__list">
			<li v-for="child in nodes" :key="child.id" class="children__item">
				<TtIcon :name="ICON[child.kind]" />
				<div class="children__text">
					<RouterLink :to="nodeHref(child.path)" class="children__name">{{ child.slug }}</RouterLink>
					<p v-if="child.description" class="children__desc">{{ child.description }}</p>
				</div>
				<span class="chip chip--muted">{{ child.kind }}</span>
				<span v-if="child.archived" class="chip chip--muted">archived</span>
				<span v-if="child.visibility !== 'internal'" class="chip chip--muted">{{ child.visibility }}</span>
			</li>
		</ul>
		<p v-else-if="!loading && !error" class="tt-muted">Nothing here yet.</p>
		<p v-if="error" class="chip chip--danger" role="alert">{{ error }}</p>
		<button v-if="cursor" type="button" class="tt-button" :disabled="loading" @click="load(false)">
			{{ loading ? "Loading…" : "Load more" }}
		</button>
	</div>
</template>

<style scoped>
.children {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-3);
}

.children__list {
	margin: 0;
	padding: 0;
	list-style: none;
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	background: var(--tt-surface);
}

.children__item {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--tt-space-2) var(--tt-space-3);
	padding: var(--tt-space-3);
	border-bottom: 1px solid var(--tt-border);
	color: var(--tt-text-muted);
}

.children__item:last-child {
	border-bottom: 0;
}

.children__text {
	flex: 1 1 12rem;
	min-width: 0;
}

.children__name {
	font-weight: 600;
	overflow-wrap: anywhere;
}

.children__desc {
	margin: 0;
	font-size: var(--tt-text-sm);
	overflow-wrap: anywhere;
}
</style>
