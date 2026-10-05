<script setup lang="ts">
// CUE issues and registry denials of one evaluation (ADR repo config, "User
// interface"). Every message is repository-controlled text: interpolated,
// never HTML. A position links to the blob view only for a root `<name>.cue`
// file the evaluation was given; forge positions link to the schema.
import { computed } from "vue";
import { RouterLink } from "vue-router";
import type {
	EvalIssue,
	RepoConfigDenial,
} from "@tartan/contract/repoconfig.ts";
import { DENIAL_LABEL, issueTitle, positionLink } from "./model.ts";

const props = defineProps<{
	issues: readonly EvalIssue[];
	denials: readonly RepoConfigDenial[];
	repoPath: string;
	/** The commit the positions refer to (trunk or the lane head). */
	commit: string;
	/** Root `*.cue` names that were sent to the evaluator. */
	sent: readonly string[];
	/** Where forge positions (`cue.mod/…`, `~tartan.cue`) link. */
	schemaHref: string;
}>();

const sentSet = computed(() => new Set(props.sent));
const rows = computed(() =>
	props.issues.map((issue) => ({
		title: issueTitle(issue),
		msg: issue.msg,
		links: issue.pos.map((p) =>
			positionLink(p, props.repoPath, props.commit, sentSet.value)
		),
	}))
);
</script>

<template>
	<div v-if="issues.length > 0 || denials.length > 0" class="config-issues">
		<ul v-if="issues.length > 0" class="config-issues__list" aria-label="CUE errors">
			<li v-for="(row, i) in rows" :key="`i${i}`" class="config-issues__item">
				<code class="config-issues__path">{{ row.title }}</code>
				<span class="config-issues__msg">{{ row.msg }}</span>
				<span v-if="row.links.length > 0" class="config-issues__pos">
					<template v-for="(link, j) in row.links" :key="`p${j}`">
						<RouterLink v-if="link.kind === 'blob'" :to="link.href"><code>{{ link.text }}</code></RouterLink>
						<RouterLink v-else-if="link.kind === 'schema'" :to="schemaHref" title="the forge's schema"><code>{{ link.text }}</code></RouterLink>
						<code v-else>{{ link.text }}</code>
					</template>
				</span>
			</li>
		</ul>
		<ul v-if="denials.length > 0" class="config-issues__list" aria-label="Registry denials">
			<li v-for="(d, i) in denials" :key="`d${i}`" class="config-issues__item">
				<span class="chip chip--danger">{{ DENIAL_LABEL[d.code] ?? d.code }}</span>
				<code v-if="d.path" class="config-issues__path">{{ d.path }}</code>
				<span class="config-issues__msg">{{ d.message }}</span>
			</li>
		</ul>
	</div>
</template>

<style scoped>
.config-issues {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
}

.config-issues__list {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-2);
}

.config-issues__item {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: var(--tt-space-1) var(--tt-space-2);
	min-width: 0;
	overflow-wrap: anywhere;
}

.config-issues__path {
	font-size: var(--tt-text-sm);
}

.config-issues__msg {
	white-space: pre-wrap;
}

.config-issues__pos {
	display: inline-flex;
	flex-wrap: wrap;
	gap: var(--tt-space-2);
	font-size: var(--tt-text-sm);
}
</style>
