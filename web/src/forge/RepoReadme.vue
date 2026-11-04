<script setup lang="ts">
// A directory's README, if it has one. It goes through the same safe renderer as
// extension documents: no raw HTML, links checked.
import { css } from "../../styled-system/css";
import { heading, line } from "../../styled-system/recipes";
import { useResource } from "../composables/resource.ts";
import UiMarkdown from "../ui/nodes/UiMarkdown.ts";
import { type ForgeNode, useForge } from "./data/index.ts";

const props = defineProps<{ repo: ForgeNode; dir?: string }>();

const store = useForge();

const file = useResource(
	() => `${props.repo.addr}:${props.dir ?? ""}`,
	() => store.readme(props.repo, props.dir),
);

const rows = line();
const label = heading({ size: "rule" });
const stack = css({ display: "flex", flexDirection: "column", gap: "2.5" });
const prose = css({ maxWidth: "[64ch]", overflowWrap: "anywhere" });
</script>

<template>
	<section v-if="file.data.value" :class="stack">
		<h2 :class="label">{{ file.data.value.path }}</h2>
		<div :class="prose">
			<UiMarkdown :md="file.data.value.text" />
		</div>
	</section>
	<p v-else-if="file.error.value" role="alert"
		:class="rows.empty">Could not read the README: {{ file.error.value }}</p>
</template>
