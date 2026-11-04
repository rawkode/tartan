<script setup lang="ts">
import { computed } from "vue";
import { css } from "../../styled-system/css";
import { line, table } from "../../styled-system/recipes";
import { Status } from "../design-system/index.ts";
import {
	type ForgeNode,
	openIssues,
	projectsUnder,
	rel,
	urlFor,
} from "./data/index.ts";

const props = defineProps<{ trail: ForgeNode[]; scope: string }>();

const rows = computed(() =>
	projectsUnder(props.trail[props.trail.length - 1], props.trail.slice(0, -1))
		.map(({ addr, node }) => ({
			addr,
			node,
			// Long addresses wrap after a separator, not in the middle of a name.
			parts: rel(props.scope, addr).split(/(?<=[/:])/),
			release: node.releases?.[0]?.[0] ?? "—",
			issues: openIssues(addr).length,
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
				<span>Release</span>
				<span>Issues</span>
				<span>CI</span>
			</div>
			<a v-for="row in rows" :key="row.addr" :href="urlFor(row.addr)"
				:class="grid.row">
				<span :class="grid.cell">
					<span
						:class="grid.name"><template v-for="(part, i) in row.parts" :key="i">{{ part }}<wbr /></template></span>
					<span :class="grid.sub">{{ row.node.path ?? "Whole repo" }}</span>
				</span>
				<span :class="grid.num">{{ row.release }}</span>
				<span :class="grid.num">{{ row.issues }}</span>
				<span>
					<template v-if="row.node.empty">—</template>
					<Status v-else-if="row.node.fail" state="fail">Failing</Status>
					<Status v-else state="pass">Pass</Status>
				</span>
			</a>
		</div>
		<p v-else :class="lines.empty">No projects here yet.</p>
	</div>
</template>
