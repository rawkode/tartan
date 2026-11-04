<script setup lang="ts">
// A repo's newest commits, or those touching one project's directory.
import { css } from "../../styled-system/css";
import { heading, line, text } from "../../styled-system/recipes";
import { useResource } from "../composables/resource.ts";
import { commitHref, logHref } from "../router/params.ts";
import { age, type ForgeNode, useForge } from "./data/index.ts";

const props = defineProps<{ repo: ForgeNode; path?: string; limit?: number }>();

const store = useForge();

const log = useResource(
	() => `${props.repo.addr}:${props.path ?? ""}`,
	() => store.commits(props.repo, props.path),
);

const rows = line();
const label = heading({ size: "rule" });
const section = css({ display: "flex", flexDirection: "column" });
const mono = text({ mono: true, size: "xs" });
const heads = css({
	display: "flex",
	justifyContent: "space-between",
	alignItems: "baseline",
	gap: "3",
});
</script>

<template>
	<section :class="section">
		<h2 :class="[label, heads]"><span>Recent commits</span><a
				:href="logHref(repo.addr, repo.defaultBranch ?? 'main', path ?? '')">All</a></h2>
		<a v-for="commit in (log.data.value ?? []).slice(0, limit ?? 8)"
			:key="commit.sha" :href="commitHref(repo.addr, commit.sha)"
			:class="rows.root">
			<span :class="mono">{{ commit.sha.slice(0, 7) }}</span>
			<span :class="rows.title">{{ commit.subject }}</span>
			<span :class="rows.age">{{ age(commit.authoredAt) }}</span>
		</a>
		<p v-if="log.loading.value && !log.data.value" role="status"
			:class="rows.empty">Loading…</p>
		<p v-else-if="log.error.value" role="alert"
			:class="rows.empty">Could not read the commits: {{ log.error.value }}</p>
		<p v-else-if="log.data.value && !log.data.value.length"
			:class="rows.empty">No commits here yet.</p>
	</section>
</template>
