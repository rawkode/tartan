<script setup lang="ts">
import { Accordion } from "@ark-ui/vue/accordion";
import { computed, onMounted, ref, watch } from "vue";
import { tree } from "../../styled-system/recipes";
import { Button } from "../design-system/index.ts";
import {
	type ForgeNode,
	plural,
	type Route,
	under,
	urlFor,
	useForge,
} from "./data/index.ts";

const props = defineProps<{ node: ForgeNode; scope: string; route: Route }>();

const store = useForge();

// A level reads its own children when it opens, and each repo on it says what
// expands below it and how many issues it has.
const load = () => {
	if (props.node.kind === "group") void store.ensureChildren(props.node);
	for (const child of props.node.children) {
		if (child.kind !== "repo") continue;
		void store.ensureProjects(child);
		void store.ensureIssues(child.addr);
	}
};
onMounted(load);
watch(() => props.node.children.length, load);

// The child on the way to the current address opens by itself, closing its siblings.
const onPath = computed(() => {
	const child = props.node.children.find((k) => under(props.scope, k.addr));
	return child && child.kind !== "project" &&
			(child.kind === "group" || child.children.length)
		? child.name
		: undefined;
});

const open = ref(onPath.value ? [onPath.value] : []);
watch(
	[() => props.scope, onPath],
	() => {
		if (onPath.value) open.value = [onPath.value];
	},
);

const expandable = (child: ForgeNode) =>
	child.kind === "group" || child.children.length > 0;
const sub = (child: ForgeNode) =>
	child.kind === "project"
		? child.root
		: child.kind === "repo" && child.children.length
		? plural(child.children.length, "project")
		: "";

const styles = tree();
</script>

<template>
	<Accordion.Root v-model="open" collapsible lazy-mount unmount-on-exit>
		<Accordion.Item v-for="child in node.children" :key="child.name"
			:value="child.name">
			<div :class="styles.row"
				:data-current="child.addr === scope && !route.detail ? '' : undefined"
				:data-open="open.includes(child.name) ? '' : undefined">
				<a :href="urlFor(child.addr)"
					:aria-current="child.addr === scope && !route.detail ? 'page' : undefined"
					:class="styles.link">
					<svg :class="styles.icon" width="16" height="16" viewBox="0 0 16 16"
						fill="none" stroke="currentColor" stroke-width="1.4"
						stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
						<path v-if="child.kind === 'group'"
							d="M1.5 3.5h4.2l1.4 1.6h7.4v7.4h-13z" />
						<template v-else-if="child.kind === 'repo'">
							<circle cx="4.5" cy="3.5" r="1.75" />
							<circle cx="4.5" cy="12.5" r="1.75" />
							<circle cx="11.5" cy="5.5" r="1.75" />
							<path d="M4.5 5.25v5.5M11.5 7.25c0 2.6-7 1.4-7 3.5" />
						</template>
						<path v-else
							d="M8 1.6 13.8 4.8v6.4L8 14.4 2.2 11.2V4.8zM2.2 4.8 8 8l5.8-3.2M8 8v6.4" />
					</svg>
					<span :class="styles.text">
						<span :class="styles.name">{{ child.name }}</span>
						<span v-if="sub(child)" :class="styles.sub"
							data-dim>{{ sub(child) }}</span>
					</span>
					<span v-if="store.openCount(child) !== undefined" :class="styles.count"
						data-dim>{{ store.openCount(child) }}</span>
				</a>
				<Accordion.ItemTrigger v-if="expandable(child)"
					:aria-label="`Show what is in ${child.name}`" :class="styles.toggle">
					<Accordion.ItemIndicator :class="styles.chevron">
						<svg width="12" height="12" viewBox="0 0 16 16" fill="none"
							stroke="currentColor" stroke-width="1.4" stroke-linecap="round"
							stroke-linejoin="round" aria-hidden="true">
							<path d="M6 3.5 10.5 8 6 12.5" />
						</svg>
					</Accordion.ItemIndicator>
				</Accordion.ItemTrigger>
				<span v-else :class="styles.spacer"></span>
			</div>
			<Accordion.ItemContent v-if="expandable(child)" :class="styles.section">
				<TreeLevel :node="child" :scope="scope" :route="route" />
				<p v-if="!child.children.length"
					:class="styles.note">Nothing here yet.</p>
				<div v-if="child.kind === 'group' && child.addr === scope"
					:class="[styles.actions, 'owner-only']">
					<Button :href="urlFor(child.addr, 'new/group')">New group</Button>
					<Button :href="urlFor(child.addr, 'new/repo')">New repo</Button>
				</div>
				<p v-if="child.kind === 'repo'"
					:class="styles.note">Projects are discovered from <code>package tartan</code> files in this repo.</p>
			</Accordion.ItemContent>
		</Accordion.Item>
	</Accordion.Root>
</template>
