<script setup lang="ts">
import { css } from "../../styled-system/css";
import { tree } from "../../styled-system/recipes";
import { Button } from "../design-system/index.ts";
import { type ForgeNode, type Route, urlFor, useForge } from "./data/index.ts";
import TreeLevel from "./TreeLevel.vue";

defineProps<{ scope: string; route: Route }>();

const store = useForge();

const styles = tree();
const issuesHead = css({ marginInlineEnd: "[2.75rem]" });
const footLinks = css({
	display: "flex",
	flexWrap: "wrap",
	columnGap: "3",
	rowGap: "1",
});
</script>

<template>
	<nav aria-label="Tree">
		<div
			:class="styles.head"><span>Tree</span><span :class="issuesHead">Issues</span></div>
		<div :class="styles.row"
			:data-current="scope === '' && !route.detail ? '' : undefined">
			<a href="/"
				:aria-current="scope === '' && !route.detail ? 'page' : undefined"
				:class="styles.link">
				<span :class="styles.text"><span :class="styles.name">~</span></span>
				<span v-if="store.openCount(store.state.tree as ForgeNode) !== undefined"
					:class="styles.count"
					data-dim>{{ store.openCount(store.state.tree as ForgeNode) }}</span>
			</a>
			<span :class="styles.spacer"></span>
		</div>
		<TreeLevel :node="store.state.tree as ForgeNode" :scope="scope"
			:route="route" />
		<div v-if="scope === ''" :class="[styles.actions, 'owner-only']">
			<Button :href="urlFor('', 'new/group')">New group</Button>
		</div>
		<p :class="[styles.foot, footLinks]">
			<a href="/-/hud">HUD</a>
			<a href="/-/explore">Explore</a>
			<a class="member-only" href="/-/agents">Agents</a>
			<a class="member-only" href="/-/extensions">Extensions</a>
			<a href="/-/design-system">Design system</a>
		</p>
	</nav>
</template>
