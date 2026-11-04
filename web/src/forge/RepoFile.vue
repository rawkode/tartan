<script setup lang="ts">
// One known file at the trunk tip, or nothing when it isn't there.
import { computed } from "vue";
import { css } from "../../styled-system/css";
import { diff, heading, line } from "../../styled-system/recipes";
import { useResource } from "../composables/resource.ts";
import { blobHref } from "../router/params.ts";
import { type ForgeNode, useForge } from "./data/index.ts";

const props = defineProps<{ repo: ForgeNode; path: string; title: string }>();

const store = useForge();

const file = useResource(
	() => `${props.repo.addr}:${props.path}`,
	() => store.readFile(props.repo, props.path),
);
const href = computed(() =>
	blobHref(props.repo.addr, props.repo.defaultBranch ?? "main", props.path)
);

const source = diff();
const rows = line();
const label = heading({ size: "rule" });
const stack = css({ display: "flex", flexDirection: "column", gap: "2.5" });
const code = css({
	margin: "0",
	padding: "3",
	fontFamily: "academy-mono",
	fontSize: "xs",
	lineHeight: "academy-reading",
	overflowX: "auto",
	tabSize: "2",
});
</script>

<template>
	<section v-if="file.data.value !== null" :class="stack">
		<h2 :class="label">{{ title }}</h2>
		<div :class="source.root">
			<a :href="href" :class="source.file">{{ path }}</a>
			<pre :class="code">{{ file.data.value }}</pre>
		</div>
	</section>
	<p v-else-if="file.error.value" role="alert"
		:class="rows.empty">Could not read {{ path }}: {{ file.error.value }}</p>
</template>
