<script setup lang="ts">
// Commits as a list: subject (links to the commit), author, time, short sha,
// and the agent/advance trailers as chips.
import { RouterLink } from "vue-router";
import type { CommitMeta } from "@tartan/contract/git.ts";
import { commitHref } from "../router/params.ts";
import { formatTime, isoTime, shortSha } from "../ui/format.ts";

defineProps<{ repo: string; commits: readonly CommitMeta[] }>();

const SHOWN_TRAILERS = new Set(["Tartan-Agent", "Tartan-Advance", "Tartan-Work"]);
</script>

<template>
	<ol class="commits">
		<li v-for="commit in commits" :key="commit.sha" class="commits__item">
			<div class="commits__main">
				<RouterLink :to="commitHref(repo, commit.sha)" class="commits__subject">{{ commit.subject }}</RouterLink>
				<p class="commits__meta">
					{{ commit.author.name }} ·
					<time :datetime="isoTime(commit.committedAt * 1000)">{{ formatTime(commit.committedAt * 1000) }}</time>
				</p>
				<p v-if="commit.trailers.some((t) => SHOWN_TRAILERS.has(t.key))" class="commits__trailers">
					<span
						v-for="trailer in commit.trailers.filter((t) => SHOWN_TRAILERS.has(t.key))"
						:key="`${trailer.key}:${trailer.value}`"
						class="chip chip--muted"
					>{{ trailer.key.replace("Tartan-", "").toLowerCase() }}: {{ trailer.value }}</span>
				</p>
			</div>
			<RouterLink :to="commitHref(repo, commit.sha)" class="commits__sha">
				<code>{{ shortSha(commit.sha) }}</code>
			</RouterLink>
		</li>
	</ol>
</template>

<style scoped>
.commits {
	margin: 0;
	padding: 0;
	list-style: none;
	border: 1px solid var(--tt-border);
	border-radius: var(--tt-radius);
	background: var(--tt-surface);
}

.commits__item {
	display: flex;
	gap: var(--tt-space-3);
	justify-content: space-between;
	padding: var(--tt-space-3);
	border-bottom: 1px solid var(--tt-border);
}

.commits__item:last-child {
	border-bottom: 0;
}

.commits__main {
	display: flex;
	flex-direction: column;
	gap: var(--tt-space-1);
	min-width: 0;
}

.commits__subject {
	font-weight: 600;
	color: var(--tt-text);
	text-decoration: none;
	overflow-wrap: anywhere;
}

.commits__subject:hover {
	text-decoration: underline;
}

.commits__meta {
	margin: 0;
	color: var(--tt-text-muted);
	font-size: var(--tt-text-sm);
}

.commits__trailers {
	display: flex;
	flex-wrap: wrap;
	gap: var(--tt-space-1);
	margin: 0;
}

.commits__sha {
	flex: none;
	align-self: flex-start;
}
</style>
