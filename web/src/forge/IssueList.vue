<script setup lang="ts">
import { computed, ref } from "vue";
import { css } from "../../styled-system/css";
import { line, text } from "../../styled-system/recipes";
import { Button, Segmented } from "../design-system/index.ts";
import {
	type ForgeNode,
	type Issue,
	rel,
	store,
	under,
	urlFor,
} from "./data/index.ts";
import IssueRow from "./IssueRow.vue";

const props = defineProps<{ node: ForgeNode; scope: string }>();

const state = ref("open");
const grouping = ref("none");
const showAll = ref(false);

const inScope = computed(() =>
	(store.issues as Issue[]).filter(
		(i) =>
			under(i.where, props.scope) ||
			(props.node.kind === "project" && i.affected.includes(props.scope)),
	)
);
const open = computed(() => inScope.value.filter((i) => !i.closed));
const closed = computed(() => inScope.value.filter((i) => i.closed));
const list = computed(
	() => (state.value === "open" ? open.value : closed.value),
);
const shown = computed(
	() => (showAll.value ? list.value : list.value.slice(0, 12)),
);
const grouped = computed(() => grouping.value === "project");

const sections = computed(() => {
	if (!grouped.value) return [{ title: "", rows: shown.value }];
	const byKey = new Map<string, Issue[]>();
	for (const issue of shown.value) {
		const key = rel(props.scope, issue.where) ||
			(props.node.kind === "repo" && props.node.children.length
				? "root"
				: props.node.name);
		byKey.set(key, [...(byKey.get(key) ?? []), issue]);
	}
	return [...byKey].map(([title, rows]) => ({ title, rows }));
});

const width = computed(() =>
	shown.value.reduce(
		(max, i) =>
			Math.max(
				max,
				(grouped.value ? 0 : rel(props.scope, i.where).length) +
					String(i.n).length + 1,
			),
		0,
	)
);

const canOpen = computed(() => props.node.kind !== "group");

const rows = line();
const page = css({
	display: "flex",
	flexDirection: "column",
	paddingInline: "7",
	paddingBlockStart: "3.5",
	paddingBlockEnd: "12",
});
const bar = css({
	display: "flex",
	flexWrap: "wrap",
	alignItems: "center",
	justifyContent: "space-between",
	columnGap: "6",
	rowGap: "2",
	paddingBlockEnd: "3",
	borderBlockEnd: "rule",
});
const controls = css({
	display: "flex",
	flexWrap: "wrap",
	alignItems: "center",
	gap: "4",
});
const groupTitle = css({
	paddingInline: "2.5",
	paddingBlockStart: "5",
	paddingBlockEnd: "2",
	borderBlockEnd: "rule",
	fontFamily: "academy-mono",
	fontSize: "sm",
	fontWeight: "bold",
	overflowWrap: "anywhere",
});
const more = css({ paddingBlockStart: "3" });
const muted = text({ tone: "muted", size: "sm" });
</script>

<template>
	<div :class="page">
		<div :class="bar">
			<Segmented
				v-model="state"
				label="Issue state"
				hide-label
				:items="[{ label: `Open ${open.length}`, value: 'open' }, { label: `Closed ${closed.length}`, value: 'closed' }]"
				@update:model-value="showAll = false"
			/>
			<div :class="controls">
				<Segmented v-model="grouping" label="Group"
					:items="[{ label: 'None', value: 'none' }, { label: 'By project', value: 'project' }]" />
				<template v-if="canOpen">
					<Button class="member-only" variant="solid"
						:href="urlFor(scope, 'issues/new')">New issue</Button>
					<Button class="anon-only"
						href="/-/login">Sign in to contribute</Button>
				</template>
			</div>
		</div>
		<template v-for="section in sections" :key="section.title">
			<h2 v-if="section.title" :class="groupTitle">{{ section.title }}</h2>
			<IssueRow v-for="issue in section.rows" :key="issue.id" :issue="issue"
				:scope="scope" :grouped="grouped" :width="width" />
		</template>
		<p v-if="!list.length"
			:class="[rows.empty, muted]">{{ state === "open" ? "No open issues here." : "No closed issues here." }}</p>
		<div v-if="list.length > shown.length" :class="more">
			<Button type="button"
				@click="showAll = true">Show {{ list.length - shown.length }} more</Button>
		</div>
	</div>
</template>
