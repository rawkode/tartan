<script setup lang="ts">
import { computed } from "vue";
import { css } from "../../styled-system/css";
import { line, table } from "../../styled-system/recipes";
import {
	type ForgeNode,
	projectsUnder,
	rel,
	urlFor,
	useForge,
} from "./data/index.ts";

const props = defineProps<{ node: ForgeNode; scope: string }>();

const store = useForge();

const rows = computed(() =>
	projectsUnder(props.node).map((project) => ({
		project,
		// Long addresses wrap after a separator, not in the middle of a name.
		parts: rel(props.scope, project.addr).split(/(?<=[/:])/),
		issues: project.issuesEnabled === false
			? "off"
			: store.openCount(project) ?? "—",
	}))
);

const grid = table({ columns: "list" });
const lines = line();
const projectHead = css({ paddingInlineStart: "2.5" });
const page = css({
	display: "flex",
	flexDirection: "column",
	paddingInline: "7",
	paddingBlockStart: "3.5",
	paddingBlockEnd: "12",
});
</script>

<template>
	<div :class="page">
		<div v-if="rows.length" :class="grid.scroll">
			<div :class="grid.head">
				<span :class="projectHead">Project</span>
				<span>Issues</span>
				<span>Depends on</span>
			</div>
			<a v-for="row in rows" :key="row.project.addr"
				:href="urlFor(row.project.addr)" :class="grid.row">
				<span :class="grid.cell">
					<span
						:class="grid.name"><template v-for="(part, i) in row.parts" :key="i">{{ part }}<wbr /></template></span>
					<span :class="grid.sub">{{ row.project.root ?? "Whole repo" }}</span>
				</span>
				<span :class="grid.num">{{ row.issues }}</span>
				<span :class="grid.num">{{ row.project.deps.join(", ") || "—" }}</span>
			</a>
		</div>
		<p v-else :class="lines.empty">No projects here yet.</p>
	</div>
</template>
