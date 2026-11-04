<script setup lang="ts">
import { computed } from "vue";
import { css } from "../../styled-system/css";
import { shell, table, text } from "../../styled-system/recipes";
import { treeHref } from "../router/params.ts";
import { type ForgeNode, plural, urlFor, useForge } from "./data/index.ts";
import CloneCommand from "./CloneCommand.vue";
import CommitList from "./CommitList.vue";
import RepoReadme from "./RepoReadme.vue";

const props = defineProps<{ node: ForgeNode; scope: string }>();

const store = useForge();

const rows = computed(() =>
	props.node.children.map((project) => ({
		project,
		issues: project.issuesEnabled === false
			? "off"
			: store.openCount(project) ?? "—",
	}))
);

const rootHref = computed(() =>
	treeHref(props.node.addr, props.node.defaultBranch ?? "main")
);
const sha = computed(() => props.node.sha?.slice(0, 7) ?? "");

const page = shell();
const grid = table({ columns: "list" });
const muted = text({ tone: "muted", size: "sm" });
const monoMuted = text({ mono: true, tone: "muted", size: "xs" });
const discovered = css({ paddingBlockEnd: "3" });
const projectHead = css({ paddingInlineStart: "2.5" });
const discovery = css({ maxWidth: "[720px]" });
</script>

<template>
	<div :class="page.pad">
		<CloneCommand :repo="scope"
			:note="`All ${plural(node.children.length, 'project')} and the root.`" />

		<section>
			<p
				:class="[monoMuted, discovered]">Discovered from package tartan files at {{ sha }}</p>
			<div :class="grid.scroll">
				<div :class="grid.head">
					<span :class="projectHead">Project</span>
					<span>Issues</span>
					<span>Depends on</span>
				</div>
				<a v-for="row in rows" :key="row.project.addr"
					:href="urlFor(row.project.addr)" :class="grid.row">
					<span :class="grid.cell">
						<span :class="grid.name">{{ row.project.name }}</span>
						<span
							:class="grid.sub">{{ row.project.manifestPath ?? row.project.root }}</span>
					</span>
					<span :class="grid.num">{{ row.issues }}</span>
					<span :class="grid.num">{{ row.project.deps.join(", ") || "—" }}</span>
				</a>
				<a :href="rootHref" :class="grid.row">
					<span :class="grid.cell">
						<span :class="grid.name">root</span>
						<span :class="grid.sub">Files no other project claims</span>
					</span>
					<span :class="grid.num">—</span>
					<span :class="grid.num">—</span>
				</a>
			</div>
		</section>

		<p
			:class="[muted, discovery]">Projects are discovered from <code>package tartan</code> files on every push to main, and cached by commit. A project is any directory below the root that holds a <code>.cue</code> file in that package, so to add, rename or remove one, commit a change to its file.</p>

		<RepoReadme :repo="node" />
		<CommitList :repo="node" />
	</div>
</template>
