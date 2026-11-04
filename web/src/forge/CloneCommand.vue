<script setup lang="ts">
import { computed } from "vue";
import { css } from "../../styled-system/css";
import { terminal, text } from "../../styled-system/recipes";

const props = defineProps<{ repo: string; note?: string }>();

const command = computed(() =>
	`git clone ${globalThis.location?.origin ?? ""}/${props.repo}.git`
);

const muted = text({ tone: "muted", size: "sm" });
const stack = css({
	display: "flex",
	flexDirection: "column",
	gap: "2",
	maxWidth: "[720px]",
	minWidth: "0",
});
const wrap = css({ overflowWrap: "anywhere" });
</script>

<template>
	<div :class="stack">
		<span :class="muted">Clone</span>
		<code :class="[terminal(), wrap]">{{ command }}</code>
		<span v-if="note" :class="muted">{{ note }}</span>
	</div>
</template>
