<script setup lang="ts">
// The HUD (WP19; `/`, `/-/hud`, `/-/hud?node=<path>`). It hosts the
// `hud.metric` and `home.section` slots:
// WP20's tartan.hud counts active lanes, predicted and avoided conflicts,
// landings per hour and the changes that needed a human for every repository
// under the namespace it is installed on. `GET /-/api/view` needs a node
// path, so the forge home shows the HUD of each top-level namespace that has
// one (its `hud` and `home` views), and `?node=` shows one node's HUD (a
// namespace, a group or a repository with its own repo-scoped metrics).
// "Where to look" links every judge question in one click.
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import type { NodeDto, ViewResponse } from "@tartan/contract/api.ts";
import { useApi, useSession } from "../../app/context.ts";
import AsyncState from "../../components/AsyncState.vue";
import NodeChildren from "../../components/NodeChildren.vue";
import PageHeader from "../../components/PageHeader.vue";
import { useResource } from "../../composables/resource.ts";
import HudGuide from "./hud/HudGuide.vue";
import HudNode from "./hud/HudNode.vue";
import { MAX_NAMESPACES, selectedNode } from "./hud/model.ts";

type Board = {
	readonly node: NodeDto;
	readonly hud: ViewResponse;
	readonly home: ViewResponse;
};

const api = useApi();
const route = useRoute();
const session = useSession();

const selected = computed(() => selectedNode(route.query["node"]));
const title = computed(() => session.state.me?.forge.name ?? "Tartan");

const boardOf = async (path: string): Promise<Board> => {
	const [hud, home] = await Promise.all([api.view(path, "hud"), api.view(path, "home")]);
	return { node: hud.node, hud, home };
};

const boards = useResource(
	() => selected.value ?? "",
	async (node): Promise<readonly Board[]> => {
		if (node !== "") return [await boardOf(node)];
		const top = await api.nodes.children(null);
		const all = await Promise.all(
			top.nodes.slice(0, MAX_NAMESPACES).map((n) => boardOf(n.path).catch(() => null)),
		);
		return all.filter((b): b is Board => b !== null);
	},
);

const shown = computed(() =>
	(boards.data.value ?? []).filter((b) =>
		selected.value !== null ||
		b.hud.slots.some((s) => s.slot === "hud.metric") ||
		b.home.slots.some((s) => s.slot === "home.section")
	)
);
const roots = computed(() => (boards.data.value ?? []).map((b) => b.node));
</script>

<template>
	<div class="tt-stack hud">
		<PageHeader :title="title" :subtitle="selected ? `HUD · ${selected}` : 'Forge home'">
			<template #actions>
				<RouterLink v-if="selected" class="tt-button tt-button--sm" to="/">Forge home</RouterLink>
				<RouterLink class="tt-button tt-button--sm" to="/-/explore">Explore</RouterLink>
			</template>
		</PageHeader>
		<AsyncState
			:loading="boards.loading.value"
			:error="boards.error.value"
			:status="boards.status.value"
			:ready="boards.data.value !== null"
			:what="selected ?? 'the HUD'"
			@retry="boards.reload"
		>
			<HudNode
				v-for="board in shown"
				:key="board.node.id"
				:hud="board.hud"
				:home="board.home"
				:alone="selected !== null"
			/>
			<section v-if="shown.length === 0" class="tt-panel tt-stack" aria-labelledby="hud-none">
				<h2 id="hud-none" class="hud__heading">No HUD yet</h2>
				<p class="tt-muted">
					No namespace on this forge has a HUD. Install the HUD extension (tartan.hud) on a namespace from
					<RouterLink to="/-/extensions">Extensions</RouterLink>
					to count active lanes, predicted and avoided conflicts, landings per hour and the changes that needed a human across every repository below it.
				</p>
			</section>
			<HudGuide v-if="roots.length > 0" :roots="roots" :here="selected" />
		</AsyncState>
		<section v-if="!selected" class="tt-stack" aria-labelledby="hud-namespaces">
			<h2 id="hud-namespaces" class="hud__heading">Namespaces</h2>
			<NodeChildren :parent="null" />
		</section>
	</div>
</template>

<style scoped>
.hud__heading {
	font-size: var(--tt-text-md);
	margin: 0;
}
</style>
