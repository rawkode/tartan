<script setup lang="ts">
import { computed } from "vue";
import { css } from "../../styled-system/css";
import { line, text } from "../../styled-system/recipes";
import { Badge } from "../design-system/index.ts";
import { eventsAt, type ForgeNode } from "./data/index.ts";

const props = defineProps<{ node: ForgeNode; scope: string }>();

const activity = computed(() => eventsAt(props.node, props.scope, 24));

const rows = line();
const page = css({
	display: "flex",
	flexDirection: "column",
	paddingInline: "7",
	paddingBlockStart: "3.5",
	paddingBlockEnd: "12",
});
const monoMuted = text({ mono: true, tone: "muted", size: "xs" });
const age = css({ flex: "[0 0 4ch]" });
const place = css({ overflowWrap: "anywhere" });
</script>

<template>
	<div :class="page">
		<div v-for="event in activity" :key="event.sha" :class="rows.root">
			<span :class="[monoMuted, age]">{{ event.age }}</span>
			<span :class="monoMuted">{{ event.sha }}</span>
			<span :class="rows.title">{{ event.subject }}</span>
			<span v-if="event.place"
				:class="[monoMuted, place]">{{ event.place }}</span>
			<span
				:class="rows.chips"><Badge v-for="project in event.chips" :key="project">{{ project }}</Badge></span>
		</div>
		<p v-if="!activity.length"
			:class="rows.empty">Nothing has happened here yet.</p>
	</div>
</template>
