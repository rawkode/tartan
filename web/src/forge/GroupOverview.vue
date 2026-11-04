<script setup lang="ts">
import { computed } from "vue";
import { css } from "../../styled-system/css";
import { heading, line, shell, stats, text } from "../../styled-system/recipes";
import {
	type ForgeNode,
	projectsUnder,
	reposUnder,
	urlFor,
	useForge,
} from "./data/index.ts";
import IssueRow from "./IssueRow.vue";

const props = defineProps<{ node: ForgeNode; scope: string }>();

const store = useForge();

const openCount = computed(() => store.openCount(props.node));
const recent = computed(() =>
	store.issuesUnder(props.node).filter((i) => i.state === "open").slice(0, 5)
);
const repos = computed(() => reposUnder(props.node).length);
const projects = computed(() => projectsUnder(props.node).length);
const refused = computed(() => store.refusedUnder(props.node).length > 0);

const page = shell();
const number = stats();
const rows = line();
const label = heading({ size: "rule" });
const columns = css({
	display: "grid",
	gridTemplateColumns: "repeat(auto-fit, minmax(min(380px, 100%), 1fr))",
	gap: "8",
});
const column = css({ display: "flex", flexDirection: "column", minWidth: "0" });
const name = text({ mono: true, size: "sm" });
const muted = css({ fontWeight: "normal", color: "academy.textMuted" });
</script>

<template>
	<div :class="page.pad">
		<div :class="number.root">
			<a v-if="openCount !== undefined" :href="urlFor(scope, 'issues')"
				:class="number.stat">
				<span :class="number.numeral">{{ openCount }}</span>
				<span :class="number.unit">Open issues</span>
			</a>
			<a :href="urlFor(scope, 'projects')" :class="number.stat">
				<span :class="number.numeral">{{ projects }}</span>
				<span
					:class="number.unit">{{ projects === 1 ? "Project" : "Projects" }}</span>
			</a>
			<div :class="number.stat">
				<span :class="number.numeral">{{ repos }}</span>
				<span :class="number.unit">{{ repos === 1 ? "Repo" : "Repos" }}</span>
			</div>
		</div>

		<div :class="columns">
			<section :class="column">
				<h2 :class="label">Here</h2>
				<a v-for="child in node.children" :key="child.addr"
					:href="urlFor(child.addr)" :class="rows.root">
					<span :class="name">{{ child.name }}</span>
					<span :class="[rows.title, muted]">{{ child.description }}</span>
				</a>
				<p v-if="node.loaded && !node.children.length"
					:class="rows.empty">Nothing here yet.</p>
				<p v-if="!node.loaded" role="status"
					:class="rows.empty">{{ node.loadError ?? "Loading…" }}</p>
			</section>
			<section :class="column">
				<h2 :class="label">Recently updated issues</h2>
				<IssueRow v-for="issue in recent" :key="`${issue.repo}#${issue.number}`"
					:issue="issue" :scope="scope" stacked />
				<p v-if="!recent.length && !refused"
					:class="rows.empty">No open issues here.</p>
				<p v-if="refused"
					:class="rows.empty">Some issues here are not visible to you. <a
						class="anon-only" href="/-/auth/login?return_to=/"
						data-reload>Sign in</a></p>
			</section>
		</div>
	</div>
</template>
