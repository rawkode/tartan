<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { css } from "../../styled-system/css";
import { line, panel, text } from "../../styled-system/recipes";
import { Button, Segmented } from "../design-system/index.ts";
import {
	type ForgeNode,
	type IssuesRefusal,
	type PlacedIssue,
	plural,
	rel,
	urlFor,
	useForge,
} from "./data/index.ts";
import IssueRow from "./IssueRow.vue";
import IssuesRefused from "./IssuesRefused.vue";

const props = defineProps<{ node: ForgeNode; scope: string }>();

const store = useForge();

const state = ref("open");
const grouping = ref("none");
const showAll = ref(false);

// A group adds up the repos below it, which ForgeApp keeps loaded. A repo or
// project asks the kernel for its own list.
const isGroup = computed(() => props.node.kind === "group");
watch(
	() => props.scope,
	() => {
		if (!isGroup.value) void store.ensureIssues(props.scope);
	},
	{ immediate: true },
);

const own = computed(() =>
	isGroup.value ? undefined : store.issuesAt(props.scope)
);
const refusal = computed(
	(): { reason: IssuesRefusal; message: string } | null =>
		own.value?.status === "refused"
			? { reason: own.value.reason, message: own.value.message }
			: null,
);
const loading = computed(() =>
	!isGroup.value && (own.value === undefined || own.value.status === "loading")
);

const repoNode = computed(() =>
	props.node.kind === "project"
		? store.nodeAt(props.scope.split(":")[0]!)
		: props.node
);

const all = computed((): PlacedIssue[] => {
	if (isGroup.value) return store.issuesUnder(props.node);
	if (own.value?.status !== "ready") return [];
	return own.value.list.issues.map((issue) =>
		store.placed(repoNode.value!, issue)
	);
});

const open = computed(() => all.value.filter((i) => i.state === "open"));
const closed = computed(() => all.value.filter((i) => i.state === "closed"));
const openTotal = computed(() =>
	own.value?.status === "ready" ? own.value.list.open : open.value.length
);
const closedTotal = computed(() =>
	own.value?.status === "ready" ? own.value.list.closed : closed.value.length
);
const cutOff = computed(() =>
	own.value?.status === "ready" &&
	own.value.list.issues.length < own.value.list.open + own.value.list.closed
);
const list = computed(
	() => (state.value === "open" ? open.value : closed.value),
);
const shown = computed(
	() => (showAll.value ? list.value : list.value.slice(0, 12)),
);
const grouped = computed(() => grouping.value === "project");
const canGroup = computed(() => props.node.kind !== "project");
const unreadable = computed(() =>
	isGroup.value ? store.refusedUnder(props.node) : []
);

const sections = computed(() => {
	if (!grouped.value) return [{ title: "", rows: shown.value }];
	const byKey = new Map<string, PlacedIssue[]>();
	for (const issue of shown.value) {
		const key = rel(props.scope, issue.where) || props.node.name;
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
					String(i.number).length + 1,
			),
		0,
	)
);

const canOpen = computed(() => !isGroup.value);

const rows = line();
const box = panel();
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
	<IssuesRefused v-if="refusal" :reason="refusal.reason"
		:message="refusal.message" />
	<div v-else-if="loading" :class="page">
		<div role="status" :class="[box.root, box.empty]">Loading…</div>
	</div>
	<div v-else :class="page">
		<div :class="bar">
			<Segmented
				v-model="state"
				label="Issue state"
				hide-label
				:items="[{ label: `Open ${openTotal}`, value: 'open' }, { label: `Closed ${closedTotal}`, value: 'closed' }]"
				@update:model-value="showAll = false"
			/>
			<div :class="controls">
				<Segmented v-if="canGroup" v-model="grouping" label="Group"
					:items="[{ label: 'None', value: 'none' }, { label: 'By project', value: 'project' }]" />
				<Button v-if="canOpen" class="member-only" variant="solid"
					:href="urlFor(scope, 'issues/new')">New issue</Button>
			</div>
		</div>
		<template v-for="section in sections" :key="section.title">
			<h2 v-if="section.title" :class="groupTitle">{{ section.title }}</h2>
			<IssueRow v-for="issue in section.rows"
				:key="`${issue.repo}#${issue.number}`" :issue="issue" :scope="scope"
				:grouped="grouped" :width="width" />
		</template>
		<p v-if="!list.length"
			:class="[rows.empty, muted]">{{ state === "open" ? "No open issues here." : "No closed issues here." }}</p>
		<div v-if="list.length > shown.length" :class="more">
			<Button type="button"
				@click="showAll = true">Show {{ list.length - shown.length }} more</Button>
		</div>
		<p v-if="cutOff"
			:class="[rows.empty, muted]">Showing the newest {{ all.length }}.</p>
		<p v-if="unreadable.length"
			:class="[rows.empty, muted]">{{ plural(unreadable.length, "repo") }} here would not show its issues to you.</p>
	</div>
</template>
